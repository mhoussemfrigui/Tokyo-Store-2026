import { Timer, RotateCcw, CheckCircle2, XCircle } from "lucide-react";

import type { UptimeStats } from "@/lib/telemetry/uptime";
import type { InstanceHeartbeatRow } from "@/modules/instance";
import { STORE_TIME_ZONE } from "@/lib/time/store-tz";

/**
 * Cross-restart availability — server-rendered from the heartbeat trail
 * (`instanceHeartbeatService.recent` → `computeUptimeStats`). Distinct from the
 * live "Disponibilité (instance)" card in Aperçu (which shows only the current
 * process's `process.uptime()`): this infers restarts + outage windows ACROSS
 * redeploys over the analysis window. Process-local heartbeats per instance.
 * Timestamps render in the STORE zone (Africa/Tunis) — this is a server
 * component and the container runs in UTC.
 */
export function PerfUptime({
  stats,
  boots,
  windowDays,
  currentInstanceId,
}: {
  stats: UptimeStats;
  boots: InstanceHeartbeatRow[];
  windowDays: number;
  currentInstanceId: string;
}) {
  // Newest boots first, capped for display.
  const recent = [...boots].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  ).slice(0, 10);

  return (
    <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
      <header className="flex items-start gap-2">
        <Timer className="mt-0.5 h-4 w-4 text-muted-foreground" strokeWidth={2} />
        <div>
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
            Disponibilité (historique)
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Redémarrages et fenêtres d&apos;indisponibilité inférés sur {windowDays} jours à partir
            des battements d&apos;instance.
          </p>
        </div>
      </header>

      {stats.instances === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-surface/40 px-3 py-4 text-center text-xs text-muted-foreground">
          Aucun battement enregistré sur la fenêtre — le suivi démarre au prochain heartbeat.
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Disponibilité"
              value={`${stats.availabilityPct.toFixed(2)} %`}
              tone={stats.availabilityPct >= 99 ? "good" : stats.availabilityPct >= 95 ? "warn" : "bad"}
            />
            <Stat label="Redémarrages" value={String(stats.restarts)} icon={RotateCcw} />
            <Stat label="Indisponibilité cumulée" value={humanDuration(stats.downtimeMs)} />
            <Stat
              label="Dernier démarrage"
              value={stats.lastRestartAt ? storeDateTime(stats.lastRestartAt) : "—"}
            />
          </div>

          {stats.gaps.length > 0 && (
            <div className="mt-4 rounded-[12px] border border-[#f3e3bd] bg-[#fff4e0] p-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#b45309]">
                Fenêtres d&apos;indisponibilité ({stats.gaps.length})
              </p>
              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                {stats.gaps.slice(0, 5).map((g) => (
                  <li key={g.fromMs}>
                    {storeDateTime(g.fromMs)} → {storeDateTime(g.toMs)} ({humanDuration(g.ms)})
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="py-2 pr-4 font-bold">Instance</th>
                  <th className="py-2 pr-4 font-bold">Démarrée</th>
                  <th className="py-2 pr-4 font-bold">Dernier signe</th>
                  <th className="py-2 pr-4 font-bold">Arrêt</th>
                  <th className="py-2 font-bold">Build</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recent.map((b) => (
                  <tr key={b.instance_id} className="transition hover:bg-[#fffbfb]">
                    <td className="py-2 pr-4 font-mono text-[11px] text-foreground">
                      {b.instance_id}
                      {b.instance_id === currentInstanceId && (
                        <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-primary">
                          actuelle
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-[11px] text-muted-foreground">
                      {storeDateTime(b.started_at)}
                    </td>
                    <td className="py-2 pr-4 text-[11px] text-muted-foreground">
                      {storeDateTime(b.last_seen_at)}
                    </td>
                    <td className="py-2 pr-4 text-[11px]">
                      {b.stopped_at ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <CheckCircle2 className="h-3 w-3" /> propre
                        </span>
                      ) : b.instance_id === currentInstanceId ? (
                        <span className="text-[#15803d]">en cours</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[#b45309]">
                          <XCircle className="h-3 w-3" /> non marqué
                        </span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-[11px] text-muted-foreground">
                      {b.build_sha ? b.build_sha.slice(0, 12) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneCls =
    tone === "good"
      ? "text-[#15803d]"
      : tone === "warn"
        ? "text-[#b45309]"
        : tone === "bad"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="rounded-[16px] border border-border bg-surface/30 p-4">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </div>
      <p className={`mt-2 font-display text-xl font-bold tabular-nums ${toneCls}`}>{value}</p>
    </div>
  );
}

/** « 23/09/2026 14:05:00 » in shop time, not the runtime (UTC) zone. */
function storeDateTime(v: Date | number | string): string {
  return new Date(v).toLocaleString("fr-FR", { timeZone: STORE_TIME_ZONE });
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
