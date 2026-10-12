import "server-only";

import { and, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { audit_log } from "@/modules/audit/schema";

/**
 * Live security signals for the Sécurité control center — the runtime attack
 * trail + account-hygiene facts the read-only diagnostics page never surfaced.
 *
 * Sources:
 *   • audit_log — the security-FAILURE events emitted at warn severity
 *     (user.sign_in_failed / two_factor_failed / auth.rate_limited /
 *     rbac.permission_denied / api_key.auth_failed). Counted over 24h + 7d.
 *   • users — 2FA adoption (the enforced `two_factor_enabled` flag, not a
 *     half-finished `two_factors` row) among ACTIVE admins (the high-value gap).
 *   • sessions / verifications — active sessions + the expired-token backlog the
 *     retention purge clears.
 *
 * Every query is independently try/caught and degrades to a zero/neutral default,
 * so one unavailable table never blanks the whole panel (mirrors the Database +
 * Performance diagnostics). Read-only; never writes.
 */

/** The five security-failure events the panel tracks, in display order. */
export const SECURITY_FAILURE_EVENTS = [
  "user.sign_in_failed",
  "user.two_factor_failed",
  "auth.rate_limited",
  "rbac.permission_denied",
  "api_key.auth_failed",
] as const;

export type SecurityEventCount = { event: string; last24h: number; last7d: number };

export type SecuritySignals = {
  events: SecurityEventCount[];
  /** Sum of all five failure events over each window (the headline numbers). */
  totals: { last24h: number; last7d: number };
  twoFactor: {
    adminsActive: number;
    adminsWith2fa: number;
    adminsWithout2fa: number;
    enrolmentsTotal: number;
  };
  sessions: { active: number; expiredBacklog: number };
  verifications: { expiredBacklog: number };
  /** True when the active PAYMENT_ENCRYPTION_KEY is stored in `app_secrets` in this
   *  same DB (auto-generated on boot) rather than supplied via the environment — so a
   *  DB dump would contain both the key and the ciphertext it protects. Defaults false
   *  (env-supplied / unknown) on a read error, so a transient DB blip never false-warns. */
  paymentKeyInDb: boolean;
  /** True when at least one source query failed (panel shows a soft notice). */
  degraded: boolean;
};

function asInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getSecuritySignals(): Promise<SecuritySignals> {
  let degraded = false;

  // ── Failure events over 24h / 7d (one grouped scan, index-friendly). ──
  const events: SecurityEventCount[] = SECURITY_FAILURE_EVENTS.map((event) => ({
    event,
    last24h: 0,
    last7d: 0,
  }));
  try {
    // BOTH windows use the DB clock (now()) so the 24h subset + the 7d bound are
    // measured against one reference (no app↔DB clock skew between them).
    const rows = await db
      .select({
        event: audit_log.event_name,
        last24h: sql<number>`count(*) filter (where ${audit_log.created_at} >= now() - interval '24 hours')::int`,
        last7d: sql<number>`count(*)::int`,
      })
      .from(audit_log)
      .where(
        and(
          inArray(audit_log.event_name, [...SECURITY_FAILURE_EVENTS]),
          sql`${audit_log.created_at} >= now() - interval '7 days'`,
        ),
      )
      .groupBy(audit_log.event_name);
    const byEvent = new Map(rows.map((r) => [r.event, r]));
    for (const e of events) {
      const r = byEvent.get(e.event);
      if (r) {
        e.last24h = asInt(r.last24h);
        e.last7d = asInt(r.last7d);
      }
    }
  } catch {
    degraded = true;
  }

  const totals = events.reduce(
    (acc, e) => ({ last24h: acc.last24h + e.last24h, last7d: acc.last7d + e.last7d }),
    { last24h: 0, last7d: 0 },
  );

  // ── 2FA adoption among ACTIVE admins (raw SQL — no user input). ──
  // "admin" = the EFFECTIVE super-admin set, matching countEffectiveWildcardAdmins
  // (src/lib/rbac/guards.ts): any ACTIVE account holding the RBAC `*` permission
  // via user_roles → role_permissions. The legacy `users.role` enum was dropped
  // (Stage-4 migration) — the wildcard grant is the sole source of effective-admin.
  // "Has 2FA" = `users.two_factor_enabled`, the flag Better Auth's sign-in hook
  // actually enforces. A bare `two_factors` row is NOT enough: /two-factor/enable
  // inserts it (verified=false) BEFORE the TOTP confirmation, so an abandoned or
  // failed QR step left a row while the admin still signed in password-only.
  const twoFactor = { adminsActive: 0, adminsWith2fa: 0, adminsWithout2fa: 0, enrolmentsTotal: 0 };
  try {
    const res = await db.execute(sql`
      WITH effective_admins AS (
        SELECT DISTINCT u.id, u.two_factor_enabled
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission = '*'
        WHERE u.disabled_at IS NULL
      )
      SELECT
        (SELECT count(*) FROM effective_admins)::int AS admins_active,
        (SELECT count(*) FROM effective_admins WHERE two_factor_enabled)::int AS admins_with_2fa,
        (SELECT count(*) FROM users WHERE two_factor_enabled)::int AS enrolments_total
    `);
    const row = (res.rows as Record<string, unknown>[])[0] ?? {};
    twoFactor.adminsActive = asInt(row.admins_active);
    twoFactor.adminsWith2fa = asInt(row.admins_with_2fa);
    twoFactor.enrolmentsTotal = asInt(row.enrolments_total);
    twoFactor.adminsWithout2fa = Math.max(0, twoFactor.adminsActive - twoFactor.adminsWith2fa);
  } catch {
    degraded = true;
  }

  // ── Sessions: active vs expired backlog (the purge target). ──
  const sessionsStat = { active: 0, expiredBacklog: 0 };
  try {
    const res = await db.execute(sql`
      SELECT
        count(*) filter (where expires_at > now())::int AS active,
        count(*) filter (where expires_at <= now())::int AS expired
      FROM sessions
    `);
    const row = (res.rows as Record<string, unknown>[])[0] ?? {};
    sessionsStat.active = asInt(row.active);
    sessionsStat.expiredBacklog = asInt(row.expired);
  } catch {
    degraded = true;
  }

  // ── Verifications: expired backlog (also a purge target). ──
  const verifications = { expiredBacklog: 0 };
  try {
    const res = await db.execute(
      sql`SELECT count(*) filter (where expires_at <= now())::int AS expired FROM verifications`,
    );
    const row = (res.rows as Record<string, unknown>[])[0] ?? {};
    verifications.expiredBacklog = asInt(row.expired);
  } catch {
    degraded = true;
  }

  // ── Payment-key provenance: is the active key co-located in app_secrets? ──
  // `app_secrets` is a RAW table (outside the Drizzle barrel), written by
  // init-secrets ONLY when it auto-generates a key (an env-supplied key is a no-op,
  // never persisted). So a PAYMENT_ENCRYPTION_KEY row ⟺ the key material lives in
  // THIS DB alongside the ciphertext it protects. A read error (table absent on a
  // fresh/throwaway DB, or a DB blip) degrades to false so the posture never
  // false-warns an env-supplied key. This is NOT counted into `degraded` (the key
  // may simply never have been generated here).
  let paymentKeyInDb = false;
  try {
    const res = await db.execute(
      sql`SELECT EXISTS (SELECT 1 FROM app_secrets WHERE key = 'PAYMENT_ENCRYPTION_KEY') AS present`,
    );
    const row = (res.rows as Record<string, unknown>[])[0] ?? {};
    paymentKeyInDb = row.present === true || row.present === "t";
  } catch {
    paymentKeyInDb = false;
  }

  return {
    events,
    totals,
    twoFactor,
    sessions: sessionsStat,
    verifications,
    paymentKeyInDb,
    degraded,
  };
}
