import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Tokyo Care — a bonus / extended-warranty PROTECTION plan the operator creates
 * and sells as a paid add-on on eligible products. EVERYTHING is admin-controlled
 * (characteristics + pricing + eligibility); nothing is hardcoded. A plan is
 * ACTIVATED on products and/or categories via `care_plan_scope_targets`, with
 * per-product include/exclude + price overrides via the `product_care`
 * association (edited from the product form's « Tokyo Care » sub-tab).
 *
 * Owns its own table; products/categories are SOFT polymorphic links (no cross-
 * module FK, per the module-boundary convention). Money is integer MILLIMES
 * (src/lib/price.ts). `pricing_mode` selects which column drives the charge:
 *   - 'flat'    → `price_cents` (a fixed add-on price), or
 *   - 'percent' → `price_bps` basis points of the product price (700 = 7%),
 * with the computed amount rounded to `price_round_to_cents` (0 = none) and
 * floored at `min_charge_cents`. The charge is ALWAYS re-validated + recomputed
 * server-side at checkout — the snapshot/display amount is never trusted.
 */
export const care_plans = pgTable(
  "care_plans",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Stable opaque code from an external system (ERP/PIM) for sync by reference.
     *  Unique among LIVE plans (partial index). Empty → NULL. */
    external_ref: text("external_ref"),
    /** Short marketing line shown under the plan label on the PDP/cart. */
    description: text("description"),
    /** Coverage duration in months (the extension de garantie). */
    duration_months: integer("duration_months").notNull().default(12),
    /** 'flat' (price_cents) | 'percent' (price_bps of product price). CHECK in migration. */
    pricing_mode: text("pricing_mode").notNull().default("percent"),
    /** Flat add-on price in MILLIMES (used when pricing_mode='flat'). */
    price_cents: integer("price_cents").notNull().default(0),
    /** Percentage of the product price in BASIS POINTS (pricing_mode='percent'; 700 = 7%). */
    price_bps: integer("price_bps").notNull().default(0),
    /** Round the computed charge to this MILLIMES step (0 = none; 10000 = nearest 10 TND). */
    price_round_to_cents: integer("price_round_to_cents").notNull().default(0),
    /** Floor the computed charge at this MILLIMES amount (0 = no floor). */
    min_charge_cents: integer("min_charge_cents").notNull().default(0),
    /** Eligibility — only offer on products priced at/above this (MILLIMES; 0 = no floor). */
    min_product_price_cents: integer("min_product_price_cents").notNull().default(0),
    /** Eligibility — only offer on products that carry a (base) warranty. */
    require_warranty: boolean("require_warranty").notNull().default(true),
    /** Eligibility — product conditions this plan applies to ('new'|'used'|'refurbished').
     *  NULL / empty = all conditions. */
    applicable_conditions: jsonb("applicable_conditions").$type<string[]>(),
    /** Coverage bullet points shown on the PDP/cart. */
    perks: jsonb("perks").$type<string[]>(),
    /** Curated lucide icon key (see @/lib/catalog/chip-icons); NULL = a per-type default. */
    icon: text("icon"),
    is_active: boolean("is_active").notNull().default(true),
    /** Higher shows first (the storefront offers plans by priority DESC, then created_at ASC). */
    display_priority: integer("display_priority").notNull().default(0),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    // Tombstoned plans free their slug for reuse (mirrors brands/collections).
    slugUnique: uniqueIndex("care_plans_slug_unique")
      .on(table.slug)
      .where(sql`${table.deleted_at} is null`),
    externalRefUnique: uniqueIndex("care_plans_external_ref_unique")
      .on(table.external_ref)
      .where(sql`${table.external_ref} is not null and ${table.deleted_at} is null`),
  }),
);

/**
 * Where a care plan is ACTIVATED — products and/or categories. Mirrors
 * `promotion_scope_targets`: `target_id` is a SOFT polymorphic link resolved by
 * `target_type` (no cross-module FK). A category target with include_descendants
 * covers products filed on any descendant leaf (the cascade). Only `care_plan_id`
 * CASCADEs; the `target_type` CHECK lives in the migration.
 */
export const care_plan_scope_targets = pgTable(
  "care_plan_scope_targets",
  {
    id: id(),
    care_plan_id: uuid("care_plan_id").notNull(),
    /** 'product' | 'category' (CHECK-enforced in migration). */
    target_type: text("target_type").notNull(),
    target_id: uuid("target_id").notNull(),
    /** Categories only: also cover products in SUBcategories. Ignored for products. */
    include_descendants: boolean("include_descendants").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    uniq: uniqueIndex("care_scope_uniq").on(
      table.care_plan_id,
      table.target_type,
      table.target_id,
    ),
    lookupIdx: index("care_scope_lookup_idx").on(table.target_type, table.target_id),
    planIdx: index("care_scope_plan_idx").on(table.care_plan_id),
    // DB-ONLY (migration): care_plan_id → care_plans CASCADE FK + target_type CHECK.
  }),
);

export type CarePlanRow = typeof care_plans.$inferSelect;
export type NewCarePlanRow = typeof care_plans.$inferInsert;
export type CarePlanScopeTargetRow = typeof care_plan_scope_targets.$inferSelect;
export type NewCarePlanScopeTargetRow = typeof care_plan_scope_targets.$inferInsert;
export type CareScopeTargetType = "product" | "category";
export type CarePricingMode = "flat" | "percent";
