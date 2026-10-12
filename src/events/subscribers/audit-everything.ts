import "server-only";

import { auditService } from "@/modules/audit/service";
import { redactForStorage } from "@/lib/telemetry/redact";
import { getAuditRuntimeConfig } from "@/lib/audit/runtime-config";
import { severityFor } from "@/events/severity";
import { bus } from "../bus";
import { AUDIT_TRAIL_EVENTS } from "./audit-trail";
import { summarizeEvent, targetTypeForEvent, targetIdForPayload } from "./audit-target";

/**
 * Wildcard subscriber — records every emitted event to `audit_log`, EXCEPT
 * the curated allowlist owned by `audit-trail.ts`. Those events get a
 * higher-signal row from that subscriber; logging them here too would write
 * a duplicate row per emit (there is no unique constraint to dedupe). So this
 * handler skips them and owns only the "long tail" of events.
 *
 * Cheap because handlers run async (Promise.allSettled). At write rates
 * past ~1k events/sec the synchronous append becomes a bottleneck — at
 * that point move to a queued append worker (pg-boss is the obvious pick
 * since Postgres already runs).
 *
 * Sensitive fields (password, tokens) must NEVER appear in event payloads
 * — the registry in `events/types.ts` is the chokepoint, enforce there.
 * As defence-in-depth the metadata is also run through `redactForStorage()` so
 * any email/secret that slips into a payload is masked — and the blob is capped
 * (array/depth/total-size) — before it lands in the retained table that admins
 * read verbatim.
 *
 * Two admin gates (read through the short-TTL runtime config, fail-open):
 *   - audit.enabled=false        → record nothing (master capture off).
 *   - audit.persist_low_signal=false → skip debug-severity (high-churn) rows
 *     so the long tail doesn't bloat the table; warn/info/error still persist.
 */

const CURATED = new Set<string>(AUDIT_TRAIL_EVENTS);

export function registerAuditSubscriber() {
  bus.onAny(async (env) => {
    // Curated events are recorded (with a richer summary) by audit-trail.ts —
    // skip them here so each emit produces exactly one audit_log row.
    if (CURATED.has(env.name)) return;
    const cfg = await getAuditRuntimeConfig();
    if (!cfg.enabled) return; // master capture off
    const severity = severityFor(env.name);
    // Drop the low-signal (debug-severity) long tail when the operator asked to
    // keep the table lean. Curated rows (audit-trail) are never dropped.
    if (severity === "debug" && !cfg.persistLowSignal) return;
    await auditService.record({
      event_name: env.name,
      actor_user_id: env.actorUserId ?? null,
      actor_ip: env.actorIp ?? null,
      target_type: targetTypeForEvent(env.name),
      target_id: targetIdForPayload(env.payload),
      summary: summarizeEvent(env.name),
      severity,
      metadata: redactForStorage(env.payload),
    });
  });
}
