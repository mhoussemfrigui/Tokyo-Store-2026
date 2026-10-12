/**
 * Effective session policy from a `site_settings` map — PURE (no `server-only`,
 * no DB, no better-auth import), so the Sécurité diagnostics tab and tests can
 * resolve the SAME values `buildAuth` enforces without pulling in the auth
 * instance.
 *
 * Mirrors the clamp in `resolveSessionPolicy` (src/lib/auth/server.ts): a saved
 * value is used only when it is a finite number inside its
 * `SESSION_POLICY_BOUNDS` [min, max]; anything else (missing, garbage,
 * out-of-range) falls back to the `AUTH_POLICY` default — never clamped to the
 * nearest bound, so what's shown matches what's enforced. (server.ts keeps its
 * own inline copy for now; it can switch to this helper without behavior change.)
 */
import { SESSION_POLICY_BOUNDS, SESSION_POLICY_KEYS } from "./policy";

export type EffectiveSessionPolicy = {
  expiresDays: number;
  updateAgeDays: number;
  cookieCacheMinutes: number;
};

/** One bounded numeric setting → its effective value (default when invalid). */
export function readSessionPolicyNumber(
  settings: Record<string, string | null | undefined>,
  key: string,
  bounds: { def: number; min: number; max: number },
): number {
  // Byte-for-byte the `num` clamp of resolveSessionPolicy (server.ts) — keep them
  // in lockstep. A missing key reads as NaN → default. (The save action always
  // persists `String(<clamped int>)`, so null/"" values never occur in practice.)
  const v = Number(settings[key]);
  return Number.isFinite(v) && v >= bounds.min && v <= bounds.max ? Math.round(v) : bounds.def;
}

/** The three admin-tunable session values, as enforced by better-auth. */
export function resolveSessionPolicyFromSettings(
  settings: Record<string, string | null | undefined>,
): EffectiveSessionPolicy {
  return {
    expiresDays: readSessionPolicyNumber(
      settings,
      SESSION_POLICY_KEYS.expiresDays,
      SESSION_POLICY_BOUNDS.expiresDays,
    ),
    updateAgeDays: readSessionPolicyNumber(
      settings,
      SESSION_POLICY_KEYS.updateAgeDays,
      SESSION_POLICY_BOUNDS.updateAgeDays,
    ),
    cookieCacheMinutes: readSessionPolicyNumber(
      settings,
      SESSION_POLICY_KEYS.cookieCacheMinutes,
      SESSION_POLICY_BOUNDS.cookieCacheMinutes,
    ),
  };
}
