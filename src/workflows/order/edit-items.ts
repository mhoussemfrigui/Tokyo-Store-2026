import "server-only";

import { z } from "zod";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orderService } from "@/modules/order/service";
import { order_items, order_status_history } from "@/modules/order/schema";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { stockMovementService } from "@/modules/stock-movement";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import { resolveLowStockConfig } from "@/lib/inventory/low-stock";
import { emitStockCrossingEvents, type StockLevelChange } from "@/lib/inventory/stock-alerts";
import { getTaxConfigStrict, computeTaxCents } from "@/lib/tax";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { formatMoneyExact } from "@/lib/price";
import { recomputeOrderTotals } from "@/lib/order/recompute-totals";
import { documentShippingTaxCents, sumCareTaxCents } from "@/lib/order/document-money";
import { orderTaxMode, orderTotalLock } from "@/lib/order/order-tax-mode";
import { buildAddLineSnapshots, BuildLineError } from "@/lib/order/build-line-snapshot";
import { isFullyRefunded, sumRefundCents } from "@/lib/order/fulfilment-state";
import { bus } from "@/events/bus";
import { emitProductStockCacheBust } from "@/lib/catalog/product-cache-bust";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

const PRE_SHIP = new Set(["pending", "paid", "preparing"]);

/**
 * Thrown INSIDE the edit transaction to abort it once a write already ran (a
 * stock claim failing after an earlier release/claim of the same batch).
 * drizzle only rolls back on a THROW — a returned `{ kind: "fail" }` COMMITS
 * every stock move + ledger row already applied while skipping the line/totals
 * mutations (half an edit → phantom/lost units). Caught just outside
 * `db.transaction` and mapped back to its WorkflowFail (never reaches the
 * generic workflow() "internal" catch).
 */
class EditItemsAbort extends Error {
  constructor(readonly failure: WorkflowFail) {
    super(failure.message);
    this.name = "EditItemsAbort";
  }
}

export const editItemsSchema = z.object({
  orderId: z.string().uuid(),
  ops: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("add"),
          productId: z.string().uuid(),
          variantId: z.string().nullable().optional(),
          quantity: z.number().int().positive(),
        }),
        z.object({ kind: z.literal("set_qty"), orderItemId: z.string().uuid(), quantity: z.number().int().positive() }),
        z.object({ kind: z.literal("remove"), orderItemId: z.string().uuid() }),
      ]),
    )
    .min(1)
    // One op per existing line — two set_qty/remove ops on the same orderItemId in
    // one batch would double-apply its stock delta (oversell / leak).
    .refine(
      (ops) => {
        const ids = ops
          .filter((o) => o.kind !== "add")
          .map((o) => (o as { orderItemId: string }).orderItemId);
        return new Set(ids).size === ids.length;
      },
      { message: "Une seule opération par ligne de commande." },
    ),
});

/**
 * Operator order-line editing on a PRE-SHIP order (pending/paid/preparing): add
 * a line, change a line's quantity, or remove a line — in ONE locked, atomic
 * transaction. Stock is reconciled exactly like place-order (decrement, race-safe
 * `gte` guard) + transition-status/returns (restock, sold-out-only in_stock CASE),
 * with a single deterministic lock order across the combined decrement+restock
 * set so concurrent multi-line edits sharing SKUs can't AB/BA deadlock. Per-line
 * tax + order totals are recomputed via the shared resolver; frozen discounts are
 * re-clamped (never re-derived). Blocked once an invoice is issued (fiscal
 * lock), a line is shipped, or the order is fully refunded (the refund already
 * restocked it); a partial refund caps how far the total may shrink. Atomic for
 * a multi-op batch too: a failure after the first stock write throws
 * (EditItemsAbort) so nothing of the batch commits.
 *
 * Money integrity on an EXISTING order:
 *   - the TOTAL may not move once it is locked (orderTotalLock — the same rule
 *     as set-invoice-tax): a settled order (`paid_at` = the captured amount) or
 *     a pending online order with a live gateway session refuses a
 *     total-changing edit; a total-NEUTRAL edit (e.g. swapping equal lines)
 *     stays allowed;
 *   - re-tax in the ORDER's own mode (orderTaxMode — its arithmetic, not the
 *     live tax.mode) and keep its own shipping-tax term (`tax_cents − Σ line
 *     tax`, not the live rate / on_shipping), so a store-wide config change
 *     never re-interprets an old order;
 *   - a manual TVA override (`tax_manual_cents`) is cleared: it corrected the
 *     OLD lines, and the rebuilt total uses the computed tax.
 */
export const editOrderItemsWorkflow = workflow<
  [z.input<typeof editItemsSchema>, { actorUserId?: string | null }],
  { orderId: string; subtotalCents: number; totalCents: number }
>("order.edit_items", async (input, { actorUserId }) => {
  const parsed = editItemsSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Modification invalide.");
  const d = parsed.data;

  // Read-only config resolved before the tx. STRICT tax read: a failed settings
  // read throws (→ workflow() "internal", nothing written) instead of re-taxing
  // the edited lines with TVA off.
  const taxConfig = await getTaxConfigStrict();
  const storePolicy = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const minOrderCents = Math.max(0, Math.trunc(Number(storePolicy["checkout.min_order_cents"])) || 0);
  const sharedDefault = await getSharedStockDefault();
  // Low-stock operator alerts — the same toggle/threshold place-order reads.
  const lowStockCfg = resolveLowStockConfig(storePolicy);

  // Resolve ADD snapshots up front (validates availability + prices the lines).
  // Only the RATE is taken from here: "ht" keeps the resolved cascade rate on
  // the snapshot even while the store's TVA is off — the TVA AMOUNT of an added
  // line is computed inside the tx in the locked ORDER's own mode.
  const addOps = d.ops.filter((o): o is Extract<typeof o, { kind: "add" }> => o.kind === "add");
  let builtAdds: Awaited<ReturnType<typeof buildAddLineSnapshots>>;
  try {
    builtAdds = await buildAddLineSnapshots(
      addOps.map((o) => ({ productId: o.productId, variantId: o.variantId ?? null, quantity: o.quantity })),
      { mode: "ht", defaultRateBps: taxConfig.defaultRateBps },
    );
  } catch (err) {
    if (err instanceof BuildLineError) return fail("product_unavailable", err.userMessage);
    throw err;
  }

  type EditTxResult =
    | {
        kind: "ok";
        subtotalCents: number;
        totalCents: number;
        orderNumber: string;
        touchedProductIds: string[];
        levelChanges: StockLevelChange[];
        /** False for a batch that changes no line (nothing written, no event). */
        changed: boolean;
        /** The manual TVA override the edit cleared (null = none was set). */
        clearedManualTaxCents: number | null;
      }
    | { kind: "fail"; error: WorkflowFail };
  const result = await db.transaction<EditTxResult>(async (tx) => {
    const order = await orderService.findById(d.orderId, tx, { forUpdate: true });
    if (!order) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    if (!PRE_SHIP.has(order.status)) {
      return { kind: "fail", error: fail("invalid_status", "Seules les commandes non expédiées (en attente / payée / en préparation) peuvent être modifiées.") };
    }
    if (order.invoice_number || order.credit_note_number) {
      return { kind: "fail", error: fail("conflict", "Facture déjà émise — émettez un avoir avant de modifier les lignes.") };
    }
    // Refund-ledger guards. A FULL refund already restocked the unshipped units
    // (refund-order.ts) — removing/shrinking a line would restock them a SECOND
    // time (phantom stock → oversell), growing one would claim stock for an
    // order whose money is back with the customer. The refund does not change
    // the status, so the PRE_SHIP gate above doesn't catch it.
    const refundedCents = sumRefundCents(await orderService.listRefunds(d.orderId, tx));
    if (isFullyRefunded(order.total_cents, refundedCents)) {
      return {
        kind: "fail",
        error: fail(
          "conflict",
          "Commande intégralement remboursée — son stock non expédié a déjà été réintégré, ses lignes ne peuvent plus être modifiées (annulez-la si rien n'est parti).",
        ),
      };
    }

    const lines = await orderService.listItemsInTx(tx, d.orderId);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const shippedByItem = await orderService.shippedQtyByItem(d.orderId, tx);

    // The ORDER's own tax semantics, from its pre-edit rows (never the live
    // tax.mode / on_shipping alone): the mode every re-taxed / added line uses,
    // and the shipping-tax term it was sold with (kept as is — shipping never
    // changes in an edit).
    const orderMode = orderTaxMode(order, lines, taxConfig.mode);
    // Tokyo Care snapshot. Its charge + TVA must be RECONCILED to the edited line
    // set below (a removed line drops its care; a qty-changed per-unit line
    // re-multiplies), not blindly preserved — else editing would keep charging
    // care for a removed product or the old quantity. The ORIGINAL care TVA (all
    // rows) is what's excluded from the shipping-tax remainder, since the order's
    // (pre-edit) tax_cents includes it.
    const careItems = await orderService.listCareItems(d.orderId, tx);
    const originalCareTaxCents = sumCareTaxCents(careItems);
    const shippingTaxCents = documentShippingTaxCents(order, lines, originalCareTaxCents);

    // Product + variant rows for every line + add target (stock mode, flags) —
    // read ON the tx (sequential, no extra pool connection while the order row
    // is locked), and a failed read THROWS → the edit rolls back instead of
    // degrading a variant line to "untracked" (silently skipped stock move).
    const allProductIds = [
      ...new Set([...lines.map((l) => l.product_id), ...addOps.map((o) => o.productId)]),
    ];
    const prodRows =
      allProductIds.length === 0
        ? []
        : await tx
            .select()
            .from(products)
            .where(and(inArray(products.id, allProductIds), isNull(products.deleted_at)));
    const variantRows =
      allProductIds.length === 0
        ? []
        : await tx
            .select()
            .from(product_variants)
            .where(and(inArray(product_variants.product_id, allProductIds), isNull(product_variants.deleted_at)));
    const productById = new Map(prodRows.map((p) => [p.id, p]));
    const variantById = new Map(variantRows.map((v) => [v.id, v]));

    // A stock op: which row to touch + signed delta (negative = claim/decrement),
    // plus the labels the post-commit low-stock alert email carries.
    type StockOp = {
      lockKey: string;
      isVariant: boolean;
      targetId: string;
      productId: string;
      variantId: string | null;
      delta: number;
      alert: Pick<StockLevelChange, "sku" | "name" | "variantLabel">;
    };
    const stockOps: StockOp[] = [];
    // Post-edit line set (kept lines, qty-adjusted) for the totals recompute.
    const finalLines = new Map(
      lines.map((l) => [l.id, { unitPriceCents: l.unit_price_cents, quantity: l.quantity, taxCents: l.tax_cents }]),
    );
    const addedLineValues: Array<Parameters<typeof orderService.insertItems>[0][number]> = [];
    const setQtyPatches: Array<{ id: string; quantity: number; subtotalCents: number; taxCents: number }> = [];
    const removeIds: string[] = [];

    // Resolve the stock target + zero-delta skip rule for an EXISTING line.
    // MUST mirror the ADD path (build-line-snapshot) + place-order/cancel: a line
    // moves stock_qty iff its tracked qty is non-null. The target is decided
    // from the LINE (variant_id + the product's stock mode, like the cancel
    // restock), never from whether a variant row came back: a variant removed
    // since the sale is untracked here — its parent row is never moved instead.
    const stockTargetFor = (line: (typeof lines)[number]) => {
      const product = productById.get(line.product_id);
      const variant = line.variant_id ? variantById.get(line.variant_id) : undefined;
      const shared = Boolean(line.variant_id) && isSharedStock(product?.shared_variant_stock, sharedDefault);
      const decrementsVariant = Boolean(line.variant_id) && !shared;
      const trackedQty = decrementsVariant ? (variant?.stock_qty ?? null) : (product?.stock_qty ?? null);
      const noStock = trackedQty === null;
      // Alert labels mirror place-order: the variant's own SKU/label when its row
      // is the stock target, the parent's otherwise (shared pool / simple product).
      const alert = {
        sku: decrementsVariant ? (variant?.sku ?? product?.sku ?? line.product_sku ?? null) : (product?.sku ?? line.product_sku ?? null),
        name: product?.name ?? line.product_name,
        variantLabel: decrementsVariant ? (variant?.label || line.variant_label || null) : null,
      };
      return { product, decrementsVariant, noStock, alert };
    };

    let addIdx = 0;
    for (const op of d.ops) {
      if (op.kind === "add") {
        const built = builtAdds[addIdx++];
        // TVA in the ORDER's mode (the builder only resolved the rate).
        const rateBps = built.values.tax_rate_bps ?? 0;
        const addTaxCents = computeTaxCents(
          built.values.unit_price_cents * built.values.quantity,
          rateBps,
          orderMode,
        );
        addedLineValues.push({
          order_id: d.orderId,
          ...built.values,
          tax_cents: addTaxCents,
          tax_rate_bps: orderMode === "disabled" ? null : rateBps,
        });
        finalLines.set(`add:${addIdx}`, {
          unitPriceCents: built.values.unit_price_cents,
          quantity: built.values.quantity,
          taxCents: addTaxCents,
        });
        const noStock = built.decrementsVariant ? built.variant?.stock_qty == null : built.product.stock_qty == null;
        if (!noStock) {
          const targetId = built.decrementsVariant ? built.variant!.id : built.product.id;
          stockOps.push({
            lockKey: targetId,
            isVariant: built.decrementsVariant,
            targetId,
            productId: built.product.id,
            variantId: built.decrementsVariant ? built.variant!.id : null,
            delta: -built.values.quantity,
            alert: {
              sku: built.decrementsVariant ? (built.variant!.sku ?? built.product.sku) : built.product.sku,
              name: built.product.name,
              variantLabel: built.decrementsVariant ? built.variant!.label || null : null,
            },
          });
        }
        continue;
      }

      const line = lineById.get(op.orderItemId);
      if (!line || line.order_id !== d.orderId) {
        return { kind: "fail", error: fail("validation", "Ligne de commande introuvable.") };
      }
      const shipped = shippedByItem.get(line.id) ?? 0;
      const target = stockTargetFor(line);

      if (op.kind === "remove") {
        if (shipped > 0) {
          return { kind: "fail", error: fail("exceeds_remaining", `Impossible de retirer « ${line.product_name} » : ${shipped} unité(s) déjà expédiée(s).`) };
        }
        removeIds.push(line.id);
        finalLines.delete(line.id);
        if (!target.noStock) {
          const targetId = target.decrementsVariant ? line.variant_id! : line.product_id;
          stockOps.push({ lockKey: targetId, isVariant: target.decrementsVariant, targetId, productId: line.product_id, variantId: target.decrementsVariant ? line.variant_id : null, delta: line.quantity, alert: target.alert });
        }
        continue;
      }

      // set_qty
      const newQty = op.quantity;
      if (newQty === line.quantity) continue; // no-op
      if (newQty < shipped) {
        return { kind: "fail", error: fail("exceeds_remaining", `Quantité < expédiée pour « ${line.product_name} » (${shipped} déjà expédiée(s)).`) };
      }
      const delta = -(newQty - line.quantity); // increase → negative (decrement); decrease → positive (restock)
      if (!target.noStock && delta !== 0) {
        const targetId = target.decrementsVariant ? line.variant_id! : line.product_id;
        stockOps.push({ lockKey: targetId, isVariant: target.decrementsVariant, targetId, productId: line.product_id, variantId: target.decrementsVariant ? line.variant_id : null, delta, alert: target.alert });
      }
      const newSubtotal = line.unit_price_cents * newQty;
      const newTax = computeTaxCents(newSubtotal, line.tax_rate_bps ?? 0, orderMode);
      setQtyPatches.push({ id: line.id, quantity: newQty, subtotalCents: newSubtotal, taxCents: newTax });
      finalLines.set(line.id, { unitPriceCents: line.unit_price_cents, quantity: newQty, taxCents: newTax });
    }

    // Must keep ≥ 1 line.
    if (finalLines.size === 0) {
      return { kind: "fail", error: fail("validation", "Une commande doit contenir au moins une ligne.") };
    }

    // A batch that changes no line (e.g. a stale set_qty to the current qty) is
    // a no-op: nothing to write, no override to reset, no event.
    if (addedLineValues.length === 0 && setQtyPatches.length === 0 && removeIds.length === 0) {
      return {
        kind: "ok",
        subtotalCents: order.subtotal_cents,
        totalCents: order.total_cents,
        orderNumber: order.order_number,
        touchedProductIds: [],
        levelChanges: [],
        changed: false,
        clearedManualTaxCents: null,
      };
    }

    // ── Reconcile Tokyo Care to the edited line set. A removed goods line's care
    // is DROPPED (row deleted); a qty-changed line's PER-UNIT care is re-multiplied
    // by the new qty (per-line care stays), keeping the snapshot unit price;
    // unchanged lines keep their rows. The post-edit sums feed the totals + a care
    // charge is never kept for a product that left the order.
    const removedSet = new Set(removeIds);
    const newQtyById = new Map(setQtyPatches.map((p) => [p.id, p.quantity]));
    const careDeleteIds: string[] = [];
    const careUpdates: { id: string; careCents: number; quantity: number; taxCents: number }[] = [];
    let careCents = 0;
    let careTaxCents = 0;
    for (const c of careItems) {
      if (removedSet.has(c.order_item_id)) {
        careDeleteIds.push(c.id);
        continue;
      }
      const newQty = newQtyById.get(c.order_item_id);
      if (newQty !== undefined && newQty !== c.quantity) {
        // Per-unit when the stored line total equals unit × stored qty; else per-line.
        const perUnit = c.care_cents === c.unit_care_cents * c.quantity;
        const nextCare = perUnit ? c.unit_care_cents * newQty : c.care_cents;
        const nextTax = perUnit ? computeTaxCents(nextCare, c.tax_rate_bps ?? 0, orderMode) : c.tax_cents;
        if (nextCare !== c.care_cents || nextTax !== c.tax_cents) {
          careUpdates.push({ id: c.id, careCents: nextCare, quantity: newQty, taxCents: nextTax });
        }
        careCents += nextCare;
        careTaxCents += nextTax;
      } else {
        careCents += c.care_cents;
        careTaxCents += c.tax_cents;
      }
    }

    // Totals in the ORDER's mode with its OWN shipping-tax term.
    const postLines = [...finalLines.values()];
    const recomputed = recomputeOrderTotals({
      lines: postLines,
      shippingCents: order.shipping_cents,
      discountCents: order.discount_cents,
      taxMode: orderMode,
      taxDefaultRateBps: taxConfig.defaultRateBps,
      taxOnShipping: taxConfig.onShipping,
      shippingTaxCents,
      // Preserve the Tokyo Care add-on + its TVA unchanged through the edit.
      careCents,
      careTaxCents,
    });

    // Total lock (shared rule with set-invoice-tax): a settled order's total is
    // the CAPTURED amount (refund cap, avoir, revenue) and a pending online
    // order's is what the gateway session charges — neither may move. Thrown
    // (EditItemsAbort → mapped outside the tx) so it can never commit a write.
    if (recomputed.totalCents !== order.total_cents) {
      const lock = orderTotalLock(order);
      if (lock === "settled") {
        throw new EditItemsAbort(
          fail(
            "conflict",
            "Commande déjà payée : le total encaissé ne peut plus changer — utilisez un remboursement, ou annulez puis recréez la commande.",
          ),
        );
      }
      if (lock === "gateway_pending") {
        throw new EditItemsAbort(
          fail(
            "conflict",
            "Paiement en ligne en cours : le total ne peut pas changer tant que le règlement n'est pas finalisé.",
          ),
        );
      }
    }

    // Min-order floor on the post-edit subtotal.
    if (minOrderCents > 0 && recomputed.subtotalCents < minOrderCents) {
      return { kind: "fail", error: fail("min_order", `Le montant minimum de commande est de ${formatMoneyExact(minOrderCents)}.`) };
    }

    // A PARTIAL refund stays editable (a refund implies `paid_at`, so the total
    // lock above already limits it to total-neutral edits — this floor stays as
    // defence in depth), but the new total must remain ABOVE what was already
    // refunded: shrinking it to (or below) the refunded sum would
    // make the ledger read "fully refunded" without the full-refund restock /
    // promo reversal ever running — a later cancel then skips its restock
    // (transition-status alreadyRestockedByRefund) and the units are lost.
    if (refundedCents > 0 && recomputed.totalCents <= refundedCents) {
      return {
        kind: "fail",
        error: fail(
          "conflict",
          `Déjà remboursé : ${formatMoneyExact(refundedCents)} — le nouveau total doit rester supérieur à ce montant (remboursez le solde ou annulez plutôt).`,
        ),
      };
    }

    // Apply stock in one deterministic lock order (decrements + restocks together).
    // From here on the tx has WRITTEN: any failure must THROW (EditItemsAbort) so
    // the whole batch rolls back — a returned fail would commit the moves above.
    const ordered = [...stockOps].sort((a, b) => (a.lockKey < b.lockKey ? -1 : a.lockKey > b.lockKey ? 1 : 0));
    // Level before → after of every stock row moved, for the post-commit crossing
    // events (low-stock / rupture alerts on claims, back-in-stock on releases).
    // RETURNING gives the NEW qty; the level before is reconstructed from it.
    const levelChanges: StockLevelChange[] = [];
    const noteLevel = (so: StockOp, newQty: number | null, prevQty: number | null) => {
      if (newQty == null || prevQty == null) return;
      levelChanges.push({ productId: so.productId, variantId: so.variantId, ...so.alert, prevQty, newQty });
    };
    for (const so of ordered) {
      const q = Math.abs(so.delta);
      if (so.delta < 0) {
        // Claim units (race-safe gte guard).
        const r = so.isVariant
          ? await tx
              .update(product_variants)
              .set({ stock_qty: sql`${product_variants.stock_qty} - ${q}`, in_stock: sql`(${product_variants.stock_qty} - ${q}) > 0` })
              .where(and(eq(product_variants.id, so.targetId), gte(product_variants.stock_qty, q)))
              .returning({ stockQty: product_variants.stock_qty })
          : await tx
              .update(products)
              .set({ stock_qty: sql`${products.stock_qty} - ${q}`, in_stock: sql`(${products.stock_qty} - ${q}) > 0` })
              .where(and(eq(products.id, so.targetId), gte(products.stock_qty, q)))
              .returning({ stockQty: products.stock_qty });
        if (r.length === 0) {
          throw new EditItemsAbort(fail("conflict", "Stock insuffisant pour appliquer la modification."));
        }
        await stockMovementService.record(
          { productId: so.productId, variantId: so.variantId, delta: -q, resultingQty: r[0].stockQty, reason: "admin", orderId: d.orderId, actorUserId },
          tx,
        );
        noteLevel(so, r[0].stockQty, r[0].stockQty == null ? null : r[0].stockQty + q);
      } else {
        // Release units back (sold-out-only in_stock CASE; never resurrect deleted/untracked).
        const r = so.isVariant
          ? await tx
              .update(product_variants)
              .set({ stock_qty: sql`${product_variants.stock_qty} + ${q}`, in_stock: sql`case when ${product_variants.stock_qty} <= 0 then true else ${product_variants.in_stock} end` })
              .where(and(eq(product_variants.id, so.targetId), sql`${product_variants.stock_qty} IS NOT NULL`, isNull(product_variants.deleted_at)))
              .returning({ stockQty: product_variants.stock_qty })
          : await tx
              .update(products)
              .set({ stock_qty: sql`${products.stock_qty} + ${q}`, in_stock: sql`case when ${products.stock_qty} <= 0 then true else ${products.in_stock} end` })
              .where(and(eq(products.id, so.targetId), sql`${products.stock_qty} IS NOT NULL`, isNull(products.deleted_at)))
              .returning({ stockQty: products.stock_qty });
        if (r.length > 0) {
          await stockMovementService.record(
            { productId: so.productId, variantId: so.variantId, delta: q, resultingQty: r[0].stockQty, reason: "admin", orderId: d.orderId, actorUserId },
            tx,
          );
          noteLevel(so, r[0].stockQty, r[0].stockQty == null ? null : r[0].stockQty - q);
        }
      }
    }

    // Apply line mutations.
    if (removeIds.length > 0) {
      await tx.delete(order_items).where(inArray(order_items.id, removeIds));
    }
    for (const p of setQtyPatches) {
      await orderService.updateItemQuantity(p.id, { quantity: p.quantity, subtotalCents: p.subtotalCents, taxCents: p.taxCents }, tx);
    }
    if (addedLineValues.length > 0) {
      await orderService.insertItems(addedLineValues, tx);
    }
    // Tokyo Care: drop the snapshot rows of removed lines, and re-quantify the
    // per-unit rows of qty-changed lines, so order_care_items + orders.care_cents
    // track the edited line set (patchTotals carries the new care_cents below).
    if (careDeleteIds.length > 0) {
      await orderService.deleteCareItems(careDeleteIds, tx);
    }
    for (const u of careUpdates) {
      await orderService.updateCareItem(u.id, { careCents: u.careCents, quantity: u.quantity, taxCents: u.taxCents }, tx);
    }

    // A manual TVA override corrected the OLD lines — cleared: the rebuilt
    // total uses the computed tax, so a kept override would print a TVA row
    // that no longer adds up to the total.
    await orderService.patchTotals(
      d.orderId,
      {
        subtotalCents: recomputed.subtotalCents,
        taxCents: recomputed.taxCents,
        taxManualCents: null,
        totalCents: recomputed.totalCents,
        discountCents: recomputed.clampedDiscountCents,
        careCents,
      },
      tx,
    );

    // Audit: a same-status history row marks the edit on the ADMIN order timeline
    // (+ the API history). The customer trail filters same-status rows out, so it
    // never shows the current status twice.
    const summary = [
      addedLineValues.length ? `+${addedLineValues.length} ligne(s)` : null,
      setQtyPatches.length ? `${setQtyPatches.length} quantité(s) ajustée(s)` : null,
      removeIds.length ? `−${removeIds.length} ligne(s)` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const manualTaxNote =
      order.tax_manual_cents != null
        ? ` — ${taxConfig.label} manuelle réinitialisée (${formatMoneyExact(order.tax_manual_cents)} → ${formatMoneyExact(recomputed.taxCents)})`
        : "";
    await tx.insert(order_status_history).values({
      order_id: d.orderId,
      from_status: order.status,
      to_status: order.status,
      actor_user_id: actorUserId ?? null,
      notes: `Édition des lignes : ${summary}${manualTaxNote}`,
    });

    return {
      kind: "ok",
      subtotalCents: recomputed.subtotalCents,
      totalCents: recomputed.totalCents,
      orderNumber: order.order_number,
      // Surface the products whose stock moved so the post-commit cache-bust can
      // invalidate them (stockOps is tx-scoped; the ids escape via the result).
      touchedProductIds: [...new Set(stockOps.map((o) => o.productId))],
      levelChanges,
      changed: true,
      clearedManualTaxCents: order.tax_manual_cents,
    };
  }).catch((err: unknown): EditTxResult => {
    // An in-tx abort already rolled everything back — surface its business fail.
    if (err instanceof EditItemsAbort) return { kind: "fail", error: err.failure };
    throw err;
  });

  if (result.kind === "fail") return result.error;
  if (!result.changed) {
    return ok({ orderId: d.orderId, subtotalCents: result.subtotalCents, totalCents: result.totalCents });
  }

  await bus.emit(
    "order.edited",
    {
      orderId: d.orderId,
      orderNumber: result.orderNumber,
      changedFields:
        result.clearedManualTaxCents != null
          ? ["items", "totals", "tax_manual_cents"]
          : ["items", "totals"],
    },
    { actorUserId: actorUserId ?? null },
  );

  // The edit moved stock (decrements for added/grown lines, restocks for
  // removed/shrunk ones) — bust the catalog cache for every touched product so a
  // cached PDP / listing reflects the new stock (shared helper; same path as
  // place-order + restock). Post-commit + best-effort.
  await emitProductStockCacheBust(result.touchedProductIds, actorUserId ?? null);

  // Stock-crossing events, exactly as the equivalent sale / cancel paths raise
  // them: an added or grown line that takes a tracked row under the threshold
  // (or to 0) alerts the operator (gated on the low-stock toggle, like
  // place-order); a removed or shrunk line that brings a sold-out row back fires
  // `product.restocked` (back-in-stock waitlist + webhook, like the cancel
  // restock). Post-commit + best-effort (the helper swallows its own errors).
  await emitStockCrossingEvents(result.levelChanges, {
    lowStock: lowStockCfg,
    restocked: true,
    actorUserId: actorUserId ?? null,
  });

  return ok({ orderId: d.orderId, subtotalCents: result.subtotalCents, totalCents: result.totalCents });
});
