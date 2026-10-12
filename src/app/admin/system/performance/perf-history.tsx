import type { RuntimeSample } from "@/lib/telemetry/runtime-metrics";

/**
 * Historique — server-rendered sparklines + a recent-samples table from the
 * in-memory ring buffer (process-local, captured at page load; the Aperçu tab
 * is the live view). No client JS: pure SVG over the snapshot passed in.
 */
export function PerfHistory({ samples }: { samples: RuntimeSample[] }) {
  if (samples.length === 0) {
    return (
      <p className="rounded-[16px] border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
        Aucun échantillon en mémoire pour l&apos;instant — le collecteur vient peut-être de démarrer.
      </p>
    );
  }

  const ram = samples.map((s) => s.ramPct);
  const cpu = samples.map((s) => s.cpuPct);
  const lag = samples.map((s) => s.eventLoopLagMs);
  const db = samples.map((s) => s.dbLatencyMs);

  const recent = [...samples].slice(-30).reverse();

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        {samples.length} échantillon(s) en mémoire — instantané au chargement. Voir l&apos;onglet
        Aperçu pour les valeurs en direct.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SparkCard label="RAM %" values={ram} unit="%" />
        <SparkCard label="CPU %" values={cpu} unit="%" />
        <SparkCard label="Boucle p99" values={lag} unit="ms" />
        <SparkCard label="Latence DB" values={db} unit="ms" />
      </div>

      <div className="overflow-x-auto rounded-[22px] border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <th className="px-3 py-2 font-bold">Heure</th>
              <th className="px-3 py-2 text-right font-bold">RAM %</th>
              <th className="px-3 py-2 text-right font-bold">CPU %</th>
              <th className="px-3 py-2 text-right font-bold">Boucle p99</th>
              <th className="px-3 py-2 text-right font-bold">Latence DB</th>
              <th className="px-3 py-2 text-right font-bold">Pool attente</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {recent.map((s) => (
              <tr key={s.at} className="transition hover:bg-[#fffbfb]">
                <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                  {new Date(s.at).toLocaleTimeString("fr-FR")}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(s.ramPct)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(s.cpuPct)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(s.eventLoopLagMs)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {s.dbOk ? fmt(s.dbLatencyMs) : "✕"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {s.poolWaiting}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmt(v: number | null): string {
  return v == null ? "—" : String(v);
}

function SparkCard({
  label,
  values,
  unit,
}: {
  label: string;
  values: Array<number | null>;
  unit: string;
}) {
  const nums = values.filter((v): v is number => v != null);
  const last = nums.length > 0 ? nums[nums.length - 1] : null;
  const max = nums.length > 0 ? Math.max(...nums) : null;
  return (
    <div className="rounded-[16px] border border-border bg-surface/30 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="text-[14.5px] tabular-nums text-foreground">
          {last != null ? `${last} ${unit}` : "—"}
        </span>
      </div>
      <div className="mt-2">
        <Sparkline values={values} />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        max {max != null ? `${max} ${unit}` : "—"}
      </p>
    </div>
  );
}

/** Inline SVG sparkline. Nulls break the line into segments. */
function Sparkline({ values }: { values: Array<number | null> }) {
  const W = 200;
  const H = 36;
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) {
    return <div className="h-9 w-full rounded bg-border/40" aria-hidden />;
  }
  const max = Math.max(...nums, 1);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - 2) - 1;

  // Build path, breaking on nulls.
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-9 w-full" preserveAspectRatio="none" aria-hidden>
      <path d={d.trim()} fill="none" stroke="var(--primary)" strokeWidth={1.5} />
    </svg>
  );
}
