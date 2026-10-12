import "server-only";

import { increment } from "@/lib/telemetry/metrics-store";
import { bus } from "../bus";

/**
 * Metrics-counter subscriber.
 *
 * Wildcard listener that buckets every emitted event by name in the
 * in-memory store. The `/api/admin/metrics` route exposes the snapshot.
 *
 * Counters are process-local and reset on every restart — this is
 * observability scaffolding, deliberately not a source of truth. Move to
 * `prom-client` (and have Prometheus scrape `/api/admin/metrics`) once we
 * have a real dashboard need.
 *
 * Errors are swallowed at the subscriber boundary; the increment itself
 * is a Map.set and can't realistically fail, but the try/catch makes
 * the "never break the emitter" contract explicit.
 */
export function registerMetricsCounterSubscriber() {
  bus.onAny(async (env) => {
    try {
      increment(env.name);
    } catch (err) {
      console.error("[telemetry:metrics-counter] increment failed", err);
    }
  });
}
