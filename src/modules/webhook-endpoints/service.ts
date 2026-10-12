import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
import {
  webhook_endpoints,
  webhook_deliveries,
  type WebhookEndpointRow,
  type WebhookDeliveryRow,
  type WebhookDeliveryStatus,
} from "./schema";

const SECRET_PREFIX = "whsec_";

/**
 * HMAC-SHA256 signature over `${timestamp}.${body}` with the endpoint's secret,
 * hex-encoded (Stripe-style). The receiver recomputes it to verify authenticity
 * + integrity; the timestamp guards against replay. Namespaced hash of the
 * secret (like loyalty-qr-token) so the stored value isn't the raw HMAC key.
 */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  const key = createHmac("sha256", secret).update("webhook-v1").digest();
  return createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
}

/** Constant-time signature compare (for a future inbound test / self-check). */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const expected = signWebhookBody(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

class WebhookEndpointService {
  // ─────────────────────────────────────────────── endpoints (subscriptions)

  /**
   * Create an endpoint. Returns the row + the PLAINTEXT signing secret — shown
   * ONCE (only the encrypted form is stored). `eventTypes` is the subscribed set,
   * or `["*"]` for every event.
   */
  async createEndpoint(input: {
    name: string;
    url: string;
    eventTypes: string[];
    description?: string | null;
    createdBy?: string | null;
  }): Promise<{ row: WebhookEndpointRow; secret: string }> {
    const secret = `${SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;
    const [row] = await db
      .insert(webhook_endpoints)
      .values({
        name: input.name.trim(),
        url: input.url.trim(),
        secret_enc: encryptSecret(secret),
        // Non-secret identifier for the UI: prefix + a short fingerprint of the
        // secret (never the secret itself).
        prefix: `${SECRET_PREFIX}${createHash("sha256").update(secret).digest("hex").slice(0, 8)}`,
        event_types: input.eventTypes,
        description: input.description ?? null,
        created_by: input.createdBy ?? null,
      })
      .returning();
    return { row, secret };
  }

  /** All endpoints (active + revoked), newest first. Never returns the secret. */
  async list(): Promise<WebhookEndpointRow[]> {
    return db.select().from(webhook_endpoints).orderBy(desc(webhook_endpoints.created_at));
  }

  /** Active (non-revoked, is_active) endpoints — the enqueue subscriber's set. */
  async listActive(): Promise<WebhookEndpointRow[]> {
    return db
      .select()
      .from(webhook_endpoints)
      .where(and(isNull(webhook_endpoints.revoked_at), eq(webhook_endpoints.is_active, true)));
  }

  async findById(id: string): Promise<WebhookEndpointRow | null> {
    const [row] = await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.id, id)).limit(1);
    return row ?? null;
  }

  /** Decrypt an endpoint's signing secret (drain only; "" if key rotated/lost). */
  secretOf(row: WebhookEndpointRow): string {
    return decryptSecret(row.secret_enc);
  }

  /** Pause / resume without deleting (no deliveries enqueued while paused). */
  async setActive(id: string, active: boolean): Promise<void> {
    // Revocation is TERMINAL — a revoked endpoint (revoked_at set) can never be
    // toggled back to active, so guard the UPDATE on revoked_at IS NULL (a revoked
    // row would otherwise show is_active=true in the admin UI even though
    // listActive still excludes it).
    await db
      .update(webhook_endpoints)
      .set({ is_active: active, updated_at: sql`now()` })
      .where(and(eq(webhook_endpoints.id, id), isNull(webhook_endpoints.revoked_at)));
  }

  /** Permanently revoke (soft — kept for audit, never re-activated). */
  async revoke(id: string): Promise<void> {
    await db
      .update(webhook_endpoints)
      .set({ revoked_at: sql`now()`, is_active: false, updated_at: sql`now()` })
      .where(and(eq(webhook_endpoints.id, id), isNull(webhook_endpoints.revoked_at)));
  }

  // ───────────────────────────────────────────────── deliveries (the queue)

  /** Enqueue one delivery per (event × subscribed endpoint). */
  async enqueue(
    rows: Array<{ endpointId: string; eventName: string; payload: unknown }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    await db.insert(webhook_deliveries).values(
      rows.map((r) => ({
        endpoint_id: r.endpointId,
        event_name: r.eventName,
        payload: r.payload,
        status: "queued" as const,
      })),
    );
    return rows.length;
  }

  /**
   * Atomically claim up to `limit` DUE queued rows (→ 'pending') so overlapping
   * cron ticks can't double-send. `FOR UPDATE SKIP LOCKED` — one row, one worker.
   */
  async claimDueBatch(limit: number): Promise<WebhookDeliveryRow[]> {
    // Only claim a row whose endpoint is ACTIVE, or REVOKED (so the drain can
    // terminally fail it). A PAUSED-but-not-revoked endpoint's rows are skipped —
    // they wait in 'queued' until it resumes, so pausing actually halts delivery
    // (not just new enqueues). A deleted endpoint cascades its rows away (FK).
    const res = await db.execute<WebhookDeliveryRow>(sql`
      with due as (
        select ${webhook_deliveries.id} as id from ${webhook_deliveries}
        where ${webhook_deliveries.status} = 'queued'
          and ${webhook_deliveries.next_attempt_at} <= now()
          and exists (
            select 1 from ${webhook_endpoints} e
            where e.id = ${webhook_deliveries.endpoint_id}
              and (e.is_active = true or e.revoked_at is not null)
          )
        order by ${webhook_deliveries.next_attempt_at}
        limit ${limit}
        for update skip locked
      )
      update ${webhook_deliveries} as d set status = 'pending', updated_at = now()
      from due where d.id = due.id
      returning d.*;
    `);
    return res.rows;
  }

  /** Recover rows stranded 'pending' by a drain that crashed mid-POST. */
  async recoverStalePending(olderThanMinutes: number): Promise<number> {
    const res = await db.execute<{ count: number }>(sql`
      with recovered as (
        update ${webhook_deliveries} set status = 'queued', updated_at = now()
        where ${webhook_deliveries.status} = 'pending'
          and ${webhook_deliveries.updated_at} < now() - make_interval(mins => ${olderThanMinutes})
        returning 1
      )
      select count(*)::int as count from recovered;
    `);
    return Number(res.rows[0]?.count ?? 0);
  }

  // The three finalizers guard on `status = 'pending'` — i.e. THIS drain still owns
  // the claim. Under the overlap regime (a slow drain + recoverStalePending +
  // a second drain), a late finalize can't resurrect an already-delivered row or
  // flip a terminal one back to 'queued'; it simply no-ops (0 rows) once ownership
  // was lost. Idempotency at the receiver (stable x-webhook-id) covers the rest.
  async markDelivered(id: string, responseStatus: number): Promise<void> {
    await db
      .update(webhook_deliveries)
      .set({
        status: "delivered",
        response_status: responseStatus,
        delivered_at: new Date(),
        error_message: null,
        attempts: sql`${webhook_deliveries.attempts} + 1`,
        updated_at: sql`now()`,
      })
      .where(and(eq(webhook_deliveries.id, id), eq(webhook_deliveries.status, "pending")));
  }

  async markRetry(id: string, error: string, backoffSeconds: number, responseStatus?: number): Promise<void> {
    await db
      .update(webhook_deliveries)
      .set({
        status: "queued",
        error_message: error.slice(0, 2000),
        response_status: responseStatus ?? null,
        attempts: sql`${webhook_deliveries.attempts} + 1`,
        next_attempt_at: sql`now() + make_interval(secs => ${backoffSeconds})`,
        updated_at: sql`now()`,
      })
      .where(and(eq(webhook_deliveries.id, id), eq(webhook_deliveries.status, "pending")));
  }

  async markFailedTerminal(id: string, error: string, responseStatus?: number): Promise<void> {
    await db
      .update(webhook_deliveries)
      .set({
        status: "failed",
        error_message: error.slice(0, 2000),
        response_status: responseStatus ?? null,
        attempts: sql`${webhook_deliveries.attempts} + 1`,
        updated_at: sql`now()`,
      })
      .where(and(eq(webhook_deliveries.id, id), eq(webhook_deliveries.status, "pending")));
  }

  /**
   * Recent deliveries for the admin log (newest first), optionally per-endpoint
   * and/or per-status — the « Échecs uniquement » filter keeps a failed delivery
   * findable (and re-sendable) after newer traffic pushed it out of the window.
   */
  async listRecent(
    limit = 50,
    endpointId?: string,
    status?: WebhookDeliveryStatus,
  ): Promise<WebhookDeliveryRow[]> {
    const conds = [];
    if (endpointId) conds.push(eq(webhook_deliveries.endpoint_id, endpointId));
    if (status) conds.push(eq(webhook_deliveries.status, status));
    return db
      .select()
      .from(webhook_deliveries)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(webhook_deliveries.created_at))
      .limit(Math.min(limit, 200));
  }

  /**
   * Re-queue a delivery for another attempt (admin "redeliver"). Resets the retry
   * cycle (`attempts → 0`) so a terminally-failed row gets a FRESH full set of
   * attempts, not one leftover try. Skips a row a drain currently owns
   * (status='pending') to avoid yanking it mid-POST → double-send.
   */
  async redeliver(id: string): Promise<boolean> {
    const res = await db
      .update(webhook_deliveries)
      .set({
        status: "queued",
        attempts: 0,
        next_attempt_at: sql`now()`,
        error_message: null,
        response_status: null,
        updated_at: sql`now()`,
      })
      .where(and(eq(webhook_deliveries.id, id), ne(webhook_deliveries.status, "pending")))
      .returning({ id: webhook_deliveries.id });
    return res.length > 0;
  }

  /**
   * Age-based purge of the delivery log (retention sweep).
   *
   * BATCHED in 5000-row chunks — like every other high-volume log purge
   * (webhook_events, audit_log, search_log, cart_events, ai_call_logs) — so each
   * statement commits a bounded WAL segment and stays under the app role's 10s
   * statement_timeout even after a backlog. An unbatched DELETE over a large
   * >90d cohort would exceed the timeout, be aborted, the retention orchestrator's
   * per-table catch would swallow it, and this wide-jsonb table (one row per
   * event × subscribed endpoint) is the only mechanism that trims it — so it
   * would grow unbounded. The cutoff sub-select rides
   * `webhook_deliveries_created_at_brin` (migration 0119).
   */
  async purgeOlderThan(days: number): Promise<number> {
    const PURGE_BATCH_SIZE = 5000;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let total = 0;
    for (;;) {
      const res = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM ${webhook_deliveries}
          WHERE id IN (
            SELECT id FROM ${webhook_deliveries}
            WHERE ${webhook_deliveries.created_at} < ${cutoff}
            LIMIT ${PURGE_BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM del;
      `);
      const deleted = Number(res.rows[0]?.count ?? 0);
      total += deleted;
      if (deleted < PURGE_BATCH_SIZE) break;
    }
    return total;
  }
}

export const webhookEndpointService = new WebhookEndpointService();
