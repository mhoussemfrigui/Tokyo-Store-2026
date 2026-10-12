/**
 * Server-side mirror of client-side funnel events.
 *
 * The client `track()` helper sends funnel events here in addition to
 * pushing onto the GTM dataLayer. Today the route only validates, enforces
 * consent + the rate limit, and logs in dev — it deliberately does NOT
 * persist to audit_log (that table is for stateful actions, not high-volume
 * telemetry). It exists as the single server-side hook where a future
 * fan-out (Meta Conversions API, GA4 Measurement Protocol, Plausible,
 * custom DWH) plugs in without each touchpoint needing its own endpoint.
 * Until one is wired, `serverMirrorActive()` is false in production: the
 * client doesn't POST and this route answers before any DB work.
 *
 * Rate-limited (per-IP) so it can't be spammed. Body is bounded; any
 * bigger payload is rejected before parsing.
 *
 * No auth — funnel events fire on public pages, including for anonymous
 * visitors. We still get useful aggregate data without an identifier.
 */

import { unstable_cache } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { CONSENT_COOKIE } from "@/lib/consent/categories";
import { isConsentRecordCurrent } from "@/lib/consent/state";
import { settingService } from "@/modules/cms/setting/service";
import { ALL_FUNNEL_EVENTS } from "@/lib/tracking/event-groups";
import { serverMirrorActive } from "@/lib/tracking/server-mirror";
import { requireFirstParty } from "@/lib/api-auth/same-origin";
import { CACHE_TAGS } from "@/lib/cache/tags";

/**
 * Server-side read of the analytics consent grant from the tokyo.consent cookie.
 * A decision recorded under an older consent revision is void (same rule as the
 * provider + hasConsent), so its grant doesn't count.
 */
function analyticsCookieGranted(req: NextRequest, revision: number): boolean {
  const raw = req.cookies.get(CONSENT_COOKIE)?.value;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as {
      v?: unknown;
      categories?: { analytics?: unknown };
    };
    if (!isConsentRecordCurrent(parsed, revision)) return false;
    return parsed?.categories?.analytics === true;
  } catch {
    return false;
  }
}

/** `consent.revision` parsed like the consent config's int() (positive, default 1). */
function parseRevision(v: string | null | undefined): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The settings the consent gate reads (master switch + consent config). */
const GATE_KEYS = [
  "tracking.enabled",
  "consent.enabled",
  "consent.analytics_enabled",
  "tracking.bypass_consent",
  "tracking.consent_mode",
  "consent.revision",
] as const;
type GateSettings = Record<(typeof GATE_KEYS)[number], string | null>;

/**
 * The gate's six keys as ONE cached read instead of six DB lookups per event
 * (single-row indexed reads — never the whole settings table). Tagged
 * CACHE_TAGS.settings, so a settings save (`setting.upserted` → bust) —
 * including a consent.revision bump — applies on the next event; the 60 s
 * revalidate bounds staleness if a bust is missed. A DB error throws (never
 * cached) and the caller treats it as "all unset" → tracking off, fail-closed.
 */
const readGateSettings = unstable_cache(
  async (): Promise<GateSettings> => {
    const rows = await Promise.all(GATE_KEYS.map((key) => settingService.findByKey(key)));
    return Object.fromEntries(
      GATE_KEYS.map((key, i) => [key, rows[i]?.value ?? null]),
    ) as GateSettings;
  },
  ["track-gate-settings-v1"],
  { revalidate: 60, tags: [CACHE_TAGS.settings] },
);

const MAX_BODY_BYTES = 8 * 1024; // 8 KB — generous for the GA4 shape
// Derived from the funnel's FunnelEvent union (single source of truth) so the
// server mirror can never drift from what the client emits.
const ALLOWED_EVENTS = new Set<string>(ALL_FUNNEL_EVENTS);

export async function POST(req: NextRequest): Promise<Response> {
  // First-party only — this mirrors funnel events from our own pages; it is not
  // a public ingestion endpoint.
  const notFirstParty = requireFirstParty(req);
  if (notFirstParty) return notFirstParty;

  // No server-side sink (production until a fan-out is wired — see
  // server-mirror.ts): the client doesn't send, and a stray/stale-bundle POST is
  // answered here with ZERO DB work (no rate-limit row, no settings reads).
  if (!serverMirrorActive()) {
    return NextResponse.json({ ok: true, skipped: "no_sink" });
  }

  // Honor consent server-side — defense-in-depth so any future third-party
  // fan-out (Meta CAPI / GA4 Measurement Protocol) can't leak events for a
  // visitor who didn't grant analytics. Checked BEFORE the rate limit: the
  // settings come from one cached read, so a disabled/unconsented event costs
  // no DB round-trip at all. The gate mirrors the client exactly:
  //  - "collect freely" when « Bypass » is on, the banner is disabled, OR
  //    Consent Mode is "off" (the client funnel sends in all three — without
  //    this, the server would silently drop what the client already sent).
  //  - otherwise the cookie's analytics grant counts ONLY if the category is
  //    still OFFERED (consent.analytics_enabled): a stale grant for a category
  //    the admin disabled is denied here too (same mask as hasConsent()), and
  //    ONLY if it was recorded under the current consent.revision (a bump voids
  //    every earlier decision — same rule as hasConsent()).
  const gate = await readGateSettings().catch(
    () => Object.fromEntries(GATE_KEYS.map((key) => [key, null])) as GateSettings,
  );
  // Master switch (Suivi & Analytics tab) — default OFF, matching parseTrackingConfig
  // + clientTrackingFlags (which forces every funnel group off when it's off). The
  // client no-ops before sending; this is the server-side mirror so the two gates
  // agree on the SAME key (not just the legacy consent.* keys).
  const trackingMaster = ["true", "1", "on", "yes"].includes(
    (gate["tracking.enabled"] ?? "").trim().toLowerCase(),
  );
  if (!trackingMaster) {
    return NextResponse.json({ ok: true, skipped: "tracking_disabled" });
  }
  const bannerOn = (gate["consent.enabled"] ?? "").trim().toLowerCase() !== "false";
  const analyticsOffered =
    (gate["consent.analytics_enabled"] ?? "").trim().toLowerCase() !== "false";
  const bypassOn = (gate["tracking.bypass_consent"] ?? "").trim().toLowerCase() === "true";
  const modeOff = (gate["tracking.consent_mode"] ?? "").trim().toLowerCase() === "off";
  const collectFreely = bypassOn || !bannerOn || modeOff;
  const analyticsGranted =
    analyticsCookieGranted(req, parseRevision(gate["consent.revision"])) && analyticsOffered;
  if (!collectFreely && !analyticsGranted) {
    return NextResponse.json({ ok: true, skipped: "no_consent" });
  }

  // Per-IP rate limit. 60 events / minute is plenty for a real user (typical
  // checkout sends ~5 events end-to-end) and shuts down anyone trying to
  // spray events for SEO / attribution manipulation.
  const ip = getClientIp(req.headers) ?? "unknown";
  const rl = await checkRateLimit({ bucket: `track:${ip}`, max: 60, windowSeconds: 60 });
  if (!rl.ok) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  // Bound the body by ACTUAL size. A `content-length` header check alone is
  // bypassable (a client can omit it), which would let the body grow to the
  // 16 MB Next ceiling instead of this 8 KB intent. Read the text and cap it
  // before parsing.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("event" in body) || !("payload" in body)) {
    return NextResponse.json({ ok: false, error: "invalid_shape" }, { status: 400 });
  }
  const { event, payload } = body as { event: string; payload: Record<string, unknown> };
  if (typeof event !== "string" || !ALLOWED_EVENTS.has(event)) {
    return NextResponse.json({ ok: false, error: "unknown_event" }, { status: 400 });
  }

  // Log in development for easy debugging of the funnel; production
  // would fan out to Meta CAPI / GA4 Measurement Protocol / Plausible
  // here (and flip serverMirrorActive()). We don't write to audit_log for
  // funnel events — that table is for stateful actions, not high-volume
  // telemetry — but it's a sensible future hook.
  if (process.env.NODE_ENV !== "production") {
    console.log("[track]", event, JSON.stringify(payload));
  }

  return NextResponse.json({ ok: true });
}
