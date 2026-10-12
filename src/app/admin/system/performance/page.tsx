import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Activity, ChevronLeft, Cpu, Tags } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { snapshot } from "@/lib/telemetry/metrics-store";
import {
  getRuntimeSnapshot,
  getRuntimeHistory,
  type RuntimeSnapshot,
} from "@/lib/telemetry/runtime-metrics";
import { resolvePerformanceConfig, thresholdsOf } from "@/lib/telemetry/perf-config";
import { computeUptimeStats } from "@/lib/telemetry/uptime";
import { instanceHeartbeatService } from "@/modules/instance";
import { CACHE_TAGS, cacheTag } from "@/lib/cache/tags";
import {
  STALE_TIMES,
  PROXY_CLIENT_MAX_BODY,
  SERVER_ACTION_BODY_LIMIT,
  IMAGE_FORMATS,
  IMAGE_MIN_CACHE_TTL,
  NEXT_OUTPUT,
  NEXT_COMPRESS,
  CACHE_COMPONENTS,
} from "@/lib/config/next-runtime";

import { PerformanceControlCenter } from "./performance-control-center";
import { PerfOverview } from "./perf-overview";
import { PerfHistory } from "./perf-history";
import { PerfUptime } from "./perf-uptime";
import { MetricsCountsTable, type CountRow } from "./performance-panel";

/** Availability analysis window for the cross-restart uptime view. */
const UPTIME_WINDOW_DAYS = 30;

/**
 * The catalog reads currently behind cross-request `'use cache'`, surfaced so an
 * operator can SEE what's cached + what keeps each fresh. Kept in sync by hand
 * with the `cacheTag(...)` calls in the loader modules (brand/category
 * queries + lib/api/products + modules/blog).
 */
const CACHED_READERS: Array<{ fn: string; tags: string; trigger: string }> = [
  { fn: "listActiveBrands / getBrandBySlug", tags: "brands", trigger: "écriture marque" },
  {
    fn: "listCategories / getCategoryBySlug",
    tags: "categories, products:list",
    trigger: "écriture catégorie ou produit (compteurs)",
  },
  {
    fn: "getProductWithRowBySlug (PDP)",
    tags: "product:<id>, product:slug:<slug>, products:list",
    trigger: "édition produit, réassort, ou vente",
  },
  { fn: "listPublishedPosts (blog)", tags: "blog:posts, blog:categories", trigger: "écriture blog" },
];

export const metadata: Metadata = { title: "Performance" };
// Live runtime metrics + counters change on every request — never cache.
export const dynamic = "force-dynamic";

export default async function PerformancePage() {
  const session = await requirePermission("system_performance", "view");
  // "manage" gates the Réglages form (the action re-checks server-side).
  const canManage = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "system_performance",
    "manage",
  );

  // No `.catch`: the Réglages form is pre-filled from this — a swallowed read
  // would show the defaults that a save then persists. A failure reaches the
  // admin error boundary (retry).
  const settingsMap = await getSettingsMap();
  const cfg = resolvePerformanceConfig(settingsMap);

  // Live snapshot (memory + pool + fresh DB probe) — never throws (returns
  // safe defaults), but guard anyway so the page can't 500.
  let runtimeSnap: RuntimeSnapshot | null = null;
  try {
    runtimeSnap = await getRuntimeSnapshot();
  } catch {
    runtimeSnap = null;
  }
  const history = getRuntimeHistory();

  // Cross-restart availability from the heartbeat trail (read path → pure compute).
  // Anchor "now" to the DB clock — the heartbeat trail is entirely DB-clock, so
  // using the app clock here would re-introduce skew into the trailing gap. Fall
  // back to the app clock if the DB now() probe fails.
  // Async Server Component (one render per request) — the clock read is intended.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = await instanceHeartbeatService.now().catch(() => Date.now());
  const windowStartMs = nowMs - UPTIME_WINDOW_DAYS * 86_400_000;
  const boots = await instanceHeartbeatService.recent(UPTIME_WINDOW_DAYS).catch(() => []);
  const uptimeStats = computeUptimeStats(
    // Map the snake_case DB rows to the pure helper's HeartbeatLike shape.
    boots.map((b) => ({
      startedAt: b.started_at,
      lastSeenAt: b.last_seen_at,
      stoppedAt: b.stopped_at,
    })),
    { heartbeatIntervalSec: cfg.heartbeatIntervalSec, windowStartMs, nowMs },
  );

  let eventMetrics: ReturnType<typeof snapshot> | null = null;
  try {
    eventMetrics = snapshot();
  } catch {
    eventMetrics = null;
  }
  const countRows: CountRow[] = eventMetrics
    ? Object.entries(eventMetrics.counts).map(([name, count]) => ({ name, count }))
    : [];

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
            title="Performance"
            description="Métriques runtime en direct (RAM, CPU, boucle d'évènements, latence DB), disponibilité, alertes et cache."
          />
        </div>
      </div>

      <PerformanceControlCenter
        overview={
          <div className="space-y-6">
            {runtimeSnap ? (
              <PerfOverview
                initial={runtimeSnap}
                thresholds={thresholdsOf(cfg)}
                pollIntervalSec={cfg.sampleIntervalSec}
              />
            ) : (
              <p className="rounded-[16px] border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
                Métriques runtime indisponibles.
              </p>
            )}
            <PerfUptime
              stats={uptimeStats}
              boots={boots}
              windowDays={UPTIME_WINDOW_DAYS}
              currentInstanceId={runtimeSnap?.instanceId ?? ""}
            />
          </div>
        }
        history={<PerfHistory samples={history} />}
        metrics={
          <MetricsCacheSection
            eventMetrics={eventMetrics}
            countRows={countRows}
          />
        }
        settings={cfg}
        canManage={canManage}
      />
    </div>
  );
}

/* ─────────────────────── Métriques & cache (server-rendered) ─────────── */

function MetricsCacheSection({
  eventMetrics,
  countRows,
}: {
  eventMetrics: ReturnType<typeof snapshot> | null;
  countRows: CountRow[];
}) {
  const staticTags = Object.entries(CACHE_TAGS);
  const dynamicBuilders = Object.keys(cacheTag);
  const buildSha = process.env.NEXT_PUBLIC_BUILD_SHA?.trim() || null;

  return (
    <div className="space-y-6">
      {/* ── ÉVÉNEMENTS ─────────────────────────────────────────────── */}
      <section>
        <header className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
            Compteurs d&apos;événements
          </h2>
        </header>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Compteurs du bus d&apos;événements en mémoire — process-local, remis à zéro au
          redémarrage, propre à cette instance.
        </p>

        {eventMetrics === null ? (
          <p className="mt-4 rounded-[16px] border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
            Métriques indisponibles.
          </p>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <StatCard
                label="Événements totaux"
                value={eventMetrics.totalEvents.toLocaleString("fr-FR")}
                icon={Activity}
              />
              <StatCard
                label="Événements uniques"
                value={eventMetrics.uniqueEvents.toLocaleString("fr-FR")}
                icon={Tags}
              />
              <StatCard
                label="Compteurs depuis"
                value={formatDate(eventMetrics.startedAt)}
                icon={Activity}
              />
            </div>
            <div className="mt-5">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Compteurs par événement
              </h3>
              <MetricsCountsTable rows={countRows} />
            </div>
          </>
        )}
      </section>

      {/* ── CACHE ───────────────────────────────────────────────────── */}
      <section>
        <header className="flex items-center gap-2">
          <Tags className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Cache</h2>
        </header>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Vocabulaire des tags de cache (source unique de revalidateTag). Les lectures
          catalogue les plus fréquentes sont mises en cache cross-requête via{" "}
          <span className="font-mono">&apos;use cache&apos;</span> avec invalidation{" "}
          <strong className="font-semibold text-foreground">instantanée par tag</strong> :
          chaque écriture (édition admin, réassort, ou <em>vente</em>) émet l&apos;évènement
          correspondant, le souscripteur <span className="font-mono">invalidate-catalog-cache</span>{" "}
          purge le tag, et la lecture est recalculée au prochain accès (read-your-writes).{" "}
          <span className="font-mono">cacheLife(&quot;hours&quot;)</span> n&apos;est que le
          plafond de repli.
        </p>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-[16px] border border-border bg-surface/30 p-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Tags statiques ({staticTags.length})
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {staticTags.map(([key, value]) => (
                <li
                  key={key}
                  title={key}
                  className="rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-foreground"
                >
                  {value}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-[16px] border border-border bg-surface/30 p-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Constructeurs dynamiques ({dynamicBuilders.length})
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {dynamicBuilders.map((name) => (
                <li
                  key={name}
                  className="rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
                >
                  {name}()
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Lecteurs en cache — what 'use cache' actually covers + its bust trigger. */}
        <div className="mt-4 rounded-[16px] border border-border bg-surface/30 p-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Lecteurs en cache
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Lecture</th>
                  <th className="pb-2 pr-3 font-medium">Tags</th>
                  <th className="pb-2 font-medium">Invalidé par</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {CACHED_READERS.map((r) => (
                  <tr key={r.fn} className="align-top">
                    <td className="py-2 pr-3 font-mono text-foreground">{r.fn}</td>
                    <td className="py-2 pr-3 font-mono text-muted-foreground">{r.tags}</td>
                    <td className="py-2 text-muted-foreground">{r.trigger}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Réglages Next.js — single source via src/lib/config/next-runtime.ts */}
        <div className="mt-4 rounded-[16px] border border-border bg-surface/30 p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" /> Réglages Next.js
          </h3>
          <p className="mb-3 text-[11px] text-muted-foreground">
            Source unique partagée avec <span className="font-mono">next.config.ts</span>{" "}
            (<span className="font-mono">src/lib/config/next-runtime.ts</span>) — aucune dérive
            possible.
          </p>
          <dl className="divide-y divide-border">
            <ConfigRow label="staleTimes.dynamic" value={`${STALE_TIMES.dynamic} s`} />
            <ConfigRow label="staleTimes.static" value={`${STALE_TIMES.static} s`} />
            <ConfigRow label="proxyClientMaxBodySize" value={PROXY_CLIENT_MAX_BODY} />
            <ConfigRow label="serverActions.bodySizeLimit" value={SERVER_ACTION_BODY_LIMIT} />
            <ConfigRow label="images.formats" value={IMAGE_FORMATS.join(", ")} />
            <ConfigRow
              label="images.minimumCacheTTL"
              value={`${(IMAGE_MIN_CACHE_TTL / 86400).toFixed(0)} j`}
            />
            <ConfigRow label="output" value={NEXT_OUTPUT} />
            <ConfigRow label="compress" value={<BoolPill value={NEXT_COMPRESS} />} />
            <ConfigRow
              label="Cache Components"
              value={
                <BoolPill value={CACHE_COMPONENTS} onLabel="Activé" offLabel="Désactivé" />
              }
            />
          </dl>
        </div>

        {/* ── EXÉCUTION ─────────────────────────────────────────────── */}
        <div className="mt-4 rounded-[16px] border border-border bg-surface/30 p-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Exécution
          </h3>
          <dl className="divide-y divide-border">
            <ConfigRow
              label="NODE_ENV"
              value={
                <span className="rounded-full bg-card px-2 py-0.5 font-mono text-[11px] text-foreground">
                  {process.env.NODE_ENV ?? "—"}
                </span>
              }
            />
            <ConfigRow label="URL du site" value={process.env.NEXT_PUBLIC_SITE_URL ?? "—"} mono />
            <ConfigRow label="Version de Node" value={process.version || "—"} mono />
            <ConfigRow label="Identifiant de build" value={buildSha ?? "—"} mono />
          </dl>
          {!buildSha && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Aucun identifiant de build (<span className="font-mono">NEXT_PUBLIC_BUILD_SHA</span>{" "}
              absent). Définissez-le en argument de build (Coolify → Build Arguments) pour la
              traçabilité du déploiement.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR");
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}) {
  return (
    <div className="rounded-[16px] border border-border bg-surface/30 p-4">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-2 font-display text-xl font-bold text-foreground">{value}</p>
    </div>
  );
}

function ConfigRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 break-all text-right text-foreground ${
          mono ? "font-mono text-xs" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function BoolPill({
  value,
  onLabel = "Oui",
  offLabel = "Non",
}: {
  value: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        value ? "bg-[#eaf7ee] text-[#15803d]" : "bg-muted text-muted-foreground"
      }`}
    >
      {value ? onLabel : offLabel}
    </span>
  );
}
