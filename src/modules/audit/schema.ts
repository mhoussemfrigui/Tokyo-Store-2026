import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Audit module.
 *
 * Notable exception to the "no JSON" rule: the `metadata` column is
 * structured data ABOUT an action (diff of changed fields, request IP,
 * etc.), not content. JSONB here is appropriate — it's append-only,
 * never queried as content, and the shape is owned by the subscriber.
 *
 * `actor_user_id` and `target_*` are soft links (no FKs) — same
 * cross-module rule.
 *
 * `severity` (debug|info|warn|error) is written once at insert from
 * `severityFor(event_name)` (src/events/severity.ts) so the admin UI can
 * filter by level and the long-tail subscriber can drop debug-level rows.
 *
 * INDEX SOURCE OF TRUTH: the btree indexes below are declared here AND created
 * by migration 0000/0079. ONE companion index is intentionally NOT modelled in
 * Drizzle (the repo never round-trips `drizzle-kit generate` — see
 * guard-generate.ts): `audit_created_at_brin` (BRIN, pages_per_range=32) which
 * drives the retention purge's range scan over this append-only, time-ordered
 * table. Migration 0079 drops the redundant single-column event/actor btrees
 * (shadowed by the composites) + the ASC created_at btree + the unused metadata
 * GIN, all of which only amplified writes on the hottest-insert table.
 */

export const audit_log = pgTable(
  "audit_log",
  {
    id: id(),
    event_name: text("event_name").notNull(),     // e.g. "user.created", "product.deleted"
    actor_user_id: text("actor_user_id"),         // who did it (null = system / public)
    actor_ip: text("actor_ip"),
    target_type: text("target_type"),             // "user", "product", "page", ...
    target_id: text("target_id"),                 // the affected row's id
    summary: text("summary"),                     // human-readable one-liner
    severity: text("severity").notNull().default("info"), // debug|info|warn|error
    metadata: jsonb("metadata"),                  // structured details (NOT content)
    ...timestamps(),
  },
  (table) => ({
    // (target_type, target_id) — "show every row about this entity".
    targetIdx: index("audit_target_idx").on(table.target_type, table.target_id),
    // (created_at DESC, id DESC) — drives the retention purge's ORDER BY
    // created_at AND the date-range Journal filter (created_at BETWEEN … ORDER
    // BY id DESC). The BRIN companion (raw-SQL) covers the bulk purge range.
    createdIdIdx: index("audit_created_id_idx").on(table.created_at.desc(), table.id.desc()),
    // (col, id DESC) composites — the list keysets on id (uuid v7), so each
    // filterable column leads + id DESC ⇒ filtered pages are index range-scans.
    eventRecentIdx: index("audit_event_recent_idx").on(table.event_name, table.id.desc()),
    actorRecentIdx: index("audit_actor_recent_idx").on(table.actor_user_id, table.id.desc()),
    severityRecentIdx: index("audit_severity_recent_idx").on(table.severity, table.id.desc()),
  }),
);

export type AuditLogRow = typeof audit_log.$inferSelect;
export type NewAuditLogRow = typeof audit_log.$inferInsert;
