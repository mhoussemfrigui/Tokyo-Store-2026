import { Activity, Clock, Layers, ShieldAlert } from "lucide-react";

import type { AuditOverview } from "@/modules/audit/queries";
import { severityBadge, severityDot, severityLabel, SEVERITY_ORDER_UI } from "./severity-style";

/**
 * Statistiques tab of the audit control center. Server-rendered KPI strip
 * (total / last-24h / distinct event types) + a by-severity breakdown + the
 * most-frequent events and most-active actors. All fed by the cheap aggregates
 * in queries.ts.
 */
export function AuditStats({
  overview,
  topEvents,
  topActors,
  actorNames,
}: {
  overview: AuditOverview;
  topEvents: { eventName: string; severity: string; count: number }[];
  topActors: { actorUserId: string; count: number }[];
  actorNames: Record<string, string>;
}) {
  const fmt = (n: number) => n.toLocaleString("fr-FR");
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={<Layers className="h-4 w-4" />} label="Entrées (total)" value={fmt(overview.total)} />
        <Kpi icon={<Clock className="h-4 w-4" />} label="Dernières 24 h" value={fmt(overview.last24h)} />
        <Kpi
          icon={<Activity className="h-4 w-4" />}
          label="Types d'événements"
          value={fmt(overview.distinctEvents)}
          hint="événements distincts observés"
        />
        <Kpi
          icon={<ShieldAlert className="h-4 w-4" />}
          label="Alertes + erreurs"
          value={fmt((overview.bySeverity.warn ?? 0) + (overview.bySeverity.error ?? 0))}
        />
      </div>

      {/* Severity breakdown */}
      <section>
        <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Par sévérité</h2>
        <div className="flex flex-wrap gap-2">
          {SEVERITY_ORDER_UI.map((sev) => (
            <span
              key={sev}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${severityBadge(sev)}`}
            >
              {severityLabel(sev)}
              <span className="tabular-nums">{fmt(overview.bySeverity[sev] ?? 0)}</span>
            </span>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top events */}
        <section>
          <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">
            Événements les plus fréquents
          </h2>
          {topEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune donnée.</p>
          ) : (
            <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
              {topEvents.map((e) => (
                <li key={e.eventName} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${severityDot(e.severity)}`}
                      aria-hidden
                    />
                    <code className="truncate text-xs text-foreground">{e.eventName}</code>
                  </span>
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                    {fmt(e.count)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Top actors */}
        <section>
          <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">
            Acteurs les plus actifs
          </h2>
          {topActors.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun acteur identifié.</p>
          ) : (
            <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
              {topActors.map((a) => (
                <li key={a.actorUserId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate text-sm text-foreground">
                    {actorNames[a.actorUserId] ?? `${a.actorUserId.slice(0, 8)}…`}
                  </span>
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                    {fmt(a.count)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-[16px] border border-border bg-card px-4 py-3.5">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1.5 font-display text-2xl font-bold tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
