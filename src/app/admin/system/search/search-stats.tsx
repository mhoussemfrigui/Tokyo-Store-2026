import Link from "next/link";
import {
  AlertTriangle,
  BarChart3,
  PlusCircle,
  Search as SearchIcon,
  TrendingUp,
} from "lucide-react";

import type {
  SearchAnalyticsRow,
  SearchOverviewStats,
} from "@/modules/search";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import { ZeroResultCreateAlias } from "./zero-result-alias";

/**
 * Presentational "Statistiques" panel for the Recherche control center — the
 * overview KPIs, the day-range filter and the top / zero-result tables. Pure
 * server JSX (no client hooks): the parent (a client FormTabs wrapper) renders
 * it as a passed-in node. The day filter navigates via `?days=` links, so the
 * RSC re-reads the param and re-renders this tab's content on switch.
 */
export function SearchStats({
  overview,
  topQueries,
  zeroResultQueries,
  days,
  maxDays,
  canManage = false,
}: {
  overview: SearchOverviewStats | null;
  topQueries: SearchAnalyticsRow[];
  zeroResultQueries: SearchAnalyticsRow[];
  days: number;
  /** Configured retention window (purge_months × 30) — the day filter never
   *  offers a longer window than the data actually kept. */
  maxDays: number;
  /** system_search:manage — enables the inline « Créer alias » on zero-result rows. */
  canManage?: boolean;
}) {
  const hasNoData = !overview || overview.total_searches === 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AdminNote className="max-w-2xl">
          Les requêtes saisies sur la boutique, regroupées et triées par
          fréquence. Les recherches sans résultat sont les meilleures candidates
          pour étoffer le catalogue ou ajouter une page.
        </AdminNote>
        <DaysFilter active={days} maxDays={maxDays} />
      </div>

      <Overview overview={overview} days={days} />

      {hasNoData ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-10 text-center">
          <SearchIcon className="mx-auto h-7 w-7 text-muted-foreground" strokeWidth={1.5} />
          <p className="mt-3 font-semibold">
            Aucune donnée de recherche sur les derniers {days} jours.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Les requêtes effectuées depuis la barre de recherche du site
            apparaîtront ici après quelques utilisations.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <QueryTable
            title="Requêtes les plus fréquentes"
            subtitle="Les sujets que vos visiteurs recherchent le plus."
            icon={TrendingUp}
            rows={topQueries.map((r) => ({
              normalized: r.normalized_query,
              sample: r.sample_query,
              count: r.count,
              avgResults: r.avg_results,
              lastSeenAt: r.last_seen_at,
            }))}
            mode="top"
          />
          <QueryTable
            title="Recherches sans résultat"
            subtitle="Lacunes possibles du catalogue ou typos récurrentes."
            icon={AlertTriangle}
            rows={zeroResultQueries.map((r) => ({
              normalized: r.normalized_query,
              sample: r.sample_query,
              count: r.count,
              avgResults: 0,
              lastSeenAt: r.last_seen_at,
            }))}
            mode="zero"
            canManage={canManage}
          />
        </div>
      )}
    </div>
  );
}

function DaysFilter({ active, maxDays }: { active: number; maxDays: number }) {
  // Offer a 24-month window only when retention keeps that much data, so the
  // longest-retained rows are viewable without showing a mostly-empty range.
  const presets = [
    { label: "7j", value: 7 },
    { label: "30j", value: 30 },
    { label: "90j", value: 90 },
    { label: "12 mois", value: 365 },
    ...(maxDays > 365 ? [{ label: "24 mois", value: 730 }] : []),
  ];
  return (
    <div className="inline-flex items-center gap-1 rounded-[14px] bg-[var(--background)] p-1">
      {presets.map((p) => {
        const isActive = active === p.value;
        return (
          <Link
            key={p.value}
            href={`/admin/system/search?days=${p.value}`}
            className={`inline-flex h-9 shrink-0 items-center rounded-[10px] px-3 text-[13px] transition ${
              isActive
                ? "bg-card font-extrabold text-foreground shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
                : "font-semibold text-muted-foreground hover:text-foreground"
            }`}
          >
            {p.label}
          </Link>
        );
      })}
    </div>
  );
}

function Overview({
  overview,
  days,
}: {
  overview: SearchOverviewStats | null;
  days: number;
}) {
  const tiles = [
    {
      label: "Recherches totales",
      value: (overview?.total_searches ?? 0).toLocaleString("fr-FR"),
      icon: BarChart3,
    },
    {
      label: "Requêtes uniques",
      value: (overview?.unique_queries ?? 0).toLocaleString("fr-FR"),
      icon: SearchIcon,
    },
    {
      label: "Sans résultat",
      value: (overview?.zero_result_count ?? 0).toLocaleString("fr-FR"),
      icon: AlertTriangle,
    },
    {
      label: "Résultats par requête",
      value: (overview?.avg_results ?? 0).toFixed(1),
      icon: TrendingUp,
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-[22px] border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </div>
          <p className="mt-2 font-display text-2xl font-bold text-foreground">{t.value}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Sur les {days} derniers jours.</p>
        </div>
      ))}
    </div>
  );
}

function QueryTable({
  title,
  subtitle,
  icon: Icon,
  rows,
  mode,
  canManage = false,
}: {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  rows: {
    normalized: string;
    sample: string;
    count: number;
    avgResults: number;
    lastSeenAt: string;
  }[];
  mode: "top" | "zero";
  canManage?: boolean;
}) {
  return (
    <div className="rounded-[22px] border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      </header>
      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          {mode === "top"
            ? "Aucune recherche pour le moment."
            : "Aucune recherche sans résultat — bravo."}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li
              key={row.normalized}
              className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 font-medium text-foreground">{row.sample}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {mode === "top"
                    ? `${row.avgResults.toFixed(1)} résultats en moyenne · `
                    : ""}
                  vu {formatRelative(row.lastSeenAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-foreground">
                  {row.count.toLocaleString("fr-FR")}
                </span>
                {mode === "zero" ? (
                  <>
                    {canManage && <ZeroResultCreateAlias term={row.sample} />}
                    <Link
                      href="/admin/catalog/categories"
                      title="Créer une catégorie pour combler ce manque"
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                    >
                      <PlusCircle className="h-3 w-3" strokeWidth={2} />
                      Créer
                    </Link>
                  </>
                ) : (
                  <Link
                    href={`/recherche?q=${encodeURIComponent(row.sample)}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Tester cette requête sur la boutique"
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                  >
                    Tester
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "à l'instant";
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `il y a ${hr} h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `il y a ${d} j`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `il y a ${mo} mois`;
  const yr = Math.floor(d / 365);
  return `il y a ${yr} an${yr > 1 ? "s" : ""}`;
}
