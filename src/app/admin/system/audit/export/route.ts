import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/session";
import { bus } from "@/events/bus";
import { authQueries } from "@/modules/auth";
import { listAuditEntriesForExport, type AuditExportRow } from "@/modules/audit/queries";
import { normalizeAuditFilters } from "@/modules/audit/cursor";
import { csvCell } from "@/lib/csv/cell";

/**
 * Streams the current filtered audit log as CSV. Honors the same query params as
 * the Journal tab (event, domain, severity, targetType, targetId, actor,
 * summary, from, to). Pages the id-keyset to export the FULL filtered window
 * (previously the route asked for 1000 but listAuditEntries hard-capped at 200,
 * so exports were a silent partial). A hard MAX_EXPORT_ROWS ceiling guards an
 * unbounded export; a trailing marker row signals truncation so a compliance
 * export is never silently incomplete. Emits `data.exported` (resource "audit",
 * row count, the downloading admin as actor) so the export itself is on record.
 */
const MAX_EXPORT_ROWS = 50_000;
const PAGE = 200;

export async function GET(req: Request) {
  const session = await requirePermission("system_audit", "view");
  const url = new URL(req.url);
  const g = (k: string) => url.searchParams.get(k);
  // Same normalization as the page + load-more action (trim + `to`=inclusive
  // end-of-day + remap) so the export window matches the on-screen Journal.
  const filters = normalizeAuditFilters({
    event: g("event"),
    domain: g("domain"),
    severity: g("severity"),
    targetType: g("targetType"),
    targetId: g("targetId"),
    actor: g("actor"),
    summary: g("summary"),
    from: g("from"),
    to: g("to"),
  });

  const rows: AuditExportRow[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const { items, nextCursor } = await listAuditEntriesForExport({ ...filters, limit: PAGE, cursor });
    rows.push(...items);
    if (!nextCursor) break;
    if (rows.length >= MAX_EXPORT_ROWS) {
      truncated = true;
      break;
    }
    cursor = nextCursor;
  }

  await bus
    .emit("data.exported", { resource: "audit", count: rows.length }, { actorUserId: session.user.id })
    .catch(() => {});

  // Resolve actor IDs to names in one query so the CSV is human-friendly.
  const actorIds = [
    ...new Set(rows.map((e) => e.actor_user_id).filter((v): v is string => Boolean(v))),
  ];
  const userMap = await authQueries.findUsersByIds(actorIds);

  const header = [
    "id",
    "created_at",
    "severity",
    "actor_user_name",
    "actor_user_id",
    "action",
    "target_type",
    "target_id",
    "ip",
    "summary",
  ];
  const lines = rows.map((e) => {
    const actor = e.actor_user_id ? userMap.get(e.actor_user_id) : null;
    return [
      e.id,
      e.created_at.toISOString(),
      e.severity,
      actor?.name ?? "",
      e.actor_user_id ?? "",
      e.event_name,
      e.target_type ?? "",
      e.target_id ?? "",
      e.actor_ip ?? "",
      e.summary ?? "",
    ]
      .map(csvCell)
      .join(",");
  });
  const out = [header.map(csvCell).join(","), ...lines];
  if (truncated) {
    out.push(`# tronqué à ${MAX_EXPORT_ROWS} lignes — affinez les filtres ou la plage de dates`);
  }
  const csv = out.join("\n");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
