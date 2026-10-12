"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ShieldCheck,
  ShieldOff,
  ShieldAlert,
  Lock,
  KeyRound,
  Cookie,
  Users,
  FileLock2,
  Activity,
  Gauge,
  ChevronRight,
} from "lucide-react";

import { SubTabBar } from "@/components/admin/_components/form-tabs";
import type { PostureItem, PostureStatus } from "@/lib/security/posture";
import type { SecuritySignals } from "@/lib/security/signals";
import type { HeaderEntry } from "@/lib/security/headers";

// ─────────────────────────────────────────────────── serialisable data shape
export type SecurityCenterData = {
  posture: {
    items: PostureItem[];
    summary: { pass: number; warn: number; info: number; total: number; scorePct: number };
  };
  signals: SecuritySignals;
  headers: HeaderEntry[];
  csp: string | null;
  policy: {
    minPasswordLength: number;
    maxPasswordLength: number;
    requireEmailVerification: boolean;
    emailVerificationExpiresHours: number;
    passwordResetExpiresMinutes: number;
    trustedLinkingProviders: string;
    sessionExpiresDays: number;
    sessionUpdateAgeDays: number;
    sessionCookieCacheMinutes: number;
    cookiePrefix: string;
    cookieSameSite: string;
    cookieHttpOnly: boolean;
  };
  rateLimits: {
    windowSeconds: number;
    maxPerWindow: number;
    rules: { endpoint: string; window: number; max: number }[];
  };
  social: { google: boolean; facebook: boolean };
  secrets: { name: string; required: boolean; configured: boolean; valid?: boolean; note?: string }[];
  consent: {
    enabled: boolean;
    functional: boolean;
    analytics: boolean;
    marketing: boolean;
  } | null;
  tracking: { ga4: boolean; gtm: boolean; meta: boolean };
  cookieSecureInProd: boolean;
  activeAdmins: number | null;
};

const EVENT_LABELS: Record<string, string> = {
  "user.sign_in_failed": "Connexions échouées",
  "user.two_factor_failed": "Échecs 2FA",
  "auth.rate_limited": "Requêtes limitées (anti-force-brute)",
  "rbac.permission_denied": "Refus de permission (RBAC)",
  "api_key.auth_failed": "Échecs d'auth. clé API",
};

// ───────────────────────────────────────────────────────────── small UI bits
function StatusPill({ status }: { status: PostureStatus }) {
  if (status === "pass")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-semibold text-[#15803d]">
        <ShieldCheck className="h-3 w-3" /> conforme
      </span>
    );
  if (status === "warn")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fff4e0] px-2.5 py-1 text-[11px] font-semibold text-[#b45309]">
        <ShieldAlert className="h-3 w-3" /> à corriger
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
      <ShieldOff className="h-3 w-3" /> info
    </span>
  );
}

function BoolPill({ ok, yes = "Configuré", no = "Non configuré" }: { ok: boolean; yes?: string; no?: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-semibold text-[#15803d]">
      <ShieldCheck className="h-3 w-3" /> {yes}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
      <ShieldOff className="h-3 w-3" /> {no}
    </span>
  );
}

function YesNoPill({ value }: { value: boolean }) {
  return value ? (
    <span className="rounded-full bg-[#eaf7ee] px-2 py-0.5 text-[11px] font-semibold text-[#15803d]">oui</span>
  ) : (
    <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">non</span>
  );
}

function Card({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
      <header className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        <div className="min-w-0">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ConfigRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="min-w-0 text-muted-foreground">{label}</span>
      <span className="shrink-0 text-right font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function StatTile({ label, value, tone = "neutral", hint }: { label: string; value: React.ReactNode; tone?: "neutral" | "warn" | "good"; hint?: string }) {
  const ring =
    tone === "warn" ? "border-[#f3e3bd] bg-[#fff4e0]" : tone === "good" ? "border-[#cdebd6] bg-[#eaf7ee]" : "border-border bg-surface/40";
  return (
    <div className={`rounded-[16px] border p-4 ${ring}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const TABS = [
  { id: "posture", label: "Posture", icon: Gauge },
  { id: "signaux", label: "Signaux en direct", icon: Activity },
  { id: "headers", label: "En-têtes & CSP", icon: ShieldCheck },
  { id: "auth", label: "Authentification", icon: Lock },
  { id: "secrets", label: "Secrets", icon: KeyRound },
  { id: "rgpd", label: "RGPD & accès", icon: Cookie },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SecurityCenter({ data }: { data: SecurityCenterData }) {
  const [tab, setTab] = useState<TabId>("posture");
  const { posture, signals } = data;
  const scoreTone =
    posture.summary.scorePct >= 90 ? "text-[#15803d]" : posture.summary.scorePct >= 70 ? "text-[#b45309]" : "text-[#d40530]";
  const scoreBar =
    posture.summary.scorePct >= 90 ? "bg-[#15803d]" : posture.summary.scorePct >= 70 ? "bg-[#b45309]" : "bg-[#d40530]";

  return (
    <div className="space-y-5">
      {/* Shared segmented tab strip (icons + live count badges), in its white nav card. */}
      <SubTabBar
        tabs={TABS.map((t) => {
          const badge =
            t.id === "posture" && posture.summary.warn > 0
              ? posture.summary.warn
              : t.id === "signaux" && signals.totals.last24h > 0
                ? signals.totals.last24h
                : undefined;
          return badge != null ? { ...t, badge } : { ...t };
        })}
        activeTab={tab}
        onSelect={setTab}
      />

      {/* ── Posture ─────────────────────────────────────────────────────── */}
      {tab === "posture" && (
        <div className="space-y-5">
          <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Score de posture</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Contrôles actifs / contrôles évaluables (les éléments « info » sont neutres). Aligné OWASP Top 10 2021.
                </p>
              </div>
              <div className="text-right">
                <span className={`text-4xl font-extrabold tabular-nums ${scoreTone}`}>{posture.summary.scorePct}</span>
                <span className="text-lg font-bold text-muted-foreground">/100</span>
              </div>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface">
              <div className={`h-full rounded-full ${scoreBar}`} style={{ width: `${posture.summary.scorePct}%` }} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-full bg-[#eaf7ee] px-2.5 py-1 font-semibold text-[#15803d]">
                {posture.summary.pass} conformes
              </span>
              <span className="rounded-full bg-[#fff4e0] px-2.5 py-1 font-semibold text-[#b45309]">
                {posture.summary.warn} à corriger
              </span>
              <span className="rounded-full bg-surface px-2.5 py-1 font-semibold text-muted-foreground">
                {posture.summary.info} info
              </span>
            </div>
          </section>

          <Card icon={ShieldCheck} title="Contrôles de sécurité" description="État de chaque contrôle, avec sa catégorie OWASP.">
            <ul className="divide-y divide-border">
              {posture.items.map((it) => (
                <li key={it.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        {it.owasp}
                      </span>
                      {it.label}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{it.detail}</p>
                  </div>
                  <div className="shrink-0 pt-0.5">
                    <StatusPill status={it.status} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* ── Signaux en direct ───────────────────────────────────────────── */}
      {tab === "signaux" && (
        <div className="space-y-5">
          {signals.degraded && (
            <p className="rounded-xl border border-[#f3e3bd] bg-[#fff4e0] px-4 py-2 text-xs text-[#b45309]">
              Certaines mesures sont momentanément indisponibles — les valeurs affichées peuvent être incomplètes.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Échecs sécurité (24 h)" value={signals.totals.last24h} tone={signals.totals.last24h > 0 ? "warn" : "good"} hint="connexion + 2FA + RBAC + clé API" />
            <StatTile label="Échecs sécurité (7 j)" value={signals.totals.last7d} tone={signals.totals.last7d > 0 ? "warn" : "neutral"} />
            <StatTile
              label="Admins sans 2FA"
              value={signals.twoFactor.adminsWithout2fa}
              tone={signals.twoFactor.adminsWithout2fa > 0 ? "warn" : "good"}
              hint={`${signals.twoFactor.adminsWith2fa}/${signals.twoFactor.adminsActive} admins protégés`}
            />
            <StatTile label="Sessions actives" value={signals.sessions.active} hint={`${signals.sessions.expiredBacklog} expirées en attente de purge`} />
          </div>

          <Card icon={Activity} title="Évènements de sécurité (échecs)" description="Tentatives échouées enregistrées — la trace d'attaque. Détail dans le Journal d'audit.">
            <div className="overflow-hidden rounded-[22px] border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                    <th className="px-3 py-2 font-bold">Évènement</th>
                    <th className="px-3 py-2 text-right font-bold">24 h</th>
                    <th className="px-3 py-2 text-right font-bold">7 j</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {signals.events.map((e) => (
                    <tr key={e.event} className="transition hover:bg-[#fffbfb]">
                      <td className="px-3 py-2 text-foreground">{EVENT_LABELS[e.event] ?? e.event}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${e.last24h > 0 ? "font-semibold text-[#b45309]" : "text-muted-foreground"}`}>
                        {e.last24h}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">{e.last7d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <Link href="/admin/system/audit" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                Journal d'audit <ChevronRight className="h-3 w-3" />
              </Link>
              <Link href="/admin/system/jobs" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                Purge planifiée (sessions / jetons) <ChevronRight className="h-3 w-3" />
              </Link>
              <Link href="/admin/users/roles" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                Politique de session & rôles <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          </Card>

          <Card icon={KeyRound} title="Hygiène des comptes & jetons" description="Adoption de la 2FA et arriéré de jetons expirés (cible de la purge).">
            <div className="grid gap-x-8 sm:grid-cols-2">
              <div className="divide-y divide-border">
                <ConfigRow label="Administrateurs actifs" value={signals.twoFactor.adminsActive} />
                <ConfigRow label="Administrateurs avec 2FA" value={signals.twoFactor.adminsWith2fa} />
                <ConfigRow
                  label="Administrateurs sans 2FA"
                  value={
                    signals.twoFactor.adminsWithout2fa > 0 ? (
                      <span className="font-semibold text-[#b45309]">{signals.twoFactor.adminsWithout2fa}</span>
                    ) : (
                      0
                    )
                  }
                />
                <ConfigRow label="Inscriptions 2FA (total)" value={signals.twoFactor.enrolmentsTotal} />
              </div>
              <div className="divide-y divide-border">
                <ConfigRow label="Sessions actives" value={signals.sessions.active} />
                <ConfigRow label="Sessions expirées (à purger)" value={signals.sessions.expiredBacklog} />
                <ConfigRow label="Jetons de vérification expirés" value={signals.verifications.expiredBacklog} />
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ── En-têtes & CSP ──────────────────────────────────────────────── */}
      {tab === "headers" && (
        <Card
          icon={ShieldCheck}
          title="En-têtes & CSP"
          description="En-têtes de sécurité appliqués à chaque réponse et politique de sécurité du contenu (CSP) résolue. Source unique partagée avec next.config."
        >
          <div className="overflow-hidden rounded-[22px] border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {data.headers.map((h) => (
                  <tr key={h.key} className="align-top">
                    <th className="w-1/3 bg-surface/40 px-3 py-2 text-left font-medium text-muted-foreground">{h.key}</th>
                    <td className="break-all px-3 py-2 font-mono text-[12px] text-foreground">{h.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Content-Security-Policy (résolue)</p>
          {data.csp ? (
            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-surface/40 p-3 text-[12px] leading-relaxed text-foreground">
              <code>{data.csp}</code>
            </pre>
          ) : (
            <p className="mt-1.5 text-sm text-muted-foreground">CSP indisponible.</p>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Note : <code className="rounded bg-surface px-1 py-0.5">'unsafe-inline'</code> sur{" "}
            <code className="rounded bg-surface px-1 py-0.5">script-src</code> est un compromis requis par l'hydratation
            RSC de Next.js. C'est l'élément « CSP — script-src avec nonce » de la Posture : un durcissement futur
            migrerait vers un nonce par requête + <code className="rounded bg-surface px-1 py-0.5">'strict-dynamic'</code>.
            En attendant, la désinfection HTML (DOMPurify) reste le contrôle anti-XSS actif.
          </p>
        </Card>
      )}

      {/* ── Authentification ────────────────────────────────────────────── */}
      {tab === "auth" && (
        <Card
          icon={Lock}
          title="Politique d'authentification"
          description="Règles de mot de passe, de session et de cookie appliquées par better-auth + limitation anti-force-brute."
        >
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div className="divide-y divide-border">
              <ConfigRow label="Longueur min. du mot de passe" value={data.policy.minPasswordLength} />
              <ConfigRow label="Longueur max. du mot de passe" value={data.policy.maxPasswordLength} />
              <ConfigRow label="Vérification e-mail requise" value={<YesNoPill value={data.policy.requireEmailVerification} />} />
              <ConfigRow label="Expiration vérification e-mail" value={`${data.policy.emailVerificationExpiresHours} h`} />
              <ConfigRow label="Expiration réinitialisation" value={`${data.policy.passwordResetExpiresMinutes} min`} />
              <ConfigRow label="Auto-liaison (fournisseurs de confiance)" value={data.policy.trustedLinkingProviders} />
            </div>
            <div className="divide-y divide-border">
              <ConfigRow label="Expiration de session" value={`${data.policy.sessionExpiresDays} j`} />
              <ConfigRow label="Rafraîchissement (updateAge)" value={`${data.policy.sessionUpdateAgeDays} j`} />
              <ConfigRow
                label="Cache cookie de session"
                value={
                  data.policy.sessionCookieCacheMinutes === 0
                    ? "Désactivé"
                    : `${data.policy.sessionCookieCacheMinutes} min`
                }
              />
              <ConfigRow label="Préfixe de cookie" value={<code>{data.policy.cookiePrefix}</code>} />
              <ConfigRow label="Cookie SameSite" value={data.policy.cookieSameSite} />
              <ConfigRow label="Cookie httpOnly" value={<YesNoPill value={data.policy.cookieHttpOnly} />} />
            </div>
          </div>

          <p className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Limitation de débit (par IP / endpoint)
          </p>
          <div className="mt-1.5 overflow-hidden rounded-[22px] border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="px-3 py-2 font-bold">Endpoint</th>
                  <th className="px-3 py-2 text-right font-bold">Fenêtre</th>
                  <th className="px-3 py-2 text-right font-bold">Max</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="px-3 py-2 font-mono text-[12px] text-muted-foreground">(par défaut) /api/auth/*</td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{data.rateLimits.windowSeconds} s</td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{data.rateLimits.maxPerWindow}</td>
                </tr>
                {data.rateLimits.rules.map((r) => (
                  <tr key={r.endpoint}>
                    <td className="px-3 py-2 font-mono text-[12px] text-foreground">{r.endpoint}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">{r.window} s</td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">{r.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Les connexions par server action passent par une limitation Postgres dédiée (par IP + par compte), et la
            vérification 2FA par une limite par IP + par défi — distinctes du limiteur HTTP ci-dessus.
          </p>
        </Card>
      )}

      {/* ── Secrets ─────────────────────────────────────────────────────── */}
      {tab === "secrets" && (
        <Card
          icon={KeyRound}
          title="Secrets (configuration)"
          description="Présence et validité des secrets — aucune valeur n'est jamais affichée. Les prédicats reflètent ceux appliqués au démarrage (src/lib/env.ts)."
        >
          <div className="divide-y divide-border">
            {data.secrets.map((s) => (
              <div key={s.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    <code className="rounded bg-surface px-1.5 py-0.5 text-[12px]">{s.name}</code>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        s.required ? "bg-[#fff4e0] text-[#b45309]" : "bg-surface text-muted-foreground"
                      }`}
                    >
                      {s.required ? "requis" : "optionnel"}
                    </span>
                  </p>
                  {s.note && <p className="mt-0.5 text-[11px] text-muted-foreground">{s.note}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {s.valid !== undefined && s.configured && <BoolPill ok={s.valid} yes="valide" no="placeholder" />}
                  <BoolPill ok={s.configured} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── RGPD & accès ────────────────────────────────────────────────── */}
      {tab === "rgpd" && (
        <div className="space-y-5">
          <Card
            icon={Users}
            title="Fournisseurs sociaux (OAuth)"
            description="Un fournisseur est « prêt » lorsque son identifiant client ET son secret sont résolus. Aucune information d'identification n'est affichée."
          >
            <div className="divide-y divide-border">
              <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="font-medium text-foreground">Google</span>
                <BoolPill ok={data.social.google} yes="prêt" no="non configuré" />
              </div>
              <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="font-medium text-foreground">Facebook</span>
                <BoolPill ok={data.social.facebook} yes="prêt" no="non configuré" />
              </div>
            </div>
          </Card>

          <Card
            icon={Cookie}
            title="RGPD / Consentement"
            description="Bannière de consentement, catégories proposées et balises configurées. Les identifiants de balises ne sont jamais affichés."
          >
            {data.consent ? (
              <div className="grid gap-x-8 sm:grid-cols-2">
                <div className="divide-y divide-border">
                  <ConfigRow label="Bannière de consentement active" value={<YesNoPill value={data.consent.enabled} />} />
                  <ConfigRow label="Catégorie « Fonctionnel »" value={<YesNoPill value={data.consent.functional} />} />
                  <ConfigRow label="Catégorie « Analytique »" value={<YesNoPill value={data.consent.analytics} />} />
                  <ConfigRow label="Catégorie « Marketing »" value={<YesNoPill value={data.consent.marketing} />} />
                </div>
                <div className="divide-y divide-border">
                  <ConfigRow label="Google Analytics (GA4)" value={<BoolPill ok={data.tracking.ga4} />} />
                  <ConfigRow label="Google Tag Manager (GTM)" value={<BoolPill ok={data.tracking.gtm} />} />
                  <ConfigRow label="Meta Pixel" value={<BoolPill ok={data.tracking.meta} />} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Configuration de consentement indisponible.</p>
            )}
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Drapeaux des cookies de session
            </p>
            <div className="mt-1.5 divide-y divide-border">
              <ConfigRow label="httpOnly" value={<YesNoPill value={data.policy.cookieHttpOnly} />} />
              <ConfigRow label="secure (en production)" value={<YesNoPill value={data.cookieSecureInProd} />} />
              <ConfigRow label="SameSite" value={data.policy.cookieSameSite} />
              <ConfigRow label="Préfixe" value={<code>{data.policy.cookiePrefix}</code>} />
            </div>
          </Card>

          <Card
            icon={FileLock2}
            title="Protection du dernier administrateur"
            description="Empêche la suppression ou la désactivation du dernier compte administrateur actif."
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <BoolPill ok yes="active" no="active" />
              <div className="flex items-center gap-2 text-sm">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Administrateurs actifs</span>
                <span className="rounded-full bg-surface px-2.5 py-1 text-sm font-bold tabular-nums text-foreground">
                  {data.activeAdmins != null ? data.activeAdmins.toLocaleString("fr-FR") : "indisponible"}
                </span>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
