import "server-only";

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { email_logs, type EmailLogRow, type NewEmailLogRow } from "./schema";

export type EmailLogStatus = "pending" | "queued" | "sent" | "failed";

/**
 * Column projection for the admin Logs LIST — everything the table renders, minus
 * the heavy `body` (rendered HTML) / `variables` / `metadata` JSONB the list
 * never shows. Keeps a 50-row page lean. `findById` still selects the full row.
 */
const EMAIL_LOG_LIST_COLUMNS = {
  id: email_logs.id,
  template_key: email_logs.template_key,
  to_email: email_logs.to_email,
  from_email: email_logs.from_email,
  subject: email_logs.subject,
  provider: email_logs.provider,
  provider_message_id: email_logs.provider_message_id,
  status: email_logs.status,
  error_message: email_logs.error_message,
  category: email_logs.category,
  flow_key: email_logs.flow_key,
  campaign_id: email_logs.campaign_id,
  attempts: email_logs.attempts,
  max_attempts: email_logs.max_attempts,
  next_attempt_at: email_logs.next_attempt_at,
  sent_at: email_logs.sent_at,
  pinned_at: email_logs.pinned_at,
  created_at: email_logs.created_at,
  updated_at: email_logs.updated_at,
} as const;

export type EmailLogListRow = Pick<EmailLogRow, keyof typeof EMAIL_LOG_LIST_COLUMNS>;

export type EnqueueEmailInput = {
  templateKey?: string | null;
  toEmail: string;
  subject: string;
  /** Pre-rendered HTML body the drain sends as-is. */
  body: string;
  category?: string | null;
  flowKey?: string | null;
  campaignId?: string | null;
  replyTo?: string | null;
  variables?: Record<string, unknown> | null;
};

export type RecordEmailLogInput = {
  templateKey?: string | null;
  toEmail: string;
  fromEmail?: string | null;
  subject?: string | null;
  /** Rendered HTML, or "[redacted]" for sensitive templates. */
  body?: string | null;
  provider?: string | null;
  status: EmailLogStatus;
  errorMessage?: string | null;
  providerMessageId?: string | null;
  category?: string | null;
  flowKey?: string | null;
  campaignId?: string | null;
  variables?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  sentAt?: Date | null;
};

/**
 * The send-audit log AND the durable send queue (`email_logs`). Every send funnels
 * a row through here — immediate transactional sends record a finalized `sent`/
 * `failed` row; bulk sends are `enqueue`d as `queued` and the mailing cron drains
 * them (queue methods land in Phase 3). All writes are best-effort from the
 * caller's view — a log failure must never break a send.
 */
class EmailLogService {
  /** Record one finalized send attempt (immediate transactional path). */
  async record(input: RecordEmailLogInput): Promise<string | null> {
    const [row] = await db
      .insert(email_logs)
      .values({
        template_key: input.templateKey ?? null,
        to_email: input.toEmail,
        from_email: input.fromEmail ?? null,
        subject: input.subject?.slice(0, 500) ?? null,
        body: input.body ?? null,
        provider: input.provider ?? null,
        status: input.status,
        error_message: input.errorMessage?.slice(0, 2000) ?? null,
        provider_message_id: input.providerMessageId ?? null,
        category: input.category ?? null,
        flow_key: input.flowKey ?? null,
        campaign_id: input.campaignId ?? null,
        variables: input.variables ?? null,
        metadata: input.metadata ?? null,
        sent_at: input.sentAt ?? (input.status === "sent" ? new Date() : null),
        attempts: input.status === "sent" || input.status === "failed" ? 1 : 0,
      } as NewEmailLogRow)
      .returning({ id: email_logs.id });
    return row?.id ?? null;
  }

  /**
   * Enqueue bulk sends (campaigns + large automation fan-outs) — `status='queued'`
   * rows the mailing cron drains with throttle + retry. The body is pre-rendered
   * (so the drain just sends it); `replyTo` is stashed in metadata.
   */
  async enqueue(rows: EnqueueEmailInput[]): Promise<number> {
    if (rows.length === 0) return 0;
    await db.insert(email_logs).values(
      rows.map(
        (r) =>
          ({
            template_key: r.templateKey ?? null,
            to_email: r.toEmail,
            subject: r.subject?.slice(0, 500) ?? null,
            body: r.body,
            status: "queued",
            category: r.category ?? null,
            flow_key: r.flowKey ?? null,
            campaign_id: r.campaignId ?? null,
            variables: r.variables ?? null,
            metadata: r.replyTo ? { replyTo: r.replyTo } : null,
          }) as NewEmailLogRow,
      ),
    );
    return rows.length;
  }

  /**
   * Atomically claim up to `limit` DUE queued rows (flipping them to `pending` so
   * a concurrent cron tick can't grab them) and return them. `FOR UPDATE SKIP
   * LOCKED` is what makes overlapping ticks safe — each row is processed once.
   */
  async claimDueBatch(limit: number): Promise<EmailLogRow[]> {
    const res = await db.execute<EmailLogRow>(sql`
      with due as (
        select ${email_logs.id} as id from ${email_logs}
        where ${email_logs.status} = 'queued'
          and (${email_logs.next_attempt_at} is null or ${email_logs.next_attempt_at} <= now())
        order by ${email_logs.created_at}
        limit ${limit}
        for update skip locked
      )
      update ${email_logs} as e set status = 'pending', updated_at = now()
      from due where e.id = due.id
      returning e.*;
    `);
    return res.rows;
  }

  /**
   * Recover rows stranded in `pending` (claimed by a drain that then crashed
   * mid-send) by flipping them back to `queued`. Only `claimDueBatch` ever sets
   * `pending` (immediate transactional sends record a finalized `sent`/`failed`
   * row, never `pending`), so the only `pending` rows are in-flight claims; a
   * generous threshold (> the longest possible batch drain) makes this safe.
   * Returns how many were recovered.
   */
  async recoverStalePending(olderThanMinutes: number): Promise<number> {
    const res = await db.execute<{ count: number }>(sql`
      with recovered as (
        update ${email_logs}
          set status = 'queued', updated_at = now()
        where ${email_logs.status} = 'pending'
          and ${email_logs.updated_at} < now() - make_interval(mins => ${olderThanMinutes})
        returning 1
      )
      select count(*)::int as count from recovered;
    `);
    return Number(res.rows[0]?.count ?? 0);
  }

  // The three finalizers (markSent / markRetry / markFailedTerminal) guard on
  // `status = 'pending'` — i.e. THIS drain still owns the row. If a stalled batch
  // trips recoverStalePending (pending → queued) and an overlapping tick re-claims
  // + re-sends the row, this drain's late finalize then no-ops instead of
  // clobbering the new send's result (avoids a duplicate/last-writer-wins finalize).
  // Mirrors the outbound-webhook drain (webhook-endpoints/service.ts).
  async markSent(
    id: string,
    providerMessageId: string,
    provider: string,
    fromEmail: string,
  ): Promise<void> {
    await db
      .update(email_logs)
      .set({
        status: "sent",
        sent_at: new Date(),
        provider_message_id: providerMessageId,
        provider,
        from_email: fromEmail,
        error_message: null,
        next_attempt_at: null,
        attempts: sql`${email_logs.attempts} + 1`,
        updated_at: sql`now()`,
      })
      .where(and(eq(email_logs.id, id), eq(email_logs.status, "pending")));
  }

  /** Re-queue a failed send with a backoff delay (transient error, attempts left). */
  async markRetry(id: string, error: string, backoffSeconds: number): Promise<void> {
    await db
      .update(email_logs)
      .set({
        status: "queued",
        error_message: error.slice(0, 2000),
        attempts: sql`${email_logs.attempts} + 1`,
        next_attempt_at: sql`now() + make_interval(secs => ${backoffSeconds})`,
        updated_at: sql`now()`,
      })
      .where(and(eq(email_logs.id, id), eq(email_logs.status, "pending")));
  }

  /** Terminal failure (max attempts reached, or a send we won't retry). */
  async markFailedTerminal(id: string, error: string): Promise<void> {
    await db
      .update(email_logs)
      .set({
        status: "failed",
        error_message: error.slice(0, 2000),
        attempts: sql`${email_logs.attempts} + 1`,
        next_attempt_at: null,
        updated_at: sql`now()`,
      })
      .where(and(eq(email_logs.id, id), eq(email_logs.status, "pending")));
  }

  /**
   * DEFER a just-claimed row back to the queue until `until` — the daily
   * marketing-cap pause: the campaign stops sending now and resumes at the next
   * reset. Unlike markRetry this is NOT a failure (attempts is NOT bumped; no
   * error message), and `next_attempt_at` is an ABSOLUTE instant so the row isn't
   * re-claimed (claimDueBatch skips rows whose next_attempt_at is in the future)
   * until the reset. Guarded on `status='pending'` like the finalizers.
   */
  async deferUntil(id: string, until: Date): Promise<void> {
    await db
      .update(email_logs)
      .set({ status: "queued", next_attempt_at: until, updated_at: sql`now()` })
      .where(and(eq(email_logs.id, id), eq(email_logs.status, "pending")));
  }

  /**
   * Count MARKETING sends (campaigns + marketing automations — category
   * 'marketing') that actually went out since `since`. Backs the daily send cap:
   * the drain pauses marketing once this reaches `mail.daily_limit`. Transactional
   * (account/commerce) rows are not counted, so the cap never blocks them.
   */
  async countMarketingSentSince(since: Date): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(email_logs)
      .where(
        and(
          eq(email_logs.category, "marketing"),
          eq(email_logs.status, "sent"),
          gte(email_logs.sent_at, since),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * Filtered, paginated read for the admin Logs tab (newest first, live rows).
   * COLUMN-PROJECTED: drops the heavy `body` (full rendered HTML — tens of KB per
   * campaign row), `variables` and `metadata` JSONB the list never renders, so a
   * 50-row page doesn't drag full email bodies across the wire (mirrors
   * listAuditEntriesForExport). The detail view (findById) keeps the full row.
   */
  async list(filters: {
    status?: string;
    category?: string;
    email?: string;
    limit?: number;
    offset?: number;
  }): Promise<EmailLogListRow[]> {
    const conds = [isNull(email_logs.deleted_at)];
    if (filters.status) conds.push(eq(email_logs.status, filters.status));
    if (filters.category) conds.push(eq(email_logs.category, filters.category));
    if (filters.email) {
      // Cap the LIKE pattern length: a pathologically long fragment makes the
      // trigram-GIN-backed substring scan degrade. 100 chars is far beyond any
      // real email (RFC max local+domain is 320, but a *filter* needs nowhere
      // near that). Validate at the service boundary, not just client-side.
      const needle = filters.email.toLowerCase().slice(0, 100);
      conds.push(sql`lower(${email_logs.to_email}) like ${`%${needle}%`}`);
    }
    return db
      .select(EMAIL_LOG_LIST_COLUMNS)
      .from(email_logs)
      .where(and(...conds))
      .orderBy(desc(email_logs.created_at), desc(email_logs.id))
      .limit(Math.min(filters.limit ?? 50, 200))
      .offset(filters.offset ?? 0);
  }

  async findById(id: string): Promise<EmailLogRow | null> {
    const [row] = await db.select().from(email_logs).where(eq(email_logs.id, id)).limit(1);
    return row ?? null;
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await db
      .update(email_logs)
      .set({ pinned_at: pinned ? new Date() : null, updated_at: sql`now()` })
      .where(eq(email_logs.id, id));
  }

  async softDelete(id: string): Promise<void> {
    await db
      .update(email_logs)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(email_logs.id, id));
  }

  /**
   * Re-enqueue a fresh queued row from a prior log's stored fields (admin
   * "renvoyer"). Never mutates the original; refuses redacted rows (their body is
   * "[redacted]" — there's nothing to resend, and sensitive tokens are stale).
   */
  async requeueFrom(id: string): Promise<boolean> {
    const row = await this.findById(id);
    if (!row || row.body === "[redacted]" || !row.subject) return false;
    await db.insert(email_logs).values({
      template_key: row.template_key,
      to_email: row.to_email,
      subject: row.subject,
      body: row.body,
      status: "queued",
      category: row.category,
      flow_key: row.flow_key,
      campaign_id: row.campaign_id,
      variables: row.variables,
      metadata: row.metadata,
    } as NewEmailLogRow);
    return true;
  }

  /**
   * Per-campaign send progress (the Campaigns tab derives live sent/failed/
   * pending from the linked `email_logs` rows — there are no static counters).
   * One grouped query over the campaign index for the listed campaigns.
   */
  async progressByCampaign(
    campaignIds: string[],
  ): Promise<Map<string, { sent: number; failed: number; pending: number }>> {
    const out = new Map<string, { sent: number; failed: number; pending: number }>();
    if (campaignIds.length === 0) return out;
    const rows = await db
      .select({ cid: email_logs.campaign_id, status: email_logs.status, n: sql<number>`count(*)::int` })
      .from(email_logs)
      .where(and(inArray(email_logs.campaign_id, campaignIds), isNull(email_logs.deleted_at)))
      .groupBy(email_logs.campaign_id, email_logs.status);
    for (const r of rows) {
      if (!r.cid) continue;
      const m = out.get(r.cid) ?? { sent: 0, failed: 0, pending: 0 };
      if (r.status === "sent") m.sent += r.n;
      else if (r.status === "failed") m.failed += r.n;
      else m.pending += r.n; // queued | pending
      out.set(r.cid, m);
    }
    return out;
  }

  /**
   * Status tally for ONE campaign — backs the drain's "is this campaign fully
   * drained?" check (remaining = queued + pending) so it can advance the campaign
   * status past 'queued' once the last row is sent.
   */
  async campaignTally(campaignId: string): Promise<{ remaining: number; sent: number; failed: number }> {
    const rows = await db
      .select({ status: email_logs.status, n: sql<number>`count(*)::int` })
      .from(email_logs)
      .where(and(eq(email_logs.campaign_id, campaignId), isNull(email_logs.deleted_at)))
      .groupBy(email_logs.status);
    let remaining = 0;
    let sent = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.status === "queued" || r.status === "pending") remaining += r.n;
      else if (r.status === "sent") sent += r.n;
      else if (r.status === "failed") failed += r.n;
    }
    return { remaining, sent, failed };
  }

  /** Counts by status for the Logs tab header (live rows only). */
  async statusCounts(): Promise<Record<string, number>> {
    const rows = await db
      .select({ status: email_logs.status, n: sql<number>`count(*)::int` })
      .from(email_logs)
      .where(isNull(email_logs.deleted_at))
      .groupBy(email_logs.status);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /**
   * Age-based purge of the audit log (daily retention sweep). PINNED rows are
   * never purged so an operator can keep evidence indefinitely.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const res = await db.execute<{ count: number }>(sql`
      with del as (
        delete from ${email_logs}
        where ${email_logs.created_at} < now() - make_interval(days => ${days})
          and ${email_logs.pinned_at} is null
        returning 1
      )
      select count(*)::int as count from del;
    `);
    return Number(res.rows[0]?.count ?? 0);
  }
}

export const emailLogService = new EmailLogService();
