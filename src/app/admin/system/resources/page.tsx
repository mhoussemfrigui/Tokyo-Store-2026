import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Boxes,
  ChevronLeft,
  Cloud,
  Database,
  Gauge,
  Globe,
  HardDrive,
  Image as ImageIcon,
  Link2,
  Mail,
  Plug,
  Server,
  Sparkles,
  Users,
} from "lucide-react";
import { HeadBucketCommand } from "@aws-sdk/client-s3";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/session";
import { serverEnv, clientEnv } from "@/lib/env";
import { db, POOL_CONFIG } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { mediaSettingsService } from "@/modules/media/settings.service";
import { getS3Client } from "@/modules/media/storage";
import { primeCdnBase } from "@/modules/media/cdn-base";
import { pingDbSamples } from "@/lib/telemetry/runtime-metrics";
import { resolveMailProviderConfig } from "@/lib/email/config";
import { resolvePaymentConfig } from "@/lib/payments/config";
import { resolveAiProviderConfig } from "@/lib/ai/config";
import { AI_PROVIDERS } from "@/lib/ai/providers";
import { socialProvidersReady } from "@/lib/auth/social-config";
import { getTrackingConfig } from "@/lib/tracking/config";

export const metadata: Metadata = { title: "Ressources" };
// Infrastructure status is live (env + DB) — never serve a stale snapshot.
export const dynamic = "force-dynamic";

const DEV_S3_ACCESS = "seaweedfs";
const DEV_S3_SECRET = "seaweedfs_dev_secret";

/**
 * Ressources — infrastructure & resources overview.
 *
 * A read-only diagnostic of the moving parts behind the storefront: object
 * storage (S3), the media library + its processing settings, the
 * effective CDN base, the e-mail provider, and a roll-up of every external
 * integration with a configured/resolved badge. Secrets are NEVER printed —
 * only a "Configuré"/"Non configuré" pill. Each block reads its data inside a
 * try/catch and degrades to "indisponible" rather than 500-ing the page.
 */
export default async function ResourcesPage() {
  await requirePermission("system_resources", "view");
  const [
    s3,
    mediaStats,
    mediaSettings,
    cdn,
    mail,
    payments,
    consent,
    ai,
    oauth,
    dbProbe,
    s3Reachable,
  ] = await Promise.all([
    loadS3(),
    loadMediaStats(),
    loadMediaSettings(),
    loadCdn(),
    loadMail(),
    loadPayments(),
    loadConsent(),
    loadAi(),
    loadOAuth(),
    pingDbSamples(3).catch(() => null),
    // Only probe object-store reachability when real creds are configured —
    // otherwise null = "non testée" (no wasted 2.5s HeadBucket, no contradictory
    // "Non configuré" + "Injoignable"). The check is synchronous (env-only).
    s3CredentialsConfigured() ? loadS3Reachable() : Promise.resolve(null),
  ]);

  const siteUrl = safeSiteUrl();
  const healthUrl = siteUrl ? `${siteUrl.replace(/\/+$/, "")}/api/health` : null;

  // Live "is it actually up?" status (vs. mere config presence). DB latency is
  // the SHARED probe used by the Performance + Database tabs.
  const dbOnline = dbProbe?.ok ?? false;
  const dbLatencyMs = dbProbe?.medianMs ?? null;

  // Roll-up: count the integrations that are configured vs the total surfaced.
  const serviceFlags: boolean[] = [
    dbOnline,
    Boolean(s3?.credentialsConfigured),
    Boolean(mail?.configured),
    Boolean(payments?.clictopay),
    Boolean(payments?.flouci),
    Boolean(consent?.gtm),
    Boolean(consent?.ga4),
    Boolean(consent?.metaPixel),
    Boolean(oauth?.google),
    Boolean(oauth?.facebook),
    // Fixed denominator slot per AI provider even if loadAi() failed (null) —
    // else serviceTotal would silently shrink and "X/Y" would be unstable.
    ...(ai ? ai.map((p) => p.configured) : AI_PROVIDERS.map(() => false)),
  ];
  const configuredCount = serviceFlags.filter(Boolean).length;
  const serviceTotal = serviceFlags.length;
  // "Down" = something that IS configured but isn't responding (DB / object store).
  const downCount = (dbOnline ? 0 : 1) + (s3?.credentialsConfigured && s3Reachable === false ? 1 : 0);

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
            title="Ressources"
            description="Stockage objet, médiathèque, CDN, e-mail et services externes — configuration + état en direct."
          />
        </div>
      </div>

      {/* ── Diagnostics liés + rollup ───────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Diagnostics liés :</span>
          <RelatedLink href="/admin/system/performance" icon={Gauge} label="Performance" />
          <RelatedLink href="/admin/system/database" icon={Database} label="Base de données" />
          <RelatedLink href="/admin/system/api" icon={Plug} label="API & Webhooks" />
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">
            {configuredCount}/{serviceTotal} services configurés
          </span>
          {downCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 font-semibold text-destructive">
              {downCount} injoignable{downCount > 1 ? "s" : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf7ee] px-2.5 py-1 font-semibold text-[#15803d]">
              Opérationnel
            </span>
          )}
        </div>
      </div>

      {/* ── Stockage S3 (SeaweedFS) ─────────────────────────────────────── */}
      <Card>
        <CardHeader
          icon={HardDrive}
          title="Stockage S3 (SeaweedFS)"
          subtitle="Bucket d'objets où sont stockés les médias et fichiers."
        />
        {s3 ? (
          <div className="space-y-1">
            <ConfigRow label="Endpoint" value={<Mono>{s3.endpoint}</Mono>} />
            <ConfigRow label="Région" value={<Mono>{s3.region}</Mono>} />
            <ConfigRow label="Bucket" value={<Mono>{s3.bucket}</Mono>} />
            <ConfigRow
              label="URL publique"
              value={<Mono>{s3.publicUrl}</Mono>}
            />
            <ConfigRow
              label="Force path style"
              value={<BoolPill value={s3.forcePathStyle} on="Activé" off="Désactivé" />}
            />
            <ConfigRow
              label="Identifiants configurés"
              value={
                <BoolPill
                  value={s3.credentialsConfigured}
                  on="Configuré"
                  off="Non configuré"
                />
              }
            />
            <ConfigRow
              label="Réachabilité (HeadBucket en direct)"
              value={
                s3Reachable == null ? (
                  <Muted>non testée</Muted>
                ) : (
                  <BoolPill value={s3Reachable} on="En ligne" off="Injoignable" />
                )
              }
            />
          </div>
        ) : (
          <Unavailable />
        )}
      </Card>

      {/* ── Médiathèque ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          icon={ImageIcon}
          title="Médiathèque"
          subtitle="Contenu stocké et réglages de traitement des médias."
          action={
            <Link
              href="/admin/system/database"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Répartition du stockage <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        />
        {mediaStats ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Médias" value={mediaStats.count.toLocaleString("fr-FR")} icon={ImageIcon} />
            <Stat label="Taille totale" value={formatBytes(mediaStats.bytes)} icon={HardDrive} />
            {mediaStats.perKind.map((k) => (
              <Stat
                key={k.kind}
                label={`${k.kind} · ${k.n.toLocaleString("fr-FR")}`}
                value={formatBytes(k.bytes)}
                icon={Boxes}
              />
            ))}
          </div>
        ) : (
          <Unavailable />
        )}

        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Réglages de traitement
          </p>
          {mediaSettings ? (
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <ConfigRow
                label="Générer WebP"
                value={<BoolPill value={mediaSettings.generate_webp} />}
              />
              <ConfigRow
                label="Générer AVIF"
                value={<BoolPill value={mediaSettings.generate_avif} />}
              />
              <ConfigRow
                label="Conserver l'original"
                value={<BoolPill value={mediaSettings.keep_original} />}
              />
              <ConfigRow
                label="Supprimer EXIF"
                value={<BoolPill value={mediaSettings.strip_exif} />}
              />
              <ConfigRow
                label="Largeur max"
                value={<Mono>{mediaSettings.max_width_px} px</Mono>}
              />
              <ConfigRow
                label="Hauteur max"
                value={<Mono>{mediaSettings.max_height_px} px</Mono>}
              />
              <ConfigRow
                label="Qualité WebP"
                value={<Mono>{mediaSettings.webp_quality}</Mono>}
              />
              <ConfigRow
                label="Qualité AVIF"
                value={<Mono>{mediaSettings.avif_quality}</Mono>}
              />
              <ConfigRow
                label="Qualité JPEG"
                value={<Mono>{mediaSettings.jpeg_quality}</Mono>}
              />
              <ConfigRow
                label="Upload max"
                value={<Mono>{mediaSettings.max_upload_mb} MB</Mono>}
              />
              <ConfigRow
                label="Texte alternatif par défaut"
                value={
                  mediaSettings.default_alt_text ? (
                    <Mono>{mediaSettings.default_alt_text}</Mono>
                  ) : (
                    <Muted>—</Muted>
                  )
                }
              />
              <ConfigRow
                label="CDN (réglage)"
                value={
                  mediaSettings.cdn_base_url ? (
                    <Mono>{mediaSettings.cdn_base_url}</Mono>
                  ) : (
                    <Muted>même origine</Muted>
                  )
                }
              />
            </div>
          ) : (
            <Unavailable />
          )}
        </div>
      </Card>

      {/* ── CDN ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          icon={Cloud}
          title="CDN"
          subtitle="Préfixe d'URL effectif pour servir les médias publics."
        />
        {cdn ? (
          <div className="space-y-1">
            <ConfigRow
              label="Base effective"
              value={
                cdn.base ? <Mono>{cdn.base}</Mono> : <Muted>/cdn (même origine)</Muted>
              }
            />
            <ConfigRow label="Source" value={<Mono>{cdn.source}</Mono>} />
          </div>
        ) : (
          <Unavailable />
        )}
      </Card>

      {/* ── E-mail ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          icon={Mail}
          title="E-mail"
          subtitle="Fournisseur d'envoi et adresses expéditrices."
        />
        {mail ? (
          <div className="space-y-1">
            <ConfigRow label="Fournisseur" value={<Mono>{mail.providerName}</Mono>} />
            <ConfigRow
              label="Configuré"
              value={
                <BoolPill value={mail.configured} on="Configuré" off="Non configuré" />
              }
            />
            <ConfigRow label="Expéditeur (From)" value={<Mono>{mail.from}</Mono>} />
            <ConfigRow
              label="Répondre à (Reply-To)"
              value={mail.replyTo ? <Mono>{mail.replyTo}</Mono> : <Muted>—</Muted>}
            />
            {mail.providerName === "smtp" && (
              <>
                <ConfigRow
                  label="Hôte SMTP"
                  value={mail.smtpHost ? <Mono>{mail.smtpHost}</Mono> : <Muted>—</Muted>}
                />
                <ConfigRow label="Port SMTP" value={<Mono>{mail.smtpPort}</Mono>} />
                <ConfigRow
                  label="SMTP sécurisé (TLS)"
                  value={<BoolPill value={mail.smtpSecure} on="Activé" off="Désactivé" />}
                />
              </>
            )}
          </div>
        ) : (
          <Unavailable />
        )}
      </Card>

      {/* ── Services externes ───────────────────────────────────────── */}
      <Card>
        <CardHeader
          icon={Plug}
          title="Services externes"
          subtitle="État de configuration des principales intégrations externes."
        />
        <div className="space-y-1">
          <ServiceRow
            icon={Database}
            label="PostgreSQL"
            configured={dbOnline}
            href="/admin/system/database"
            subtitle={
              dbOnline && dbLatencyMs != null
                ? `Base de données · ${dbLatencyMs} ms (médian, ${POOL_CONFIG.applicationName})`
                : "Base de données"
            }
            trailing={<BoolPill value={dbOnline} on="En ligne" off="Injoignable" />}
          />
          <ServiceRow
            icon={HardDrive}
            label="Stockage S3 (SeaweedFS)"
            configured={Boolean(s3?.credentialsConfigured)}
            subtitle={
              s3Reachable == null
                ? "Identifiants du bucket"
                : s3Reachable
                  ? "Bucket joignable (HeadBucket)"
                  : "Bucket injoignable"
            }
            trailing={
              s3Reachable == null ? undefined : (
                <BoolPill value={s3Reachable} on="En ligne" off="Injoignable" />
              )
            }
          />
          <ServiceRow
            icon={Mail}
            label="E-mail"
            configured={Boolean(mail?.configured)}
            subtitle={mail ? `Fournisseur : ${mail.providerName}` : "indisponible"}
          />
          <ServiceRow
            icon={Plug}
            label="ClicToPay"
            configured={Boolean(payments?.clictopay)}
            subtitle="Passerelle de paiement"
          />
          <ServiceRow
            icon={Plug}
            label="Flouci"
            configured={Boolean(payments?.flouci)}
            subtitle="Passerelle de paiement"
          />
          <ServiceRow
            icon={Globe}
            label="Google Tag Manager (GTM)"
            configured={Boolean(consent?.gtm)}
            subtitle="Analytique"
          />
          <ServiceRow
            icon={Globe}
            label="Google Analytics (GA4)"
            configured={Boolean(consent?.ga4)}
            subtitle="Analytique"
          />
          <ServiceRow
            icon={Globe}
            label="Meta Pixel"
            configured={Boolean(consent?.metaPixel)}
            subtitle="Analytique"
          />
          <ServiceRow
            icon={Users}
            label="Connexion Google (OAuth)"
            configured={Boolean(oauth?.google)}
            subtitle="Authentification sociale"
          />
          <ServiceRow
            icon={Users}
            label="Connexion Facebook (OAuth)"
            configured={Boolean(oauth?.facebook)}
            subtitle="Authentification sociale"
          />
          {/* Fall back to the known providers (all "Non configuré") if loadAi()
              failed, so the rows never vanish + match the rollup denominator. */}
          {(ai ?? AI_PROVIDERS.map((p) => ({ id: p.id, label: p.label, configured: false }))).map((p) => (
            <ServiceRow
              key={p.id}
              icon={Sparkles}
              label={`IA — ${p.label}`}
              configured={p.configured}
              subtitle="Fournisseur IA / automatisation (clé chiffrée en base ; env force-override)"
            />
          ))}
          <ServiceRow
            icon={Server}
            label="Endpoint de santé"
            configured={Boolean(healthUrl)}
            subtitle={
              healthUrl ? (
                <span className="inline-flex items-center gap-1">
                  <Link2 className="h-3 w-3" />
                  <Mono>{healthUrl}</Mono>
                </span>
              ) : (
                "indisponible"
              )
            }
          />
        </div>
      </Card>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── loaders ── */

type S3View = {
  endpoint: string;
  region: string;
  bucket: string;
  publicUrl: string;
  forcePathStyle: boolean;
  credentialsConfigured: boolean;
};

/** Synchronous env-only check: are REAL (non-dev-placeholder) S3 creds set? */
function s3CredentialsConfigured(): boolean {
  const accessKey = serverEnv.S3_ACCESS_KEY;
  const secretKey = serverEnv.S3_SECRET_KEY;
  return (
    Boolean(accessKey && secretKey) &&
    accessKey !== DEV_S3_ACCESS &&
    secretKey !== DEV_S3_SECRET
  );
}

async function loadS3(): Promise<S3View | null> {
  try {
    return {
      endpoint: serverEnv.S3_ENDPOINT,
      region: serverEnv.S3_REGION,
      bucket: serverEnv.S3_BUCKET,
      publicUrl: serverEnv.S3_PUBLIC_URL,
      forcePathStyle: serverEnv.S3_FORCE_PATH_STYLE,
      credentialsConfigured: s3CredentialsConfigured(),
    };
  } catch {
    return null;
  }
}

/**
 * LIVE object-store reachability — a bounded HeadBucket against the configured
 * bucket. true = reachable, false = error/timeout. Only called when real creds
 * are configured (else the caller short-circuits to null = "non testée").
 * The request is ABORTED at 2.5s (AbortController) so a hung object store can neither
 * stall the page nor leak a socket; the send promise is also `.catch`-swallowed
 * so the loser of the race can never become an unhandled rejection. Read-only.
 */
async function loadS3Reachable(): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("s3-timeout")), 2500);
  // Swallow the eventual settlement of the send promise so that, whichever side
  // of the race wins, a late rejection is always handled.
  const send = getS3Client()
    .send(new HeadBucketCommand({ Bucket: serverEnv.S3_BUCKET }), {
      abortSignal: ac.signal,
    })
    .then(
      () => true as const,
      () => false as const,
    );
  try {
    return await send;
  } finally {
    clearTimeout(timer);
  }
}

type MediaStats = {
  count: number;
  bytes: number;
  perKind: { kind: string; n: number; bytes: number }[];
};

async function loadMediaStats(): Promise<MediaStats | null> {
  try {
    // True S3 footprint = primary + every derived variant (webp/avif/original),
    // each a separate physical object — otherwise the total undercounts. The kept
    // original counts only when it's a DISTINCT object (its URL differs from the
    // primary); GIFs / no-variant fallbacks alias it to the primary, so counting
    // its bytes there would double-count the same object.
    const sizeSum = sql`(COALESCE(sum(size_bytes),0) + COALESCE(sum(webp_size_bytes),0) + COALESCE(sum(avif_size_bytes),0) + COALESCE(sum(CASE WHEN original_url IS DISTINCT FROM url THEN original_size_bytes ELSE 0 END),0))::bigint`;
    const totals = await db.execute(
      sql`SELECT count(*)::int AS n, ${sizeSum} AS bytes FROM media WHERE deleted_at IS NULL`,
    );
    // Per-kind COUNT *and* bytes so images / videos / … storage is itemised.
    const kinds = await db.execute(
      sql`SELECT kind, count(*)::int AS n, ${sizeSum} AS bytes FROM media WHERE deleted_at IS NULL GROUP BY kind ORDER BY bytes DESC`,
    );
    const totalsRow = totals.rows[0] as { n: number; bytes: string | number } | undefined;
    return {
      count: Number(totalsRow?.n ?? 0),
      bytes: Number(totalsRow?.bytes ?? 0),
      perKind: (kinds.rows as { kind: string; n: number; bytes: string | number }[]).map((r) => ({
        kind: String(r.kind),
        n: Number(r.n),
        bytes: Number(r.bytes ?? 0),
      })),
    };
  } catch {
    return null;
  }
}

async function loadMediaSettings() {
  try {
    return await mediaSettingsService.get();
  } catch {
    return null;
  }
}

type CdnView = { base: string; source: string };

async function loadCdn(): Promise<CdnView | null> {
  try {
    const base = await primeCdnBase();
    let source: string;
    // Mirror primeCdnBase's precedence: DB setting → MEDIA_CDN_URL env → "".
    const settings = await mediaSettingsService.get().catch(() => null);
    const dbBase = settings?.cdn_base_url?.trim();
    const envBase = (process.env.MEDIA_CDN_URL ?? "")
      .split(",")
      .map((s) => s.trim())
      .find(Boolean);
    if (dbBase) source = "Réglage médiathèque (cdn_base_url)";
    else if (envBase) source = "Variable d'environnement (MEDIA_CDN_URL)";
    else source = "Même origine (/cdn)";
    return { base, source };
  } catch {
    return null;
  }
}

type MailView = {
  providerName: string;
  configured: boolean;
  from: string;
  replyTo: string | undefined;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
};

async function loadMail(): Promise<MailView | null> {
  try {
    const cfg = await resolveMailProviderConfig();
    let configured: boolean;
    switch (cfg.providerName) {
      case "resend":
        configured = Boolean(cfg.resendApiKey);
        break;
      case "smtp":
        configured = Boolean(cfg.smtp.host);
        break;
      case "internal":
        configured = Boolean(cfg.sendmailPath);
        break;
      default:
        // "console" — always works (logs to stdout), no external dependency.
        configured = true;
    }
    return {
      providerName: cfg.providerName,
      configured,
      from: cfg.from,
      replyTo: cfg.replyTo,
      smtpHost: cfg.smtp.host,
      smtpPort: cfg.smtp.port,
      smtpSecure: cfg.smtp.secure,
    };
  } catch {
    return null;
  }
}

type PaymentsView = { clictopay: boolean; flouci: boolean };

async function loadPayments(): Promise<PaymentsView | null> {
  try {
    const [clictopay, flouci] = await Promise.all([
      resolvePaymentConfig("clictopay").catch(() => null),
      resolvePaymentConfig("flouci").catch(() => null),
    ]);
    return {
      clictopay: Boolean(clictopay?.userName && clictopay?.password),
      flouci: Boolean(flouci?.appToken && flouci?.appSecret),
    };
  } catch {
    return null;
  }
}

type ConsentView = { gtm: boolean; ga4: boolean; metaPixel: boolean };

async function loadConsent(): Promise<ConsentView | null> {
  try {
    const cfg = await getTrackingConfig();
    return {
      gtm: Boolean(cfg.gtmId),
      ga4: Boolean(cfg.ga4Id),
      metaPixel: Boolean(cfg.metaPixelId),
    };
  } catch {
    return null;
  }
}

type AiView = { id: string; label: string; configured: boolean }[];

/** Per-provider AI/automation key presence (env or admin-stored). Booleans only. */
async function loadAi(): Promise<AiView | null> {
  try {
    return await Promise.all(
      AI_PROVIDERS.map(async (p) => ({
        id: p.id,
        label: p.label,
        configured: Boolean(
          (await resolveAiProviderConfig(p.id).catch(() => null))?.configured,
        ),
      })),
    );
  } catch {
    return null;
  }
}

/** Social-OAuth readiness (id + secret resolved). Booleans only — never creds. */
async function loadOAuth(): Promise<{ google: boolean; facebook: boolean } | null> {
  try {
    return await socialProvidersReady();
  } catch {
    return null;
  }
}

function safeSiteUrl(): string | null {
  try {
    return clientEnv.NEXT_PUBLIC_SITE_URL;
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────── presentational ── */

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-[28px] border border-border bg-card p-5">{children}</div>;
}

function CardHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  subtitle: string;
  /** Optional right-aligned action (e.g. a cross-link to another tab). */
  action?: ReactNode;
}) {
  return (
    <header className="mb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
        </div>
        {action}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
    </header>
  );
}

/** Compact cross-link chip for the "Diagnostics liés" strip. */
function RelatedLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/40 px-2.5 py-1 font-medium text-foreground transition hover:border-primary/40 hover:bg-primary/5"
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      {label}
    </Link>
  );
}

function ConfigRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-[16px] border border-border bg-surface/30 p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-2 font-display text-2xl font-bold text-foreground tabular-nums">{value}</p>
    </div>
  );
}

function ServiceRow({
  icon: Icon,
  label,
  configured,
  subtitle,
  href,
  trailing,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  configured: boolean;
  subtitle: ReactNode;
  /** Deep link for the label (e.g. PostgreSQL → Base de données). */
  href?: string;
  /** Override the default Configuré/Non-configuré pill (e.g. a live status pill). */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 text-sm last:border-b-0">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        <div className="min-w-0">
          {href ? (
            <Link href={href} className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary hover:underline">
              {label} <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : (
            <p className="font-medium text-foreground">{label}</p>
          )}
          <p className="mt-0.5 break-all text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {trailing ?? <BoolPill value={configured} on="Configuré" off="Non configuré" />}
    </div>
  );
}

function BoolPill({
  value,
  on = "Oui",
  off = "Non",
}: {
  value: boolean;
  on?: string;
  off?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
        value
          ? "bg-[#eaf7ee] text-[#15803d]"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {value ? on : off}
    </span>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Unavailable() {
  return (
    <p className="rounded-xl border border-dashed border-border bg-surface/30 px-4 py-6 text-center text-sm text-muted-foreground">
      Données indisponibles.
    </p>
  );
}

/** Bytes → human-readable (B / KB / MB / GB), French decimal separator. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const formatted = i === 0 ? String(value) : value.toFixed(1).replace(".", ",");
  return `${formatted} ${units[i]}`;
}
