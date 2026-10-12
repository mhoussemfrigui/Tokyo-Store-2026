import "server-only";

import { NextResponse } from "next/server";

import { apiKeyService } from "@/modules/api-key";
import { checkRateLimit } from "@/lib/rate-limit";
import { bus } from "@/events/bus";
import { passesSample } from "@/events/severity";
import { getClientIp } from "@/lib/client-ip";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { actorMayGrantScope, hasScope } from "./scopes";

/** Deny reasons an unauthenticated/attacker flood can drive at high volume — these
 *  are SAMPLED before the audit emit so a key-guessing or post-throttle storm
 *  can't amplify into a per-request audit_log INSERT. The low-volume,
 *  high-signal reasons (missing/expired/scope — incl. a creator who lost the
 *  grant) always emit. */
// Only the attacker-floodable reasons are sampled; the MEANINGFUL ones
// (missing / expired / scope) are always emitted, so a real mis-scoped or
// expired-key incident always leaves a trail. SECURITY TODO: route the sampled
// `invalid` / `rate_limited` firehose to a SEPARATE high-volume telemetry stream
// (not audit_log) + surface an aggregate "N invalid keys / hour" metric in the
// admin panel, so a key-guessing storm is visible without amplifying audit_log.
const FLOODABLE_REASONS = new Set(["invalid", "rate_limited"]);
const AUTH_FAIL_SAMPLE_PCT = 5;

/**
 * Request guard for the EXTERNAL HTTP API. Authenticates the bearer / x-api-key
 * credential, checks it is active + unexpired + carries the required scope,
 * applies a per-key rate limit, re-checks that the key's CREATOR still holds the
 * RBAC grants behind that scope, and stamps last-used. Returns either the
 * authenticated key context or a ready-to-return error Response — so a route
 * handler is simply:
 *
 *   const auth = await requireApiKey(req, "products:write");
 *   if (!auth.ok) return auth.response;
 *   // … use auth.createdBy as the workflow actor …
 *
 * Never leaks whether a key exists vs is wrong (both → 401 invalid).
 */
export type ApiKeyAuth =
  | { ok: true; keyId: string; scopes: string[]; createdBy: string | null }
  | { ok: false; response: NextResponse };

function extractKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim() || null;
  const x = req.headers.get("x-api-key");
  return x?.trim() || null;
}

const json = (status: number, error: string, headers?: Record<string, string>) =>
  NextResponse.json({ error }, { status, headers });

export async function requireApiKey(req: Request, requiredScope: string): Promise<ApiKeyAuth> {
  // Record a failed API-key auth for the security trail (no key value ever, only
  // the reason + requested scope + IP). FIRE-AND-FORGET (never hold the 401/403/429
  // open behind a DB write), and SAMPLE the attacker-floodable reasons so a
  // key-guessing / post-throttle storm can't amplify into per-request audit_log
  // INSERTs on this hot path. A stolen/mis-scoped key being probed otherwise
  // produced ZERO observable events. Returns the deny result inline (sync).
  const denied = (
    reason: "missing" | "invalid" | "expired" | "scope" | "rate_limited",
    response: NextResponse,
  ): ApiKeyAuth => {
    if (!FLOODABLE_REASONS.has(reason) || passesSample(AUTH_FAIL_SAMPLE_PCT, Math.random())) {
      void bus
        .emit("api_key.auth_failed", { reason, scope: requiredScope, ip: getClientIp(req.headers) })
        .catch(() => {});
    }
    return { ok: false, response };
  };

  const plaintext = extractKey(req);
  if (!plaintext) {
    return denied(
      "missing",
      json(401, "Clé API requise (en-tête Authorization: Bearer … ou X-API-Key).", {
        "WWW-Authenticate": "Bearer",
      }),
    );
  }

  const key = await apiKeyService.findActiveByPlaintext(plaintext).catch(() => null);
  if (!key) return denied("invalid", json(401, "Clé API invalide."));

  if (key.expires_at && key.expires_at.getTime() <= Date.now()) {
    return denied("expired", json(401, "Clé API expirée."));
  }

  if (!hasScope(key.scopes, requiredScope)) {
    return denied("scope", json(403, `Scope « ${requiredScope} » requis pour cette opération.`));
  }

  // Per-key rate limit (fail-open on limiter error so a transient DB hiccup
  // never hard-blocks a valid key) — but LOG it, so a sustained fail-open that
  // silently disables per-key throttling is visible (mirrors enforce.ts).
  const rl = await checkRateLimit({ bucket: `apikey:${key.id}`, max: 120, windowSeconds: 60 }).catch(
    (err) => {
      console.error(`[api-auth] per-key rate-limit check failed for key ${key.id}, allowing (fail-open)`, err);
      return { ok: true } as { ok: boolean };
    },
  );
  if (!rl.ok) {
    return denied("rate_limited", json(429, "Trop de requêtes pour cette clé API."));
  }

  // REQUEST-TIME creator re-check. A key's calls run the admin workflows
  // attributed to its creator, and the scopes were bounded against the creator's
  // RBAC only at MINT time — so a later demotion / role removal would otherwise
  // leave the key's full scope live. The creator must STILL hold the dashboard
  // grants this route's scope maps to (`actorMayGrantScope`). A disabled or
  // deleted creator resolves to the empty set → denied; an enum `admin` owner
  // resolves to `*` → always passes. Runs after the per-key limiter, so it costs
  // at most one (request-memoized) permission lookup per throttled-in call. A
  // key with no creator (`created_by` null) keeps its behaviour: reads only —
  // `requireApiActor` refuses its writes.
  if (key.created_by) {
    const creatorPerms = await resolveUserPermissions(key.created_by).catch(() => new Set<string>());
    if (!actorMayGrantScope(creatorPerms, requiredScope)) {
      return denied("scope", json(403, "Le créateur de cette clé ne dispose plus de ce droit."));
    }
  }

  // Stamp last-used, but at most once a minute per key — `last_used_at` is a
  // display-only field, so writing it on every request would be pure MVCC churn
  // (a new row version + WAL on each call) for no visible gain. The freshness
  // check uses the value already on the loaded row, so it costs no extra read.
  const lastUsedMs = key.last_used_at?.getTime() ?? 0;
  if (Date.now() - lastUsedMs > 60_000) {
    void apiKeyService.touchLastUsed(key.id).catch(() => {});
  }
  return { ok: true, keyId: key.id, scopes: key.scopes, createdBy: key.created_by };
}
