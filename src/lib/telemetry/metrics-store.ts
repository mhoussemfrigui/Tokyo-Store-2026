import "server-only";

import type { EventName } from "@/events/types";

/**
 * Tiny in-memory metrics store.
 *
 * Counters bucketed by event name. Resets on every process restart — this
 * is observability scaffolding, NOT a source of truth. Swap for a real
 * Prometheus client (`prom-client`) once we wire a `/metrics` scrape
 * endpoint. The public API here (`increment`, `snapshot`) mirrors what
 * the swap will look like: one counter per event name, atomic increment,
 * pull-based read.
 *
 * The map is held on `globalThis` so HMR in dev doesn't blow away the
 * accumulating counts between route compilations.
 */

declare global {
  var __gz_metrics_counters: Map<string, number> | undefined;
  var __gz_metrics_started_at: number | undefined;
}

const counters = (globalThis.__gz_metrics_counters ??= new Map<string, number>());
const startedAt = (globalThis.__gz_metrics_started_at ??= Date.now());

export function increment(name: EventName): void {
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function snapshot(): {
  counts: Record<string, number>;
  totalEvents: number;
  uniqueEvents: number;
  startedAt: string;
  uptimeMs: number;
} {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of counters) {
    counts[k] = v;
    total += v;
  }
  return {
    counts,
    totalEvents: total,
    uniqueEvents: counters.size,
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Date.now() - startedAt,
  };
}
