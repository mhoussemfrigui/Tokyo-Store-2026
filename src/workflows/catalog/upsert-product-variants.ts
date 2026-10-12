import "server-only";

import { z } from "zod";

import { productService } from "@/modules/catalog/product/service";
import { attributeService } from "@/modules/catalog/attribute/service";
import { stockMovementService } from "@/modules/stock-movement";
import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { isAvailable, nextInStockForQty } from "@/lib/inventory/in-stock-rule";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import { fail, ok, workflow } from "../shared";

/**
 * Reconcile the full variant set of a product in one call (the admin variant
 * editor submits the whole list). Rows with an `id` are updated in place;
 * new rows are inserted; removed rows are soft-deleted — see
 * `productService.replaceVariants`. Promotes the product to `variable` when
 * it gains variants (never auto-demotes — the admin owns that via the type
 * selector).
 */
export const upsertProductVariantsSchema = z.object({
  productId: z.string().uuid(),
  variants: z
    .array(
      z.object({
        id: z.string().uuid().nullable().optional(),
        label: z.string().trim().max(200).default(""),
        sku: z.string().trim().max(60).nullable().optional(),
        // GTIN, when present, must be 8–14 digits (GTIN-8/12/13/14). Empty is
        // allowed (no barcode); the editor sends "" → treated as none.
        gtin: z
          .string()
          .trim()
          .max(14)
          .refine((v) => v === "" || /^\d{8,14}$/.test(v), "GTIN : 8 à 14 chiffres.")
          .nullable()
          .optional(),
        mpn: z.string().trim().max(70).nullable().optional(),
        // A sellable variant must carry a positive price (a bad/empty input
        // must not silently persist as 0 — see the editor guard too).
        priceCents: z.number().int().positive(),
        oldPriceCents: z.number().int().positive().nullable().optional(),
        // Stock: `undefined` on an EXISTING variant leaves its stock untouched
        // (the editor only sends what the operator changed); `null` = untracked.
        // A new variant without them takes the defaults (untracked, in stock).
        stockQty: z.number().int().min(0).nullable().optional(),
        inStock: z.boolean().optional(),
        // Compare-and-set guard: the stock_qty the operator SAW on page load. When
        // present on an existing variant, the save refuses with a `conflict` if
        // the locked committed stock has moved since (a sale / return / sync).
        expectedStockQty: z.number().int().min(0).nullable().optional(),
        imageMediaId: z.string().uuid().nullable().optional(),
        displayOrder: z.number().int().min(0).default(0),
        isDefault: z.boolean().default(false),
        attributeValueIds: z.array(z.string().uuid()).default([]),
      }),
    )
    .default([]),
});

export const upsertProductVariantsWorkflow = workflow<
  [z.input<typeof upsertProductVariantsSchema>, { actorUserId: string }],
  { productId: string; count: number }
>("product.variants.upsert", async (input, { actorUserId }) => {
  const parsed = upsertProductVariantsSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flatten(parsed.error));
  const d = parsed.data;

  const product = await productService.findById(d.productId);
  if (!product) return fail("not_found", "Produit introuvable.");

  const variants = d.variants.map((v, i) => ({
    id: v.id ?? null,
    label: v.label ?? "",
    sku: v.sku ?? null,
    gtin: v.gtin ?? null,
    mpn: v.mpn ?? null,
    priceCents: v.priceCents,
    oldPriceCents: v.oldPriceCents ?? null,
    // Keep `undefined` distinct from `null` (see the schema): undefined = leave
    // an existing variant's stock untouched.
    stockQty: v.stockQty,
    inStock: v.inStock,
    imageMediaId: v.imageMediaId ?? null,
    displayOrder: v.displayOrder ?? i,
    isDefault: v.isDefault,
    attributeValueIds: v.attributeValueIds,
  }));
  // Guarantee EXACTLY ONE default-selected variant for the PDP. Collapse any
  // extra `isDefault` rows to the first (a stale/buggy client could send two,
  // which the product_variants_one_default_per_product partial unique index
  // would reject with a raw 23505), then force-first when none was flagged.
  let seenDefault = false;
  for (const v of variants) {
    if (v.isDefault && !seenDefault) seenDefault = true;
    else v.isDefault = false;
  }
  if (variants.length > 0 && !seenDefault) variants[0].isDefault = true;

  // Validate every referenced attribute value EXISTS before opening the tx. A
  // stale value id (an option deleted in another tab) would otherwise raise a
  // raw FK violation (23503) inside replaceVariants, aborting the entire save
  // with an opaque 500. Fail cleanly up front (mirrors setCategoryFilters).
  const valueIds = Array.from(new Set(variants.flatMap((v) => v.attributeValueIds)));
  if (valueIds.length > 0) {
    const existing = await attributeService.findExistingValueIds(valueIds);
    if (valueIds.some((id) => !existing.has(id))) {
      return fail(
        "validation",
        "Une valeur d'attribut n'existe plus — rechargez la page et réessayez.",
      );
    }
  }

  // Per-variant price DROPS detected against the pre-save snapshot (emitted after
  // commit) so the wishlist price-drop email fires for VARIABLE products too — the
  // variant editor previously emitted only product.updated, never price_changed.
  const priceDrops: Array<{ variantId: string; oldCents: number; newCents: number }> = [];

  // `conflictLabel` = the variant whose stock moved under the editor (nothing
  // written); `becameAvailable` = an existing variant went unavailable →
  // available (a restock of a sold-out variant) — drives the back-in-stock email
  // after commit, like the product-level and bulk stock paths.
  type TxOut = { conflictLabel: string } | { conflictLabel: null; becameAvailable: boolean };
  const txOut = await db.transaction(async (tx): Promise<TxOut> => {
    // Snapshot existing per-variant stock + price BEFORE the reconcile so we can
    // ledger admin stock edits AND detect price drops (the product-level + bulk
    // paths already ledger stock; the variant editor was the one unledgered path).
    // Row-LOCKED: the compare-and-set, the in_stock derivation and the ledger
    // deltas below read the COMMITTED stock, and a concurrent order decrement
    // serializes behind this save instead of being overwritten by it.
    const before = await productService.listVariantStock(d.productId, tx, { forUpdate: true });
    const lockedById = new Map(before.map((r) => [r.id, r]));
    const oldPrice = new Map(before.map((r) => [r.id, r.price_cents]));
    for (const [i, v] of variants.entries()) {
      const locked = v.id ? lockedById.get(v.id) : undefined;
      if (!locked) {
        // An id that is no longer a live variant of this product (deleted in
        // another tab) would be RE-INSERTED by replaceVariants — and with its
        // stock omitted (unchanged in this stale editor) the insert would default
        // to untracked = unlimited. Refuse instead: the editor is out of date.
        if (v.id && v.stockQty === undefined) return { conflictLabel: v.label || "sans nom" };
        continue; // new variant → initial stock, nothing to compare
      }
      // Compare-and-set: the stock moved since the editor loaded (a sale, a
      // return, an ERP sync) → refuse rather than overwrite (nothing written yet).
      const expected = d.variants[i]?.expectedStockQty;
      if (expected !== undefined && locked.stock_qty !== expected) {
        return { conflictLabel: v.label || "sans nom" };
      }
      // A quantity change without an explicit availability flag (the editor has
      // no Disponible control) re-derives in_stock by the shared sold-out rule:
      // restocking a SOLD-OUT variant re-lists it; a delisted one stays delisted.
      if (v.stockQty !== undefined && v.inStock === undefined) {
        v.inStock = nextInStockForQty(locked.stock_qty, locked.in_stock, v.stockQty);
      }
    }
    const { removed } = await productService.replaceVariants(d.productId, variants, tx);
    // A removed variant is soft-deleted at stock 0 — ledger each TRACKED one's
    // units leaving (−old → 0), so Σ(delta) still explains the on-hand an ERP
    // reads from /api/stock/movements. Untracked (NULL) or already-empty rows
    // move no quantity.
    for (const r of removed) {
      if (r.stockQty != null && r.stockQty > 0) {
        await stockMovementService.record(
          { productId: d.productId, variantId: r.id, delta: -r.stockQty, resultingQty: 0, reason: "admin", actorUserId, note: "variante supprimée" },
          tx,
        );
      }
    }
    // Keep product_type in lock-step with the variant set: promote to `variable`
    // on the first variant, and DEMOTE back to `simple` when the set is emptied
    // (otherwise the product is left 'variable' with no variants → no picker on
    // the PDP, yet place-order rejects a simple add with "choisissez une
    // option"). Symmetric with the main-form demotion reconcile (VX-1).
    if (variants.length > 0 && product.product_type !== "variable") {
      await productService.update(d.productId, { product_type: "variable" }, tx);
    } else if (variants.length === 0 && product.product_type === "variable") {
      // Demote to 'simple'. A per-variant variable product keeps the PARENT
      // products.stock_qty NULL (stock lived on the variants), and NULL means
      // "untracked / always sellable" on every read path — so after removing the
      // variants, reset the now-variant-less parent to a TRACKED, out-of-stock
      // state so it isn't silently sold in unlimited quantity until the admin
      // sets a real stock. (A shared-pool variable product keeps its parent
      // stock_qty, so only reset when it was NULL.)
      const demotePatch: Parameters<typeof productService.update>[1] =
        product.stock_qty === null
          ? { product_type: "simple", stock_qty: 0, in_stock: false }
          : { product_type: "simple" };
      await productService.update(d.productId, demotePatch, tx);
      // The NULL → 0 reset makes the parent a tracked line: a delta-0 marker row
      // (resulting_qty 0 = the new baseline), like the main-form demotion.
      if (product.stock_qty === null) {
        await stockMovementService.record(
          { productId: d.productId, delta: 0, resultingQty: 0, reason: "admin", actorUserId, note: "rétrogradation" },
          tx,
        );
      }
    }
    // Append a `stock_movements` row for each EXISTING variant whose quantity
    // actually changed (from the LOCKED pre-value), mirroring applyStockSet:
    // number→number carries the signed change; a tracking switch (number→null
    // « suivi désactivé », null→number « suivi activé ») is a delta-0 marker
    // whose resulting_qty re-baselines the line (null = untracked) — the same
    // shape the ERP api_set path writes for that transition. New variants (no
    // prior id) carry initial stock, not a movement; an untouched stock
    // (undefined) and null↔null (untracked, e.g. shared-pool) are skipped.
    let becameAvailable = false;
    for (const v of variants) {
      const locked = v.id ? lockedById.get(v.id) : undefined;
      if (!v.id || !locked) continue;
      const beforeQty = locked.stock_qty;
      const after = v.stockQty;
      if (after !== undefined && beforeQty !== after) {
        await stockMovementService.record(
          {
            productId: d.productId,
            variantId: v.id,
            delta: typeof beforeQty === "number" && typeof after === "number" ? after - beforeQty : 0,
            resultingQty: after,
            reason: "admin",
            actorUserId,
            note: after === null ? "suivi désactivé" : beforeQty === null ? "suivi activé" : null,
          },
          tx,
        );
      }
      const afterQty = after !== undefined ? after : beforeQty;
      const afterInStock = v.inStock !== undefined ? v.inStock : locked.in_stock;
      if (!isAvailable(locked.in_stock, beforeQty) && isAvailable(afterInStock, afterQty)) {
        becameAvailable = true;
      }
      // Collect price drops for the after-commit price_changed emit.
      const oldCents = oldPrice.get(v.id);
      if (typeof oldCents === "number" && v.priceCents < oldCents) {
        priceDrops.push({ variantId: v.id, oldCents, newCents: v.priceCents });
      }
    }
    return { conflictLabel: null, becameAvailable };
  });
  if (txOut.conflictLabel !== null) {
    return fail(
      "conflict",
      `Le stock de la variante « ${txOut.conflictLabel} » a changé depuis l'ouverture de la page — rechargez.`,
    );
  }

  await bus.emit(
    "product.updated",
    {
      productId: d.productId,
      slug: product.slug,
      changedFields: ["variants"],
      // `product` loaded via findById at the top — ERP identifiers already here.
      sku: product.sku,
      gtin: product.gtin,
      externalRef: product.external_ref,
    },
    { actorUserId },
  );
  // A variant whose price DROPPED drives the wishlist price-drop email (the event
  // carries variantId so distinct variant drops aren't de-duped against each other).
  for (const drop of priceDrops) {
    await bus.emit(
      "product.price_changed",
      { productId: d.productId, variantId: drop.variantId, oldCents: drop.oldCents, newCents: drop.newCents },
      { actorUserId },
    );
  }
  // Back-in-stock: only when variants carry their OWN stock — in SHARED mode the
  // per-variant qty is ignored (availability comes from the parent pool), so a
  // variant-row change there says nothing about sellability.
  if (txOut.becameAvailable && !isSharedStock(product.shared_variant_stock, await getSharedStockDefault())) {
    await bus.emit("product.restocked", { productId: d.productId }, { actorUserId });
  }
  return ok({ productId: d.productId, count: variants.length });
});

function flatten(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) out[i.path.join(".") || "form"] = i.message;
  return out;
}
