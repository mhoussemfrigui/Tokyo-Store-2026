import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, timestamps } from "@/lib/db/columns";

/**
 * API access keys for the EXTERNAL HTTP API (/api/products, /api/categories,
 * and the write endpoints). In-process data access and the storefront's own
 * browser routes do NOT use these — see src/lib/api-auth.
 *
 * The plaintext key is shown ONCE at creation and never stored; only its
 * SHA-256 hash is persisted. `prefix` is a non-secret identifier for the admin
 * list — the "gz_live_" label + a short non-reversible sha256 fingerprint of the
 * key (NOT a slice of the live secret).
 */
export const api_keys = pgTable(
  "api_keys",
  {
    id: id(),
    name: text("name").notNull(),
    /** Non-secret identifier (e.g. "gz_live_a1b2c3d4") — label + sha256 fingerprint. */
    prefix: text("prefix").notNull(),
    /** SHA-256 hex of the full key — the only persisted form of the secret. */
    key_hash: text("key_hash").notNull(),
    /** Granted scopes: coarse ("read"/"write"/"full") and/or "resource:action". */
    scopes: text("scopes").array().notNull().default(sql`'{}'`),
    /** null = never expires. */
    expires_at: timestamp("expires_at", { withTimezone: true }),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    /** null = active; set = revoked (kept for audit, never reactivated). */
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    /** Admin user id who created the key — the actor recorded for API writes. */
    created_by: text("created_by"),
    ...timestamps(),
  },
  (table) => ({
    hashUnique: uniqueIndex("api_keys_key_hash_unique").on(table.key_hash),
    activeIdx: index("api_keys_active_idx").on(table.revoked_at),
  }),
);

export type ApiKeyRow = typeof api_keys.$inferSelect;
