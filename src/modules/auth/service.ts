import "server-only";

import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { findUsersByIds } from "./queries";
import type { NewUserRow, UserRow } from "./schema";
import { sessions, users, twoFactors, accounts } from "./schema";

/**
 * Auth service — CRUD on `users` only.
 *
 * Better Auth manages most writes through its own adapter. This service is
 * for our own admin operations (listing, soft-disable) and
 * for query helpers that should be reused across workflows.
 *
 * Strict rules:
 *   - No imports from other modules
 *   - No business logic (workflows live in `src/workflows/`)
 *   - No event emission (workflows emit)
 *
 * JS field names follow Better Auth's camelCase convention (emailVerified,
 * createdAt). Underlying SQL columns are snake_case (`email_verified`,
 * `created_at`).
 */

class AuthService {
  async findById(id: string): Promise<UserRow | null> {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * EXACT case-insensitive match (`lower(email) = lower(trim(input))`, served by
   * `users_email_lower_idx`). Never ILIKE: the raw email would be a pattern, so
   * `_` / `%` act as wildcards — `jean_dupont@x.tn` would match
   * `jean.dupont@x.tn` and attach an order / membership to the wrong account.
   * The ORDER BY only keeps the pick deterministic should legacy mixed-case
   * duplicates exist (Better Auth stores emails lower-cased).
   */
  async findByEmail(email: string): Promise<UserRow | null> {
    const [row] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
      .orderBy(users.createdAt, users.id)
      .limit(1);
    return row ?? null;
  }

  /**
   * Does this user have a password (credential) account? Used by the OAuth
   * auto-link gate: an OAuth account linking onto a user that already has a
   * password is a silent merge that bypasses TOTP 2FA, so it's gated behind the
   * user's `oauthAutolink` opt-in. A pure-OAuth user (no credential) is a fresh
   * social sign-up and not gated.
   */
  async userHasCredentialAccount(userId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
      .limit(1);
    return Boolean(row);
  }

  /** Set the per-user OAuth auto-link opt-in (profile setting). */
  async setOauthAutolink(userId: string, value: boolean): Promise<void> {
    await db
      .update(users)
      .set({ oauthAutolink: value, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
  }

  /**
   * Batch id→email lookup for admin export / listing views — one round-trip
   * instead of N. Ids without a matching user are simply absent from the map.
   */
  async listEmailsByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(rows.map((r) => [r.id, r.email]));
  }

  /**
   * Batch lookup for the admin views that need to resolve user IDs to
   * names/emails (order status history, audit log). Returns a Map keyed
   * by user id; missing ids are simply absent. Delegates to the read-side
   * helper in `queries.ts` (single source of truth for this query).
   */
  async findUsersByIds(ids: string[]): Promise<Map<string, UserRow>> {
    return findUsersByIds(ids);
  }

  async insert(input: NewUserRow): Promise<UserRow> {
    const [row] = await db.insert(users).values(input).returning();
    return row;
  }

  /** Update arbitrary fields on a user. Touches `updatedAt`. */
  async update(
    id: string,
    patch: Partial<Omit<UserRow, "id" | "createdAt">>,
  ): Promise<UserRow | null> {
    const [row] = await db
      .update(users)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Admin lockout-recovery for 2FA: turn OFF `twoFactorEnabled` AND delete the
   * user's `two_factors` row (secret + backup codes) in one transaction. An
   * admin can never READ the secret/codes — only clear them — so a user who lost
   * both their device and backup codes can be reset, then re-enrol. Returns true
   * when a 2FA row existed.
   */
  async clearTwoFactor(userId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.update(users).set({ twoFactorEnabled: false, updatedAt: sql`now()` }).where(eq(users.id, userId));
      const removed = await tx
        .delete(twoFactors)
        .where(eq(twoFactors.userId, userId))
        .returning({ id: twoFactors.id });
      return removed.length > 0;
    });
  }

  async disable(id: string): Promise<UserRow | null> {
    return this.update(id, { disabledAt: new Date() });
  }

  async enable(id: string): Promise<UserRow | null> {
    return this.update(id, { disabledAt: null });
  }

  /**
   * Force-revoke every active session for a user. Called by the role-assignment
   * and disable workflows so a de-escalated or just-disabled user can't
   * keep acting on their old privileges until the 7-day cookie expires.
   */
  async deleteSessionsForUser(userId: string): Promise<number> {
    const rows = await db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    return rows.length;
  }

  /**
   * Hard-delete EXPIRED sessions. Better Auth only evicts an expired session
   * LAZILY — when that exact token is presented again — so a session whose owner
   * closed the browser / switched device / cleared cookies is never revisited
   * and lives forever, bloating the table + its indexes. Run from the daily
   * retention cron. Batched (LIMIT chunks) so each statement commits a bounded
   * WAL segment and stays under the role's statement_timeout; the
   * `sessions_expires_idx` makes the predicate sargable. Returns rows removed.
   */
  async purgeExpiredSessions(): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM sessions
          WHERE id IN (SELECT id FROM sessions WHERE expires_at < now() LIMIT 5000)
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM del;
      `);
      const n = Number(result.rows[0]?.count ?? 0);
      total += n;
      if (n < 5000) break;
    }
    return total;
  }

  /**
   * Hard-delete EXPIRED verification tokens (email-verify / password-reset /
   * change-email). A token that is never clicked is never consumed and persists
   * past `expires_at` indefinitely — PII-adjacent (identifier = email) and grows
   * with every signup / reset request. Same batched pattern + the
   * `verifications_expires_idx` predicate. Returns rows removed.
   */
  async purgeExpiredVerifications(): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM verifications
          WHERE id IN (SELECT id FROM verifications WHERE expires_at < now() LIMIT 5000)
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM del;
      `);
      const n = Number(result.rows[0]?.count ?? 0);
      total += n;
      if (n < 5000) break;
    }
    return total;
  }

  /**
   * Paginated list for the admin panel. `cursor` is a compound keyset
   * `"<createdAt-iso>__<id>"` (descending) — `createdAt` alone isn't unique
   * (seed/bulk-created users share a timestamp), so the `id` tie-breaker makes
   * the `(createdAt, id)` order total and the page seam skip-free. A malformed
   * cursor (missing the `id` tail or an unparseable date) is ignored → first
   * page, never a 500.
   */
  async list(opts: {
    search?: string;
    limit?: number;
    cursor?: string;
    /** Active/disabled filter. Takes precedence over `includeDisabled` when set;
     *  "all" (or undefined + includeDisabled) shows both. */
    status?: "active" | "disabled" | "all";
    includeDisabled?: boolean;
  }): Promise<{ items: UserRow[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 25, 100);
    const conditions = [];

    if (opts.status === "active") conditions.push(isNull(users.disabledAt));
    else if (opts.status === "disabled") conditions.push(isNotNull(users.disabledAt));
    else if (opts.status === undefined && !opts.includeDisabled) {
      // Back-compat: no explicit status + includeDisabled falsy → active-only.
      conditions.push(isNull(users.disabledAt));
    }
    // status === "all" (or includeDisabled true) → no disabledAt predicate.
    if (opts.search) {
      conditions.push(
        or(ilike(users.email, `%${opts.search}%`), ilike(users.name, `%${opts.search}%`))!,
      );
    }
    // Composite keyset cursor "<iso>__<id>". createdAt alone isn't unique
    // (seed/bulk-created users share a timestamp), so a plain lt(createdAt)
    // would SKIP or DUPLICATE rows at the page seam. id breaks the tie; the
    // (createdAt, id) tuple is a stable total order matching the ORDER BY below.
    // A malformed cursor (missing the id tail or unparseable date) is ignored
    // → first page, never a 500. (Mirrors mediaService.list.)
    if (opts.cursor) {
      const sep = opts.cursor.lastIndexOf("__");
      const iso = sep >= 0 ? opts.cursor.slice(0, sep) : opts.cursor;
      const cursorId = sep >= 0 ? opts.cursor.slice(sep + 2) : "";
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime()) && cursorId) {
        conditions.push(sql`(${users.createdAt}, ${users.id}) < (${d}, ${cursorId})`);
      }
    }

    const items = await db
      .select()
      .from(users)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);

    const hasMore = items.length > limit;
    const trimmed = hasMore ? items.slice(0, limit) : items;
    const last = trimmed[trimmed.length - 1];
    return {
      items: trimmed,
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()}__${last.id}` : null,
    };
  }

  async count(filter?: {
    status?: "active" | "disabled" | "all";
    includeDisabled?: boolean;
  }): Promise<number> {
    const conditions = [];
    if (filter?.status === "active") conditions.push(isNull(users.disabledAt));
    else if (filter?.status === "disabled") conditions.push(isNotNull(users.disabledAt));
    else if (filter?.status === undefined && !filter?.includeDisabled) {
      conditions.push(isNull(users.disabledAt));
    }

    const [row] = await db
      .select({ value: count() })
      .from(users)
      .where(conditions.length ? and(...conditions) : undefined);
    return Number(row?.value ?? 0);
  }

}

export const authService = new AuthService();
export type { AuthService };
