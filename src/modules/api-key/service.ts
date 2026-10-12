import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { normalizeScopes } from "@/lib/api-auth/scopes";
import { api_keys, type ApiKeyRow } from "./schema";

const KEY_PREFIX = "gz_live_";

/** SHA-256 hex of the full key — the only persisted form of the secret. */
function hashKey(full: string): string {
  return createHash("sha256").update(full).digest("hex");
}

class ApiKeyService {
  /**
   * Create a key. Returns the stored row AND the PLAINTEXT key — the plaintext
   * is the only time the full secret exists; the caller shows it once and it is
   * never recoverable afterwards (only the hash is stored).
   */
  async create(input: {
    name: string;
    scopes: string[];
    expiresAt: Date | null;
    createdBy: string | null;
  }): Promise<{ row: ApiKeyRow; plaintext: string }> {
    // 24 random bytes → 32 url-safe chars; with the prefix that's a 40-char key.
    const plaintext = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
    const [row] = await db
      .insert(api_keys)
      .values({
        name: input.name.trim(),
        // Non-secret identifier for the admin UI: the label + a short NON-REVERSIBLE
        // sha256 fingerprint of the key — NOT the first chars of the live secret
        // (which leaked ~48 bits of key material at rest). Mirrors webhook-endpoints.
        prefix: `${KEY_PREFIX}${hashKey(plaintext).slice(0, 8)}`,
        key_hash: hashKey(plaintext),
        scopes: normalizeScopes(input.scopes),
        expires_at: input.expiresAt,
        created_by: input.createdBy,
      })
      .returning();
    return { row, plaintext };
  }

  /** All keys (active + revoked), newest first. Never includes the secret. */
  async list(): Promise<ApiKeyRow[]> {
    return db.select().from(api_keys).orderBy(desc(api_keys.created_at));
  }

  /** Revoke an active key (idempotent — already-revoked keys are untouched). */
  async revoke(keyId: string): Promise<void> {
    await db
      .update(api_keys)
      .set({ revoked_at: sql`now()`, updated_at: sql`now()` })
      .where(and(eq(api_keys.id, keyId), isNull(api_keys.revoked_at)));
  }

  /**
   * Revoke EVERY active key created by a user — the offboarding kill-switch.
   * A bearer key authenticates on its hash + scopes alone (never the login path),
   * so disabling the owner's account does NOT stop their keys unless we revoke
   * them here. Called from `disableUserWorkflow`. Returns the ids actually
   * revoked (already-revoked keys are untouched) so the caller can audit each.
   */
  async revokeAllForUser(userId: string): Promise<string[]> {
    const rows = await db
      .update(api_keys)
      .set({ revoked_at: sql`now()`, updated_at: sql`now()` })
      .where(and(eq(api_keys.created_by, userId), isNull(api_keys.revoked_at)))
      .returning({ id: api_keys.id });
    return rows.map((r) => r.id);
  }

  /** Active (non-revoked) key matching a plaintext secret, for request auth. */
  async findActiveByPlaintext(plaintext: string): Promise<ApiKeyRow | null> {
    const [row] = await db
      .select()
      .from(api_keys)
      .where(and(eq(api_keys.key_hash, hashKey(plaintext)), isNull(api_keys.revoked_at)))
      .limit(1);
    return row ?? null;
  }

  /** Best-effort last-used stamp (fire-and-forget from the request guard). */
  async touchLastUsed(keyId: string): Promise<void> {
    await db.update(api_keys).set({ last_used_at: sql`now()` }).where(eq(api_keys.id, keyId));
  }
}

export const apiKeyService = new ApiKeyService();
