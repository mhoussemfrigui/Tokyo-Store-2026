import { sql } from "drizzle-orm";
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

import { id, softDelete, timestamps } from "@/lib/db/columns";
import type { RuleNode } from "@/lib/promotions/rule-tree";

/**
 * Per-template admin overrides + enable flag for the transactional email
 * system. The CODE registry (`./templates`) is the source of truth for which
 * emails exist and their default subject/body; a row here OPTIONALLY overrides
 * the subject and/or HTML for one `template_key`, and toggles whether the email
 * sends at all. No row ⇒ the code default, enabled.
 *
 * Only operator-tunable copy lives in the DB — the variable contract, trigger
 * wiring, and layout stay in code, so the system can't be broken from the UI.
 */
export const email_template_overrides = pgTable(
  "email_template_overrides",
  {
    id: id(),
    /** Registry key, e.g. "order_confirmation". Unique. */
    template_key: text("template_key").notNull(),
    /** Subject override (may contain {{vars}}). NULL ⇒ use the code default. */
    subject: text("subject"),
    /** HTML body override (may contain {{vars}}). NULL ⇒ use the code default. */
    html: text("html"),
    /** When false, the email is suppressed entirely (per-email on/off toggle). */
    is_enabled: boolean("is_enabled").notNull().default(true),
    ...timestamps(),
  },
  (table) => ({
    keyUniq: uniqueIndex("email_template_overrides_key_uniq").on(table.template_key),
  }),
);

export type EmailTemplateOverrideRow = typeof email_template_overrides.$inferSelect;
export type NewEmailTemplateOverrideRow = typeof email_template_overrides.$inferInsert;

/**
 * Per-flow (automation) enable override. The CODE registry (`./flows.registry`)
 * is the source of truth for which automations exist and their `default_enabled`;
 * a row here OPTIONALLY flips one `flow_key` on/off from the admin Workflows tab.
 * No row ⇒ the registry default. Mirrors `email_template_overrides`. (0045)
 */
export const email_flows = pgTable(
  "email_flows",
  {
    id: id(),
    flow_key: text("flow_key").notNull(),
    is_enabled: boolean("is_enabled").notNull().default(true),
    ...timestamps(),
  },
  (table) => ({
    keyUniq: uniqueIndex("email_flows_key_uniq").on(table.flow_key),
  }),
);
export type EmailFlowRow = typeof email_flows.$inferSelect;
export type NewEmailFlowRow = typeof email_flows.$inferInsert;

/**
 * Admin-composed bulk campaign (the "Manual send" tab). One row per blast; the
 * actual per-recipient sends are `email_logs` rows linked via `campaign_id`.
 * Sends are enqueued (status='queued') and paced by the mailing cron drain. (0045)
 */
export const email_campaigns = pgTable(
  "email_campaigns",
  {
    id: id(),
    name: text("name"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** Optional source template key when composed from a template. */
    template_key: text("template_key"),
    /** segment | newsletter | marketing_optin | addresses | rule (CHECK in migration). */
    audience_kind: text("audience_kind").notNull(),
    /** Segment id for audience_kind='segment'; NULL otherwise. */
    audience_ref: text("audience_ref"),
    /** Newline-separated pasted addresses for audience_kind='addresses'. */
    audience_addresses: text("audience_addresses"),
    /** Inline compound audience rule for audience_kind='rule' — the same RuleNode
     *  shape promotions store, resolved by the shared segment SQL engine. (0197) */
    audience_rule_tree: jsonb("audience_rule_tree").$type<RuleNode>(),
    /** draft | queued | sending | sent | failed (CHECK in migration). */
    status: text("status").notNull().default("draft"),
    total_recipients: integer("total_recipients").notNull().default(0),
    /** Admin user id who launched it. */
    created_by: text("created_by"),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    statusIdx: index("email_campaigns_status_idx").on(table.status),
    createdIdx: index("email_campaigns_created_idx").on(table.created_at),
  }),
);
export type EmailCampaignRow = typeof email_campaigns.$inferSelect;
export type NewEmailCampaignRow = typeof email_campaigns.$inferInsert;

/**
 * One row per send ATTEMPT — the audit log AND the durable send queue. Immediate
 * transactional sends write a row that flips pending→sent/failed; bulk sends
 * (campaigns + large automation fan-outs) insert status='queued' rows that the
 * `/api/cron/mailing` drain claims (FOR UPDATE SKIP LOCKED), paces, and retries
 * with backoff. Sensitive templates (password reset, verification, invitation)
 * store `[redacted]` for body+variables so tokens never land in the DB.
 * Retention-pruned (180d, pinned excluded). (0045)
 */
export const email_logs = pgTable(
  "email_logs",
  {
    id: id(),
    /** Registry template key, or NULL for ad-hoc/campaign compose sends. */
    template_key: text("template_key"),
    to_email: text("to_email").notNull(),
    from_email: text("from_email"),
    subject: text("subject"),
    /** Rendered HTML, or '[redacted]' for sensitive templates. */
    body: text("body"),
    /** Resolved provider name at send time (resend|smtp|internal|console). */
    provider: text("provider"),
    /** pending | queued | sent | failed (CHECK in migration). */
    status: text("status").notNull().default("pending"),
    error_message: text("error_message"),
    provider_message_id: text("provider_message_id"),
    /** account | commerce | marketing (from the template/flow). */
    category: text("category"),
    /** Automation flow that triggered it, if any. */
    flow_key: text("flow_key"),
    /** Campaign this send belongs to (FK → email_campaigns, SET NULL). */
    campaign_id: uuid("campaign_id"),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(3),
    /** Next retry time for queued rows (backoff); NULL = send asap / done. */
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }),
    /** Scalar+html vars for resend, or NULL when redacted. */
    variables: jsonb("variables").$type<Record<string, unknown>>(),
    /** Free-form (audience descriptor, actor, ip…). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    pinned_at: timestamp("pinned_at", { withTimezone: true }),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    // Drain hot path: WHERE status='queued' AND next_attempt_at due.
    statusNextIdx: index("email_logs_status_next_idx").on(table.status, table.next_attempt_at),
    createdIdx: index("email_logs_created_idx").on(table.created_at),
    categoryIdx: index("email_logs_category_idx").on(table.category),
    // Per-campaign progress read (status breakdown) + the FK SET-NULL fan-out.
    campaignIdx: index("email_logs_campaign_idx").on(table.campaign_id),
    // DB-ONLY (migration 0047): trigram GIN on lower(to_email) for the Logs-tab
    // substring filter (a leading-wildcard LIKE a plain btree can't serve).
  }),
);
export type EmailLogRow = typeof email_logs.$inferSelect;
export type NewEmailLogRow = typeof email_logs.$inferInsert;

/**
 * Idempotency ledger for automation sends — one row per (flow, dedup_key). A flow
 * inserts FIRST with onConflictDoNothing().returning(); an empty return means it
 * already fired and the send is skipped. Kept SEPARATE from `email_logs` (which is
 * retention-pruned) so the correctness key is never mis-pruned. Mirrors the
 * `coin_tx_earn_per_order_uq` idempotency idiom. (0045)
 */
export const mailing_sends = pgTable(
  "mailing_sends",
  {
    id: id(),
    flow_key: text("flow_key").notNull(),
    /** Flow-specific natural key, e.g. "<profileId>:<year>" (birthday). */
    dedup_key: text("dedup_key").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    uniq: uniqueIndex("mailing_sends_flow_dedup_uniq").on(table.flow_key, table.dedup_key),
    // Retention sweep prunes WHERE created_at < cutoff (migration 0047).
    createdIdx: index("mailing_sends_created_idx").on(table.created_at),
  }),
);
export type MailingSendRow = typeof mailing_sends.$inferSelect;
export type NewMailingSendRow = typeof mailing_sends.$inferInsert;

/**
 * Email suppression list — hard bounces / spam complaints. The marketing-consent
 * gate consults it (case-insensitively) so a known-bad address is never
 * re-emailed. Provider bounce-webhook ingestion lands later; the table + gate
 * exist from day one. (0045)
 */
export const email_suppressions = pgTable(
  "email_suppressions",
  {
    id: id(),
    email: text("email").notNull(),
    /** bounce | complaint | manual */
    reason: text("reason").notNull().default("manual"),
    source: text("source"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  () => ({
    // DB-ONLY (migration 0047): UNIQUE on lower(email) — case-insensitive, so the
    // gate's lower(email) lookup is sargable and case-variant dupes can't insert
    // (mirrors the newsletter lower(email) convention; not declared here).
  }),
);
export type EmailSuppressionRow = typeof email_suppressions.$inferSelect;
export type NewEmailSuppressionRow = typeof email_suppressions.$inferInsert;
