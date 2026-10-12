import "server-only";

import { z } from "zod";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { carts, cart_items } from "@/modules/cart/schema";
import { cartService } from "@/modules/cart/service";
import { productService } from "@/modules/catalog/product/service";
import { findVariantById, findVariantBySku } from "@/modules/catalog/product/queries";
import { promotionService } from "@/modules/promotion";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { orderService } from "@/modules/order/service";
import { ORDER_FIELD_MAX } from "@/lib/checkout/order-field-max";
import { isUuid } from "@/lib/utils/uuid";
import { fail, flattenZodError, ok, workflow } from "../shared";
import { orderFieldTooLongMessage, placeOrderWorkflow } from "./place-order";
import { transitionOrderStatusWorkflow } from "./transition-status";

/**
 * ERP / POS ORDER PUSH — create an order from a line array addressed by product
 * REFERENCE (sku/gtin/external_ref/id + variant), the API sibling of the admin
 * `createManualOrderAction`. It resolves + LIVE-prices the lines, builds an
 * ephemeral guest cart, and runs the SAME `placeOrderWorkflow` a web checkout
 * does (atomic stock decrement, snapshots, tax cascade, promo, loyalty), then
 * records the offline settlement (cash/bank_transfer → paid; cod → pending) and
 * stamps the ERP `externalRef`. Actor for loyalty = the resolved customer (via
 * userId / customerId / customerExternalRef / attachByEmail); settlement actor =
 * the API key owner.
 */

const lineSchema = z
  .object({
    productId: z.string().optional(),
    sku: z.string().trim().optional(),
    gtin: z.string().trim().optional(),
    externalRef: z.string().trim().optional(),
    variantId: z.string().optional(),
    variantSku: z.string().trim().optional(),
    quantity: z.number().int().min(1),
  })
  .refine((l) => l.productId || l.sku || l.gtin || l.externalRef || l.variantId || l.variantSku, {
    message: "Chaque ligne exige une référence produit (productId|sku|gtin|externalRef|variantId|variantSku).",
  });

// Free-text caps mirror the place-order schema (ORDER_FIELD_MAX), so an
// over-long field is refused up front with its name + cap (and a fieldErrors
// entry) instead of surfacing later as a vaguer placement refusal.
const createOrderSchema = z.object({
  externalRef: z.string().trim().max(200).optional(),
  // The customer to attach the sale to (loyalty earn), by ONE of: the storefront
  // ACCOUNT id (`userId`, as the order / loyalty feeds + ApiCustomer.userId carry
  // it), the customer PROFILE (`customerId` — the `id` the customers API returns,
  // or its externalRef), or the profile's ERP `customerExternalRef`.
  userId: z.string().trim().optional(),
  customerId: z.string().trim().max(200).optional(),
  customerExternalRef: z.string().trim().max(200).optional(),
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
  lines: z.array(lineSchema).min(1),
  deliveryMethod: z.enum(["home_delivery", "drive_by_pickup", "in_store"]).default("home_delivery"),
  deliveryAgentId: z.string().uuid().optional(),
  pickupLocationId: z.string().uuid().optional(),
  promotionCode: z.string().trim().optional(),
  paymentChannel: z.enum(["cash", "bank_transfer", "cod"]),
  paymentReference: z.string().trim().optional(),
  notes: z.string().trim().max(ORDER_FIELD_MAX.notes).optional(),
});

type ResolvedLine = { productId: string; variantId: string | null; unitPriceCents: number; quantity: number };

const CHANNEL_LABELS: Record<string, string> = {
  cash: "Espèces (comptoir)",
  bank_transfer: "Virement bancaire",
  cod: "Paiement à la livraison",
};

export const createOrderFromLinesWorkflow = workflow<
  [z.input<typeof createOrderSchema>, { actorUserId: string }],
  { orderId: string; orderNumber: string; externalRef: string | null }
>("order.create_from_lines", async (input, { actorUserId }) => {
  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) {
    // Keep the French summary, but tell the integrator WHICH field failed
    // (fieldErrors keyed by top-level field: contactEmail, shipping, lines, …);
    // an over-long text field is named with its cap.
    return fail(
      "validation",
      orderFieldTooLongMessage(parsed.error) ??
        "Commande invalide : vérifiez le client, l'adresse et les articles.",
      flattenZodError(parsed.error),
    );
  }
  const d = parsed.data;

  // Reject a duplicate externalRef up front (clean 409, not a place-then-fail).
  if (d.externalRef) {
    const clash = await orderService.findByExternalRef(d.externalRef).catch(() => null);
    if (clash) return fail("conflict", "externalRef déjà utilisé par une autre commande.");
  }

  // Resolve + LIVE-price every line (never trust a pushed price).
  const resolved: ResolvedLine[] = [];
  for (const line of d.lines) {
    // A variant reference resolves the exact variant + its parent product.
    if (line.variantId || line.variantSku) {
      const v = line.variantId
        ? await findVariantById(line.variantId).catch(() => null)
        : await findVariantBySku(line.variantSku!).catch(() => null);
      if (!v) return fail("validation", `Variante introuvable pour une ligne (${line.variantSku ?? line.variantId}).`);
      const p = await productService.findById(v.product_id).catch(() => null);
      if (!p || !p.is_published) return fail("validation", "Un article d'une ligne n'est pas disponible.");
      resolved.push({ productId: p.id, variantId: v.id, unitPriceCents: v.price_cents, quantity: line.quantity });
      continue;
    }
    // Product-level reference, most-specific key first.
    const p =
      (line.productId ? await productService.findById(line.productId).catch(() => null) : null) ??
      (line.sku ? await productService.findBySku(line.sku).catch(() => null) : null) ??
      (line.gtin ? await productService.findByGtin(line.gtin).catch(() => null) : null) ??
      (line.externalRef ? await productService.findByExternalRef(line.externalRef).catch(() => null) : null);
    if (!p || !p.is_published) return fail("validation", "Un article d'une ligne est introuvable ou non publié.");
    if (p.product_type === "variable") {
      return fail("validation", `« ${p.name} » exige une variante (variantId|variantSku) sur la ligne.`);
    }
    resolved.push({ productId: p.id, variantId: null, unitPriceCents: p.price_cents, quantity: line.quantity });
  }

  // Two lines resolving to the SAME (product, variant) — the same SKU scanned
  // twice on a POS receipt, or one line by sku + one by externalRef — become ONE
  // cart line with the summed quantity. cart_items is unique on (cart, product,
  // variant), so inserting them separately raised a 23505 and rejected a
  // legitimate order with a field-less 409. Per-product min/max quantity and
  // stock are then enforced by placeOrderWorkflow on the merged total.
  const merged = new Map<string, ResolvedLine>();
  for (const l of resolved) {
    const key = `${l.productId}:${l.variantId ?? ""}`;
    const prev = merged.get(key);
    if (prev) prev.quantity += l.quantity;
    else merged.set(key, { ...l });
  }

  // Optional coupon code → promotionId (the workflow re-validates eligibility).
  // An unknown / inactive / expired code is REFUSED — an unattended ERP must not
  // get a silent full-price order it can only detect by diffing discountCents.
  let promotionId: string | undefined;
  if (d.promotionCode) {
    const promo = await promotionService.findLiveByCode(d.promotionCode);
    if (!promo) {
      return fail("validation", "Code promo invalide ou expiré.", {
        promotionCode: "Code promo invalide ou expiré.",
      });
    }
    promotionId = promo.id;
  }

  // Attribute to a customer account (earns loyalty), else guest. An EXPLICIT
  // customer identifier that resolves to no account is REFUSED — it used to
  // silently place a guest order (no loyalty earn) behind a 201, which an
  // unattended ERP can't notice. `attachByEmail` stays best-effort (it is an
  // opportunistic match, not an identifier).
  const idFields = (["userId", "customerId", "customerExternalRef"] as const).filter((k) => Boolean(d[k]));
  if (idFields.length > 1) {
    const msg = "Un seul identifiant client à la fois : userId, customerId ou customerExternalRef.";
    return fail("validation", msg, Object.fromEntries(idFields.map((k) => [k, msg])));
  }
  // (No `.catch → null` on these lookups: an infra error must surface as a
  // retryable 500, not read as « client introuvable ».)
  let customerUserId: string | null = null;
  if (d.userId) {
    const user = await authService.findById(d.userId);
    if (!user) {
      const msg = "Client introuvable : aucun compte pour ce userId.";
      return fail("validation", msg, { userId: msg });
    }
    customerUserId = user.id;
  } else if (d.customerId || d.customerExternalRef) {
    const field = d.customerId ? "customerId" : "customerExternalRef";
    // `customerId` = the profile uuid, falling back to its externalRef (like the
    // `/api/customers/[id]` segment); `customerExternalRef` = the ERP ref only.
    const ref = (d.customerId || d.customerExternalRef)!;
    const byId = d.customerId && isUuid(ref) ? await customerService.findProfileById(ref) : null;
    const profile = byId ?? (await customerService.findByExternalRef(ref));
    if (!profile) {
      const msg = `Client introuvable (${field}).`;
      return fail("validation", msg, { [field]: msg });
    }
    const link = await customerUserLink.findByProfileId(profile.id);
    if (!link) {
      // A standalone (ERP-created) profile has no storefront account, so nothing
      // can carry the sale's loyalty — say so rather than downgrade to a guest.
      const msg =
        "Ce client n'a pas de compte en ligne (userId nul) : la commande ne peut pas lui être rattachée. Omettez l'identifiant client pour une commande invité.";
      return fail("validation", msg, { [field]: msg });
    }
    customerUserId = link.user_id;
  } else if (d.attachByEmail && d.contactEmail) {
    const user = await authService.findByEmail(d.contactEmail).catch(() => null);
    if (user) customerUserId = user.id;
  }

  // Ephemeral guest cart (user_id NULL → can't collide with a real cart).
  const cart = await cartService.createCart({
    token: `erp_${actorUserId}_${randomBytes(8).toString("hex")}`,
  } as never);
  // Dispose the ephemeral cart ENTIRELY (items + the row) in a `finally`, so a
  // throw between creation and placement (item insert, placement crash) can't
  // leak it. placeOrderWorkflow only clears items on success and
  // cartService.clear never removes the carts row, and this `erp_`-token cart is
  // NOT covered by the qb-% retention purge — so it would otherwise leak forever.
  let placed: Awaited<ReturnType<typeof placeOrderWorkflow>>;
  try {
    await db.insert(cart_items).values(
      [...merged.values()].map((l) => ({
        cart_id: cart.id,
        product_id: l.productId,
        variant_id: l.variantId ?? "",
        quantity: l.quantity,
        unit_price_cents: l.unitPriceCents,
      })),
    );

    placed = await placeOrderWorkflow(
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
        // Written on the order row INSIDE placeOrderWorkflow's transaction, so the
        // unique index is the race backstop (no orphaned/duplicate order on a
        // concurrent same-ref push) — not a best-effort post-place stamp.
        externalRef: d.externalRef,
      },
      // `deliveryChannel: operator` bypasses the storefront delivery toggles (a
      // pickup-only e-shop still ships ERP orders); `channel: erp` tags the sales
      // origin (the ERP link ref lives in external_ref). Distinct concerns.
      { actorUserId: customerUserId, deliveryChannel: "operator", channel: "erp" },
    );
  } finally {
    await db.delete(cart_items).where(eq(cart_items.cart_id, cart.id)).catch(() => {});
    await db.delete(carts).where(eq(carts.id, cart.id)).catch(() => {});
  }

  if (!placed.ok) {
    return fail(placed.error, placed.message, placed.fieldErrors);
  }

  // Mark the pushed order operator-CONFIRMED (stamp confirmed_at) — an API/ERP push is a
  // deliberately-submitted, accepted order, NOT an abandoned online checkout. Without this
  // an API-created COD order with no externalRef stays pending+unconfirmed and the
  // abandoned-orders sweep would auto-cancel + restock it after 48 h (external_ref is the
  // only other sweep exemption, and the route does not require one). Mirrors
  // createManualOrderAction: silent (no order.confirmed event / customer email),
  // idempotent, best-effort (the sweep is only a 48 h backstop).
  await db
    .transaction((tx) => orderService.confirmOrderInTx(tx, placed.data.orderId, actorUserId))
    .catch(() => {});

  // Offline settlement: cash / bank_transfer are paid NOW; COD settles at delivery.
  const channelLabel = CHANNEL_LABELS[d.paymentChannel] ?? d.paymentChannel;
  if (d.paymentChannel !== "cod") {
    const reference = [channelLabel, d.paymentReference].filter(Boolean).join(" — ");
    const settled = await transitionOrderStatusWorkflow(
      { orderId: placed.data.orderId, toStatus: "paid", paymentReference: reference },
      { actorUserId },
    );
    // The order IS placed + ERP-linked; only the offline settlement transition
    // failed. Don't fail the push (that would strand a real, stock-decremented
    // order) — surface it so an admin/reconcile can settle. The response returns
    // the fresh order, whose status=pending / paid_at=null makes the gap visible.
    if (!settled.ok) {
      console.error(
        `[order.create_from_lines] settlement to 'paid' failed for ${placed.data.orderNumber} ` +
          `(${d.paymentChannel}): ${settled.error} — order left pending`,
      );
    }
  }

  return ok({
    orderId: placed.data.orderId,
    orderNumber: placed.data.orderNumber,
    externalRef: d.externalRef ?? null,
  });
});
