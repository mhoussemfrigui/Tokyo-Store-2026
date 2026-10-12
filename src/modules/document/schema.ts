import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Gapless sequential counters for fiscal/logistics documents (factures, avoirs,
 * bons de livraison). One row per (kind, period); `current_value` is bumped
 * atomically via `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which locks the
 * row so concurrent issuance can't skip or reuse a number.
 *
 *   kind   — 'invoice' | 'credit_note' | 'delivery_note'
 *   period — the reset bucket the number lives in (e.g. the year "2026"); the
 *            issued number embeds it, so per-year reset stays gapless WITHIN a
 *            year. Use a constant period to never reset.
 *
 * The formatted number ("FA-2026-000042") is stamped onto the order
 * (orders.invoice_number / credit_note_number / delivery_note_number), each
 * with a partial-unique index — this table only hands out the next integer.
 */
export const document_sequences = pgTable(
  "document_sequences",
  {
    id: id(),
    kind: text("kind").$type<DocumentKind>().notNull(),
    period: text("period").notNull(),
    current_value: bigint("current_value", { mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    kindPeriodUniq: uniqueIndex("document_sequences_kind_period_uniq").on(table.kind, table.period),
    kindIdx: index("document_sequences_kind_idx").on(table.kind),
  }),
);

export type DocumentSequenceRow = typeof document_sequences.$inferSelect;
export type NewDocumentSequenceRow = typeof document_sequences.$inferInsert;

/** Document kinds that draw a gapless number. */
export const DOCUMENT_KINDS = ["invoice", "credit_note", "delivery_note"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
