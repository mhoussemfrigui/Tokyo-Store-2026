import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveAuditConfig } from "@/lib/audit/parse-config";
import {
  listAuditEntries,
  getAuditOverview,
  getTopEvents,
  getTopActors,
  type AuditOverview,
} from "@/modules/audit/queries";
import { normalizeAuditFilters } from "@/modules/audit/cursor";
import { STORE_TIME_ZONE } from "@/lib/time/store-tz";
import { authQueries } from "@/modules/auth";
import { isJobEnabled } from "@/lib/jobs/run-job";
import { jobRunLogService, type JobRunStatus } from "@/modules/jobs";
import { AdminPageHeader } from "@/components/admin/page-header";

import { AuditControlCenter } from "./audit-control-center";
import { AuditJournal, type AuditFilters } from "./audit-journal";
import { AuditStats } from "./audit-stats";
import { type AuditPurgeState } from "./audit-purge-panel";

export const metadata: Metadata = { title: "Journal d'audit" };

const PAGE_SIZE = 50;

const EMPTY_OVERVIEW: AuditOverview = { total: 0, last24h: 0, bySeverity: {}, distinctEvents: 0 };

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    event?: string;
    domain?: string;
    severity?: string;
    targetType?: string;
    targetId?: string;
    actor?: string;
    summary?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const sp = await searchParams;
  const session = await requirePermission("system_audit", "view");
  // Réglages + Purge are manage-class — gate them for UI honesty (the actions
  // re-check system_audit:manage server-side).
  const canManage = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "system_audit",
    "manage",
  );

  // Shared filter normalization (trim + `to`=inclusive end-of-day + remap) —
  // identical to the CSV export route + the load-more action so they can't drift.
  // No URL cursor: the page always serves the FIRST page; "Charger plus" appends
  // via the load-more action (a bookmarked ?cursor= would render a mid-stream page).
  const queryFilters = normalizeAuditFilters(sp);

  const [list, overview, topEvents, topActors, settingsMap, jobEnabled, lastRunMap] =
    await Promise.all([
      listAuditEntries({ ...queryFilters, limit: PAGE_SIZE }),
      getAuditOverview().catch(() => EMPTY_OVERVIEW),
      getTopEvents(10).catch(() => []),
      getTopActors(10).catch(() => []),
      // No `.catch`: the Réglages form is pre-filled from this — a swallowed read
      // would show the defaults (retention reset to 12 months…) that a save then
      // persists. A failure reaches the admin error boundary (retry).
      getSettingsMap(),
      isJobEnabled("retention_purge").catch(() => true),
      jobRunLogService.lastRunByJob(["retention_purge"]).catch(() => null),
    ]);

  const settings = resolveAuditConfig(settingsMap);

  // Resolve actor ids → names for the list rows AND the top-actors table in ONE
  // batched query (no per-row N+1; the list + export now agree on names).
  const actorIds = [
    ...new Set(
      [
        ...list.items.map((e) => e.actor_user_id),
        ...topActors.map((a) => a.actorUserId),
      ].filter((v): v is string => Boolean(v)),
    ),
  ];
  const userMap = await authQueries.findUsersByIds(actorIds);
  const actorNames: Record<string, string> = {};
  for (const id of actorIds) {
    const u = userMap.get(id);
    if (u?.name) actorNames[id] = u.name;
  }

  const lastRun = lastRunMap?.get("retention_purge") ?? null;
  const purge: AuditPurgeState = {
    retentionMonths: settings.retentionMonths,
    jobEnabled,
    lastRunLabel: lastRun ? formatDateTime(lastRun.created_at) : null,
    lastRunStatus: lastRun ? STATUS_FR[lastRun.status as JobRunStatus] ?? lastRun.status : null,
    lastRunSummary: lastRun?.summary ?? null,
  };

  const journalFilters: AuditFilters = {
    event: sp.event ?? "",
    domain: sp.domain ?? "",
    severity: sp.severity ?? "",
    targetType: sp.targetType ?? "",
    targetId: sp.targetId ?? "",
    actor: sp.actor ?? "",
    summary: sp.summary ?? "",
    from: sp.from ?? "",
    to: sp.to ?? "",
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
            title="Journal d'audit"
            description="Le centre des journaux : toutes les actions enregistrées par le bus d'événements (créations, modifications, suppressions, connexions), les statistiques, les réglages de capture/débogage et la purge. Append-only — aucune entrée n'est modifiable."
          />
        </div>
      </div>

      <AuditControlCenter
        journal={
          <AuditJournal
            items={list.items.map((e) => ({
              id: e.id,
              eventName: e.event_name,
              severity: e.severity,
              actorUserId: e.actor_user_id,
              actorIp: e.actor_ip,
              targetType: e.target_type,
              targetId: e.target_id,
              summary: e.summary,
              metadata: e.metadata as Record<string, unknown> | null,
              createdAt: e.created_at.toISOString(),
            }))}
            nextCursor={list.nextCursor}
            filters={journalFilters}
            actorNames={actorNames}
          />
        }
        stats={
          <AuditStats
            overview={overview}
            topEvents={topEvents}
            topActors={topActors}
            actorNames={actorNames}
          />
        }
        settings={settings}
        purge={purge}
        canManage={canManage}
      />
    </div>
  );
}

const STATUS_FR: Record<JobRunStatus, string> = {
  ok: "OK",
  failed: "échec",
  skipped: "ignorée",
};

// Shop time (Africa/Tunis), not the UTC container's zone.
function formatDateTime(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", {
    timeZone: STORE_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
