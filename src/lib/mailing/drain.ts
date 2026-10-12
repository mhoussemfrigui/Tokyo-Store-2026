import "server-only";

import { db } from "@/lib/db/client";
import { sendEmail } from "@/lib/email/client";
import { filterMarketableEmails } from "@/lib/email/consent";
import { listUnsubscribeHeaders } from "@/lib/email/list-unsubscribe";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { emailLogService, emailCampaignService } from "@/modules/mailing";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { htmlToPlainText } from "./html-to-text";
import { dailyMarketingWindow } from "./daily-limit";

/**
 * Drains the email send queue (`email_logs` rows with status='queued'). Shared by
 * the cron endpoint (`/api/cron/mailing`) and the dashboard "run now" so they
 * can't drift. Claims a batch (FOR UPDATE SKIP LOCKED), re-checks marketing
 * consent at SEND time (opt-out race), throttles, and retries transient failures
 * with backoff up to MAX_ATTEMPTS.
 *
 * SINGLE-FLIGHT: the throttle (`mail.throttle_per_min`) is paced INSIDE one run,
 * so overlapping runs would each send at the full rate (N drains => N x the
 * configured throttle), and a run outliving the stale-pending window used to get
 * its still-in-memory rows re-queued and sent a second time by the next tick.
 * So a run (1) holds a cluster-wide advisory lock — a concurrent tick / "run now"
 * is skipped, not stacked; (2) sizes its batch from the throttle so one batch —
 * paced to a per-row deadline, so send latency is absorbed — finishes before
 * the next cron tick (a run spilling past it would get that tick lock-skipped,
 * halving the real throughput); (3) stops taking rows past DRAIN_BUDGET_MS, well
 * under STALE_PENDING_MINUTES, so a live run never sends a row the stale
 * recovery could have re-queued.
 */

const BATCH_SIZE = 50;
/** The documented cadence of POST /api/cron/mailing (docs/deployment-coolify.md:
 *  every 2 min). One batch is sized to ~fill this window at the throttle rate. */
const CRON_INTERVAL_MINUTES = 2;
/** Headroom kept at the end of the interval: the LAST paced send of a batch is
 *  scheduled at least this long before the next tick, so the run (claim +
 *  settings + that send + campaign tally) is over when the tick arrives. */
const CRON_HEADROOM_SECONDS = 10;
const MAX_ATTEMPTS = 3;
/** Backoff per attempt number (1st retry → 1 min, 2nd → 5 min). */
const BACKOFF_SECONDS = [60, 300, 1800];
/** Wall-clock budget of ONE run: past it no further claimed row is sent (the
 *  leftovers stay `pending` and are recovered by a later run once stale — only
 *  reachable when sends are pathologically slow, where a pause is welcome). */
const DRAIN_BUDGET_MS = 10 * 60_000;
/** Rows stuck `pending` (claimed by a drain that then crashed mid-send) older than
 *  this are recovered to `queued`. Must exceed the longest possible run:
 *  DRAIN_BUDGET_MS + one provider-bounded send (PROVIDER_SEND_TIMEOUT_MS). */
const STALE_PENDING_MINUTES = 30;
/** Cluster-wide advisory-lock key for the drain (distinct from the migration
 *  runner's 72707468). */
const DRAIN_LOCK_KEY = 72707469;
/** Safety valve: the lock-holding transaction sits idle while the run works on
 *  other pooled connections, so the role's 30 s idle-in-transaction cutoff is
 *  lifted for it — to this bound, so a wedged run can't hold the lock forever.
 *  Exceeds DRAIN_BUDGET_MS + one bounded send; stays under the stale window. */
const LOCK_MAX_HOLD_MS = 15 * 60_000;

/** Rows claimed per run: as many as the throttle can START within one cron
 *  interval minus the headroom (row k starts k × 60/perMin s into the run), capped
 *  at BATCH_SIZE — a throttle of 1/min → 2 rows, 10/min → 19, 27+/min → the full
 *  50. Filling the WHOLE interval with pacing would let send latency push the run
 *  past the next tick, which the lock then skips (≈ half the configured rate). */
export function drainBatchSize(perMin: number): number {
  const rate = Number.isFinite(perMin) && perMin > 0 ? perMin : 1;
  const windowSeconds = CRON_INTERVAL_MINUTES * 60 - CRON_HEADROOM_SECONDS;
  return Math.max(1, Math.min(BATCH_SIZE, Math.floor((windowSeconds * rate) / 60) + 1));
}

/**
 * Run `work` under the drain's advisory lock, or report that another run holds
 * it. A TRANSACTION-scoped lock (released on COMMIT, or with the session when
 * the process dies) so it also holds behind a transaction-mode PgBouncer, where
 * a session-level lock + unlock could land on different server backends.
 *
 * The lock lives on its OWN pooled client (not `db.transaction`) so an error
 * listener can be attached for the whole hold: that client sits idle for
 * minutes, and if its session is cut meanwhile (the valve, a DB restart, a
 * network drop) pg emits `error` on it — with no listener, an unhandled
 * `error` event would crash the process. A dead lock session just ends the
 * hold; the run in progress finishes normally.
 */
async function withDrainLock<T>(
  work: () => Promise<T>,
): Promise<{ acquired: boolean; result?: T }> {
  const client = await db.$client.connect();
  const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));
  // Set when the lock session is unusable → the client is destroyed, not pooled.
  let broken: Error | null = null;
  const onError = (err: Error) => {
    broken = err;
    console.warn("[mailing] drain lock session lost (lock released with it)", err.message);
  };
  client.on("error", onError);
  try {
    let acquired = false;
    try {
      await client.query("begin");
      await client.query("select set_config('idle_in_transaction_session_timeout', $1, true)", [
        String(LOCK_MAX_HOLD_MS),
      ]);
      const { rows } = await client.query<{ ok: boolean }>(
        "select pg_try_advisory_xact_lock($1::bigint) as ok",
        [DRAIN_LOCK_KEY],
      );
      acquired = rows[0]?.ok === true;
    } catch (err) {
      // Couldn't even try the lock → surface it (runScheduledJob logs a failed
      // run); never hand a client stuck mid-transaction back to the pool.
      broken ??= asError(err);
      throw err;
    }
    if (!acquired) {
      await client.query("commit").catch((err: unknown) => {
        broken ??= asError(err);
      });
      return { acquired: false };
    }
    try {
      return { acquired: true, result: await work() };
    } finally {
      // Drop the lock whatever the run's outcome (a work error propagates
      // unchanged). The tx holds no data, so COMMIT only releases the lock.
      if (!broken) {
        await client.query("commit").catch((err: unknown) => {
          broken ??= asError(err);
        });
      }
    }
  } finally {
    // The pool re-arms its own idle error listener on release, so ours can go
    // afterwards without leaving the client unguarded.
    client.release(broken ?? undefined);
    client.removeListener("error", onError);
  }
}

export type DrainResult = {
  ok: boolean;
  sent: number;
  failed: number;
  requeued: number;
  skipped: number;
  /** Marketing rows deferred to the next reset because the daily cap was hit. */
  paused: number;
  summary: string;
  status?: "ok" | "skipped";
};

export async function drainEmailQueue(): Promise<DrainResult> {
  const locked = await withDrainLock(drainBatch);
  if (!locked.acquired || !locked.result) {
    return {
      ok: true,
      sent: 0,
      failed: 0,
      requeued: 0,
      skipped: 0,
      paused: 0,
      summary: "un envoi est déjà en cours — exécution ignorée",
      status: "skipped",
    };
  }
  return locked.result;
}

async function drainBatch(): Promise<DrainResult> {
  const startedAt = Date.now();
  // Crash recovery: re-queue any rows a previous drain claimed (→ pending) but
  // never finalized (process died mid-send), so they aren't stranded forever.
  // Runs under the lock, and a live run never outlasts the stale window, so
  // this can't pull rows out from under an in-flight run.
  await emailLogService.recoverStalePending(STALE_PENDING_MINUTES).catch(() => {});

  // Settings BEFORE the claim: the throttle sizes the batch. FAIL CLOSED on a read
  // error — nothing is claimed, so nothing needs re-queueing: without the settings
  // neither the marketing kill-switch nor the throttle can be honoured (sending a
  // claimed marketing batch while the operator has marketing OFF is exactly what
  // the switch exists to stop). The rows wait for the next tick. (The consent
  // re-check below stays deliberately fail-open — the enqueue already filtered.)
  let settings: Record<string, string | null>;
  try {
    settings = await getSettingsMap();
  } catch (err) {
    console.error("[mailing] drain: settings read failed — batch left queued", err);
    return {
      ok: false,
      sent: 0,
      failed: 0,
      requeued: 0,
      skipped: 0,
      paused: 0,
      summary: "réglages indisponibles — aucun envoi (reprise au prochain passage)",
    };
  }
  const perMin = Number(settings["mail.throttle_per_min"]) || 300;
  const delayMs = Math.max(0, Math.floor(60_000 / Math.max(1, perMin)));

  // Daily MARKETING cap (campaigns + marketing automations only; transactional
  // never capped). 0 / unset = unlimited. Count what already went out since this
  // window's reset boundary; once the run reaches the cap it DEFERS the remaining
  // marketing rows to the next reset (the campaign pauses, resumes next day).
  const dailyLimit = Math.max(0, Math.floor(Number(settings["mail.daily_limit"]) || 0));
  const { boundaryMs, nextResetMs } = dailyMarketingWindow(startedAt, settings["mail.daily_reset_time"]);
  const nextResetDate = new Date(nextResetMs);
  // Fail-open to 0 on a count error: the cap is a soft safety valve (batch size is
  // already bounded), not a hard consent gate — never block a send over a read hiccup.
  const sentToday =
    dailyLimit > 0
      ? await emailLogService.countMarketingSentSince(new Date(boundaryMs)).catch(() => 0)
      : 0;
  let marketingSentThisRun = 0;
  let paused = 0;

  const claimed = await emailLogService.claimDueBatch(drainBatchSize(perMin));
  if (claimed.length === 0) {
    return { ok: true, sent: 0, failed: 0, requeued: 0, skipped: 0, paused: 0, summary: "file vide", status: "skipped" };
  }

  // Master marketing kill-switch backstop: when OFF, queued marketing rows (a
  // campaign/automation backlog enqueued before the toggle flipped) are cut, not
  // sent — matching the chokepoint gate so the switch governs the backlog too.
  const marketingDisabled = (settings["mail.marketing_enabled"]?.trim() || "true") === "false";

  // Opt-out re-check, batched: resolve the still-marketable subset of THIS batch's
  // marketing rows in 3 set-wise queries (filterMarketableEmails) instead of N×3
  // per-row round-trips. The consent snapshot is taken at batch-claim rather than
  // per-row send, but the window that matters — opt-out between ENQUEUE and drain
  // (minutes to hours) — is still honoured; only the few throttled seconds within
  // the batch are lost. Skipped when the kill-switch already cuts every marketing
  // row below. Fail-OPEN: treat all as marketable on a total read failure.
  let marketable = new Set<string>();
  if (!marketingDisabled) {
    const marketingEmails = claimed
      .filter((r) => r.category === "marketing")
      .map((r) => r.to_email);
    if (marketingEmails.length > 0) {
      marketable = await filterMarketableEmails(marketingEmails).catch(
        () => new Set(marketingEmails.map((e) => e.trim().toLowerCase())),
      );
    }
  }

  // Public origin for the marketing rows' one-click List-Unsubscribe URL —
  // resolved once per batch, and only when the batch carries a marketing row.
  const origin = claimed.some((r) => r.category === "marketing") ? await resolvePublicOrigin() : "";

  let sent = 0;
  let failed = 0;
  let requeued = 0;
  let skipped = 0;
  let deferred = 0;
  const touchedCampaigns = new Set<string>();

  for (const [i, row] of claimed.entries()) {
    const rowStartedAt = Date.now();
    if (rowStartedAt - startedAt > DRAIN_BUDGET_MS) {
      // Over budget (sends are crawling): leave the rest claimed/`pending` —
      // the stale recovery re-queues them once no run can still hold them.
      deferred = claimed.length - i;
      break;
    }
    if (row.campaign_id) touchedCampaigns.add(row.campaign_id);

    // Daily marketing cap: once today's allowance is spent, DEFER this marketing
    // row to the next reset instead of sending it — the campaign pauses and
    // resumes then. Transactional rows are never capped. Deferral is a cheap DB
    // update (no send), so no throttle pacing is spent on it.
    if (
      row.category === "marketing" &&
      dailyLimit > 0 &&
      sentToday + marketingSentThisRun >= dailyLimit
    ) {
      await emailLogService.deferUntil(row.id, nextResetDate).catch(() => {});
      paused++;
      continue;
    }

    try {
      if (row.category === "marketing" && marketingDisabled) {
        // Kill-switch is off → cut this queued marketing row (terminal).
        await emailLogService.markFailedTerminal(row.id, "Emails marketing désactivés");
        skipped++;
      } else if (
        // Opt-out race: drop marketing rows whose address is no longer marketable
        // (batched consent snapshot computed above).
        row.category === "marketing" &&
        !marketable.has(row.to_email.trim().toLowerCase())
      ) {
        await emailLogService.markFailedTerminal(row.id, "Désabonné (consent)");
        skipped++;
      } else {
        const replyTo = (row.metadata as { replyTo?: string } | null)?.replyTo;
        const body = row.body ?? "";
        const res = await sendEmail({
          to: row.to_email,
          subject: row.subject ?? "",
          html: body,
          text: htmlToPlainText(body),
          replyTo,
          // RFC 8058 one-click unsubscribe on marketing rows (campaigns + bulk
          // automations). Built at SEND time from the row's recipient — the same
          // signed token as its footer link — so a requeued or pre-existing queued
          // row carries it too and nothing extra is stored on the log row.
          headers:
            row.category === "marketing" ? listUnsubscribeHeaders(row.to_email, origin) : undefined,
        });
        await emailLogService.markSent(row.id, res.id, res.provider, res.from);
        sent++;
        if (row.category === "marketing") marketingSentThisRun++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextAttempt = (row.attempts ?? 0) + 1;
      if (nextAttempt < MAX_ATTEMPTS) {
        const backoff = BACKOFF_SECONDS[Math.min(nextAttempt - 1, BACKOFF_SECONDS.length - 1)];
        await emailLogService.markRetry(row.id, msg, backoff).catch(() => {});
        requeued++;
      } else {
        await emailLogService.markFailedTerminal(row.id, msg).catch(() => {});
        failed++;
      }
    }
    // Pace between sends (not after the last one — the next run is a cron tick
    // away) to a DEADLINE: the next row starts delayMs after this one STARTED, so
    // consecutive sends stay ≥ delayMs apart (the throttle is never exceeded)
    // while the send's own latency is absorbed instead of added on top.
    if (delayMs && i < claimed.length - 1) {
      const wait = delayMs - (Date.now() - rowStartedAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  // Advance the status of any campaign whose queue is now fully drained (so it
  // doesn't sit on 'queued' forever). Best-effort — progress is read live from
  // email_logs regardless, so a missed transition is cosmetic.
  for (const campaignId of touchedCampaigns) {
    try {
      const tally = await emailCampaignService.tallyAndMaybeFinish(campaignId);
      void tally;
    } catch {
      /* cosmetic — ignore */
    }
  }

  return {
    ok: failed === 0,
    sent,
    failed,
    requeued,
    skipped,
    paused,
    summary:
      `envoyés ${sent}, échecs ${failed}, reprogrammés ${requeued}, ignorés ${skipped}` +
      (paused ? `, en pause ${paused} (limite quotidienne atteinte, reprise à ${new Date(nextResetMs).toISOString()})` : "") +
      (deferred ? `, reportés ${deferred} (budget de temps dépassé)` : ""),
  };
}
