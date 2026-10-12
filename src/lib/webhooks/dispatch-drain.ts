import "server-only";

import { webhookEndpointService, signWebhookBody } from "@/modules/webhook-endpoints";
import type { WebhookDeliveryRow } from "@/modules/webhook-endpoints/schema";
import { apiSettingsService } from "@/modules/api-settings/service";
import { ssrfSafeRequest, SsrfError } from "@/lib/net/ssrf-fetch";

/**
 * Drains the outbound-webhook queue (`webhook_deliveries` rows status='queued').
 * Modeled on the email drain: recover stale claims → claim a batch (FOR UPDATE
 * SKIP LOCKED) → POST each as a signed JSON body via the SSRF-hardened fetch →
 * mark delivered / retry-with-backoff / terminal. Shared by the cron endpoint
 * and the admin "run now" (via runScheduledJob) so they can't drift.
 *
 * Signature: `X-Webhook-Signature = HMAC-SHA256(timestamp . body)` with the
 * endpoint's secret; `X-Webhook-Id` gives the receiver idempotency; the SSRF
 * guard blocks a webhook pointed at an internal host.
 *
 * Throughput: the claimed batch is POSTed through a bounded-concurrency pool
 * (not one-at-a-time), so a fan-out write storm drains in ~BATCH_SIZE/CONCURRENCY
 * sequential round-trips instead of serially — kept well under the stale-recovery
 * window (bounded by the DNS + HTTP timeouts in ssrf-fetch, and hard-capped per
 * row by DELIVERY_DEADLINE_MS).
 */
const BATCH_SIZE = 200;
/** Max simultaneous POSTs per drain. Bounds threadpool/socket pressure. */
const CONCURRENCY = 8;
/** Default attempt cap; a row's own `max_attempts` column wins when present. */
const MAX_ATTEMPTS = 5;
/** Backoff per attempt number (1st retry → 1 min … 4th → 1 h). */
const BACKOFF_SECONDS = [60, 300, 900, 3600];
/**
 * Stale-claim recovery window. Must stay comfortably larger than any possible
 * batch wall-time (BATCH_SIZE/CONCURRENCY × per-row DNS+HTTP timeout) so a healthy
 * drain is never recovered from under itself. The finalizers' `status='pending'`
 * guard is the hard backstop against a double-finalize if this is ever breached.
 */
const STALE_PENDING_MINUTES = 20;
/**
 * Hard wall-clock cap on ONE delivery's POST (DNS + connect + response + capped
 * body read). ssrf-fetch already bounds each phase (5 s DNS + 10 s request), so
 * this is defense in depth: whatever else stalls, the worker moves on and the
 * row takes the normal retry path (attempts + 1) instead of staying 'pending'
 * until stale recovery re-queues it with its attempt count untouched — which
 * would bypass the max_attempts cap and re-POST it forever.
 */
const DELIVERY_DEADLINE_MS = 30_000;

type Counters = { delivered: number; failed: number; requeued: number };

async function onFailure(
  row: WebhookDeliveryRow,
  message: string,
  responseStatus: number | undefined,
  counters: Counters,
): Promise<void> {
  const nextAttempt = (row.attempts ?? 0) + 1;
  const maxAttempts = row.max_attempts ?? MAX_ATTEMPTS;
  if (nextAttempt < maxAttempts) {
    const backoff = BACKOFF_SECONDS[Math.min(nextAttempt - 1, BACKOFF_SECONDS.length - 1)];
    await webhookEndpointService.markRetry(row.id, message, backoff, responseStatus).catch(() => {});
    counters.requeued++;
  } else {
    await webhookEndpointService.markFailedTerminal(row.id, message, responseStatus).catch(() => {});
    counters.failed++;
  }
}

type Endpoint = { url: string; secret: string };

/** Rejects (transient → retry) if `p` hasn't settled within `ms`. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Délai de livraison dépassé (${Math.round(ms / 1000)} s).`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deliverOne(
  d: WebhookDeliveryRow,
  endpointFor: (id: string) => Promise<Endpoint | null>,
  counters: Counters,
): Promise<void> {
  const ep = await endpointFor(d.endpoint_id);
  // Endpoint revoked/deleted, or its signing secret is unrecoverable → terminal.
  if (!ep || !ep.secret) {
    await webhookEndpointService
      .markFailedTerminal(d.id, ep ? "Secret de signature indisponible." : "Endpoint révoqué ou introuvable.")
      .catch(() => {});
    counters.failed++;
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    id: d.id,
    event: d.event_name,
    // claimDueBatch comes back via raw db.execute, so created_at may be a
    // string rather than a Date — normalize before formatting.
    occurredAt: new Date(d.created_at).toISOString(),
    data: d.payload,
  });
  const signature = signWebhookBody(ep.secret, timestamp, body);

  try {
    const res = await withDeadline(
      ssrfSafeRequest({
        url: ep.url,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-id": d.id,
          "x-webhook-event": d.event_name,
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature": signature,
          "user-agent": "TokyoStore-Webhooks/1.0",
        },
        body,
      }),
      DELIVERY_DEADLINE_MS,
    );
    if (res.status >= 200 && res.status < 300) {
      await webhookEndpointService.markDelivered(d.id, res.status).catch(() => {});
      counters.delivered++;
    } else {
      await onFailure(d, `HTTP ${res.status}`, res.status, counters);
    }
  } catch (err) {
    if (err instanceof SsrfError) {
      // Bad/blocked/unresolvable URL is a config problem — don't retry forever.
      await webhookEndpointService.markFailedTerminal(d.id, `URL refusée (${err.code}).`).catch(() => {});
      counters.failed++;
    } else {
      await onFailure(d, err instanceof Error ? err.message : String(err), undefined, counters);
    }
  }
}

export type WebhookDrainResult = {
  ok: boolean;
  delivered: number;
  failed: number;
  requeued: number;
  summary: string;
  status?: "ok" | "skipped";
};

export async function drainWebhookQueue(): Promise<WebhookDrainResult> {
  // General kill-switch (Réglages & Clés → « Webhooks sortants »): it stops
  // DELIVERY, not just new enqueues — during an incident (compromised or
  // misbehaving ERP endpoint) already-queued rows and their retries must not
  // keep going out. Rows are left `queued` (untouched) and resume on re-enable.
  // `get()` never throws (a read error degrades to the defaults).
  const { outboundWebhooksEnabled } = await apiSettingsService.get();
  if (!outboundWebhooksEnabled) {
    return {
      ok: true,
      delivered: 0,
      failed: 0,
      requeued: 0,
      summary: "webhooks sortants désactivés — file conservée",
      status: "skipped",
    };
  }

  // Crash recovery: re-queue rows a previous drain claimed but never finalized.
  await webhookEndpointService.recoverStalePending(STALE_PENDING_MINUTES).catch(() => {});

  const claimed = await webhookEndpointService.claimDueBatch(BATCH_SIZE);
  if (claimed.length === 0) {
    return { ok: true, delivered: 0, failed: 0, requeued: 0, summary: "file vide", status: "skipped" };
  }

  // Resolve (url, decrypted secret) per endpoint ONCE for the batch. The cached
  // value is the in-flight PROMISE, so concurrent workers hitting the same
  // endpoint share a single lookup instead of racing duplicate queries.
  const endpointCache = new Map<string, Promise<Endpoint | null>>();
  const endpointFor = (id: string): Promise<Endpoint | null> => {
    let p = endpointCache.get(id);
    if (!p) {
      p = webhookEndpointService
        .findById(id)
        .then((row) => {
          if (!row || row.revoked_at) return null;
          // A decrypt failure (key rotated/lost) → empty secret → terminal below,
          // distinct from a missing/revoked endpoint.
          try {
            return { url: row.url, secret: webhookEndpointService.secretOf(row) };
          } catch {
            return { url: row.url, secret: "" };
          }
        })
        .catch(() => null);
      endpointCache.set(id, p);
    }
    return p;
  };

  const counters: Counters = { delivered: 0, failed: 0, requeued: 0 };

  // Bounded-concurrency pool: up to CONCURRENCY workers each pull the next claimed
  // row and POST it, so the batch drains in parallel waves rather than serially.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < claimed.length) {
      const d = claimed[cursor++];
      await deliverOne(d, endpointFor, counters);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, worker));

  return {
    ok: counters.failed === 0,
    delivered: counters.delivered,
    failed: counters.failed,
    requeued: counters.requeued,
    summary: `livrés ${counters.delivered}, échecs ${counters.failed}, reprogrammés ${counters.requeued}`,
  };
}
