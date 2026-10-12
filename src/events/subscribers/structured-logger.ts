import "server-only";

import { randomUUID } from "node:crypto";

import { redact } from "@/lib/telemetry/redact";
import { getAuditRuntimeConfig } from "@/lib/audit/runtime-config";
import { decideLogLine } from "@/lib/audit/parse-config";
import { severityFor } from "@/events/severity";
import { bus } from "../bus";
import type { EventEnvelope } from "../types";

/**
 * Structured-logger subscriber.
 *
 * One JSON line per emitted event. Stable schema so a downstream log
 * shipper (Loki, CloudWatch, Datadog, …) can parse without per-event
 * mapping:
 *
 *   { timestamp, event, level, traceId, actorUserId, actorIp, payload? }
 *
 * Wildcard listener — runs for every event. The line is gated by the admin
 * `audit.log_level` floor (debug.enabled forces "debug"; audit.enabled=false
 * silences everything) and each event's derived severity, so production logs
 * stay at info+ unless an operator opts into debug. Config is read through a
 * short-TTL in-process cache (runtime-config) so this hot path doesn't query
 * settings per event. Wrapped in try/catch so a redaction or serialisation bug
 * never bubbles back into the originating workflow.
 *
 * `traceId` is a fresh UUID per event, used for correlation across the
 * telemetry subscribers (logger / audit / metrics). When we adopt
 * OpenTelemetry the trace context will flow in from the request scope
 * and replace this synthetic id.
 */

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch (err) {
    // Last-ditch: a payload contained a circular reference. Drop the
    // payload and keep the envelope so we still see *something*.
    return JSON.stringify({
      __serialize_error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function logEvent(env: EventEnvelope): Promise<void> {
  try {
    const cfg = await getAuditRuntimeConfig();
    // Payload-aware, matching the audit-trail subscriber — a payload-escalated
    // event (e.g. a security-relevant `setting.upserted`) logs at its real
    // severity instead of the name-only default, so the log stream and the audit
    // trail agree on what a `log_level=warn` floor keeps.
    const severity = severityFor(env.name, env.payload);
    // Pure decision (level floor + debug sampling + payload inclusion) — tested.
    const { log, includePayload } = decideLogLine(cfg, severity, Math.random());
    if (!log) return;
    const line = {
      timestamp: env.occurredAt.toISOString(),
      event: env.name,
      level: severity,
      traceId: randomUUID().slice(0, 8),
      actorUserId: env.actorUserId ?? null,
      actorIp: env.actorIp ?? null,
      ...(includePayload ? { payload: redact(env.payload) } : {}),
    };
    // Single-line JSON — log shippers split on newline.
    console.log(safeStringify(line));
  } catch (err) {
    // Never throw out of a subscriber. The bus also catches, but a
    // double-layer defence is cheap and keeps the contract explicit.
    console.error("[telemetry:structured-logger] failed", err);
  }
}

export function registerStructuredLoggerSubscriber() {
  bus.onAny(async (env) => {
    await logEvent(env);
  });
}
