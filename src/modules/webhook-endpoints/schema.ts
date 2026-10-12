import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, timestamps } from "@/lib/db/columns";

/**
 * OUTBOUND webhooks — the ERP-push subsystem. Distinct from `src/modules/webhook`
 * (which is the INBOUND payment-idempotency ledger). Two tables:
 *
 *   webhook_endpoints  — admin-registered subscriptions: where to POST, which
 *                        events, and the per-endpoint HMAC signing secret
 *                        (ENCRYPTED at rest — unlike an API key we must REPLAY it
 *                        to sign every delivery, so it can't be a one-way hash).
 *   webhook_deliveries — the durable delivery QUEUE (the event bus is in-process
 *                        + ephemeral, so the durability boundary is a DB row). A
 *                        subscriber enqueues one row per (event × subscribed
 *                        endpoint); the cron drain claims + POSTs with retry.
 *
 * Modeled on `api_keys` (endpoints) + `email_logs` (the retrying queue).
 */
export const webhook_endpoints = pgTable(
  "webhook_endpoints",
  {
    id: id(),
    name: text("name").notNull(),
    /** Destination URL (https recommended; SSRF-guarded at delivery). */
    url: text("url").notNull(),
    /** AES-256-GCM-encrypted HMAC signing secret (see @/lib/crypto/secrets). */
    secret_enc: text("secret_enc").notNull(),
    /** Non-secret leading slice of the secret (e.g. "whsec_a1b2…") for the UI. */
    prefix: text("prefix").notNull(),
    /** Subscribed event names, or ["*"] for every event. */
    event_types: text("event_types").array().notNull().default(sql`'{}'`),
    /** false = paused (kept, no deliveries enqueued). */
    is_active: boolean("is_active").notNull().default(true),
    description: text("description"),
    /** Admin user id who created it. */
    created_by: text("created_by"),
    /** null = active; set = revoked (kept for audit, never reactivated). */
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    activeIdx: index("webhook_endpoints_active_idx").on(table.revoked_at),
  }),
);

export type WebhookEndpointRow = typeof webhook_endpoints.$inferSelect;

/** Delivery/queue status. Mirrors `email_logs` (pending = claimed-in-flight). */
export type WebhookDeliveryStatus = "queued" | "pending" | "delivered" | "failed";

export const webhook_deliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    /** FK to webhook_endpoints (same module → real FK ON DELETE CASCADE in the
     *  migration). */
    endpoint_id: uuid("endpoint_id").notNull(),
    /** The event that triggered this delivery (e.g. "order.paid"). */
    event_name: text("event_name").notNull(),
    /** The fully-hydrated JSON body that will be POSTed + signed. */
    payload: jsonb("payload").notNull(),
    /** queued | pending | delivered | failed. */
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(5),
    /** Earliest time the drain may (re)attempt this row. */
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Last HTTP status seen (null = never reached the endpoint). */
    response_status: integer("response_status"),
    error_message: text("error_message"),
    delivered_at: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    // The drain's hot path: due rows in (status, next_attempt_at) order.
    dueIdx: index("webhook_deliveries_status_next_idx").on(table.status, table.next_attempt_at),
    endpointIdx: index("webhook_deliveries_endpoint_idx").on(table.endpoint_id, table.created_at),
    // Retention purge (WHERE created_at < cutoff): BRIN over the append-ordered
    // created_at — a few KB with negligible INSERT overhead, turning the daily
    // sweep's range scan into a block-range skip instead of a full seq scan.
    retentionIdx: index("webhook_deliveries_created_at_brin").using("brin", table.created_at),
  }),
);

export type WebhookDeliveryRow = typeof webhook_deliveries.$inferSelect;
