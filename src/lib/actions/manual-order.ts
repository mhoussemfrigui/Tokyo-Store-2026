"use server";

import { z } from "zod";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { cart_items, carts } from "@/modules/cart/schema";
import { cartService } from "@/modules/cart/service";
import { productService } from "@/modules/catalog/product/service";
import { productQueries } from "@/modules/catalog/product";
import { promotionService } from "@/modules/promotion";
import { orderService } from "@/modules/order/service";
import { authService } from "@/modules/auth/service";
import { workflows } from "@/workflows";
import { orderFieldTooLongMessage } from "@/workflows/order/place-order";
import { requirePermissionAny } from "@/lib/auth/session";
import { ORDER_FIELD_MAX } from "@/lib/checkout/order-field-max";
import { ORDER_SOURCE_VALUES, type OrderSource } from "@/lib/order/order-source";
import { type ActionState } from "@/lib/actions/types";

/**
 * A REMOTE operator order may be created by a dedicated « Nouvelle commande »
 * operator (orders_new:create) OR by a full order manager (orders:manage). The
 * shared product-search / code-resolve accept the same set so such an operator
 * can build the order end-to-end.
 */
const ORDER_CREATE_GRANTS = [
  { module: "orders_new", action: "create" },
  { module: "orders", action: "manage" },
] as const;

/**
 * Operator-created ("manual") orders. The operator picks a customer + address +
 * line items + delivery, then records the settlement OFFLINE (cash / wire / COD).
 *
 * The order reuses placeOrderWorkflow verbatim — an ephemeral cart is built and
 * handed to it — so it gets the exact same guarantees as a web order: live-price
 * re-resolution, atomic stock decrement, snapshots, tax cascade, promo
 * redemption. Attributing the order to a customer account
 * (`userId`) works just like a self-checkout. For an up-front
 * channel (cash / bank_transfer) the order is then marked `paid`; COD stays
 * pending and settles at delivery.
 *
 * Actor split: the attributed customer drives user_id / per-user caps,
 * while the signed-in OPERATOR is recorded as the audit actor of the creation
 * (status history « Commande créée (saisie opérateur) », stock movements,
 * order.created) and of the →paid step — so every operator order, COD included,
 * is traceable to the staff member who placed it.
 */

// ── Product search (line-item picker) ────────────────────────────────────────
export type ManualOrderProductHit = {
  id: string;
  name: string;
  sku: string | null;
  priceCents: number;
  isVariable: boolean;
  variants: Array<{ id: string; label: string; priceCents: number }>;
};

export async function searchProductsForOrderAction(query: string): Promise<ManualOrderProductHit[]> {
  await requirePermissionAny(ORDER_CREATE_GRANTS);
  const q = query.trim();
  if (q.length < 2) return [];
  const { items } = await productService.listAdminPaged({ q, status: "published", pageSize: 12 });
  if (items.length === 0) return [];
  const variantsByProduct = await productQueries
    .listVariantsForProducts(items.map((p) => p.id))
    .catch(() => new Map());
  return items.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku ?? null,
    priceCents: p.price_cents,
    isVariable: p.product_type === "variable",
    variants: ((variantsByProduct.get(p.id) ?? []) as Array<{ id: string; label: string; price_cents: number }>).map(
      (v) => ({ id: v.id, label: v.label, priceCents: v.price_cents }),
    ),
  }));
}

// ── Create ───────────────────────────────────────────────────────────────────
// Free-text caps mirror the place-order schema (ORDER_FIELD_MAX) so an over-long
// field is refused here, naming the field + its cap.
const createManualOrderSchema = z.object({
  /** Attribute to a customer account — else guest. */
  userId: z.string().optional(),
  /** When no userId is given, attach to the account matching contactEmail. */
  attachByEmail: z.boolean().optional(),
  contactEmail: z.string().trim().max(ORDER_FIELD_MAX.email).email().or(z.literal("")),
  contactPhone: z.string().trim().max(ORDER_FIELD_MAX.phone).optional(),
  shipping: z.object({
    fullName: z.string().trim().min(1).max(ORDER_FIELD_MAX.name),
    streetLine1: z.string().trim().min(1).max(ORDER_FIELD_MAX.addressLine),
    streetLine2: z.string().trim().max(ORDER_FIELD_MAX.addressLine).optional(),
    city: z.string().trim().min(1).max(ORDER_FIELD_MAX.place),
    region: z.string().trim().max(ORDER_FIELD_MAX.place).optional(),
    postalCode: z.string().trim().max(ORDER_FIELD_MAX.postalCode).optional(),
    phone: z.string().trim().max(ORDER_FIELD_MAX.phone).optional(),
  }),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variantId: z.string().optional(),
        quantity: z.number().int().min(1),
      }),
    )
    .min(1),
  deliveryMethod: z.enum(["home_delivery", "drive_by_pickup", "in_store"]).default("home_delivery"),
  deliveryAgentId: z.string().uuid().optional(),
  pickupLocationId: z.string().uuid().optional(),
  promotionCode: z.string().trim().optional(),
  /** Offline settlement channel. cash/bank_transfer = paid now; cod = at delivery. */
  paymentChannel: z.enum(["cash", "bank_transfer", "cod"]),
  paymentReference: z.string().trim().optional(),
  notes: z.string().trim().max(ORDER_FIELD_MAX.notes).optional(),
  /** Marketing source — where the order came from (Facebook / phone …). An
   *  unknown value is dropped server-side (see below), so a stale client can't
   *  write a junk source. Optional: the operator may leave it unspecified. */
  source: z.string().trim().optional(),
});

export type CreateManualOrderInput = z.input<typeof createManualOrderSchema>;

const CHANNEL_LABELS: Record<string, string> = {
  cash: "Espèces (comptoir)",
  bank_transfer: "Virement bancaire",
  cod: "Paiement à la livraison",
};

/**
 * `warning` is set (alongside `ok: true` + `orderId`) when the order was created
 * but a follow-up step failed — today only the up-front « payée » transition —
 * so the UI can flag it instead of showing a plain success.
 */
export async function createManualOrderAction(
  input: CreateManualOrderInput,
): Promise<ActionState & { orderId?: string; warning?: string }> {
  const session = await requirePermissionAny(ORDER_CREATE_GRANTS);
  const parsed = createManualOrderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation",
      message:
        orderFieldTooLongMessage(parsed.error) ??
        "Champs invalides : vérifiez le client, l'adresse et les articles.",
    };
  }
  const d = parsed.data;

  // Marketing source — keep only a KNOWN value (shared list); anything else
  // (blank, or a stale/forged key) is dropped to NULL rather than stored raw.
  const source: OrderSource | null =
    d.source && (ORDER_SOURCE_VALUES as readonly string[]).includes(d.source)
      ? (d.source as OrderSource)
      : null;

  // Validate + price the lines from LIVE catalog rows (never trust the client).
  const productIds = [...new Set(d.lines.map((l) => l.productId))];
  const [products, variantsByProduct] = await Promise.all([
    productQueries.listProductsByIds(productIds),
    productQueries.listVariantsForProducts(productIds).catch(() => new Map()),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const variantById = new Map(
    ([...variantsByProduct.values()].flat() as Array<{ id: string; price_cents: number; product_id: string }>).map(
      (v) => [v.id, v],
    ),
  );
  for (const line of d.lines) {
    const product = productById.get(line.productId);
    if (!product || !product.is_published) {
      return { ok: false, error: "product_unavailable", message: "Un article sélectionné n'est plus disponible." };
    }
    if (product.product_type === "variable" && !line.variantId) {
      return { ok: false, error: "variant_required", message: `Choisissez une variante pour « ${product.name} ».` };
    }
    if (line.variantId) {
      const v = variantById.get(line.variantId);
      if (!v || v.product_id !== product.id) {
        return { ok: false, error: "variant_unavailable", message: `Variante invalide pour « ${product.name} ».` };
      }
    }
  }

  // Resolve an optional coupon code → promotionId (best-effort; an invalid /
  // expired code is dropped, the workflow re-validates anyway).
  let promotionId: string | undefined;
  if (d.promotionCode) {
    const promo = await promotionService.findLiveByCode(d.promotionCode).catch(() => null);
    promotionId = promo?.id;
  }

  // Attribute to a customer account when given; else guest. With
  // `attachByEmail`, resolve the account from the contact email instead. An
  // EXPLICIT userId that resolves to no account is refused rather than silently
  // downgraded to a guest order (the operator picked a customer — the sale must
  // not lose its account attribution without them knowing).
  let actorUserId: string | null = null;
  if (d.userId) {
    const user = await authService.findById(d.userId).catch(() => null);
    if (!user) {
      return {
        ok: false,
        error: "customer_not_found",
        message: "Compte client introuvable : rescannez le QR du client.",
      };
    }
    actorUserId = user.id;
  } else if (d.attachByEmail && d.contactEmail) {
    const user = await authService.findByEmail(d.contactEmail).catch(() => null);
    if (user) actorUserId = user.id;
  }

  // Build an ephemeral guest cart (user_id NULL so it can't collide with the
  // customer's real cart via carts_user_unique) and seed the chosen lines.
  const cart = await cartService.createCart({
    token: `manual_${session.user.id}_${randomBytes(8).toString("hex")}`,
  } as never);
  // MERGE duplicate lines before insert: the form appends a fresh line every time
  // the operator adds/scans an item, so the same (product, variant) can appear more
  // than once (scanning two identical watches, or clicking « Ajouter » twice). A 1:1
  // map here would emit two rows with the same (cart_id, product_id, variant_id) and
  // trip cart_items_cart_product_unique mid-INSERT — an uncaught duplicate-key error
  // the form doesn't surface (silent failure, no order created). Collapse by
  // (product, variant) summing quantity — like the storefront cart does. ON CONFLICT
  // can't be used here (a multi-row INSERT can't touch the same conflict row twice).
  const mergedLines = new Map<
    string,
    { productId: string; variantId: string; quantity: number; unitPriceCents: number }
  >();
  for (const line of d.lines) {
    const variantId = line.variantId ?? "";
    const key = `${line.productId}::${variantId}`;
    const existing = mergedLines.get(key);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      const product = productById.get(line.productId)!;
      const variant = line.variantId ? variantById.get(line.variantId) : undefined;
      mergedLines.set(key, {
        productId: line.productId,
        variantId,
        quantity: line.quantity,
        unitPriceCents: variant ? variant.price_cents : product.price_cents,
      });
    }
  }
  await db.insert(cart_items).values(
    [...mergedLines.values()].map((line) => ({
      cart_id: cart.id,
      product_id: line.productId,
      variant_id: line.variantId,
      quantity: line.quantity,
      unit_price_cents: line.unitPriceCents,
    })),
  );

  // Place the order through the shared workflow (atomic stock/coins/snapshots).
  const placed = await workflows.order.place(
    {
      cartId: cart.id,
      contactEmail: d.contactEmail,
      contactPhone: d.contactPhone,
      shipping: {
        fullName: d.shipping.fullName,
        streetLine1: d.shipping.streetLine1,
        streetLine2: d.shipping.streetLine2,
        city: d.shipping.city,
        region: d.shipping.region,
        postalCode: d.shipping.postalCode,
        country: "TN",
        phone: d.shipping.phone ?? d.contactPhone,
      },
      deliveryMethod: d.deliveryMethod,
      deliveryAgentId: d.deliveryAgentId,
      pickupLocationId: d.pickupLocationId,
      promotionId,
      paymentMethod: d.paymentChannel,
      notes: d.notes,
    },
    // `actorUserId` = the attributed CUSTOMER (user_id, per-user caps);
    // `operatorUserId` = the staff member creating it, recorded as the audit actor
    // (status history, stock movements, order.created) — so a COD/unpaid operator
    // order is still traceable to whoever placed it. `channel: operator` tags the origin.
    { actorUserId, operatorUserId: session.user.id, channel: "operator", source },
  );

  // Dispose the ephemeral cart ENTIRELY (items + the row), on BOTH success and
  // failure. placeOrderWorkflow only clears items on success, cartService.clear
  // never removes the `carts` row, and this `manual_`-token cart is NOT covered by
  // the `qb-%` retention purge — so without this the row leaks on every POS/manual
  // sale (mirrors the ERP create-from-lines disposal).
  await db.delete(cart_items).where(eq(cart_items.cart_id, cart.id)).catch(() => {});
  await db.delete(carts).where(eq(carts.id, cart.id)).catch(() => {});

  if (!placed.ok) {
    return { ok: false, error: placed.error, message: placed.message };
  }

  // Mark the order operator-CONFIRMED (stamp confirmed_at) — an operator entered it,
  // so it is an accepted order, NOT an abandoned online checkout. Without this a
  // manual order stays pending+unconfirmed and the abandoned-orders sweep would
  // auto-cancel + restock it after 48h: a COD manual order (which stays pending by
  // design) on EVERY occasion, and a cash/bank_transfer order whenever the follow-up
  // →paid step below fails. Stamped silently (no order.confirmed event / customer
  // email — manual orders don't send one today); idempotent, so a later →paid won't
  // re-stamp. Best-effort like the cart disposal above — the sweep is only a 48h
  // backstop, so a rare stamp failure doesn't lose the just-created order.
  await db
    .transaction((tx) => orderService.confirmOrderInTx(tx, placed.data.orderId, session.user.id))
    .catch(() => {});

  // Record the offline settlement. cash / bank_transfer are paid NOW → mark
  // `paid` (stamps paid_at + emits order.paid). COD settles at
  // delivery, so it stays pending.
  const channelLabel = CHANNEL_LABELS[d.paymentChannel] ?? d.paymentChannel;
  const reference = [channelLabel, d.paymentReference].filter(Boolean).join(" — ");
  if (d.paymentChannel !== "cod") {
    const paid = await workflows.order.transitionStatus(
      { orderId: placed.data.orderId, toStatus: "paid", paymentReference: reference },
      { actorUserId: session.user.id },
    );
    // The order EXISTS (stock claimed) even when the →paid step fails, so this
    // stays a success carrying the orderId — returning ok:false would invite the
    // operator to re-create the sale (duplicate order + double stock claim). But
    // it must not claim « payée »: an unpaid pending order is later swept as
    // abandoned, so tell them to record the payment from the order page.
    if (!paid.ok) {
      const warning = `Commande ${placed.data.orderNumber} créée mais NON marquée payée (${paid.message}) — enregistrez le règlement depuis la fiche commande.`;
      return { ok: true, message: warning, warning, orderId: placed.data.orderId };
    }
  }

  return {
    ok: true,
    message: `Commande ${placed.data.orderNumber} créée (${channelLabel}).`,
    orderId: placed.data.orderId,
  };
}
