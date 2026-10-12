"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  RefreshCw,
  Server,
  Timer,
} from "lucide-react";

import {
  evaluateBreaches,
  BREACH_LABELS,
  type BreachMetric,
  type PerfThresholds,
} from "@/lib/telemetry/perf-config";
import type { RuntimeSnapshot } from "@/lib/telemetry/runtime-metrics";

/**
 * Live runtime overview — RAM / CPU / event-loop / DB latency gauges + pool +
 * uptime, auto-refreshing from GET /api/admin/metrics. Seeded with the RSC's
 * initial snapshot so it paints instantly, then polls at the sampler cadence.
 * Card coloring uses the SAME pure `evaluateBreaches` the alert engine uses, so
 * a red card always means "at/over the configured warn threshold."
 *
 * Process-local: reflects the ONE Node instance that served the poll.
 */
export function PerfOverview({
  initial,
  thresholds,
  pollIntervalSec,
}: {
  initial: RuntimeSnapshot;
  thresholds: PerfThresholds;
  pollIntervalSec: number;
}) {
  const [snap, setSnap] = useState<RuntimeSnapshot>(initial);
  const [updatedAt, setUpdatedAt] = useState<number | null>(initial.lastSampleAt);
  const [live, setLive] = useState(true);
  // Locale/timezone date formatting must wait for mount: the server renders in
  // the container's TZ (UTC) and the client in the operator's TZ, so formatting
  // during SSR/first hydration would mismatch. Render "—" until mounted.
  const [mounted, setMounted] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => setMounted(true), []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/metrics", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { runtime: RuntimeSnapshot };
      if (data?.runtime) {
        setSnap(data.runtime);
        setUpdatedAt(Date.now());
      }
    } catch {
      /* transient — keep the last good snapshot */
    }
  }, []);

  useEffect(() => {
    if (!live) {
      if (timer.current) clearInterval(timer.current);
      return;
    }
    const ms = Math.max(5, Math.min(pollIntervalSec, 300)) * 1000;
    timer.current = setInterval(refresh, ms);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [live, pollIntervalSec, refresh]);

  // Instantaneous breach set (for card coloring), independent of the sustained
  // alert state on the server.
  const breached = new Set<BreachMetric>(
    evaluateBreaches(
      {
        ramPct: snap.ramPct,
        cpuPct: snap.cpuPct,
        eventLoopLagMs: snap.eventLoopLagMs,
        dbLatencyMs: snap.db.latencyMs,
        dbOk: snap.db.ok,
      },
      thresholds,
    ).map((b) => b.metric),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Instance <span className="font-mono">{snap.instanceId}</span> · Node {snap.nodeVersion} ·{" "}
          {snap.cpuCount} cœur(s)
          {!snap.samplerRunning ? (
            <span className="ml-2 rounded-full bg-[#fff4e0] px-2 py-0.5 text-[10px] font-semibold text-[#b45309]">
              collecteur arrêté
            </span>
          ) : !snap.samplingEnabled ? (
            <span className="ml-2 rounded-full bg-[#fff4e0] px-2 py-0.5 text-[10px] font-semibold text-[#b45309]">
              échantillonnage en pause
            </span>
          ) : null}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {mounted && updatedAt
              ? `mis à jour ${new Date(updatedAt).toLocaleTimeString("fr-FR")}`
              : "—"}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-surface/40"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Actualiser
          </button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--primary)]"
            />
            Auto ({pollIntervalSec}s)
          </label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={HardDrive}
          label="Mémoire (RSS)"
          value={snap.ramPct != null ? `${snap.ramPct} %` : "—"}
          sub={
            snap.memory.limitBytes > 0
              ? `${formatBytes(snap.memory.rssBytes)} / ${formatBytes(snap.memory.limitBytes)}`
              : formatBytes(snap.memory.rssBytes)
          }
          breached={breached.has("ram")}
          threshold={`seuil ${thresholds.ramWarnPct} %`}
        />
        <MetricCard
          icon={Cpu}
          label="Processeur (CPU)"
          value={!snap.samplingEnabled ? "en pause" : snap.cpuPct != null ? `${snap.cpuPct} %` : "—"}
          sub={
            !snap.samplingEnabled
              ? "échantillonnage désactivé"
              : snap.loadAvg1 != null
                ? `charge 1 min ${snap.loadAvg1.toFixed(2)}`
                : undefined
          }
          breached={snap.samplingEnabled && breached.has("cpu")}
          threshold={`seuil ${thresholds.cpuWarnPct} %`}
        />
        <MetricCard
          icon={Activity}
          label="Boucle d'évènements p99"
          value={
            !snap.samplingEnabled
              ? "en pause"
              : snap.eventLoopLagMs != null
                ? `${snap.eventLoopLagMs} ms`
                : "—"
          }
          breached={snap.samplingEnabled && breached.has("event_loop")}
          threshold={`seuil ${thresholds.eventLoopLagWarnMs} ms`}
        />
        <MetricCard
          icon={Database}
          label="Latence base de données"
          value={snap.db.ok ? (snap.db.latencyMs != null ? `${snap.db.latencyMs} ms` : "—") : "injoignable"}
          breached={breached.has("db_latency") || breached.has("db_down")}
          threshold={`seuil ${thresholds.dbLatencyWarnMs} ms`}
        />
      </div>

      {/* Memory + uptime + pool detail */}
      <div className="grid gap-4 lg:grid-cols-3">
        <DetailCard icon={HardDrive} title="Mémoire">
          <Row label="RSS" value={formatBytes(snap.memory.rssBytes)} />
          <Row label="Heap utilisé" value={formatBytes(snap.memory.heapUsedBytes)} />
          <Row label="Heap total" value={formatBytes(snap.memory.heapTotalBytes)} />
          <Row label="Externe" value={formatBytes(snap.memory.externalBytes)} />
          <Row
            label="Limite conteneur"
            value={snap.memory.limitBytes > 0 ? formatBytes(snap.memory.limitBytes) : "—"}
          />
          <Row label="Mémoire système libre" value={formatBytes(snap.memory.sysFreeBytes)} />
        </DetailCard>

        <DetailCard icon={Timer} title="Disponibilité (instance)">
          <Row label="Démarré depuis" value={humanDuration(snap.uptimeMs)} />
          <Row
            label="Démarré le"
            value={mounted ? new Date(snap.bootAt).toLocaleString("fr-FR") : "—"}
          />
          <Row
            label="Collecteur"
            value={
              !snap.samplerRunning ? (
                <span className="inline-flex items-center gap-1 text-[#b45309]">
                  <AlertTriangle className="h-3.5 w-3.5" /> arrêté
                </span>
              ) : snap.samplingEnabled ? (
                <span className="inline-flex items-center gap-1 text-[#15803d]">
                  <CheckCircle2 className="h-3.5 w-3.5" /> actif
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[#b45309]">
                  <AlertTriangle className="h-3.5 w-3.5" /> échantillonnage en pause
                </span>
              )
            }
          />
          <Row
            label="Base de données"
            value={
              snap.db.ok ? (
                <span className="inline-flex items-center gap-1 text-[#15803d]">
                  <CheckCircle2 className="h-3.5 w-3.5" /> en ligne
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> injoignable
                </span>
              )
            }
          />
        </DetailCard>

        <DetailCard icon={Server} title="Pool de connexions">
          {snap.pool ? (
            <>
              <Row label="Connexions ouvertes" value={`${snap.pool.total} / ${snap.pool.max}`} />
              <Row label="Inactives" value={String(snap.pool.idle)} />
              <Row
                label="En attente"
                value={
                  <span className={snap.pool.waiting > 0 ? "text-[#b45309]" : ""}>
                    {snap.pool.waiting}
                  </span>
                }
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Indisponible.</p>
          )}
        </DetailCard>
      </div>

      {snap.activeBreaches.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Alerte active :{" "}
          {snap.activeBreaches.map((m) => BREACH_LABELS[m]).join(", ")}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Mesures <strong>propres à cette instance</strong> Node (process-local) — elles ne reflètent
        pas l&apos;ensemble du parc si plusieurs instances tournent en parallèle, et sont remises à
        zéro au redémarrage.
      </p>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  threshold,
  breached,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  threshold?: string;
  breached: boolean;
}) {
  return (
    <div
      className={`rounded-[16px] border p-4 ${
        breached ? "border-destructive/50 bg-destructive/5" : "border-border bg-surface/30"
      }`}
    >
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p
        className={`mt-2 font-display text-2xl font-bold tabular-nums ${
          breached ? "text-destructive" : "text-foreground"
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
      {threshold && <p className="mt-1 text-[10px] text-muted-foreground">{threshold}</p>}
    </div>
  );
}

function DetailCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[16px] border border-border bg-surface/30 p-4">
      <header className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
        <h3 className="text-[15px] font-black text-foreground">{title}</h3>
      </header>
      <dl className="divide-y divide-border">{children}</dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${i === 0 ? v : v.toFixed(1).replace(".", ",")} ${units[i]}`;
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
