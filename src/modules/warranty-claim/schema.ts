import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Warranty claims (SAV / RMA). A claim is raised against ONE sold line
 * (`order_item_id`) that a customer brings in for service — the watch itself, not
 * a whole basket — so, unlike a return (header + lines), a claim is a single row
 * per unit. An order can carry several claims.
 *
 *   open → in_repair | awaiting_parts (interchange) → resolved | rejected
 *
 * The warranty COVERAGE at claim time is SNAPSHOTTED here (`warranty_months` /
 * `warranty_label` / `covered_until` / `was_covered`) — computed from the order
 * line's own snapshot via `computeOrderLineWarranty` — so the record always shows
 * what the customer was actually entitled to, even after the product's warranty
 * config later changes. Money (a warranty refund) stays decoupled in
 * `order_refunds`; a claim records the SERVICE case only.
 *
 * `external_ref` links the claim to an external ERP/repair-shop record for two-way
 * sync (unique when set — migration). Catalog links (`product_id` / `variant_id`)
 * are SOFT (no FK — same cross-module rule as order_items).
 */
export const warrantyClaimStatusEnum = pgEnum("warranty_claim_status", [
  "open",
  "in_repair",
  "awaiting_parts",
  "resolved",
  "rejected",
]);

/**
 * Client-safe taxonomy (reason codes, status + resolution vocab, labels, the
 * transition graph) lives in `./claim-taxonomy` so "use client" panels can import
 * it without pulling drizzle into the browser bundle; re-exported here for servers.
 */
export {
  WARRANTY_REASON_CODES,
  WARRANTY_REASON_LABELS,
  WARRANTY_CLAIM_STATUSES,
  WARRANTY_CLAIM_STATUS_LABELS,
  WARRANTY_CLAIM_TERMINAL,
  WARRANTY_CLAIM_TRANSITIONS,
  WARRANTY_RESOLUTIONS,
  WARRANTY_RESOLUTION_LABELS,
  WARRANTY_CLAIM_STATUS_TONES,
  type WarrantyReasonCode,
  type WarrantyClaimStatus,
  type WarrantyResolution,
} from "./claim-taxonomy";

export const warranty_claims = pgTable(
  "warranty_claims",
  {
    id: id(),
    order_id: uuid("order_id").notNull(),
    /** The sold line under service (links the claim to what was bought). */
    order_item_id: uuid("order_item_id").notNull(),
    /** Catalog soft-links (no FK — cross-module rule). variant null = simple. */
    product_id: uuid("product_id").notNull(),
    variant_id: text("variant_id"),
    /** Denormalized product name snapshot for lists without a join. */
    product_name: text("product_name").notNull(),
    status: warrantyClaimStatusEnum("status").notNull().default("open"),
    /** Structured motive (WARRANTY_REASON_CODES) for SAV stats grouping. */
    reason_code: text("reason_code"),
    /** Free-text customer-stated fault. */
    reason: text("reason"),
    /** Operator internal note (distinct from the customer reason). */
    comment: text("comment"),
    /** How the claim ended (WARRANTY_RESOLUTIONS) — set on resolve/reject. */
    resolution: text("resolution"),
    /** Free-text note on the resolution. */
    resolution_note: text("resolution_note"),
    /** Coverage SNAPSHOT at claim time (from the order-line warranty snapshot). */
    warranty_months: integer("warranty_months"),
    warranty_label: text("warranty_label"),
    covered_until: timestamp("covered_until", { withTimezone: true }),
    /** Was the item still under warranty when the claim was opened? (audit / stats) */
    was_covered: boolean("was_covered").notNull().default(false),
    /** External ERP / repair-shop record id (unique when set — migration). */
    external_ref: text("external_ref"),
    created_by_user_id: text("created_by_user_id"),
    processed_by_user_id: text("processed_by_user_id"),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    orderIdx: index("warranty_claims_order_idx").on(table.order_id),
    orderItemIdx: index("warranty_claims_order_item_idx").on(table.order_item_id),
    statusIdx: index("warranty_claims_status_idx").on(table.status),
    // DB-ONLY (migration 0166): a created_at index backs the console's time-window
    // list, and a partial-unique on external_ref (WHERE external_ref IS NOT NULL)
    // enforces one claim per ERP ref — neither declared here (see order_returns).
  }),
);

export type WarrantyClaimRow = typeof warranty_claims.$inferSelect;
export type NewWarrantyClaimRow = typeof warranty_claims.$inferInsert;
