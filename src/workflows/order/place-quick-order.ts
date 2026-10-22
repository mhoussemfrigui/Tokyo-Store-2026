import "server-only";

import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { carts } from "@/modules/cart/schema";
import { cartService } from "@/modules/cart/service";
import { productService } from "@/modules/catalog/product/service";
import { findVariantById } from "@/modules/catalog/product/queries";
import { promotionService } from "@/modules/promotion";
import { discountableSubtotalCents } from "@/lib/promotions/discountable-subtotal";
import { resolvePromotionalUnitPriceCents } from "@/lib/cart/pricing";
import { resolveCartPromotionFromCandidates } from "@/lib/cart/coupon";
import { getQuickBuyConfig } from "@/lib/checkout/quick-buy-config";
import { ORDER_FIELD_MAX } from "@/lib/checkout/order-field-max";
import { fail, ok, workflow } from "../shared";
import { orderValidationMessage, placeOrderWorkflow } from "./place-order";

/**
 * Quick-buy order placement: skip the cart entirely.
 *
 * Stages an ephemeral cart for a single product, calls the standard
 * `placeOrderWorkflow`, and lets that flow drive the rest (snapshotting,
 * tax/shipping, event emission). The user's real cart is untouched.
 *
 * Using a real `Cart` row keeps the order workflow's contract simple —
 * one input shape, one validation path — at the cost of a short-lived
 * row that a periodic sweep can prune later if needed (token starts with
 * `qb-` so we can identify them).
 *
 * IDEMPOTENCY: when the buy form sends its per-mount `idempotencyKey`, the
 * ephemeral cart token is `qb-<key>` (carts.token is UNIQUE). A replayed or
 * double-fired submit then collides on that token and is refused — never a
 * second order. The cart row of a PLACED order is kept (its lines were claimed
 * by the order) as the replay guard until the ephemeral-cart retention purge; a
 * FAILED attempt's cart is disposed so the shopper can simply retry.
 */

/** Refusal for a replayed express submit (same form, already sent). */
export const QUICK_ORDER_REPLAY_MESSAGE =
  "Commande déjà enregistrée. Rechargez la page pour passer une nouvelle commande.";
export const placeQuickOrderSchema = z.object({
  productId: z.string().uuid(),
  /** Selected variant for a variable product. Omit/null for a simple one. */
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(99).default(1),
  /** Chosen Tokyo Care plan (optional). Re-validated + re-priced by place-order;
   *  an ineligible/unoffered plan is silently dropped (never trusted). */
  carePlanId: z.string().uuid().nullable().optional(),
  // Email + city are OPTIONAL: the admin can hide these express-form fields
  // (the default), in which case the client submits "". The required-when-shown
  // enforcement happens in the workflow body against the live quick-buy config.
  // Length caps shared with the place-order schema (lib/checkout/order-field-max).
  contactEmail: z.string().trim().max(ORDER_FIELD_MAX.email).email().or(z.literal("")),
  contactPhone: z.string().max(ORDER_FIELD_MAX.phone).optional(),
  shipping: z.object({
    fullName: z.string().min(1).max(ORDER_FIELD_MAX.name),
    streetLine1: z.string().min(1).max(ORDER_FIELD_MAX.addressLine),
    streetLine2: z.string().max(ORDER_FIELD_MAX.addressLine).optional(),
    city: z.string().max(ORDER_FIELD_MAX.place),
    region: z.string().max(ORDER_FIELD_MAX.place).optional(),
    postalCode: z.string().max(ORDER_FIELD_MAX.postalCode).optional(),
    country: z.string().length(2).default("TN"),
    phone: z.string().max(ORDER_FIELD_MAX.phone).optional(),
  }),
  paymentMethod: z.enum(["flouci", "clictopay", "cod", "card_stripe"]).optional(),
  notes: z.string().max(ORDER_FIELD_MAX.notes).optional(),
  /**
   * Chosen delivery method + the (untrusted) selected agent / pickup location,
   * forwarded verbatim to `placeOrderWorkflow` which re-validates and prices
   * them authoritatively. Defaults to `home_delivery` (legacy flat-rate path).
   */
  deliveryMethod: z
    .enum(["home_delivery", "drive_by_pickup", "in_store"])
    .default("home_delivery"),
  deliveryAgentId: z.string().uuid().optional(),
  pickupLocationId: z.string().uuid().optional(),
  /**
   * Promotion-id candidates from the storefront cookie jar, in the cart
   * resolver's order (`gz.coupon` code first, then the `gz.promo` URL promo).
   * The workflow forwards the FIRST one eligible for this line against the live
   * row + computed subtotal — a stale / out-of-window / non-qualifying id is
   * skipped for the next (never charged at).
   */
  promotionCandidates: z
    .array(z.object({ id: z.string().uuid(), source: z.enum(["code", "url", "auto"]) }))
    .max(2)
    .optional(),
  /**
   * Client idempotency key (a UUID the buy form generates once per mount). When
   * present, the ephemeral cart token is derived from it so a replay of the same
   * submit is refused (`conflict`) instead of placing a duplicate order.
   */
  idempotencyKey: z.string().uuid().optional(),
});

export const placeQuickOrderWorkflow = workflow<
  [z.input<typeof placeQuickOrderSchema>, { actorUserId?: string | null }],
  {
    orderId: string;
    orderNumber: string;
    /** The promotion this order actually REDEEMED (a redemption row was burned),
     *  or null — lets the caller clear a code cookie only when it was used. */
    redeemedPromotionId: string | null;
  }
>("order.place_quick", async (input, { actorUserId }) => {
  const parsed = placeQuickOrderSchema.safeParse(input);
  if (!parsed.success) return fail("validation", orderValidationMessage(parsed.error));
  const d = parsed.data;

  // Enforce the admin's quick-buy config server-side. The master switch first:
  // the storefront only hides the express button when it is off, so a scripted
  // submit (which also skips the full checkout's email / region requirements)
  // must be refused here. Then the field config — the client form already marks
  // these required, but a tampered/automated submit could omit a field the admin
  // opted to require, so we re-check against the live config.
  const config = await getQuickBuyConfig();
  if (!config.enabled) {
    return fail(
      "disabled",
      "L'achat express est désactivé. Ajoutez le produit au panier pour commander.",
    );
  }
  const fieldErrors: Record<string, string> = {};
  if (config.fields.email.enabled && config.fields.email.required && !d.contactEmail) {
    fieldErrors.contactEmail = "Email requis.";
  }
  if (config.fields.phone.enabled && config.fields.phone.required && !d.contactPhone) {
    fieldErrors.phone = "Téléphone requis.";
  }
  if (config.fields.city.enabled && !d.shipping.city) {
    fieldErrors.city = "Ville requise.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return fail("validation", "Validation échouée", fieldErrors);
  }

  const product = await productService.findById(d.productId);
  if (!product || !product.is_published) {
    return fail("not_found", "Produit introuvable.");
  }

  // A selected variant governs price + stock (same contract as add-to-cart).
  let variantId = "";
  let unitPriceCents = product.price_cents;
  if (d.variantId) {
    const variant = await findVariantById(d.variantId);
    if (!variant || variant.product_id !== product.id) {
      return fail("not_found", "Variante introuvable.");
    }
    if (!variant.in_stock) {
      return fail("out_of_stock", "Cette variante n'est plus disponible.");
    }
    variantId = variant.id;
    unitPriceCents = variant.price_cents;
  }

  // Catalogue base (pre auto-promo) for this single line — drives the scoped
  // coupon's exclude-already-on-sale rule below.
  const lineBaseCents = unitPriceCents;
  // Bake the active auto-promotion (product/category/brand scope) into the
  // unit price — same contract as add-to-cart, so the quick-buy charge matches
  // the PDP. The cart-promo block below forwards the id; place-order recomputes.
  unitPriceCents = await resolvePromotionalUnitPriceCents(product.id, unitPriceCents, variantId || null);

  const subtotalCents = unitPriceCents * d.quantity;

  // Resolve the candidate promotions against their live rows so we only forward
  // a `promotionId` the order layer will actually honour — through the SAME
  // resolver the cart pages use (`resolveCartPromotionFromCandidates` → the
  // shared `evaluateCouponEligibility`: window, min-cart, global + per-user caps,
  // scope, targeting). Candidates are tried in order (code, then URL promo), the
  // first eligible one wins — an ineligible code no longer hides an eligible URL
  // promo. The downstream `placeOrderWorkflow` re-runs this authoritatively and
  // recomputes the discount, so we forward only the id (no discount-cents). A
  // SCOPED coupon (product/category/brand code) is checked against THIS single
  // line so we don't forward an id that won't match.
  const applied = await resolveCartPromotionFromCandidates(d.promotionCandidates ?? [], {
    subtotalCents,
    userId: actorUserId ?? null,
    discountableSubtotalCents: discountableSubtotalCents([
      {
        unitCents: unitPriceCents,
        baseCents: lineBaseCents,
        quantity: d.quantity,
      },
    ]),
    lines: [
      {
        productId: product.id,
        lineCents: subtotalCents,
        baseLineCents: lineBaseCents * d.quantity,
      },
    ],
  });
  const promotionId = applied?.promotionId;

  // Build a fresh ephemeral cart for this transaction (staged LAST, right
  // before placement, so an earlier refusal never leaves one behind). `qb-`
  // prefix marks these for the retention sweep. With an idempotency key the
  // token is deterministic, so a replay of the same submit collides on
  // carts.token (UNIQUE) and is refused instead of placing a second order.
  const cartToken = d.idempotencyKey
    ? `qb-${d.idempotencyKey.toLowerCase()}`
    : `qb-${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let tmpCart: Awaited<ReturnType<typeof cartService.createCart>>;
  try {
    tmpCart = await cartService.createCart({ user_id: null, token: cartToken });
  } catch (err) {
    if (d.idempotencyKey && isUniqueViolation(err)) {
      return fail("conflict", QUICK_ORDER_REPLAY_MESSAGE);
    }
    throw err;
  }
  try {
    await cartService.upsertItem({
      cart_id: tmpCart.id,
      product_id: product.id,
      variant_id: variantId,
      quantity: d.quantity,
      unit_price_cents: unitPriceCents,
      // The chosen protection plan rides on the staged line; place-order resolves it.
      care_plan_id: d.carePlanId ?? null,
    });
  } catch (err) {
    await disposeEphemeralCart(tmpCart.id);
    throw err;
  }

  const placed = await placeOrderWorkflow(
    {
      cartId: tmpCart.id,
      contactEmail: d.contactEmail,
      contactPhone: d.contactPhone,
      shipping: d.shipping,
      deliveryMethod: d.deliveryMethod,
      deliveryAgentId: d.deliveryAgentId,
      pickupLocationId: d.pickupLocationId,
      promotionId,
      paymentMethod: d.paymentMethod ?? "cod",
      notes: d.notes,
    },
    // « express » is INDISTINGUISHABLE from storefront at the insert (same
    // { actorUserId } shape), so it must be tagged here.
    { actorUserId: actorUserId ?? null, channel: "express" },
  );
  if (!placed.ok) {
    // Nothing was ordered (the placement rolled back, its cart line is intact):
    // drop the ephemeral cart so a retry with the SAME idempotency key can stage
    // a fresh one. Kept when its line is gone — the order committed (a failure
    // after commit), and the row must keep guarding against a replay.
    const lines = await cartService.listItems(tmpCart.id).catch(() => null);
    if (lines && lines.length > 0) await disposeEphemeralCart(tmpCart.id);
    return placed;
  }

  // Did the order actually REDEEM the forwarded promotion? place-order may still
  // soft-drop it, or apply it for no benefit (no redemption burned). Only a real
  // redemption row counts. Best-effort: a lookup failure reports none (the caller
  // then just keeps the code cookie).
  let redeemedPromotionId: string | null = null;
  if (promotionId) {
    const redemptions = await promotionService
      .listRedemptionsForOrder(placed.data.orderId)
      .catch(() => []);
    if (redemptions.some((r) => r.promotion_id === promotionId)) redeemedPromotionId = promotionId;
  }
  return ok({
    orderId: placed.data.orderId,
    orderNumber: placed.data.orderNumber,
    redeemedPromotionId,
  });
});

/** Best-effort removal of an unplaced ephemeral cart (its lines cascade). */
async function disposeEphemeralCart(cartId: string): Promise<void> {
  await db
    .delete(carts)
    .where(eq(carts.id, cartId))
    .catch(() => {});
}
