import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/session";
import { SECURITY_HEADERS, buildCsp } from "@/lib/security/headers";
import { resolveDbSslPosture } from "@/lib/db/ssl";
import { AUTH_POLICY, AUTH_RATE_LIMITS, EMAIL_VERIFICATION_REQUIRED_KEY } from "@/lib/auth/policy";
import { resolveSessionPolicyFromSettings } from "@/lib/auth/session-policy";
import { socialProvidersReady } from "@/lib/auth/social-config";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { getConsentConfig } from "@/lib/consent/config";
import { getTrackingConfig } from "@/lib/tracking/config";
import { computePosture } from "@/lib/security/posture";
import { getSecuritySignals } from "@/lib/security/signals";
import { SecurityCenter, type SecurityCenterData } from "./security-center";

export const metadata: Metadata = { title: "Sécurité" };
// Live config + secret presence + admin count + signals — never statically cache.
export const dynamic = "force-dynamic";

/**
 * Sécurité — the security control center (RBAC `system_security`, view-only).
 *
 * This server component resolves every fact (live signals, posture facts, served
 * headers + CSP, auth policy, secret presence, RGPD config) and hands a fully
 * serialisable bundle to the client <SecurityCenter> which renders the tabbed UI:
 *   • Posture        — OWASP-aligned scorecard + per-control checklist
 *   • Signaux        — live attack trail (failed logins / 2FA / rate-limit / RBAC /
 *                      API-key) + 2FA adoption + session / token-backlog hygiene
 *   • En-têtes & CSP — the served headers + resolved CSP
 *   • Authentification — password/session/cookie policy + rate-limit rules
 *   • Secrets        — presence/validity checklist (BOOLEAN ONLY)
 *   • RGPD & accès   — consent + social providers + last-admin protection
 *
 * STRICTLY read-only and secret-safe: no secret VALUE is ever rendered — only a
 * "Configuré / Non configuré" (+ "valide / placeholder") badge. Predicates mirror
 * the exact env checks in src/lib/env.ts so what's shown matches what's enforced.
 */

const PLACEHOLDER_RE =
  /change[-_]?me|replace|example|placeholder|dev[-_]?secret|your[-_]?secret|secret[-_]?here|sample|minimum_32|test[-_]?secret/i;
const isPlaceholder = (v: string) => PLACEHOLDER_RE.test(v);
const isSet = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
const isProd = () => process.env.NODE_ENV === "production";

function urlHost(v: string | undefined): string {
  try {
    return new URL(v ?? "").hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}
const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1";

export default async function SecurityPage() {
  await requirePermission("system_security", "view");

  const [social, consent, tracking, signals, settingsRead] = await Promise.all([
    socialProvidersReady().catch(() => ({ google: false, facebook: false })),
    getConsentConfig().catch(() => null),
    getTrackingConfig().catch(() => null),
    getSecuritySignals().catch(() => ({
      events: [],
      totals: { last24h: 0, last7d: 0 },
      twoFactor: { adminsActive: 0, adminsWith2fa: 0, adminsWithout2fa: 0, enrolmentsTotal: 0 },
      sessions: { active: 0, expiredBacklog: 0 },
      verifications: { expiredBacklog: 0 },
      paymentKeyInDb: false,
      degraded: true,
    })),
    // Display-only page (no save form), so it may degrade — but VISIBLY: null
    // marks the read as failed and the page shows a « Réglages indisponibles »
    // banner instead of passing the defaults off as the live policy.
    getSettingsMap().catch(() => null),
  ]);
  const settingsUnavailable = settingsRead === null;
  const settings: Record<string, string | null> = settingsRead ?? {};

  // Effective email-verification requirement — the admin toggle
  // (auth.email_verification_required) overrides the AUTH_POLICY default, so the
  // Sécurité diagnostics show what's ACTUALLY enforced (no drift from buildAuth).
  const emailVerificationRequired =
    settings[EMAIL_VERIFICATION_REQUIRED_KEY] === "false"
      ? false
      : AUTH_POLICY.requireEmailVerification;

  // Effective session policy — the admin-tuned auth.session.* values (Utilisateurs
  // → Réglages) with the SAME clamp buildAuth applies, not the AUTH_POLICY
  // defaults (a weakened 90-day session / 30-min cookie cache must show here).
  const sessionPolicy = resolveSessionPolicyFromSettings(settings);

  // Active-admin count reuses the EFFECTIVE-admin number getSecuritySignals already
  // computed (active RBAC `*` holders — access is role-only) — no second query, and
  // one definition of "admin" shared with the 2FA panel. Null only when degraded.
  const activeAdmins: number | null = signals.degraded ? null : signals.twoFactor.adminsActive;

  const csp = (() => {
    try {
      return buildCsp();
    } catch {
      return null;
    }
  })();

  // ── Secret presence/validity (reads process.env directly; NO values shown). ──
  const authSecretRaw = (process.env.BETTER_AUTH_SECRET ?? "").trim();
  const authSecretSet = authSecretRaw.length > 0;
  const authSecretValid = authSecretSet && authSecretRaw.length >= 32 && !isPlaceholder(authSecretRaw);

  const s3AccessRaw = (process.env.S3_ACCESS_KEY ?? "").trim();
  const s3AccessSet = s3AccessRaw.length > 0;
  const s3AccessValid = s3AccessSet && s3AccessRaw !== "seaweedfs";

  const s3SecretRaw = (process.env.S3_SECRET_KEY ?? "").trim();
  const s3SecretSet = s3SecretRaw.length > 0;
  const s3SecretValid = s3SecretSet && s3SecretRaw !== "seaweedfs_dev_secret";

  const dbUrl = process.env.DATABASE_URL;
  const dbHost = urlHost(dbUrl);
  const dbSet = isSet(dbUrl);
  const dbValid = dbSet && !(isProd() && isLocalHost(dbHost));

  const paymentEncryptionConfigured = isSet(process.env.PAYMENT_ENCRYPTION_KEY);

  // DB TLS posture — derived from the SAME readability check the driver uses
  // (resolveDbSslPosture), so the scorecard can't claim "verified" for a CA that
  // is set but unreadable (which `require` silently downgrades to unverified).
  const dbSslPosture = resolveDbSslPosture(dbUrl ?? "");
  const dbTlsVerified: boolean | null =
    dbSslPosture === null ? null : dbSslPosture === "verified";

  const posture = computePosture({
    isProd: isProd(),
    authSecretValid,
    paymentEncryptionConfigured,
    // A key auto-generated into app_secrets sits in the SAME DB as the ciphertext it
    // protects → at-rest encryption gives no real protection; the posture reports that
    // honestly rather than a blind "pass" (only an env-supplied key is a true pass).
    paymentKeyFromDb: signals.paymentKeyInDb,
    dbTlsVerified,
    cspHasNonce: false, // tracked hardening item — see the CSP note
    cspStrictDirectives: true,
    hsts: true,
    twoFactorAvailable: true,
    // When the signals query degraded, adminsWithout2fa is unknown — don't let the
    // 2FA control paint green (or the score inflate) from no data.
    twoFactorDataAvailable: !signals.degraded,
    adminsWithout2fa: signals.twoFactor.adminsWithout2fa,
    bruteForceThrottling: true,
    lastAdminFloor: true,
    securityEventLogging: true,
    emailVerificationRequired,
  });

  const data: SecurityCenterData = {
    posture,
    signals,
    headers: SECURITY_HEADERS,
    csp,
    policy: {
      minPasswordLength: AUTH_POLICY.minPasswordLength,
      maxPasswordLength: AUTH_POLICY.maxPasswordLength,
      requireEmailVerification: emailVerificationRequired,
      emailVerificationExpiresHours: AUTH_POLICY.emailVerificationExpiresHours,
      passwordResetExpiresMinutes: AUTH_POLICY.passwordResetExpiresMinutes,
      trustedLinkingProviders: AUTH_POLICY.trustedLinkingProviders.join(", "),
      sessionExpiresDays: sessionPolicy.expiresDays,
      sessionUpdateAgeDays: sessionPolicy.updateAgeDays,
      sessionCookieCacheMinutes: sessionPolicy.cookieCacheMinutes,
      cookiePrefix: AUTH_POLICY.cookiePrefix,
      cookieSameSite: AUTH_POLICY.cookieSameSite,
      cookieHttpOnly: AUTH_POLICY.cookieHttpOnly,
    },
    rateLimits: {
      windowSeconds: AUTH_RATE_LIMITS.windowSeconds,
      maxPerWindow: AUTH_RATE_LIMITS.maxPerWindow,
      rules: Object.entries(AUTH_RATE_LIMITS.rules).map(([endpoint, rule]) => ({
        endpoint,
        window: rule.window,
        max: rule.max,
      })),
    },
    social,
    secrets: [
      { name: "BETTER_AUTH_SECRET", required: true, configured: authSecretSet, valid: authSecretValid, note: "Doit être défini, ≥ 32 caractères et non générique." },
      { name: "S3_ACCESS_KEY", required: true, configured: s3AccessSet, valid: s3AccessValid, note: "Ne doit pas rester le placeholder de dev « seaweedfs »." },
      { name: "S3_SECRET_KEY", required: true, configured: s3SecretSet, valid: s3SecretValid, note: "Ne doit pas rester le placeholder de dev." },
      { name: "DATABASE_URL", required: true, configured: dbSet, valid: dbValid, note: "En production, l'hôte ne doit pas être localhost." },
      { name: "CRON_SECRET", required: false, configured: isSet(process.env.CRON_SECRET) },
      { name: "ADMIN_BOOTSTRAP_TOKEN", required: false, configured: isSet(process.env.ADMIN_BOOTSTRAP_TOKEN) },
      { name: "PAYMENT_ENCRYPTION_KEY", required: false, configured: paymentEncryptionConfigured, note: "Chiffre les secrets de paiement stockés en base." },
      { name: "DB_SSL_CA", required: false, configured: isSet(process.env.DB_SSL_CA), note: "Bundle CA pour la vérification TLS de Postgres (requis pour sslmode=verify-*)." },
    ],
    consent: consent
      ? {
          enabled: consent.enabled,
          functional: consent.offer.functional,
          analytics: consent.offer.analytics,
          marketing: consent.offer.marketing,
        }
      : null,
    tracking: {
      ga4: Boolean(tracking?.ga4Id),
      gtm: Boolean(tracking?.gtmId),
      meta: Boolean(tracking?.metaPixelId),
    },
    cookieSecureInProd: isProd(),
    activeAdmins,
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour au Système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="Sécurité"
            description="Posture OWASP, signaux d'attaque en direct, en-têtes, authentification, secrets et RGPD."
          />
        </div>
      </div>

      {settingsUnavailable && (
        <p
          role="alert"
          className="rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3 text-xs font-semibold text-[#b45309]"
        >
          Réglages indisponibles — rechargez la page. Les valeurs de session, de
          vérification d&apos;email et de consentement affichées ci-dessous sont les
          valeurs par défaut, pas nécessairement celles appliquées.
        </p>
      )}

      <SecurityCenter data={data} />
    </div>
  );
}
