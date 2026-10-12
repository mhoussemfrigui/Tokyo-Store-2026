"use client";

import { useMemo, useState } from "react";

import { formatCents } from "@/lib/price";
import {
  bucketRevenueSeries,
  type RevenuePoint,
  type RevenueRange,
} from "@/lib/analytics/revenue-buckets";

/**
 * "Chiffre d'affaires" area chart on the admin dashboard. Fed ONE real daily
 * series (up to ~365 rows from `getDailyOrdersSeries`); the Mois / Trimestre /
 * Année toggle re-buckets it client-side via the pure `bucketRevenueSeries`
 * helper (unit-tested separately). Pure SVG, no chart dependency — colour is
 * `currentColor` from the wrapper's `text-primary` so it follows the admin theme.
 */
const RANGES: { key: RevenueRange; label: string }[] = [
  { key: "mois", label: "Mois" },
  { key: "trimestre", label: "Trimestre" },
  { key: "annee", label: "Année" },
];

export function RevenueChart({ series }: { series: RevenuePoint[] }) {
  const [range, setRange] = useState<RevenueRange>("mois");
  const points = useMemo(() => bucketRevenueSeries(series, range), [series, range]);

  const total = points.reduce((s, p) => s + p.value, 0);
  const max = Math.max(1, ...points.map((p) => p.value));
  const hasData = total > 0 && points.length >= 2;

  // Geometry — a fixed viewBox stretched responsively to the card width.
  const W = 760;
  const H = 240;
  const padX = 8;
  const padTop = 14;
  const padBottom = 26;
  const innerH = H - padTop - padBottom;
  const stepX = points.length > 1 ? (W - padX * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = padX + i * stepX;
    const y = padTop + innerH * (1 - p.value / max);
    return [x, y] as const;
  });
  const line = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const baseline = padTop + innerH;
  const area =
    coords.length > 0
      ? `${line} L${coords[coords.length - 1][0].toFixed(1)} ${baseline} L${coords[0][0].toFixed(1)} ${baseline} Z`
      : "";

  // Thin the x-axis labels so they never overlap (~8 max).
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[14.5px] text-foreground">
            Chiffre d&apos;affaires
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Évolution des ventes —{" "}
            {range === "mois"
              ? "30 derniers jours"
              : range === "trimestre"
                ? "13 dernières semaines"
                : "12 derniers mois"}
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Période"
          className="inline-flex rounded-full border border-border bg-surface/60 p-0.5"
        >
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              role="tab"
              aria-selected={range === r.key}
              onClick={() => setRange(r.key)}
              className={`rounded-full px-3 py-1.5 text-[11.5px] transition ${
                range === r.key
                  ? "bg-primary font-semibold text-primary-foreground shadow-sm"
                  : "font-medium text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {hasData ? (
        <div className="mt-4 text-primary">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-48 w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label="Évolution du chiffre d'affaires"
          >
            <defs>
              <linearGradient id="rev-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* horizontal guide lines at 0 / 50 / 100% */}
            {[0, 0.5, 1].map((t) => {
              const y = padTop + innerH * t;
              return (
                <line
                  key={t}
                  x1={padX}
                  x2={W - padX}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={0.08}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            <path d={area} fill="url(#rev-area)" stroke="none" />
            <path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {coords.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={2} fill="currentColor">
                <title>{`${points[i].label} · ${formatCents(points[i].value)}`}</title>
              </circle>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 || i === points.length - 1 ? (
                <text
                  key={i}
                  x={padX + i * stepX}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  style={{ fontSize: 10.5 }}
                >
                  {p.label}
                </text>
              ) : null,
            )}
          </svg>
        </div>
      ) : (
        <div className="mt-4 grid h-48 place-items-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
          Pas encore assez de ventes pour tracer une courbe.
        </div>
      )}
    </section>
  );
}
