import "server-only";

import { webhookEndpointService } from "@/modules/webhook-endpoints";
import type { WebhookEndpointRow } from "@/modules/webhook-endpoints/schema";
import { apiSettingsService } from "@/modules/api-settings/service";
import { bus } from "../bus";

/**
 * Wildcard OUTBOUND-webhook subscriber: fans every emitted event out to each
 * ACTIVE endpoint subscribed to it by ENQUEUEING a durable `webhook_deliveries`
 * row per (event × endpoint). The cron drain owns the signed POST + retry; this
 * handler only writes rows and is best-effort (a failure never blocks the
 * emitter — same async `Promise.allSettled` isolation as audit-everything).
 *
 * Endpoints subscribe to explicit event names or `["*"]` (all). Gated on the
 * master `webhooks.outbound_enabled` kill-switch. The active-endpoint set is
 * cached in-process for a few seconds so a zero-endpoint install (the common
 * case) doesn't run a query on every single event.
 *
 * DATA MINIMISATION: a `["*"]` (all-events) subscription does NOT receive
 * auth/security-domain telemetry (auth / rbac / api_key / user.* — these carry
 * PII like email + client IP — and data.* — the operator bulk-export trail). An
 * integration that genuinely needs one of those must subscribe to it BY EXACT
 * NAME, an explicit opt-in.
 */
export const SECURITY_DOMAINS = new Set(["auth", "rbac", "api_key", "user", "data"]);

/** True for events whose first dotted segment is a security/auth domain (PII-bearing
 *  telemetry the wildcard subscription is not given by default). Exported for the
 *  webhook-wildcard test, which also pins the admin « TOUS les évènements » helper
 *  copy (api-webhooks-panel.tsx) to this domain list. */
export function isSecuritySensitiveEvent(name: string): boolean {
  return SECURITY_DOMAINS.has(name.split(".")[0] ?? "");
}

const ENDPOINT_CACHE_MS = 5_000;
let endpointCache: { rows: WebhookEndpointRow[]; expires: number } | null = null;

async function activeEndpoints(): Promise<WebhookEndpointRow[]> {
  const now = Date.now();
  if (endpointCache && endpointCache.expires > now) return endpointCache.rows;
  const rows = await webhookEndpointService.listActive().catch(() => [] as WebhookEndpointRow[]);
  endpointCache = { rows, expires: now + ENDPOINT_CACHE_MS };
  return rows;
}

export function registerWebhookDispatchSubscriber() {
  bus.onAny(async (env) => {
    // Master kill-switch (cached ~15s in api-settings). `get()` degrades to a
    // default on a DB hiccup rather than throwing, so this try/catch is a
    // belt-and-suspenders guard; the practical safety on a DB outage is that
    // `activeEndpoints()` below also degrades to `[]` (nothing enqueued).
    let enabled = false;
    try {
      enabled = (await apiSettingsService.get()).outboundWebhooksEnabled;
    } catch {
      return;
    }
    if (!enabled) return;

    const endpoints = await activeEndpoints();
    if (endpoints.length === 0) return;
    const matched = endpoints.filter((e) => {
      // Explicit by-name subscription always matches (an opt-in to that event).
      if (e.event_types.includes(env.name)) return true;
      // A wildcard subscription matches everything EXCEPT security/auth telemetry.
      if (e.event_types.includes("*")) return !isSecuritySensitiveEvent(env.name);
      return false;
    });
    if (matched.length === 0) return;

    await webhookEndpointService
      .enqueue(matched.map((e) => ({ endpointId: e.id, eventName: env.name, payload: env.payload })))
      .catch(() => {});
  });
}
