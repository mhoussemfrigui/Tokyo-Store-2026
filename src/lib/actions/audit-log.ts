"use server";

import { requirePermission } from "@/lib/auth/session";
import { listAuditEntries } from "@/modules/audit/queries";
import { parseAuditCursor, normalizeAuditFilters } from "@/modules/audit/cursor";
import { authQueries } from "@/modules/auth";
import type { AuditRow, AuditFilters } from "@/app/admin/system/audit/audit-journal";

export type AuditPage = {
  ok: boolean;
  rows: AuditRow[];
  /** actor id → name for the rows in this page (merge into the client map). */
  actorNames: Record<string, string>;
  nextCursor: string | null;
};

const PAGE_SIZE = 50;

/**
 * Fetch the NEXT page of the audit journal for the "Charger plus" append (so the
 * list grows instead of replacing the page). Re-applies the SAME filters as the
 * server page (via the shared normalizeAuditFilters) + the id keyset cursor, and
 * resolves actor names so appended rows show names like the first page. view-gated.
 */
export async function loadMoreAuditEntriesAction(input: {
  filters: AuditFilters;
  cursor: string;
}): Promise<AuditPage> {
  await requirePermission("system_audit", "view");
  const cursor = parseAuditCursor(input.cursor);
  if (!cursor) return { ok: false, rows: [], actorNames: {}, nextCursor: null };

  const { items, nextCursor } = await listAuditEntries({
    ...normalizeAuditFilters(input.filters),
    cursor,
    limit: PAGE_SIZE,
  });

  const actorIds = [
    ...new Set(items.map((e) => e.actor_user_id).filter((v): v is string => Boolean(v))),
  ];
  const userMap = await authQueries.findUsersByIds(actorIds);
  const actorNames: Record<string, string> = {};
  for (const id of actorIds) {
    const u = userMap.get(id);
    if (u?.name) actorNames[id] = u.name;
  }

  return {
    ok: true,
    rows: items.map((e) => ({
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
    })),
    actorNames,
    nextCursor,
  };
}
