import "server-only";

import { sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { document_sequences, type DocumentKind } from "./schema";

/** Default prefixes when the operator hasn't set one in the settings. */
export const DOCUMENT_PREFIX_DEFAULTS: Record<DocumentKind, string> = {
  invoice: "FA",
  credit_note: "AV",
  delivery_note: "BL",
};

class DocumentService {
  /**
   * Atomically draw the next gapless integer for (kind, period) and return the
   * formatted document number `{prefix}-{period}-{NNNNNN}`. The
   * INSERT … ON CONFLICT DO UPDATE locks the counter row, so two concurrent
   * issuances serialize and never collide or skip. MUST run inside the same tx
   * that stamps the number onto the order, so a rollback also unwinds the bump
   * (no burnt numbers on failure).
   */
  async nextNumber(
    kind: DocumentKind,
    opts: { prefix: string; period: string; pad?: number },
    tx: DbOrTx = db,
  ): Promise<string> {
    const [row] = await tx
      .insert(document_sequences)
      .values({ kind, period: opts.period, current_value: 1 })
      .onConflictDoUpdate({
        target: [document_sequences.kind, document_sequences.period],
        set: { current_value: sql`${document_sequences.current_value} + 1`, updated_at: sql`now()` },
      })
      .returning({ value: document_sequences.current_value });
    const padded = String(row.value).padStart(opts.pad ?? 6, "0");
    return `${opts.prefix}-${opts.period}-${padded}`;
  }
}

export const documentService = new DocumentService();
