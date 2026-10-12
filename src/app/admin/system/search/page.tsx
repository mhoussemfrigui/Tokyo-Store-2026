import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { searchService } from "@/modules/search";
import { resolveSearchConfig } from "@/modules/search/config";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { isJobEnabled } from "@/lib/jobs/run-job";
import { jobRunLogService, type JobRunStatus } from "@/modules/jobs";
import { AdminPageHeader } from "@/components/admin/page-header";
import { SearchStats } from "./search-stats";
import { SearchControlCenter, type PurgeState } from "./search-control-center";

export const metadata: Metadata = { title: "Recherche" };

/**
 * Admin: storefront search control center — one tabbed page that is the home
 * of EVERYTHING search:
 *
 *   • Statistiques — top / zero-result queries + overview KPIs (search_log)
 *   • Réglages     — engine tuning (relevance weights, kinds, limits, retention)
 *   • Purge        — retention window echo + auto-purge status + manual purge
 *
 * This RSC loads the data and feeds the client `<SearchControlCenter>`. The
 * Statistiques content is server-rendered and passed down as a node; the day
 * filter still navigates via `?days=` (the RSC re-reads it).
 */
export default async function AdminSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; newAlias?: string }>;
}) {
  const session = await requirePermission("system_search", "view");
  // Réglages + Purge are manage-class controls — gate them for UI honesty (the
  // save/purge actions re-check system_search:manage server-side).
  const canManage = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "system_search",
    "manage",
  );
  const sp = await searchParams;
  const days = parseDays(sp.days);

  // Run the analytics, the settings read, the purge-state reads and the alias
  // reads in parallel.
  const [
    overview,
    topQueries,
    zeroResultQueries,
    settings,
    jobEnabled,
    lastRunMap,
    aliases,
    aliasCounts,
  ] = await Promise.all([
    searchService.getOverviewStats({ days }).catch(() => null),
    searchService.getTopQueries({ days, limit: 20 }).catch(() => []),
    searchService.getZeroResultQueries({ days, limit: 20 }).catch(() => []),
    // No `.catch`: the Réglages form is pre-filled from this — a swallowed read
    // would show the defaults (retention reset to 3 months…) that a save then
    // persists. A failure reaches the admin error boundary (retry).
    getSettingsMap(),
    isJobEnabled("retention_purge").catch(() => true),
    jobRunLogService.lastRunByJob(["retention_purge"]).catch(() => null),
    searchService.listAliases().catch(() => []),
    searchService.countAliases().catch(() => ({ total: 0, defaults: 0 })),
  ]);
  // Optional deep-link: `?newAlias=<term>` opens the Alias tab pre-filled with that
  // term. (The zero-result « Créer alias » popover in Statistiques creates the alias
  // inline via createSearchAliasAction — it does NOT navigate; this deep-link is a
  // separate, bookmarkable entry point.)
  const aliasPrefillTerm = (sp.newAlias ?? "").slice(0, 120);

  const cfg = resolveSearchConfig(settings);

  const lastRun = lastRunMap?.get("retention_purge") ?? null;
  const purge: PurgeState = {
    purgeMonths: cfg.purgeMonths,
    jobEnabled,
    lastRunLabel: lastRun ? formatDateTime(lastRun.created_at) : null,
    lastRunStatus: lastRun ? STATUS_FR[lastRun.status as JobRunStatus] ?? lastRun.status : null,
    lastRunSummary: lastRun?.summary ?? null,
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux outils système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="Recherche"
            description="Le centre de la recherche : statistiques d'utilisation, réglages du moteur (pertinence, types, limites) et conservation des données."
          />
        </div>
      </div>

      <SearchControlCenter
        stats={
          <SearchStats
            overview={overview}
            topQueries={topQueries}
            zeroResultQueries={zeroResultQueries}
            days={days}
            maxDays={cfg.purgeMonths * 30}
            canManage={canManage}
          />
        }
        settings={cfg}
        purge={purge}
        canManage={canManage}
        aliases={aliases}
        aliasCounts={aliasCounts}
        aliasPrefillTerm={aliasPrefillTerm}
      />
    </div>
  );
}

const STATUS_FR: Record<JobRunStatus, string> = {
  ok: "OK",
  failed: "échec",
  skipped: "ignorée",
};

function formatDateTime(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseDays(input: string | undefined): number {
  const n = Number(input ?? 30);
  if (!Number.isFinite(n)) return 30;
  if (n < 1) return 1;
  // Ceiling matches the max retention window (purge_months ≤ 24 ⇒ 720d) so the
  // longest-retained search_log rows stay viewable in Statistiques.
  if (n > 730) return 730;
  return Math.round(n);
}
