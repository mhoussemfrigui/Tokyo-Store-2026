import "server-only";

import { z } from "zod";
import { and, eq, gte, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { productQueries } from "@/modules/catalog/product";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { productMediaLink, productCategoryLinks } from "@/associations/catalog.service";
import { loadCategoryChains } from "@/lib/catalog/category-chain";
import { mediaQueries } from "@/modules/media";
import { resolveMediaThumbUrl } from "@/modules/media/url-resolver";
import {
  categoryWarrantyFromChain,
  getDefaultWarranty,
  resolveWarranty,
} from "@/lib/warranty";
import {
  categoryChainTaxBps,
  computeTaxCents,
  computeCareTaxCents,
  getTaxConfigStrict,
  getCareTaxConfigStrict,
  resolveTaxRateBps,
} from "@/lib/tax";
import { buildCareConfig } from "@/lib/care/config";
import { resolveOfferedCareForLines } from "@/lib/care/resolve-server";
import type { CarePlanRow } from "@/modules/catalog/care/schema";
import { taxQueries } from "@/modules/tax";
import { orderService } from "@/modules/order/service";
import { findOrderByNumber } from "@/modules/order/queries";
import { order_status_history, type OrderChannel } from "@/modules/order/schema";
import { CART_LINE_QTY_MAX, cartService } from "@/modules/cart/service";
import {
  promotionService,
  resolveLivePromotionRowsForProducts,
  rowsForLineVariant,
  resolveProductDiscount,
} from "@/modules/promotion";
import { customerUserLink } from "@/associations/customer-user.service";
import { customerService } from "@/modules/customer/service";
import {
  COUPON_HARD_FAIL_REASONS,
  evaluateCouponEligibility,
} from "@/lib/promotions/coupon-eligibility";
import { discountableSubtotalCents } from "@/lib/promotions/discountable-subtotal";
import { aggregatePurchaseLimitViolations } from "@/lib/cart/purchase-limits";
import { resolveDelivery } from "@/lib/checkout/delivery";
import { ORDER_FIELD_MAX } from "@/lib/checkout/order-field-max";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { formatMoneyExact } from "@/lib/price";
import { getActiveCurrency } from "@/lib/currency/active";
import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { emitProductStockCacheBust } from "@/lib/catalog/product-cache-bust";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import { resolveLowStockConfig, classifyStockCrossing } from "@/lib/inventory/low-stock";
import { availableStock, isActivePreorder } from "@/lib/inventory/preorder";
import { stockReservationService } from "@/modules/stock-reservation/service";
import { stockMovementService } from "@/modules/stock-movement";
import { fail, ok, workflow } from "../shared";

/**
 * Place an order from a cart.
 *
 * Reads run up front (live product/variant rows instead of the cached cart
 * price, auto-promo rows, tax + delivery config); a single transaction then
 * covers every write: CLAIM the cart first (row lock + delete its lines with
 * RETURNING — the idempotency guard against a double submit), insert order +
 * item snapshots + initial "pending" status-history row, atomically decrement
 * tracked stock, and bump/log the coupon redemption. `order.created` is emitted
 * after commit. Product fields are snapshotted into order_items so later catalog
 * edits don't change historical orders.
 *
 * Payment is NOT processed here. The order's status becomes `paid` only
 * after a payment webhook confirms — handled by `transitionOrderStatus`.
 */

export const placeOrderSchema = z.object({
  cartId: z.string().uuid(),
  // Email is OPTIONAL for the express/quick-buy flow: the admin can disable the
  // field (rider confirms by phone), in which case the form submits "". Accept a
  // valid address OR an empty string; the column is NOT NULL so "" is the
  // "no email provided" sentinel for a phone-only guest order. The quick-buy
  // workflow enforces the admin's "email required" toggle server-side.
  contactEmail: z.string().trim().max(ORDER_FIELD_MAX.email).email().or(z.literal("")),
  contactPhone: z.string().max(ORDER_FIELD_MAX.phone).optional(),
  shipping: z.object({
    fullName: z.string().min(1).max(ORDER_FIELD_MAX.name),
    streetLine1: z.string().min(1).max(ORDER_FIELD_MAX.addressLine),
    streetLine2: z.string().max(ORDER_FIELD_MAX.addressLine).optional(),
    // Optional for the same reason as email — the express form can hide "Ville"
    // (rider confirms by phone). "" is the no-city sentinel (column is NOT NULL).
    city: z.string().max(ORDER_FIELD_MAX.place),
    region: z.string().max(ORDER_FIELD_MAX.place).optional(),
    postalCode: z.string().max(ORDER_FIELD_MAX.postalCode).optional(),
    country: z.string().length(2).default("TN"),
    phone: z.string().max(ORDER_FIELD_MAX.phone).optional(),
    /**
     * The saved address the signed-in shopper PICKED at checkout (if any). When
     * present + owned, the post-commit auto-save UPDATES that row in place
     * instead of inserting a duplicate — so editing a picked address edits it,
     * rather than piling a near-identical copy on top. Untrusted: ownership is
     * re-verified server-side before any write.
     */
    selectedAddressId: z.string().uuid().optional(),
  }),
  /**
   * Chosen delivery method + the (untrusted) selected agent / pickup location.
   * `resolveDelivery` re-validates these against the live config + DB rows and
   * computes the AUTHORITATIVE fee + snapshot; a disabled method or a stale /
   * invalid pickup point is REFUSED (`delivery_unavailable`) — never silently
   * re-routed to home delivery. The method toggles only bind a storefront order:
   * an operator / ERP placement (see the `deliveryChannel` context) skips them
   * but its agent / pickup point is still validated. A pickup method with NO
   * point (operator counter sale) keeps that method at a 0 fee, even when the
   * storefront toggle for that method is off (the caisse has no picker).
   * Defaults to `home_delivery` (no agent), the legacy flat-rate path, so
   * existing callers are unaffected.
   */
  deliveryMethod: z
    .enum(["home_delivery", "drive_by_pickup", "in_store"])
    .default("home_delivery"),
  deliveryAgentId: z.string().uuid().optional(),
  pickupLocationId: z.string().uuid().optional(),
  promotionId: z.string().uuid().optional(),
  paymentMethod: z
    .enum(["flouci", "clictopay", "cod", "card_stripe", "cash", "bank_transfer"])
    .optional(),
  notes: z.string().max(ORDER_FIELD_MAX.notes).optional(),
  /**
   * ERP external reference, set ONLY by the ERP order-push (`createFromLines`);
   * web checkout never sends it. Written on the order row INSIDE this transaction
   * so the `orders_external_ref_uniq` index enforces the link atomically — a
   * concurrent same-ref push rolls back here (no orphaned/duplicate order) rather
   * than surviving a best-effort post-place stamp.
   */
  externalRef: z.string().trim().max(200).optional(),
});

export type PlaceOrderInput = z.input<typeof placeOrderSchema>;

/**
 * French name of each capped order field, keyed by the LAST schema path segment
 * — the place-order, quick-order, manual-order and ERP order schemas share these
 * field names (`contactPhone`, `shipping.phone`, `shipping.city`, …).
 */
const ORDER_FIELD_LABELS: Record<string, { label: string; max: number }> = {
  fullName: { label: "nom", max: ORDER_FIELD_MAX.name },
  streetLine1: { label: "adresse", max: ORDER_FIELD_MAX.addressLine },
  streetLine2: { label: "complément d'adresse", max: ORDER_FIELD_MAX.addressLine },
  city: { label: "ville", max: ORDER_FIELD_MAX.place },
  region: { label: "gouvernorat", max: ORDER_FIELD_MAX.place },
  postalCode: { label: "code postal", max: ORDER_FIELD_MAX.postalCode },
  phone: { label: "téléphone", max: ORDER_FIELD_MAX.phone },
  contactPhone: { label: "téléphone", max: ORDER_FIELD_MAX.phone },
  contactEmail: { label: "e-mail", max: ORDER_FIELD_MAX.email },
  notes: { label: "notes", max: ORDER_FIELD_MAX.notes },
  externalRef: { label: "référence externe", max: 200 },
};

/**
 * « Champ trop long » message naming EACH over-long text field of a schema
 * refusal with its cap (e.g. « téléphone (32 caractères max) »), built from the
 * offending issue paths so the shopper / operator / integrator knows exactly
 * what to shorten. Null when no string field exceeded its cap (another kind of
 * refusal). Looks inside union issues (the email is `email | ""`).
 */
export function orderFieldTooLongMessage(error: z.ZodError): string | null {
  const parts: string[] = [];
  const visit = (issues: ReadonlyArray<z.core.$ZodIssue>) => {
    for (const issue of issues) {
      if (issue.code === "invalid_union") {
        for (const branch of issue.errors) visit(branch);
        continue;
      }
      if (issue.code !== "too_big" || issue.origin !== "string") continue;
      const key = issue.path.length > 0 ? String(issue.path[issue.path.length - 1]) : "";
      const known = ORDER_FIELD_LABELS[key];
      const max = typeof issue.maximum === "number" ? issue.maximum : known?.max;
      const part = known
        ? `${known.label}${max != null ? ` (${max} caractères max)` : ""}`
        : "un champ";
      if (!parts.includes(part)) parts.push(part);
    }
  };
  visit(error.issues);
  if (parts.length === 0) return null;
  return parts.length === 1
    ? `Champ trop long : ${parts[0]}.`
    : `Champs trop longs : ${parts.join(", ")}.`;
}

/**
 * Message for a schema refusal: when a free-text field merely exceeds its
 * {@link ORDER_FIELD_MAX} cap, name that field and its cap (the shopper can
 * shorten it) instead of the opaque generic failure.
 */
export function orderValidationMessage(error: z.ZodError): string {
  return orderFieldTooLongMessage(error) ?? "Validation échouée";
}

/**
 * Normalise the admin-configured order-number prefix
 * (`checkout.order.number_prefix`): uppercase, alphanumerics only, 1–5 chars.
 * Falls back to "CMD" when unset/empty/invalid so a number is always produced.
 */
function normalizeOrderPrefix(raw: string | null | undefined): string {
  const cleaned = (raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 5) || "CMD";
}

// Order-reference alphabet: unambiguous uppercase so a customer can read or quote
// the code over the phone without confusion — no 0 or O, no 1 or I (and since 1/I
// are absent, L is unambiguous and kept). 32 symbols, and 256 % 32 === 0, so mapping
// a random byte with `% 32` is unbiased.
const ORDER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 8 digits + 24 letters (A–Z minus I, O)

function generateOrderCode(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ORDER_CODE_ALPHABET[bytes[i] % ORDER_CODE_ALPHABET.length];
  return out;
}

/**
 * Build a SHORT, human-quotable order reference: `<PREFIX>-<code>` with a 6-char
 * code by default (e.g. `CMD-7K9P2X`). No embedded date — the order's own
 * `created_at` is the source of truth for the printed/displayed date (formatted
 * store-local), so the reference is kept short on purpose. 32^6 ≈ 1.07e9 codes;
 * uniqueness is guaranteed by the `orders_order_number_unique` index plus the
 * pre-insert check in {@link generateUniqueOrderNumber} (which widens `codeLen`
 * as a safety valve).
 */
function generateOrderNumber(prefix: string, codeLen = 6): string {
  return `${prefix}-${generateOrderCode(codeLen)}`;
}

/**
 * Generate an order number not already in use. The 6-char space makes a clash with
 * an existing order rare; a bounded existence-check loop makes it effectively
 * impossible, and the final attempts widen the random part as a safety valve so
 * generation always terminates even at very large scale. The unique index remains
 * the ultimate guard against the astronomically unlikely concurrent same-code race,
 * which surfaces as an ordinary retryable placement error.
 */
async function generateUniqueOrderNumber(prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 7; attempt++) {
    const candidate = generateOrderNumber(prefix, attempt < 5 ? 6 : 8);
    const existing = await findOrderByNumber(candidate).catch(() => null);
    if (!existing) return candidate;
  }
  return generateOrderNumber(prefix, 10);
}

/**
 * Sentinel error class for "named" business-rule failures that bubble out of
 * the workflow body and need to be mapped to a `fail(...)` result with a
 * customer-facing French message. Using a class (rather than string-prefixed
 * Error messages) keeps the type-check tight and avoids accidental matches
 * on plain `Error` instances thrown by unrelated bugs.
 */
class PlaceOrderError extends Error {
  constructor(
    public readonly code:
      | "product_unavailable"
      | "out_of_stock"
      | "promotion_expired"
      | "max_purchase_qty"
      | "min_purchase_qty"
      | "conflict",
    /** French, customer-safe. */
    public readonly userMessage: string,
  ) {
    super(`${code}: ${userMessage}`);
    this.name = "PlaceOrderError";
  }
}

/**
 * True when the cart lines claimed inside the transaction are exactly the lines
 * the order was priced from (same line ids, same quantities). A line added,
 * removed or re-quantified by another tab between the up-front read and the
 * claim makes the priced snapshot stale.
 */
function sameCartLines(
  claimed: ReadonlyArray<{ id: string; quantity: number }>,
  priced: ReadonlyArray<{ id: string; quantity: number }>,
): boolean {
  if (claimed.length !== priced.length) return false;
  const qtyById = new Map(priced.map((it) => [it.id, it.quantity]));
  return claimed.every((it) => qtyById.get(it.id) === it.quantity);
}

/**
 * Context:
 *   - `actorUserId` — the CUSTOMER the order belongs to (null = guest). Drives
 *     `user_id`, the require-account policy, per-user coupon caps and the
 *     address auto-save.
 *   - `operatorUserId` — OPTIONAL staff member placing the order on the
 *     customer's behalf (manual order, caisse). Recorded as the AUDIT actor only
 *     (initial status-history row, stock movements, `order.created` + low-stock
 *     + cache-bust events) so an operator-created order is traceable to staff
 *     instead of naming the customer (or nobody) as its creator. Absent for a
 *     self-checkout, where the customer is also the audit actor.
 *   - `deliveryChannel` — OPTIONAL `"operator"` for a placement no shopper made
 *     that carries no `operatorUserId` (the ERP order push). Operator
 *     placements (this, or any `operatorUserId`) resolve delivery on the
 *     operator channel: the storefront method toggles don't apply, the chosen
 *     agent / pickup point is still validated (see `resolveDelivery`).
 */
export const placeOrderWorkflow = workflow<
  [
    PlaceOrderInput,
    {
      actorUserId?: string | null;
      operatorUserId?: string | null;
      deliveryChannel?: "storefront" | "operator";
      /** Sales channel — the order's ORIGIN (migration 0172). A CONTEXT field (not a
       *  placeOrderSchema input) so a crafted storefront request can't forge « erp ».
       *  Each creation path passes its own; omitted (tests / default) ⇒ storefront. */
      channel?: OrderChannel;
      /** Marketing SOURCE — where a manual order came from (Facebook / phone …).
       *  Operator-supplied on « Nouvelle commande »; a CONTEXT field like `channel`
       *  (never a storefront-forgeable input). Omitted everywhere else ⇒ NULL.
       *  Migration 0198; allowed values in lib/order/order-source.ts. */
      source?: string | null;
    },
  ],
  { orderId: string; orderNumber: string }
>("order.place", async (input, { actorUserId, operatorUserId, deliveryChannel, channel, source }) => {
  const parsed = placeOrderSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", orderValidationMessage(parsed.error));
  }
  const d = parsed.data;
  // Who is recorded as having performed the placement (audit trail only).
  const auditActorUserId = operatorUserId ?? actorUserId ?? null;

  try {
    const items = await cartService.listItems(d.cartId);
    if (items.length === 0) {
      return fail("empty_cart", "Votre panier est vide.");
    }

    // Batched lookup: a fixed number of queries regardless of cart size
    // (products, primary-media links, variants in parallel, then the media
    // rows) instead of per-item round-trips.
    const productIds = Array.from(new Set(items.map((it) => it.product_id)));
    const [productRows, primaryMediaIdsByProduct, variantsByProduct] = await Promise.all([
      productQueries.listProductsByIds(productIds),
      productMediaLink.primaryMediaIdsForProducts(productIds),
      productQueries.listVariantsForProducts(productIds),
    ]);
    const productById = new Map(productRows.map((p) => [p.id, p]));
    const variantById = new Map(
      [...variantsByProduct.values()].flat().map((v) => [v.id, v]),
    );
    const mediaIds = Array.from(
      new Set([
        ...primaryMediaIdsByProduct.values(),
        // Per-variant images — resolved in the SAME batch so an order line can
        // snapshot the exact variant photo (no extra round-trip).
        ...[...variantsByProduct.values()]
          .flat()
          .map((v) => v.image_media_id)
          .filter((id): id is string => Boolean(id)),
      ]),
    );
    const mediaMap = await mediaQueries.findMediaByIds(mediaIds);

    // ── Warranty snapshot — freeze the resolved cascade (product → primary
    // category sub→parent → global) onto each line so SAV / returns can read
    // the coverage a customer actually got, even after later catalog edits.
    // Same precedence as the storefront mapper via the shared resolver, so the
    // PDP and the order ledger never disagree. Warranty is product-level (not
    // per-variant), so every variant of a product inherits the product's.
    // ── Tax context — loaded once for the whole cart. The STRICT resolver: a
    // failed settings read throws (→ the outer catch rethrows → workflow()
    // `fail("internal")`, retryable — the cart is only claimed inside the order
    // transaction below, so nothing is consumed) instead of snapshotting every
    // line with TVA off. `taxRuleBpsForProducts` resolves the filter tier for
    // every product in ONE query. When tax is disabled both are inert:
    // config.mode short-circuits every line to 0 below, so the rule map is only
    // consulted for active modes.
    const [globalWarranty, primaryCatByProduct, taxConfig, taxRuleBpsByProduct, taxBrandBpsByProduct] =
      await Promise.all([
        getDefaultWarranty(),
        productCategoryLinks.primaryCategoriesForProducts(productIds),
        getTaxConfigStrict(),
        taxQueries.taxRuleBpsForProducts(productIds),
        taxQueries.brandTaxBpsForProducts(productIds),
      ]);
    // FULL primary-category ancestor chain (child → root) — one batched walk
    // (O(depth) queries) shared with the checkout/panier previews and the
    // post-sale line builder, so a rate / warranty set on ANY ancestor (not just
    // the direct parent) governs the line identically everywhere.
    const catChains = await loadCategoryChains(primaryCatByProduct.values());
    const warrantyByProduct = new Map<string, { months: number | null; label: string | null }>();
    // Category-tier tax rate per product — the first non-null `tax_rate_bps`
    // walking the primary category chain (child→root). Reuses the SAME chain the
    // warranty walk uses (no extra query), so the tax category tier and the
    // warranty cascade always agree on which category governs the line.
    const taxCategoryBpsByProduct = new Map<string, number | null>();
    for (const p of productRows) {
      const catId = primaryCatByProduct.get(p.id);
      const chain = catId ? (catChains.get(catId) ?? []) : [];
      const resolved = resolveWarranty(
        { months: p.warranty_months ?? null, label: p.warranty_label ?? null },
        categoryWarrantyFromChain(chain),
        globalWarranty,
      );
      // Store null (not 0) for uncovered lines so the SAV lookup reads a clean
      // "no warranty" rather than an expires-immediately 0-month window.
      warrantyByProduct.set(p.id, {
        months: resolved.months > 0 ? resolved.months : null,
        label: resolved.display,
      });
      // Tax category chain (child→parent). `categoryChainTaxBps` (via the
      // resolver) picks the first non-null; the array order encodes precedence.
      taxCategoryBpsByProduct.set(p.id, categoryChainTaxBps(chain.map((c) => c.tax_rate_bps)));
    }

    // Resolve the global variant-stock-mode default once; reused by the
    // pre-check below and the in-tx decrement so a SHARED variable product
    // checks/decrements the PARENT pool, not per-variant counts.
    const sharedStockDefault = await getSharedStockDefault();

    // Storefront placement (web checkout, quick-buy) vs an operator / ERP one —
    // the same split `resolveDelivery` uses below.
    const operatorChannel = Boolean(operatorUserId) || deliveryChannel === "operator";

    const snapshots = items.map((item) => {
      const product = productById.get(item.product_id);
      // Product was deleted / unpublished / archived between the cart view
      // and the place-order call. Surface a friendly message instead of a
      // stack trace. A DELETED product is gone from `productById` (the lookup
      // skips tombstones), so name it generically — never the raw product UUID.
      if (!product || !product.is_published) {
        throw new PlaceOrderError(
          "product_unavailable",
          product
            ? `Le produit ${product.name} n'est plus disponible.`
            : "Un article de votre panier n'est plus disponible. Retirez-le puis réessayez.",
        );
      }
      // Per-line ceiling for STOREFRONT carts, independent of stock tracking:
      // the cart caps lines at 99 (add / merge / stepper), so a bigger line is a
      // legacy or tampered one — and an UNTRACKED product has no stock gate below.
      // Operator / ERP placements (wholesale quantities) are not bound by it.
      if (!operatorChannel && item.quantity > CART_LINE_QTY_MAX) {
        throw new PlaceOrderError(
          "max_purchase_qty",
          `${product.name} est limité à ${CART_LINE_QTY_MAX} par commande.`,
        );
      }
      // A SIMPLE cart line (variant_id '') on a product since promoted to
      // `variable` is ambiguous — it would gate/decrement the parent stock
      // instead of a chosen variant's, bypassing per-variant inventory. Reject
      // so the shopper re-picks an option (mirrors the add-to-cart guard).
      if (!item.variant_id && product.product_type === "variable") {
        throw new PlaceOrderError(
          "product_unavailable",
          `Choisissez une option pour ${product.name} avant de commander.`,
        );
      }
      // Symmetric guard (VX-1): a VARIANT line on a product since demoted to
      // `simple` must not charge/decrement a stranded variant. The demotion now
      // soft-deletes variants (so variantById misses → the next guard catches
      // it), but this is the explicit, defence-in-depth check for legacy data.
      if (item.variant_id && product.product_type !== "variable") {
        throw new PlaceOrderError(
          "product_unavailable",
          `${product.name} n'est plus proposé en variantes — retirez puis rajoutez l'article.`,
        );
      }
      // Variant resolution — when the cart line carries one (variant_id is ''
      // for simple products), the VARIANT governs stock + identity; the parent
      // product still supplies the name / slug / image.
      const variant = item.variant_id ? variantById.get(item.variant_id) : undefined;
      if (item.variant_id && (!variant || variant.product_id !== product.id)) {
        throw new PlaceOrderError(
          "product_unavailable",
          `Une variante de ${product.name} n'est plus disponible.`,
        );
      }
      // Stock check. For a SHARED-mode variable product the quantity is governed
      // by the PARENT pool (per-variant stock_qty is ignored), though the
      // variant's own in_stock toggle can still disable it; otherwise the
      // variant (when present) governs, else the product. `in_stock=false` hard-
      // disables regardless of quantity.
      const shared = Boolean(variant) && isSharedStock(product.shared_variant_stock, sharedStockDefault);
      const label = variant ? ` (${variant.label})` : "";
      // Active-preorder lines sell WITHOUT stock — they RESERVE units (below)
      // instead of decrementing, so they bypass the in_stock + quantity gates.
      const preorder = isActivePreorder(product);
      if (!preorder) {
        if (!(variant ?? product).in_stock || (shared && !product.in_stock)) {
          throw new PlaceOrderError("product_unavailable", `${product.name}${label} n'est plus disponible.`);
        }
        const qtyTarget = shared ? product : (variant ?? product);
        // Sellable = stock minus units already promised to OPEN pré-commandes
        // (`reserved_qty`). Gating on raw `stock_qty` let a regular buyer purchase
        // units held for a preorder, so conversion then had no stock to decrement
        // (the oversell this reserve/convert ledger exists to prevent). `null` =
        // untracked (always sellable); for a normal product reserved_qty is 0, so
        // this is identical to the old check.
        const sellable = availableStock(qtyTarget.stock_qty, qtyTarget.reserved_qty);
        if (sellable !== null && item.quantity > sellable) {
          throw new PlaceOrderError("out_of_stock", `${product.name}${label} n'est plus disponible.`);
        }
      }
      const primaryMediaId = primaryMediaIdsByProduct.get(product.id);
      // Walk the full url-resolver chain (url_override → webp → url → original)
      // — imported rows often have an empty raw `url` but a populated `webp_url`,
      // so reading `.url` alone snapshotted a NULL image onto the order line.
      const imageUrl = primaryMediaId
        ? resolveMediaThumbUrl(mediaMap.get(primaryMediaId))
        : null;
      // Variant-specific image snapshot (compat thumb resolver, matching
      // product_image_url). NULL when the variant sets none → the order/invoice
      // falls back to the product image.
      const variantImageUrl = variant?.image_media_id
        ? resolveMediaThumbUrl(mediaMap.get(variant.image_media_id))
        : null;
      return { product, variant, item, imageUrl, variantImageUrl, preorder };
    });

    // Per-product purchase-quantity limits (authoritative gate) — aggregated by
    // PRODUCT across sibling variant lines (pure `aggregatePurchaseLimitViolations`),
    // so the per-order min/max can't be beaten by spreading the quantity over
    // several variants of the same product. For a simple product this equals its
    // single merged cart line. Throw on the first violating product.
    const qtyViolations = aggregatePurchaseLimitViolations(
      snapshots.map((s) => ({
        productId: s.product.id,
        quantity: s.item.quantity,
        name: s.product.name,
        min: s.product.min_purchase_qty,
        max: s.product.max_purchase_qty,
      })),
    );
    const firstQtyViolation = qtyViolations[0];
    if (firstQtyViolation) {
      throw new PlaceOrderError(
        firstQtyViolation.violation === "above_max" ? "max_purchase_qty" : "min_purchase_qty",
        firstQtyViolation.violation === "above_max"
          ? `${firstQtyViolation.name} est limité à ${firstQtyViolation.limit} par commande.`
          : `${firstQtyViolation.name} : quantité minimum ${firstQtyViolation.limit} par commande.`,
      );
    }

    // Re-resolve each line's auto-promotion against the LIVE product/variant
    // price rather than trusting the price cached in the cart at add-to-cart
    // time. This closes the stale-price window: a flash-sale price baked into a
    // cart line must NOT persist after the promo window closes (discount abuse /
    // revenue loss), and a promo that went live after add-to-cart should now
    // apply. Cart-scope coupons are still revalidated separately below. The
    // quick-buy path resolves+orders in one request, so only the persisted-cart
    // flow needed this.
    //
    // BATCHED: resolve the matching live auto-promotion rows for every distinct
    // product in a fixed number of queries, then apply the SAME
    // `resolveProductDiscount` engine per LINE against that line's own base unit
    // price (variant price when present). This must reproduce exactly what the
    // per-line `resolvePromotionalUnitPriceCents` (still used by add-to-cart and
    // quick-buy) computes — including stacked-promotion compounding and the
    // non-discountable guard — with O(1) queries instead of O(N).
    // Degrade safely on a promo-lookup failure (empty map ⇒ every line keeps
    // its base price) rather than aborting checkout.
    const promoRowsByProduct = await resolveLivePromotionRowsForProducts(
      snapshots.map((s) => s.product.id),
    ).catch(() => new Map<string, { discountable: boolean; rows: never[] }>());
    const unitPrices = snapshots.map((s) => {
      const base = s.variant ? s.variant.price_cents : s.product.price_cents;
      const entry = promoRowsByProduct.get(s.product.id);
      if (!entry || !entry.discountable) return base;
      // Per-variant (migration 0173): the line's own variant decides which promos
      // apply — a variant-constrained promo hits ONLY its variant (rowsForLineVariant).
      const lineRows = rowsForLineVariant(entry, s.variant?.id ?? null);
      if (lineRows.length === 0) return base;
      const discount = resolveProductDiscount(base, lineRows);
      return discount ? discount.effectivePriceCents : base;
    });

    const subtotalCents = snapshots.reduce(
      (acc, s, i) => acc + unitPrices[i] * s.item.quantity,
      0,
    );
    // Base for an order-level coupon — the full goods subtotal.
    const discountBaseCents = subtotalCents;
    // Base for an exclude-discounted-items coupon: NON-discounted lines only
    // (a line is on-sale when its effective unit price < its catalogue base).
    const discountableSub = discountableSubtotalCents(
      snapshots.map((s, i) => ({
        unitCents: unitPrices[i],
        baseCents: s.variant ? s.variant.price_cents : s.product.price_cents,
        quantity: s.item.quantity,
      })),
    );

    // ── Store-level checkout policy (Réglages commande), enforced authoritatively
    // here so it applies to web checkout, quick-buy AND operator-created orders.
    const storePolicy = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
    const minOrderCents = Math.max(0, Math.trunc(Number(storePolicy["checkout.min_order_cents"])) || 0);
    if (minOrderCents > 0 && subtotalCents < minOrderCents) {
      return fail("min_order", `Le montant minimum de commande est de ${formatMoneyExact(minOrderCents)}.`);
    }
    const requireAccount = (storePolicy["checkout.require_account"]?.trim() || "false") === "true";
    if (requireAccount && !actorUserId) {
      return fail(
        "account_required",
        // Same policy for an operator-created order, but a staff-facing message
        // (the storefront "connectez-vous" copy makes no sense at the counter).
        operatorUserId
          ? "Le réglage « compte requis » est actif : rattachez la commande à un compte client."
          : "Un compte est requis pour passer commande. Connectez-vous ou créez un compte.",
      );
    }
    // L10 low-stock alerts: resolved ONCE from the already-loaded settings map and
    // reused below — gates BOTH the in-tx crossing capture and the post-commit emit.
    const lowStockCfg = resolveLowStockConfig(storePolicy);

    // ── Per-line TVA. The taxable base is each line's PROMO-ADJUSTED subtotal
    // (effective unit price × qty), so the tax tracks what the customer actually
    // pays after auto-promotions. The rate is resolved through the
    // most-specific-wins cascade (product override → attribute-value rule →
    // category chain → global default); `computeTaxCents` then either EXTRACTS
    // the embedded TVA ("ttc", total unchanged) or computes the ADD-ON ("ht",
    // increases the total) — and returns 0 outright when the mode is "disabled",
    // preserving today's tax-free behaviour exactly. We snapshot both the amount
    // and the resolved rate onto each order_item for the invoice / audit.
    const lineTaxes = snapshots.map((s, i) => {
      const lineSubtotal = unitPrices[i] * s.item.quantity;
      const { bps } = resolveTaxRateBps({
        productTaxBps: s.product.tax_rate_bps ?? null,
        matchedRuleBps: taxRuleBpsByProduct.get(s.product.id) ?? null,
        brandTaxBps: taxBrandBpsByProduct.get(s.product.id) ?? null,
        categoryChainTaxBps: taxCategoryBpsByProduct.get(s.product.id) ?? null,
        globalBps: taxConfig.defaultRateBps,
      });
      const taxCents = computeTaxCents(lineSubtotal, bps, taxConfig.mode);
      // Snapshot the rate only when tax is actually live, so a disabled store
      // leaves order_items.tax_rate_bps NULL (no misleading "19 %" on a tax-free
      // line) and tax_cents 0.
      return { taxCents, rateBps: taxConfig.mode === "disabled" ? null : bps };
    });
    const itemsTaxCents = lineTaxes.reduce((acc, t) => acc + t.taxCents, 0);

    // ── Tokyo Care protection add-on. The customer's per-line plan choice
    // (`cart_items.care_plan_id`) is RE-VALIDATED + RE-PRICED here, never trusted:
    // the plan must be active, OFFERED on the line's product (category scope ∪
    // product-care include − exclude) and eligible, or the line carries no care.
    // Charged once-per-line or ×quantity per `care.charge_per_unit`; its TVA
    // follows the GLOBAL mode at the care rate (Système → Taxes → Tokyo Care).
    // Fails CLOSED: when the feature is off, nothing is offered or charged.
    type CareLine = {
      plan: CarePlanRow;
      unitCents: number;
      quantity: number;
      lineCents: number;
      taxCents: number;
      rateBps: number | null;
    };
    const careByLine: (CareLine | null)[] = snapshots.map(() => null);
    const careCfg = buildCareConfig(storePolicy);
    let careTotalCents = 0;
    let careTaxTotalCents = 0;
    if (careCfg.enabled && snapshots.some((s) => s.item.care_plan_id)) {
      const [careCatIds, careTaxConfig] = await Promise.all([
        productCategoryLinks
          .categoryIdsForProducts(snapshots.map((s) => s.product.id))
          .catch(() => new Map<string, string[]>()),
        getCareTaxConfigStrict(),
      ]);
      const offered = await resolveOfferedCareForLines(
        snapshots.map((s, i) => ({
          productId: s.product.id,
          productPriceCents: unitPrices[i],
          warrantyMonths: warrantyByProduct.get(s.product.id)?.months ?? null,
          condition: (s.product.condition ?? "new") as "new" | "used" | "refurbished",
          categoryIds: careCatIds.get(s.product.id) ?? [],
        })),
      );
      snapshots.forEach((s, i) => {
        const chosen = s.item.care_plan_id;
        if (!chosen) return;
        const match = offered[i]?.find((o) => o.plan.id === chosen);
        if (!match) return; // not offered / ineligible → dropped (server authoritative)
        const quantity = careCfg.chargePerUnit ? s.item.quantity : 1;
        const lineCents = match.unitCents * quantity;
        if (lineCents <= 0) return;
        const taxCents = computeCareTaxCents(lineCents, careTaxConfig, taxConfig.mode);
        careByLine[i] = {
          plan: match.plan,
          unitCents: match.unitCents,
          quantity,
          lineCents,
          taxCents,
          rateBps: taxConfig.mode === "disabled" || !careTaxConfig.taxable ? null : careTaxConfig.rateBps,
        };
        careTotalCents += lineCents;
        careTaxTotalCents += taxCents;
      });
    }
    // Whether the care charge counts toward the free-shipping threshold (knob).
    const freeShipBaseCents =
      subtotalCents + (careCfg.enabled && careCfg.countsTowardFreeShipping ? careTotalCents : 0);

    // Server-side coupon revalidation. The client passes only `promotionId`
    // (the discount is recomputed here, never trusted from the client), but a
    // promotion can expire / hit its cap / move out of the schedule window
    // between the cart render and the place-order action. Re-evaluate against
    // the live row before we trust the discount.
    let effectivePromotionId: string | null = null;
    let effectiveDiscountCents = 0;
    let effectiveCodeUsed: string | null = null;
    // The coupon's POST-clamp contribution, lifted out of the tx closure so the
    // post-commit promotion.redeemed audit event reports the same value that was
    // persisted on the redemption row (not the raw pre-clamp discount). See below.
    let couponDiscountForEvent = 0;
    // Set when the tx wrote a redemption row (line discount OR a free-shipping
    // coupon that zeroed a real fee) — the promotion.redeemed emit condition.
    let redemptionWritten = false;
    // L10: low-stock crossings captured during the in-tx decrement, emitted as
    // operator alerts AFTER commit (a pre-commit emit could false-alarm on a
    // rolled-back order). Each entry is a TRACKED line whose sale moved its stock
    // down; the crossing tier (low / depleted) is judged post-commit. Captured
    // ONLY when the alert feature is enabled (the push sites guard on
    // `lowStockCfg.enabled`), so a disabled store pays no allocation.
    const stockChanges: Array<{
      productId: string;
      variantId: string | null;
      sku: string | null;
      name: string;
      variantLabel: string | null;
      prevQty: number;
      newQty: number;
    }> = [];
    // Every product whose stock changed in this order (ALL tracked decrements,
    // independent of the low-stock alert toggle). Drives the post-commit catalog
    // cache-bust so a cached PDP / listing reflects the new stock immediately.
    const touchedProductIds = new Set<string>();
    // Per-user cap of the applied promo, captured for the RACE-SAFE in-tx re-check
    // (the pre-tx eligibility read is advisory only — TOCTOU). NULL = unlimited.
    let effectiveMaxUsesPerUser: number | null = null;
    // F2: the applied coupon grants free shipping.
    let couponGrantsFreeShipping = false;
    if (d.promotionId) {
      const promo = await promotionService.findById(d.promotionId);
      if (!promo) {
        throw new PlaceOrderError(
          "promotion_expired",
          "Promotion expirée pendant le passage de commande.",
        );
      }
      // Eligibility is computed in ONE place, shared with the cart resolver,
      // so the two can never diverge (see lib/promotions/coupon-eligibility).
      const verdict = await evaluateCouponEligibility(promo, {
        cartSubtotalCents: subtotalCents,
        userId: actorUserId ?? null,
        discountableSubtotalCents: discountableSub,
        // Per-line context (product id + charged/base subtotal) so a SCOPED coupon
        // discounts ONLY its matching lines — authoritatively, here.
        lines: snapshots.map((s, i) => ({
          productId: s.product.id,
          lineCents: unitPrices[i] * s.item.quantity,
          baseLineCents:
            (s.variant ? s.variant.price_cents : s.product.price_cents) * s.item.quantity,
        })),
      });
      if (!verdict.eligible) {
        if (COUPON_HARD_FAIL_REASONS.has(verdict.reason)) {
          // Genuine validity failure (gone/expired/capped/per-user) → abort.
          throw new PlaceOrderError(
            "promotion_expired",
            "Promotion expirée pendant le passage de commande.",
          );
        }
        // Soft "doesn't apply" (min-cart miss from the live-recomputed subtotal,
        // wrong scope, or not targeted) → DROP the coupon. The
        // customer did nothing wrong; never burn a redemption for a €0 discount.
        effectiveDiscountCents = 0;
        effectivePromotionId = null;
        effectiveCodeUsed = null;
      } else {
        effectiveDiscountCents = verdict.discountCents;
        effectivePromotionId = promo.id;
        effectiveCodeUsed = promo.code ?? null;
        effectiveMaxUsesPerUser = promo.max_uses_per_user;
        couponGrantsFreeShipping = verdict.grantsFreeShipping;
      }
    }

    // Resolve delivery AUTHORITATIVELY here from the LIVE server-computed
    // `subtotalCents` + the chosen method/agent/pickup. The client never sends a
    // shipping fee (a cart-UI preview would be derived from a possibly-stale
    // cached subtotal, so a price that drifted between the cart render and
    // checkout — an auto-promo going live/expiring, a catalog edit — could have
    // flipped the free-shipping threshold the client never re-evaluated).
    // `resolveDelivery` is the SINGLE SOURCE OF TRUTH: for
    // `home_delivery` with no agent it returns exactly `previewShipping`
    // (legacy invariant, identical fee), and for an agent / pickup selection it
    // validates against the live config + DB rows and returns the snapshot
    // fields persisted onto the order. A disabled method (storefront orders) or
    // a stale / invalid pickup point is REFUSED here — never re-routed to a
    // courier delivery the customer didn't choose (or the store doesn't offer).
    const del = await resolveDelivery({
      method: d.deliveryMethod,
      agentId: d.deliveryAgentId ?? null,
      pickupLocationId: d.pickupLocationId ?? null,
      region: d.shipping.region ?? null,
      // Care counts toward the free-shipping threshold only when the knob is on
      // (else == subtotalCents, so the default goods-only behaviour is unchanged).
      subtotalCents: freeShipBaseCents,
      channel: operatorChannel ? "operator" : "storefront",
    });
    if (!del.ok) {
      return fail("delivery_unavailable", del.message);
    }
    const effectiveShippingCents = del.shippingCents;

    // Admin-configurable order-number prefix (checkout.order.number_prefix);
    // degrades to the "CMD" default on any settings-read failure.
    const checkoutSettings = await getSettingsMap().catch(
      () => ({}) as Record<string, string | null>,
    );
    const orderNumber = await generateUniqueOrderNumber(
      normalizeOrderPrefix(checkoutSettings["checkout.order.number_prefix"]),
    );

    // Snapshot the store's active currency BEFORE opening the transaction — it's
    // an unrelated read (the `currencies` registry, relabel-only) with no
    // transactional dependency on the order writes, so it must not run inside the
    // tx where it would needlessly extend the lock-holding window (stock-row +
    // promotion locks). getActiveCurrency never throws (→ TND);
    // cache() can't help here since order placement runs from a server-action
    // POST where no shop layout/PDP rendered, so this is a real query either way.
    const activeCurrencyCode = (await getActiveCurrency()).code;

    const order = await db.transaction(async (tx) => {
      // ── Claim the cart FIRST (idempotency). Lock the cart row so a concurrent
      // submit of the SAME cart (double-tap, network retry, two tabs / devices
      // sharing a user cart) serializes here, then delete its lines with
      // RETURNING. The second submit waits on this lock; once the first commits,
      // its delete returns nothing and it rolls back cleanly — no duplicate
      // order, no second stock decrement / coupon burn / receipt.
      // Taken before any stock / promo lock, in every placement, so the
      // lock order stays deterministic (no new deadlock cycle). The lines must
      // also be exactly the ones priced above: a line changed by another tab in
      // between aborts (and, rolled back, is never silently dropped).
      const cartLocked = await cartService.lockForCheckout(d.cartId, tx);
      const claimed = cartLocked ? await cartService.clear(d.cartId, tx) : [];
      if (claimed.length === 0) {
        throw new PlaceOrderError("conflict", "Ce panier a déjà été commandé.");
      }
      if (!sameCartLines(claimed, items)) {
        throw new PlaceOrderError(
          "conflict",
          "Votre panier a été modifié pendant la commande. Vérifiez-le puis réessayez.",
        );
      }

      // Coupon discount, clamped so it can never exceed the goods subtotal.
      const nonCoinDiscountCents = Math.min(discountBaseCents, effectiveDiscountCents);

      // The coupon's ACTUAL contribution after the subtotal clamp — logged on the
      // redemption row so promo stats + refund reversal reflect what it truly cut.
      const couponDiscountAppliedCents = nonCoinDiscountCents;
      couponDiscountForEvent = couponDiscountAppliedCents;

      // Free shipping — granted by a free-shipping coupon/auto promo (F2), which
      // zeroes ALL shipping.
      // Did shipping carry a positive fee BEFORE any free-shipping zeroing? Used
      // below so a free-shipping coupon only burns a use when it ACTUALLY reduced
      // a fee (not on a pickup/in-store order) — a no-benefit application must not
      // consume the coupon.
      const shippingWasPositive = effectiveShippingCents > 0;
      const couponZeroedShipping = couponGrantsFreeShipping && shippingWasPositive;
      let shippingCents = effectiveShippingCents;
      if (couponGrantsFreeShipping) {
        shippingCents = 0;
      }

      // ── TVA total. `itemsTaxCents` is the summed per-line tax computed above.
      // When `config.onShipping` is set, the shipping fee is also taxed (same
      // mode + global rate); shipping is taxed at the GLOBAL rate since it isn't
      // tied to any one product's cascade. A free / zeroed shipping fee yields 0.
      const shippingTaxCents = taxConfig.onShipping
        ? computeTaxCents(shippingCents, taxConfig.defaultRateBps, taxConfig.mode)
        : 0;
      // Care TVA (`careTaxTotalCents`) joins the goods + shipping tax so it shows
      // in « dont TVA » and, in HT mode, is added to the total below.
      const orderTaxCents = itemsTaxCents + shippingTaxCents + careTaxTotalCents;

      // TOTAL semantics by mode:
      //   • "ht"  → prices are tax-EXCLUSIVE, so the tax is ADDED on top.
      //   • "ttc" → prices already INCLUDE the tax; the total is unchanged
      //             (orderTaxCents is informational, surfaced as "dont TVA").
      //   • "disabled" → orderTaxCents is 0, so this term vanishes.
      // DELIBERATE (audit 2026-09-26): in "ttc" mode this "dont TVA" reflects the
      // VAT embedded in the goods+shipping BEFORE order-level coupon
      // discounts (which reduce the total but are not re-apportioned into the
      // extracted tax). It is display/invoice-only — the ttc total charged is
      // unchanged and ERP reconciliation for ttc does not read tax_cents — so we
      // intentionally do not scale it by the discount ratio (the ht-base
      // treatment of order-level discounts is the separately-deferred decision).
      const totalTaxAddCents = taxConfig.mode === "ht" ? orderTaxCents : 0;
      // Care is a charge (like shipping) — ADDED to the base, never discounted
      // (coupons only reduce the goods subtotal).
      const totalCents = Math.max(
        0,
        subtotalCents + shippingCents + careTotalCents + totalTaxAddCents - nonCoinDiscountCents,
      );

      // Snapshot the store's active currency (read up-front, above the tx) onto
      // the order so historical orders + invoices keep the right label after a
      // future currency switch (relabel only — amounts stay millimes).
      const inserted = await orderService.insertOrder({
        order_number: orderNumber,
        user_id: actorUserId ?? null,
        contact_email: d.contactEmail,
        contact_phone: d.contactPhone ?? null,
        status: "pending",
        currency: activeCurrencyCode,
        subtotal_cents: subtotalCents,
        shipping_cents: shippingCents,
        discount_cents: nonCoinDiscountCents,
        tax_cents: orderTaxCents,
        // Tokyo Care protection add-on (ex-TVA); its TVA is inside tax_cents.
        care_cents: careTotalCents,
        total_cents: totalCents,
        ship_full_name: d.shipping.fullName,
        ship_street_line1: d.shipping.streetLine1,
        ship_street_line2: d.shipping.streetLine2 ?? null,
        ship_city: d.shipping.city,
        ship_region: d.shipping.region ?? null,
        ship_postal_code: d.shipping.postalCode ?? null,
        ship_country: d.shipping.country,
        ship_phone: d.shipping.phone ?? null,
        // Delivery method + the authoritative agent/pickup snapshot from
        // `resolveDelivery` (names/address frozen so the order survives later
        // edits/deletes of those rows). `shipping_cents` above already carries
        // the resolved fee (post coupon free-ship perk).
        delivery_method: del.deliveryMethod,
        delivery_agent_id: del.deliveryAgentId,
        pickup_location_id: del.pickupLocationId,
        delivery_agent_name: del.deliveryAgentName,
        pickup_location_name: del.pickupLocationName,
        pickup_location_address: del.pickupLocationAddress,
        payment_method: d.paymentMethod ?? null,
        notes: d.notes ?? null,
        // ERP link (order-push only) — written atomically so the unique index is
        // the race backstop. `undefined` for web checkout → column stays NULL.
        external_ref: d.externalRef ?? null,
        // Sales channel (origin). Default to storefront; derive operator from the
        // operator context, erp from the ERP delivery-channel flag, so a caller that
        // omits `channel` (e.g. a test) is still classified sensibly.
        channel:
          channel ??
          (operatorUserId ? "operator" : deliveryChannel === "operator" ? "erp" : "storefront"),
        // Marketing source (operator-supplied; NULL everywhere but a manual order).
        source: source ?? null,
        // Précommande: the order has ≥1 active-preorder line (reserves units, no
        // stock decrement, revenue deferred until conversion).
        is_preorder: snapshots.some((s) => s.preorder),
      }, tx);

      const insertedItems = await orderService.insertItems(
        snapshots.map((s, i) => ({
          order_id: inserted.id,
          product_id: s.product.id,
          product_name: s.product.name,
          product_slug: s.product.slug,
          // Variant SKU wins when present — it's the actual sellable unit.
          product_sku: s.variant?.sku ?? s.product.sku,
          product_image_url: s.imageUrl,
          variant_id: s.variant?.id ?? null,
          variant_sku: s.variant?.sku ?? null,
          variant_label: s.variant?.label || null,
          // Per-variant image frozen onto the line (falls back to
          // product_image_url at display time).
          variant_image_url: s.variantImageUrl,
          // Frozen warranty cascade (see warrantyByProduct above) — null when
          // the line carries no coverage.
          warranty_months: warrantyByProduct.get(s.product.id)?.months ?? null,
          warranty_label: warrantyByProduct.get(s.product.id)?.label ?? null,
          unit_price_cents: unitPrices[i],
          quantity: s.item.quantity,
          subtotal_cents: unitPrices[i] * s.item.quantity,
          // Per-line TVA snapshot (see `lineTaxes` above) — 0 / NULL when tax is
          // disabled, so the column stays clean for tax-free stores.
          tax_cents: lineTaxes[i].taxCents,
          tax_rate_bps: lineTaxes[i].rateBps,
          // Preorder lines claim no stock at placement (stock_claimed=false,
          // flipped true at conversion); regular lines are claimed now.
          is_preorder: s.preorder,
          stock_claimed: !s.preorder,
        })),
        tx,
      );

      // Tokyo Care snapshot — one row per line that bought protection. The
      // inserted order_items are returned index-aligned with `snapshots`, so each
      // care row links to its goods line. The plan name + duration are frozen.
      const careRows = snapshots
        .map((s, i) => {
          const care = careByLine[i];
          if (!care) return null;
          return {
            order_id: inserted.id,
            order_item_id: insertedItems[i].id,
            product_id: s.product.id,
            care_plan_id: care.plan.id,
            plan_name: care.plan.name,
            duration_months: care.plan.duration_months,
            unit_care_cents: care.unitCents,
            quantity: care.quantity,
            care_cents: care.lineCents,
            tax_cents: care.taxCents,
            tax_rate_bps: care.rateBps,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (careRows.length > 0) {
        await orderService.insertCareItems(careRows, tx);
      }

      // Preorder lines RESERVE units instead of decrementing — one open hold per
      // line, bumping reserved_qty (the variant for per-variant stock, else the
      // product pool, matching the decrement target below). Nothing leaves the
      // sellable total until conversion. insertedItems is index-aligned with snapshots.
      for (let i = 0; i < snapshots.length; i++) {
        const s = snapshots[i];
        if (!s.preorder) continue;
        const reserveVariantId =
          s.variant && !isSharedStock(s.product.shared_variant_stock, sharedStockDefault)
            ? s.variant.id
            : null;
        await stockReservationService.reserveForOrderLine(tx, {
          orderId: inserted.id,
          orderItemId: insertedItems[i].id,
          productId: s.product.id,
          variantId: reserveVariantId,
          qty: s.item.quantity,
          actorUserId: auditActorUserId,
        });
      }

      // Atomically decrement tracked stock inside the same transaction. The
      // `stock_qty >= quantity` guard makes this race-safe: if a concurrent
      // checkout claimed the last units between the earlier read and here, the
      // UPDATE matches 0 rows and we roll the whole order back rather than
      // oversell. Untracked lines (`stock_qty` NULL) are always sellable and
      // skipped. The variant governs stock when present, else the product.
      // `in_stock` is flipped off when the count hits 0 so the storefront
      // stops advertising it.
      //
      // Acquire the stock-row locks in a GLOBAL, deterministic id order (variant
      // id when present, else product id) so two concurrent multi-line orders
      // sharing SKUs can never deadlock in an AB/BA cycle — every transaction
      // locks the same rows in the same sequence. (A 40P01/55P03 that still
      // arises under heavy hot-SKU contention is mapped to a friendly retryable
      // conflict by the workflow() wrapper.)
      // A variable product in SHARED mode draws from the PARENT product's pool,
      // not per-variant counts — so a variant line decrements the product row.
      const decrementsVariant = (s: (typeof snapshots)[number]) =>
        Boolean(s.variant) && !isSharedStock(s.product.shared_variant_stock, sharedStockDefault);
      const ordered = [...snapshots].sort((a, b) => {
        const ka = decrementsVariant(a) ? a.variant!.id : a.product.id;
        const kb = decrementsVariant(b) ? b.variant!.id : b.product.id;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      for (const s of ordered) {
        if (s.preorder) continue; // reserved above — a preorder line never decrements at placement
        const qty = s.item.quantity;
        if (decrementsVariant(s)) {
          if (s.variant!.stock_qty === null) continue;
          const updated = await tx
            .update(product_variants)
            .set({
              stock_qty: sql`${product_variants.stock_qty} - ${qty}`,
              in_stock: sql`(${product_variants.stock_qty} - ${qty}) > 0`,
            })
            .where(
              and(
                eq(product_variants.id, s.variant!.id),
                gte(product_variants.stock_qty, qty),
              ),
            )
            .returning({ id: product_variants.id, stockQty: product_variants.stock_qty });
          if (updated.length === 0) {
            throw new PlaceOrderError(
              "out_of_stock",
              `${s.product.name} (${s.variant!.label}) n'est plus disponible en quantité suffisante.`,
            );
          }
          await stockMovementService.record(
            { productId: s.product.id, variantId: s.variant!.id, delta: -qty, resultingQty: updated[0].stockQty, reason: "order", orderId: inserted.id, actorUserId: auditActorUserId },
            tx,
          );
          touchedProductIds.add(s.product.id);
          // L10: capture the post-decrement level (RETURNING gives the NEW qty);
          // prevQty reconstructs the level before this line's sale. Only when
          // alerts are on, so a disabled store pays nothing.
          if (lowStockCfg.enabled) {
            stockChanges.push({
              productId: s.product.id,
              variantId: s.variant!.id,
              // The VARIANT's own SKU is the orderable reorder reference (parent
              // SKU as fallback), so the operator email points at the right SKU.
              sku: s.variant!.sku ?? s.product.sku,
              name: s.product.name,
              variantLabel: s.variant!.label,
              // Guarded above (s.variant.stock_qty === null ⇒ continue), so the
              // returned qty is a real number; `?? 0` only satisfies the nullable type.
              prevQty: (updated[0].stockQty ?? 0) + qty,
              newQty: updated[0].stockQty ?? 0,
            });
          }
        } else {
          if (s.product.stock_qty === null) continue;
          const updated = await tx
            .update(products)
            .set({
              stock_qty: sql`${products.stock_qty} - ${qty}`,
              in_stock: sql`(${products.stock_qty} - ${qty}) > 0`,
            })
            .where(and(eq(products.id, s.product.id), gte(products.stock_qty, qty)))
            .returning({ id: products.id, stockQty: products.stock_qty });
          if (updated.length === 0) {
            throw new PlaceOrderError(
              "out_of_stock",
              `${s.product.name} n'est plus disponible en quantité suffisante.`,
            );
          }
          await stockMovementService.record(
            { productId: s.product.id, delta: -qty, resultingQty: updated[0].stockQty, reason: "order", orderId: inserted.id, actorUserId: auditActorUserId },
            tx,
          );
          touchedProductIds.add(s.product.id);
          if (lowStockCfg.enabled) {
            stockChanges.push({
              productId: s.product.id,
              variantId: null,
              sku: s.product.sku,
              name: s.product.name,
              variantLabel: null,
              // Guarded above (s.product.stock_qty === null ⇒ continue).
              prevQty: (updated[0].stockQty ?? 0) + qty,
              newQty: updated[0].stockQty ?? 0,
            });
          }
        }
      }

      // Seed the status-history ledger with the initial "pending" entry so the
      // audit trail begins at order creation rather than at the first manual
      // transition. `orderService.transitionStatus` opens its own transaction,
      // so we insert directly here to stay within the same atomic boundary.
      await tx.insert(order_status_history).values({
        order_id: inserted.id,
        from_status: null,
        to_status: "pending",
        actor_user_id: auditActorUserId,
        notes: operatorUserId ? "Commande créée (saisie opérateur)" : "Commande créée",
      });

      // Atomic redemption: bump `uses_count` and insert the redemption row on
      // the SAME `tx` as the order write, so a rollback un-redeems both (no
      // orphan redemption row, no counter drift). The GLOBAL-cap bump folds the
      // check into its UPDATE (race-safe): if a parallel checkout claimed the
      // last slot between the `hasCapacity` read above and here, it matches zero
      // rows and we throw to roll the whole order back rather than over-redeem.
      //
      // Burn a redemption when the coupon applied a line discount OR ACTUALLY
      // reduced a shipping fee to 0 (`couponZeroedShipping`). A free-shipping-only
      // coupon contributes discount_cents = 0 but is still a real use that must
      // count against max_uses / max_uses_per_user: the redemption row carries
      // `free_shipping = true` so countRedemptionsByUser includes it, while the
      // refund path (which reverses only discount_cents > 0 rows) leaves it
      // CONSUMED — free shipping, once used, is not given back. A coupon that
      // grants free shipping AND a line discount burns via the discount > 0 path
      // and reverses cleanly on refund. NOTE: a free-shipping coupon applied to an
      // order whose shipping was ALREADY 0 (pickup/in-store, or the free-shipping
      // threshold already zeroed it) confers no benefit, so it does NOT burn a use.
      if (effectivePromotionId && (couponDiscountAppliedCents > 0 || couponZeroedShipping)) {
        // PER-USER cap — RACE-SAFE. The pre-tx eligibility read is advisory only
        // (TOCTOU: two concurrent same-user checkouts both read used=0). Lock the
        // promo row so they serialize, then re-count this user's redemptions on
        // the tx; the loser sees the winner's committed row and rolls back. (The
        // global cap is handled by the folded UPDATE below; only the per-user
        // count needs this. Lock is taken AFTER stock locks — consistent order,
        // no new deadlock cycle.) A per-user-capped code requires an account
        // (evaluateCouponEligibility → `account_required`), so a guest never
        // reaches this burn with such a code; the actorUserId guard is therefore
        // belt-and-braces for the logged-in path.
        if (actorUserId && effectiveMaxUsesPerUser) {
          await promotionService.lockForRedemption(effectivePromotionId, tx);
          const usedByUser = await promotionService.countRedemptionsByUser(
            effectivePromotionId,
            actorUserId,
            tx,
          );
          if (usedByUser >= effectiveMaxUsesPerUser) {
            throw new PlaceOrderError(
              "promotion_expired",
              "Promotion expirée pendant le passage de commande.",
            );
          }
        }
        const bumped = await promotionService.incrementUsesCount(
          effectivePromotionId,
          tx,
        );
        if (!bumped) {
          throw new PlaceOrderError(
            "promotion_expired",
            "Promotion expirée pendant le passage de commande.",
          );
        }
        await promotionService.logRedemption(
          {
            promotion_id: effectivePromotionId,
            order_id: inserted.id,
            user_id: actorUserId ?? null,
            discount_cents: couponDiscountAppliedCents,
            // Only flag the row as a free-shipping redemption when it actually
            // zeroed a positive fee — keeps countRedemptionsByUser netting
            // consistent (a real free-ship use stays counted; a no-benefit one
            // never reached this burn).
            free_shipping: couponZeroedShipping,
            // The shipping fee this coupon ate (millimes) — the store's real cost
            // of the free-ship benefit, summed into the Performance stats.
            shipping_waived_cents: couponZeroedShipping ? effectiveShippingCents : 0,
            code_used: effectiveCodeUsed,
          },
          tx,
        );
        redemptionWritten = true;
      }

      return inserted;
    });

    await bus.emit(
      "order.created",
      { orderId: order.id, orderNumber: order.order_number, totalCents: order.total_cents },
      { actorUserId: auditActorUserId },
    );

    // ── Tokyo Care — one `care.purchased` per protected line, for ERP / webhook
    // subscribers (the quick-buy path delegates here, so it is covered too).
    // Best-effort + post-commit: an emit failure must never affect the placed order.
    try {
      for (let i = 0; i < snapshots.length; i++) {
        const care = careByLine[i];
        if (!care) continue;
        await bus.emit(
          "care.purchased",
          {
            orderId: order.id,
            planId: care.plan.id,
            productId: snapshots[i].product.id,
            priceCents: care.lineCents,
          },
          { actorUserId: auditActorUserId },
        );
      }
    } catch (err) {
      console.error("[placeOrder] care.purchased emit failed", err);
    }

    // ── L10: low-stock operator alerts. Post-commit (a pre-commit emit could
    // false-alarm on a rolled-back order) and gated on the admin toggle (reusing
    // the `lowStockCfg` resolved before the tx). Fires ONE event per line that
    // crossed the low / out-of-stock edge with this sale — the subscriber turns it
    // into an operator email. Best-effort: an emit failure must never affect the
    // placed order. `stockChanges` is empty when alerts are off, so this no-ops.
    try {
      if (lowStockCfg.enabled) {
        for (const c of stockChanges) {
          const crossing = classifyStockCrossing(c.prevQty, c.newQty, lowStockCfg.threshold);
          if (crossing === "depleted") {
            await bus.emit(
              "product.stock_depleted",
              {
                productId: c.productId,
                variantId: c.variantId,
                sku: c.sku,
                name: c.name,
                variantLabel: c.variantLabel,
              },
              { actorUserId: auditActorUserId },
            );
          } else if (crossing === "low") {
            await bus.emit(
              "product.stock_low",
              {
                productId: c.productId,
                variantId: c.variantId,
                sku: c.sku,
                name: c.name,
                variantLabel: c.variantLabel,
                currentQty: c.newQty,
                threshold: lowStockCfg.threshold,
              },
              { actorUserId: auditActorUserId },
            );
          }
        }
      }
    } catch (err) {
      console.error("[order.place] low-stock alert emit failed", err);
    }

    // ── Catalog cache invalidation: a sale moved stock/in_stock on these
    // products, so bust their cached PDP / listing reads (shared helper — same
    // path as edit-items + restock). Post-commit + best-effort.
    await emitProductStockCacheBust(touchedProductIds, auditActorUserId);

    // ── Auto-save the shipping address to the signed-in customer's address
    // book so it's offered next time ("auto-saved on first use", still editable
    // / addable from checkout + the account page). Best-effort and post-commit:
    // it must NEVER fail or roll back the order. Skips pickup / in-store orders
    // (no real delivery address — e.g. the caisse's « Vente en boutique »
    // placeholder must never become a customer's default shipping address): both
    // the REQUESTED and the resolved method must be home delivery. De-dupes
    // against an identical existing line. The first saved address becomes the
    // default shipping target.
    if (
      actorUserId &&
      d.deliveryMethod === "home_delivery" &&
      del.deliveryMethod === "home_delivery" &&
      d.shipping.streetLine1.trim()
    ) {
      try {
        const link = await customerUserLink.findByUserId(actorUserId);
        if (link) {
          // The address fields the shopper submitted (snake_case for the address
          // table). Reused by both the update + insert paths below.
          const fields = {
            full_name: d.shipping.fullName,
            street_line1: d.shipping.streetLine1,
            street_line2: d.shipping.streetLine2 ?? null,
            city: d.shipping.city,
            region: d.shipping.region ?? null,
            postal_code: d.shipping.postalCode ?? null,
            country: d.shipping.country,
            phone: d.shipping.phone ?? null,
          };
          // If the shopper PICKED a saved address at checkout (then possibly
          // edited it), UPDATE that row in place rather than inserting a near-
          // duplicate — this is the fix for "editing an address adds a new one".
          // The id is client-supplied, so re-verify ownership; `findAddressById`
          // already excludes soft-deleted rows. Default flags are left untouched
          // so we never trip the `addresses_one_default_shipping` unique index.
          const picked = d.shipping.selectedAddressId
            ? await customerService.findAddressById(d.shipping.selectedAddressId)
            : null;
          if (picked && picked.customer_profile_id === link.customer_profile_id) {
            await customerService.updateAddress(picked.id, fields);
          } else {
            // New address ("+ Nouvelle adresse", or a guest-supplied id that
            // isn't theirs): de-dupe against an identical existing line, else
            // insert. The first saved address becomes the default shipping target.
            const existing = await customerService.listAddressesByProfile(
              link.customer_profile_id,
            );
            const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
            const dup = existing.some(
              (a) =>
                norm(a.street_line1) === norm(d.shipping.streetLine1) &&
                norm(a.city) === norm(d.shipping.city),
            );
            if (!dup) {
              await customerService.insertAddress({
                customer_profile_id: link.customer_profile_id,
                type: "shipping",
                ...fields,
                is_default_shipping: existing.length === 0,
              });
            }
          }
        }
      } catch (err) {
        console.error("[order.place] shipping-address auto-save failed", err);
      }
    }

    // Emitted after commit — the redemption rows were already written on the
    // order transaction above.
    // Exactly when a redemption row was written: a line discount OR a
    // free-shipping-only coupon that zeroed a real fee (its row carries
    // discount_cents 0 + free_shipping, and so does this event). Keying on
    // `discountCents > 0` silently dropped every free-shipping redemption from
    // the event stream / outbound webhooks while it still counted against caps.
    if (effectivePromotionId && redemptionWritten) {
      await bus.emit("promotion.redeemed", {
        promotionId: effectivePromotionId,
        orderId: order.id,
        // Post-clamp value, matching the persisted redemption row (API-2).
        discountCents: couponDiscountForEvent,
      });
    }

    return ok({ orderId: order.id, orderNumber: order.order_number });
  } catch (err) {
    // Business-rule failures bubble out as PlaceOrderError instances we
    // map back to `fail(...)` with the French message the customer should
    // see. Anything else is a genuine bug / infra error — rethrow so the
    // `workflow()` helper wraps it as `fail("internal", …)` and logs it.
    if (err instanceof PlaceOrderError) {
      return fail(err.code, err.userMessage);
    }
    throw err;
  }
});
