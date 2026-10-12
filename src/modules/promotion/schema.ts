import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { RuleNode } from "@/lib/promotions/rule-tree";
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Promotion module.
 *
 * A unified discount engine that powers:
 *   - per-product discounts (e.g. "20% off the Submariner for 48h")
 *   - per-category bulk promos (e.g. "−30 TND on all leather straps")
 *   - brand-wide events
 *   - cart-level coupon codes (e.g. "BLACKFRIDAY" → 15% off the whole cart)
 *   - shareable promo URLs (e.g. /promo/early-bird → cookie sets up the discount)
 *
 * One row = one promotion. The (scope, scope_id, trigger_kind) combination
 * decides what it applies to and how it activates.
 *
 * Why a single table rather than per-scope tables?
 *   - Single CRUD surface in admin (one form, scope dropdown).
 *   - Single redemption pipeline at checkout (one query to gather all
 *     applicable promotions, one ranking function).
 *   - Cross-scope filters ("show me everything ending in <7 days") are
 *     trivial; with split tables they'd need UNIONs everywhere.
 */

// ───────────────────────── enums ──────────────────────────────────────────
/** What product set the promotion applies to. */
export const promotionScopeEnum = pgEnum("promotion_scope", [
  /** A single product (scope_id = products.id). */
  "product",
  /** Every product in a category (scope_id = categories.id; cascades to children). */
  "category",
  /** Every product carrying the brand (scope_id = brands.id). */
  "brand",
  /** Discount on the whole cart subtotal (scope_id NULL). */
  "cart",
  /** MULTI-target (migration 0169/0170): the product set is defined by N rows in
   *  `promotion_scope_targets` (any mix of products / categories / brands). scope_id
   *  is NULL (like 'cart'); the targets are the source of truth. */
  "targeted",
]);

/** How a promotion is activated. */
export const promotionTriggerEnum = pgEnum("promotion_trigger", [
  /** Applies automatically when the conditions match — no code, no URL. */
  "auto",
  /** Requires the shopper to enter a coupon code at checkout. */
  "code",
  /** Visiting /promo/<url_slug> sets a cookie that activates the promotion. */
  "url",
]);

/** Discount maths. */
export const promotionDiscountTypeEnum = pgEnum("promotion_discount_type", [
  /** `discount_value` is interpreted as a percent (1-100). */
  "percent",
  /** `discount_value` is interpreted as integer millimes to subtract. */
  "fixed",
]);

// ───────────────────────── promotions table ───────────────────────────────
export const promotions = pgTable(
  "promotions",
  {
    id: id(),

    /** Operator-facing label shown in the admin grid and on storefront badges. */
    name: text("name").notNull(),

    // ─── activation ─────────────────────────────────────────────────────
    trigger_kind: promotionTriggerEnum("trigger_kind").notNull().default("auto"),
    /** Coupon code — populated when `trigger_kind = 'code'`. Case-insensitive
     * via partial unique index on `lower(code)` below. */
    code: text("code"),
    /** URL slug — populated when `trigger_kind = 'url'`. `/promo/<url_slug>`
     * sets a `gz.promo` cookie that the cart resolver picks up. */
    url_slug: text("url_slug"),

    // ─── targeting ──────────────────────────────────────────────────────
    scope: promotionScopeEnum("scope").notNull(),
    /** Target row id. Soft FK — service layer enforces existence.
     *  - scope='product'  → products.id
     *  - scope='category' → categories.id
     *  - scope='brand'    → brands.id
     *  - scope='cart'     → NULL
     */
    scope_id: uuid("scope_id"),

    // ─── discount maths ─────────────────────────────────────────────────
    discount_type: promotionDiscountTypeEnum("discount_type").notNull(),
    /** Percent (1-100) or millimes off; CHECK constraint enforces the bounds. */
    discount_value: integer("discount_value").notNull(),

    // ─── conditions ─────────────────────────────────────────────────────
    /** Minimum cart subtotal (millimes) required to qualify. 0 = no minimum. */
    min_cart_cents: integer("min_cart_cents").notNull().default(0),
    /** Optional UPPER bound on the cart subtotal (millimes) — brackets a coupon to
     *  a target spend band (pairs with min_cart_cents). NULL = no upper bound. */
    max_cart_cents: integer("max_cart_cents"),
    /** Hard cap on total uses across all shoppers. NULL = unlimited. */
    max_uses: integer("max_uses"),
    /** Per-customer (user_id) cap. NULL = unlimited per user. */
    max_uses_per_user: integer("max_uses_per_user"),
    /** Atomic counter — bumped by the redeem workflow inside a transaction. */
    uses_count: integer("uses_count").notNull().default(0),

    // ─── schedule ───────────────────────────────────────────────────────
    /** NULL = active immediately on `is_active` flip. */
    starts_at: timestamp("starts_at", { withTimezone: true }),
    /** NULL = never expires. */
    ends_at: timestamp("ends_at", { withTimezone: true }),

    // ─── announcement (migration 0171) ──────────────────────────────────
    /** Scheduled email-announcement instant (store-local wall-clock, parsed +01:00
     *  via parseStoreLocalDateTime). NULL = no scheduled announce. The cron sweep
     *  (promotion_announce_sweep) fires the blast when `announce_at <= now()` and the
     *  promo is still live, then stamps `announced_at`. */
    announce_at: timestamp("announce_at", { withTimezone: true }),
    /** When the announcement was fired (idempotency claim + « Annoncée le … » display).
     *  NULL = never announced. The sweep claims a due row race-safely
     *  (UPDATE … SET announced_at = now() WHERE announced_at IS NULL RETURNING) BEFORE
     *  the blast; an immediate create-time announce and a manual « Annoncer maintenant »
     *  also stamp it, so the sweep never double-fires an already-announced promo. */
    announced_at: timestamp("announced_at", { withTimezone: true }),

    // ─── display + behaviour ────────────────────────────────────────────
    /** Master toggle — admin can disable a promo without deleting the row. */
    is_active: boolean("is_active").notNull().default(true),
    /** When false, this promotion can't combine with other active promotions
     *  on the same line. Default false (safer for ops). */
    is_stackable: boolean("is_stackable").notNull().default(false),
    /** When true, a cart-scope coupon's discount is computed on the NON-discounted
     *  lines only — lines already cut by an auto product/category/brand promo are
     *  excluded from the coupon base (WooCommerce `exclude_sale_items`). Default
     *  false = the coupon stacks on already-on-sale lines (current behaviour). */
    exclude_discounted_items: boolean("exclude_discounted_items").notNull().default(false),
    /** Cap on a PERCENT discount's value (millimes). NULL = uncapped. Clamps both
     *  the cart-coupon and per-line product discount. Protects high-ticket carts. */
    max_discount_cents: integer("max_discount_cents"),
    /** When true the promo zeroes shipping (orthogonal to any line discount). A
     *  free-shipping-ONLY promo carries discount_value 0 (see the relaxed CHECK). */
    grants_free_shipping: boolean("grants_free_shipping").notNull().default(false),
    /** New-customer WELCOME coupon (migration 0167): the code applies ONLY to a
     *  buyer's FIRST order (no prior non-cancelled order). Account-based (a guest
     *  has no stable identity to check), checked in `evaluateCouponEligibility`;
     *  meaningless on an auto promo (no buyer at auto-apply) — rejected in manage.ts. */
    first_order_only: boolean("first_order_only").notNull().default(false),
    /** Inline AUDIENCE rule (migration 0168): a compound rule_tree (the SAME engine
     *  as Clients→Segments — spend / anniversary / cart …) that
     *  gates WHO may use a code/URL coupon, without creating a named segment first.
     *  A promo with an audience rule is TARGETED (public opt-outs don't apply); the
     *  buyer must match it AND any explicit promotion_targets. NULL = no inline rule.
     *  Buyer-aware → code/URL triggers only (rejected on auto in manage.ts). */
    audience_rule_tree: jsonb("audience_rule_tree").$type<RuleNode>(),
    /** Higher = wins when multiple non-stackable promotions match. */
    display_priority: integer("display_priority").notNull().default(0),

    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    // Lookup paths used at runtime:
    scopeIdx: index("promotions_scope_idx").on(table.scope, table.scope_id),
    activeScheduleIdx: index("promotions_active_schedule_idx")
      .on(table.is_active, table.starts_at, table.ends_at)
      .where(sql`${table.deleted_at} is null`),
    // The scheduled-announce sweep scans only unsent, live rows (migration 0171).
    announceDueIdx: index("promotions_announce_due_idx")
      .on(table.announce_at)
      .where(sql`${table.announced_at} is null and ${table.deleted_at} is null`),
    // Coupons are case-insensitive; partial unique excludes NULL codes
    // (auto/url promos don't have codes).
    codeUniqueIdx: uniqueIndex("promotions_code_lower_unique")
      .on(sql`lower(${table.code})`)
      .where(sql`${table.code} IS NOT NULL AND ${table.deleted_at} IS NULL`),
    urlSlugUniqueIdx: uniqueIndex("promotions_url_slug_unique")
      .on(table.url_slug)
      .where(sql`${table.url_slug} IS NOT NULL AND ${table.deleted_at} IS NULL`),

    // ─── CHECK constraints — enforced at the DB to keep service code lean.
    // Percent stays in (1..100); fixed stays positive (>= 1 millime); a
    // free-shipping-ONLY promo carries discount_value 0 (migration 0042 relaxed this).
    discountBounds: check(
      "promotions_discount_bounds_chk",
      sql`(${table.discount_type} = 'percent' AND ${table.discount_value} BETWEEN 1 AND 100) OR (${table.discount_type} = 'fixed' AND ${table.discount_value} >= 1) OR (${table.grants_free_shipping} = true AND ${table.discount_value} = 0)`,
    ),
    // Optional cap on a percent discount (millimes). NULL = uncapped.
    maxDiscountBounds: check(
      "promotions_max_discount_chk",
      sql`${table.max_discount_cents} IS NULL OR ${table.max_discount_cents} >= 1`,
    ),
    // scope 'cart' / 'targeted' MUST NOT carry a scope_id (cart-wide / defined by
    // promotion_scope_targets); product/category/brand MUST. Phrased over the
    // scopes that REQUIRE scope_id (see migration 0170 for the reason). (migr 0170)
    scopeIdMatch: check(
      "promotions_scope_id_match_chk",
      sql`(${table.scope} IN ('product', 'category', 'brand') AND ${table.scope_id} IS NOT NULL) OR (${table.scope} NOT IN ('product', 'category', 'brand') AND ${table.scope_id} IS NULL)`,
    ),
    // trigger='code' requires `code`; trigger='url' requires `url_slug`;
    // trigger='auto' must have neither.
    triggerSurface: check(
      "promotions_trigger_surface_chk",
      sql`(${table.trigger_kind} = 'auto' AND ${table.code} IS NULL AND ${table.url_slug} IS NULL) OR (${table.trigger_kind} = 'code' AND ${table.code} IS NOT NULL) OR (${table.trigger_kind} = 'url' AND ${table.url_slug} IS NOT NULL)`,
    ),
    // Sanity: end must be after start.
    scheduleOrder: check(
      "promotions_schedule_order_chk",
      sql`${table.ends_at} IS NULL OR ${table.starts_at} IS NULL OR ${table.ends_at} > ${table.starts_at}`,
    ),
    // uses_count never goes negative.
    usesCountNonneg: check(
      "promotions_uses_count_nonneg_chk",
      sql`${table.uses_count} >= 0`,
    ),
  }),
);

// ───────────────────────── redemptions table ──────────────────────────────
/**
 * Append-only redemption log. One row per (promotion, order) pair recorded
 * inside the place-order transaction. Used to:
 *   - enforce `max_uses_per_user` (count rows with the same user_id)
 *   - power the admin "Performance" view (total redemptions, revenue impact)
 *   - reconcile refunds (refund workflow looks up the redemption to
 *     decrement counters if the order is cancelled)
 */
export const promotion_redemptions = pgTable(
  "promotion_redemptions",
  {
    id: id(),
    promotion_id: uuid("promotion_id").notNull(),
    order_id: uuid("order_id").notNull(),
    /** NULL for guest checkouts. */
    user_id: text("user_id"),
    /** Discount the promotion contributed to this specific order (millimes). */
    discount_cents: integer("discount_cents").notNull(),
    /** Shipping fee waived by this redemption (millimes) — 0 unless it zeroed a
     *  positive fee (free_shipping). Recorded so the Performance stats count the
     *  true cost of a free-shipping coupon (discount_cents alone is 0), and a
     *  reversal nets it out like discount_cents. Migration 0133. */
    shipping_waived_cents: integer("shipping_waived_cents").notNull().default(0),
    /**
     * True when the redemption's value was (also) FREE SHIPPING. A
     * free-shipping-only coupon contributes `discount_cents = 0`, so without
     * this marker it would escape `max_uses` / `max_uses_per_user` (which count
     * `discount_cents > 0`). Free-shipping uses are CONSUMED — the refund path
     * only reverses `discount_cents > 0` rows, so a free-ship-only redemption is
     * never given back (no counter drift). Added in migration 0116.
     */
    free_shipping: boolean("free_shipping").notNull().default(false),
    /** Snapshot of the code used (when trigger=code) — survives later code edits. */
    code_used: text("code_used"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // No standalone (promotion_id) index: both composites below lead with
    // promotion_id and serve every promotion-scoped lookup + the FK cascade —
    // promotion_redemptions_promo_idx was dropped as redundant (migration 0125).
    userIdx: index("promotion_redemptions_user_idx").on(
      table.promotion_id,
      table.user_id,
    ),
    orderIdx: index("promotion_redemptions_order_idx").on(table.order_id),
    // Powers the admin "Utilisations" detail (WHERE promotion_id = ? ORDER BY
    // created_at DESC LIMIT 50) as an index top-N. Created in migration 0041.
    promoCreatedIdx: index("promotion_redemptions_promo_created_idx").on(
      table.promotion_id,
      table.created_at.desc(),
    ),
    // DB-ONLY (baseline SQL): all three columns carry REAL FKs —
    // promotion_id → promotions CASCADE, order_id → orders CASCADE,
    // user_id → users SET NULL — but cross-module REFERENCES stay out of
    // the Drizzle schema graph, so they live only in the baseline. Same for
    // the partial UNIQUE `promotion_redemptions_promotion_order_uniq` on
    // (promotion_id, order_id) WHERE order_id IS NOT NULL AND
    // discount_cents > 0: the ORIGINAL redemption is one-per-order while
    // the append-only NEGATIVE reversal row (refund path) may coexist.
  }),
);

// ───────────────────────── promotion targets ──────────────────────────────
/**
 * Who a promotion is RESTRICTED to. A promotion with ANY target rows applies
 * ONLY to a buyer matching one of them; a promotion with NO targets is PUBLIC.
 * `target_id` is a SOFT, polymorphic link resolved by target_type: customer →
 * customer_profiles.id, segment → customer_segments.id (no cross-module FK, per
 * the module-boundary convention).
 */
export const promotion_targets = pgTable(
  "promotion_targets",
  {
    id: id(),
    promotion_id: uuid("promotion_id").notNull(),
    /** 'customer' | 'segment' (CHECK-enforced in the baseline/0042). */
    target_type: text("target_type").notNull(),
    target_id: uuid("target_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    promoIdx: index("promotion_targets_promo_idx").on(table.promotion_id),
    uniq: uniqueIndex("promotion_targets_uniq").on(
      table.promotion_id,
      table.target_type,
      table.target_id,
    ),
    lookupIdx: index("promotion_targets_lookup_idx").on(table.target_type, table.target_id),
    // DB-ONLY (migration 0042): promotion_id → promotions CASCADE FK + the
    // target_type CHECK live in the migration, outside the Drizzle graph.
  }),
);

export type PromotionTargetRow = typeof promotion_targets.$inferSelect;
export type NewPromotionTargetRow = typeof promotion_targets.$inferInsert;
/** A promotion's target type. */
export type PromotionTargetType = "customer" | "segment";

// ─────────────────────── promotion scope targets ──────────────────────────
/**
 * WHAT a MULTI-target promotion (scope='targeted') applies to — one row per
 * product / category / brand it targets (migration 0170). Distinct from
 * `promotion_targets` (WHO — customer/segment audience): this is the
 * product SET. A legacy single-scope promo (product/category/brand) carries one
 * backfilled row here mirroring its (scope, scope_id), so the resolver reads a
 * single, uniform source of truth (see promotion/queries.ts effectiveScopeTargets).
 * `target_id` is a SOFT, polymorphic link resolved by target_type (no cross-module
 * FK, per the module-boundary convention — only promotion_id CASCADEs, in the migration).
 */
export const promotion_scope_targets = pgTable(
  "promotion_scope_targets",
  {
    id: id(),
    promotion_id: uuid("promotion_id").notNull(),
    /** 'product' | 'category' | 'brand' (CHECK-enforced in migration 0170). */
    target_type: text("target_type").notNull(),
    target_id: uuid("target_id").notNull(),
    /** Categories only: also cover products in SUBcategories (the cascade). true =
     *  the established behaviour; ignored for product/brand targets. */
    include_descendants: boolean("include_descendants").notNull().default(true),
    /** Per-VARIANT narrowing (migration 0173, target_type='product' only): NULL =
     *  the target covers ALL variants of the product (today's behaviour); set = ONLY
     *  that variant. Soft link (no FK). A variant-constrained target is FAIL-CLOSED:
     *  it only discounts a line whose variant matches (see queries.ts rowsByVariant). */
    variant_id: uuid("variant_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    // Variant-aware uniqueness (migration 0173, NULLS NOT DISTINCT): (P,'product',X)
    // and (P,'product',X,variantA) can coexist, but two variant-A rows can't.
    uniq: uniqueIndex("promotion_scope_targets_uniq").on(
      table.promotion_id,
      table.target_type,
      table.target_id,
      table.variant_id,
    ),
    lookupIdx: index("promotion_scope_targets_lookup_idx").on(table.target_type, table.target_id),
    // DB-ONLY (migration 0170/0173): promotion_id → promotions CASCADE FK, the
    // target_type CHECK, the variant-only-for-product CHECK, and the NULLS NOT
    // DISTINCT on the uniq live in the migrations, outside the Drizzle graph.
  }),
);

export type PromotionScopeTargetRow = typeof promotion_scope_targets.$inferSelect;
export type NewPromotionScopeTargetRow = typeof promotion_scope_targets.$inferInsert;
/** A scope target's entity type (the WHAT). */
export type PromotionScopeTargetType = "product" | "category" | "brand";

// ───────────────────────── types ──────────────────────────────────────────
export type PromotionRow = typeof promotions.$inferSelect;
export type NewPromotionRow = typeof promotions.$inferInsert;
export type PromotionRedemptionRow = typeof promotion_redemptions.$inferSelect;
export type NewPromotionRedemptionRow = typeof promotion_redemptions.$inferInsert;
export type PromotionScope = (typeof promotionScopeEnum.enumValues)[number];
export type PromotionTrigger = (typeof promotionTriggerEnum.enumValues)[number];
export type PromotionDiscountType =
  (typeof promotionDiscountTypeEnum.enumValues)[number];
