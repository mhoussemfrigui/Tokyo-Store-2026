import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Processed-webhook ledger — the idempotency / replay guard for payment
 * gateways.
 *
 * Each payment confirmation (ClicToPay / Flouci) "claims" an event here
 * before it transitions an order. The unique `(provider, event_ref,
 * target_status)` index makes the claim atomic: a retry, a replay, or two
 * concurrent deliveries of the same event collapse to a single processing —
 * the second `INSERT ... ON CONFLICT DO NOTHING` returns no row and the
 * handler skips. This closes both the replay hole (independent of the
 * timestamp window) and the check-then-act race in the status short-circuit.
 *
 * `event_ref` is the gateway's payment / transaction id (ClicToPay SMT order
 * id, Flouci `payment_id`); no gateway sends a standalone
 * event id, and signatures are re-generated per retry so they can't key it.
 * `target_status` is part of the key (forward-compat: a future `paid → refunded`
 * for the same payment would not be deduped against the original `paid`). NOTE:
 * today only `"paid"` is ever claimed — the integrated gateways (ClicToPay
 * `dynamicCallbackUrl`, Flouci status callback) push only payment confirmation;
 * refunds/cancellations are recorded out-of-band by an operator, not via a
 * gateway webhook. So `'cancelled'`/`'refunded'` targets are reserved, not
 * currently produced.
 *
 * `order_id` is a text soft-FK per the cross-module rule (no enforced FK).
 */
export const webhook_events = pgTable(
  "webhook_events",
  {
    id: id(),
    /** 'flouci' | 'clictopay' (legacy rows may carry 'konnect'). */
    provider: text("provider").notNull(),
    /** Gateway payment/transaction reference (also the order-lookup key). */
    event_ref: text("event_ref").notNull(),
    /** Mapped target order status. Only `"paid"` is claimed today;
     *  `'cancelled'`/`'refunded'` are reserved (no gateway pushes them — see above). */
    target_status: text("target_status").notNull(),
    /** Soft-FK to the order this event resolved to (null if unmatched). */
    order_id: text("order_id"),
    ...timestamps(),
  },
  (table) => ({
    providerRefStatusUniq: uniqueIndex("webhook_events_provider_ref_status_uniq").on(
      table.provider,
      table.event_ref,
      table.target_status,
    ),
  }),
);

export type WebhookEventRow = typeof webhook_events.$inferSelect;
export type NewWebhookEventRow = typeof webhook_events.$inferInsert;
