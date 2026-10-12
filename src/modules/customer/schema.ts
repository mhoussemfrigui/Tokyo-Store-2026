import {
  boolean,
  char,
  date,
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
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";
import type { RuleNode } from "@/lib/promotions/rule-tree";

/**
 * Customer module — profile + addresses.
 *
 * The link to `users` lives in `src/associations/customer-user.ts`, NOT here.
 * That keeps the customer module independent — we could even host customers
 * elsewhere later (CRM sync) without touching auth.
 *
 * One-default-per-customer IS enforced at the DB level by two partial unique
 * indexes — `addresses_one_default_shipping` / `addresses_one_default_billing`
 * (defined in the baseline SQL's raw tail, outside the Drizzle snapshot, so
 * drizzle-kit doesn't emit a duplicate CREATE INDEX). Because the constraint is
 * real, the add/update-address workflows MUST clear the sibling default BEFORE
 * writing a new default (never hold two `true` rows at once), all inside one
 * transaction. See set-default-address.ts for the canonical ordering.
 */

export const addressTypeEnum = pgEnum("address_type", ["shipping", "billing", "both"]);

export const customer_profiles = pgTable(
  "customer_profiles",
  {
    id: id(),
    first_name: text("first_name").notNull(),
    last_name: text("last_name").notNull(),
    phone: text("phone"),
    /**
     * Digits-only mirror of `phone` (maintained by customerService on
     * insert/update via normalizePhoneDigits) so admin search + guest↔customer
     * matching can compare numbers entered in different formats without a
     * per-row functional scan. NULL when phone is NULL/blank. See migration 0032.
     */
    phone_normalized: text("phone_normalized"),
    marketing_opt_in: boolean("marketing_opt_in").notNull().default(false),
    /**
     * Promo gating: when true, PUBLIC promotions (those with no targets) are
     * suppressed for this buyer; explicitly-targeted promos still apply. ADMIN-set
     * only — flipped on the admin customer detail page via setCustomerPromoOptOutAction
     * (there is no customer self-service for this). Migration 0042.
     */
    promo_opt_out: boolean("promo_opt_out").notNull().default(false),
    /** Free-form notes only visible to admins. Never surfaced to the customer. */
    admin_notes: text("admin_notes"),
    /**
     * Optional birthday — a pure DATE (no time/zone), stored 'YYYY-MM-DD'.
     * Customer-set on the storefront account page (shown with a hint teasing
     * birthday gifts) and admin-editable on the customer detail page. Powers the
     * birthday_month / birthday_today / birthday_anniversary segment leaves
     * (src/lib/promotions/rule-leaves.ts) so admins can target a promotion at
     * customers around their birthday. NULL until the customer/admin provides it.
     * Migration 0044.
     * `mode: "string"` (the default) keeps it a plain 'YYYY-MM-DD' string — never
     * a Date object — so the matcher's month slice is safe and TZ-free.
     */
    birthday: date("birthday", { mode: "string" }),
    /**
     * Optional gender — a small closed set ('female' | 'male' | 'other'), pinned by
     * a CHECK in migration 0158 (NULL = not provided). Customer-set on the storefront
     * account page and admin-editable on the customer detail page. Used as a
     * SEGMENTATION dimension.
     */
    gender: text("gender"),
    /**
     * The external ERP's stable id for this customer — the two-way link (same
     * pattern as products/orders `external_ref`). Set by the `/api/customers`
     * upsert; partial-unique over LIVE rows only (a soft-deleted profile frees
     * its ref). Migration 0118. NULL until the ERP links it.
     */
    external_ref: text("external_ref"),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    createdAtIdx: index("customer_profiles_created_at_idx").on(table.created_at),
    // Partial btree over the digits-normalized phone backing the EQUALITY /
    // anchored-prefix guest↔customer matching path (migration 0032). The admin
    // phone SEARCH uses a leading-wildcard ILIKE, which a btree cannot serve —
    // that is backed by the trigram GIN index added in migration 0037
    // (customer_profiles_phone_norm_trgm), alongside the first_name/last_name/
    // users.email trigram indexes. Those GIN indexes live in the migration only,
    // matching the products/media/blog trigram convention (not declared here).
    phoneNormIdx: index("customer_profiles_phone_norm_idx")
      .on(table.phone_normalized)
      .where(sql`${table.phone_normalized} is not null`),
    // DB-ONLY (migration 0047), kept out of the Drizzle snapshot like the trigram
    // indexes above: `customer_profiles_marketing_optin_idx` (partial, backs the
    // marketing-audience / blast scans) and `customer_profiles_birthday_md_idx`
    // (partial functional on extract(month/day) of birthday, backs the daily
    // birthday cron — extract is IMMUTABLE, unlike to_char).
  }),
);

export const addresses = pgTable(
  "addresses",
  {
    id: id(),
    // Belongs-to: customer profile. Stays inside the module — no auth FK here.
    customer_profile_id: uuid("customer_profile_id").notNull(),
    type: addressTypeEnum("type").notNull().default("both"),
    label: text("label"), // user-friendly tag: "Home", "Work", "Mum's place"
    full_name: text("full_name").notNull(),
    company: text("company"),
    street_line1: text("street_line1").notNull(),
    street_line2: text("street_line2"),
    city: text("city").notNull(),
    region: text("region"), // governorate in Tunisia
    postal_code: text("postal_code"),
    country: char("country", { length: 2 }).notNull().default("TN"),
    phone: text("phone"),
    is_default_shipping: boolean("is_default_shipping").notNull().default(false),
    is_default_billing: boolean("is_default_billing").notNull().default(false),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    customerIdx: index("addresses_customer_idx").on(table.customer_profile_id),
  }),
);

/**
 * Reusable customer groupings for promotion + mailing targeting (migration 0042).
 *   - kind='manual'  → an explicit member list (customer_segment_members).
 *   - kind='dynamic' → resolved at evaluate-time (no member rows). The PRIMARY engine
 *     since Phase 6 (migr 0161) is the compound `rule_tree` — a boolean AND/OR/NOT tree
 *     of leaf conditions (panier / démographie / anniversaires) defined in
 *     src/lib/promotions/rule-leaves.ts and compiled to SQL
 *     by rule-tree-sql.ts. The legacy single `rule` string is a fallback read via
 *     legacyRuleToTree(rule) when rule_tree IS NULL. Resolvers: segments.ts
 *     (per-checkout), audience.ts (mailing/promo), segment-stats.ts.
 */
export const customer_segments = pgTable("customer_segments", {
  id: id(),
  name: text("name").notNull(),
  /** 'manual' | 'dynamic' (CHECK-enforced in migration 0042). */
  kind: text("kind").notNull().default("manual"),
  /** Legacy single dynamic-rule key (NULL for manual + new compound segments). Kept
   *  for back-compat: read via `legacyRuleToTree(rule)` when rule_tree IS NULL. */
  rule: text("rule"),
  /** Compound AND/OR rule TREE (migration 0161, Phase 6) — the successor to `rule`.
   *  NULL = a manual segment or a legacy single-rule dynamic one. See
   *  src/lib/promotions/rule-tree.ts + rule-leaves.ts. */
  rule_tree: jsonb("rule_tree").$type<RuleNode>(),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps(),
  ...softDelete(),
});

export const customer_segment_members = pgTable(
  "customer_segment_members",
  {
    id: id(),
    segment_id: uuid("segment_id").notNull(),
    customer_profile_id: uuid("customer_profile_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    uniq: uniqueIndex("customer_segment_members_uniq").on(
      table.segment_id,
      table.customer_profile_id,
    ),
    profileIdx: index("customer_segment_members_profile_idx").on(table.customer_profile_id),
    // DB-ONLY (migration 0042): segment_id → customer_segments CASCADE FK.
  }),
);

export type CustomerProfileRow = typeof customer_profiles.$inferSelect;
export type NewCustomerProfileRow = typeof customer_profiles.$inferInsert;
export type AddressRow = typeof addresses.$inferSelect;
export type NewAddressRow = typeof addresses.$inferInsert;
export type AddressType = (typeof addressTypeEnum.enumValues)[number];
export type CustomerSegmentRow = typeof customer_segments.$inferSelect;
export type NewCustomerSegmentRow = typeof customer_segments.$inferInsert;
export type CustomerSegmentMemberRow = typeof customer_segment_members.$inferSelect;
export type SegmentKind = "manual" | "dynamic";
