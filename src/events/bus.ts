import "server-only";

import type { EventEnvelope, EventName, EventPayload } from "./types";

/**
 * In-process event bus.
 *
 * Fan-out is async + non-blocking — subscriber failures are logged but
 * never propagate to the emitter. This is the right default for side
 * effects (email, audit, cache invalidation). For *required* steps,
 * call the service directly in your workflow instead of emitting.
 *
 * Graduates to pg-boss when we need persistence (retries across restarts,
 * scheduled jobs, multi-process fan-out). The handler signature stays the
 * same — the swap is a single-file change in this module.
 */

type Handler<T extends EventName> = (envelope: EventEnvelope<T>) => Promise<void> | void;
type AnyHandler = Handler<EventName>;

const handlers = new Map<EventName | "*", AnyHandler[]>();

declare global {
  var __gz_event_handlers: Map<EventName | "*", AnyHandler[]> | undefined;
}

// Survive HMR in dev.
const registry = (globalThis.__gz_event_handlers ??= handlers);

function add(key: EventName | "*", handler: AnyHandler) {
  const existing = registry.get(key) ?? [];
  existing.push(handler);
  registry.set(key, existing);
}

export const bus = {
  /** Subscribe to a single event type. */
  on<T extends EventName>(name: T, handler: Handler<T>): void {
    add(name, handler as AnyHandler);
  },

  /** Subscribe to every event (used by the audit subscriber). */
  onAny(handler: AnyHandler): void {
    add("*", handler);
  },

  /**
   * Emit an event. Fans out to all subscribers + any wildcard listeners.
   * Resolves once every handler has settled (success or failure logged).
   * Returns void on purpose — callers shouldn't depend on the return.
   */
  async emit<T extends EventName>(
    name: T,
    payload: EventPayload<T>,
    meta: { actorUserId?: string | null; actorIp?: string | null } = {},
  ): Promise<void> {
    const envelope: EventEnvelope<T> = {
      name,
      payload,
      occurredAt: new Date(),
      actorUserId: meta.actorUserId ?? null,
      actorIp: meta.actorIp ?? null,
    };

    const subs = [
      ...(registry.get(name) ?? []),
      ...(registry.get("*") ?? []),
    ];

    if (subs.length === 0) return;

    const results = await Promise.allSettled(
      subs.map((h) => Promise.resolve().then(() => h(envelope as EventEnvelope))),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        console.error(`[events] subscriber for "${name}" rejected`, r.reason);
      }
    }
  },

  /** Test helper — drop all handlers. Do not call in production code. */
  __reset() {
    registry.clear();
    // Also clear the one-shot "subscribers registered" guard (set by
    // registerAllSubscribers). Without this, a re-registration after a reset
    // early-returns and the bus would run with ZERO handlers.
    globalThis.__gz_subscribers_registered = false;
  },
};

export type { EventEnvelope, EventName, EventPayload };
