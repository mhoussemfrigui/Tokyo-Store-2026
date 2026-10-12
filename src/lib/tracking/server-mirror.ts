/**
 * Is the server-side funnel mirror (`POST /api/track`) worth sending to?
 *
 * The route is the single hook where a server fan-out (Meta Conversions API,
 * GA4 Measurement Protocol, Plausible, a DWH…) will plug in — but NONE is wired
 * yet: its only sink is the development console log. So in production every
 * storefront funnel event cost a rate-limit write + the consent-gate settings
 * reads for nothing. Both ends read THIS switch: the client funnel skips the
 * POST, and the route answers before touching the DB, while development keeps
 * the full path (and its `[track]` log) for debugging.
 *
 * When a real fan-out lands, set `SERVER_FANOUT_WIRED` to true (or derive it
 * from that provider's config) and both ends turn back on together.
 *
 * PURE (no `server-only`, no DB) — imported by the client funnel and the route;
 * `process.env.NODE_ENV` is inlined into the client bundle at build time.
 */

/** Flip when a server-side provider consumes /api/track events. */
const SERVER_FANOUT_WIRED = false;

export function serverMirrorActive(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return SERVER_FANOUT_WIRED || nodeEnv !== "production";
}
