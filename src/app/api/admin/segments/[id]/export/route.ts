import { requirePermission } from "@/lib/auth/session";
import { bus } from "@/events/bus";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { authService } from "@/modules/auth/service";
import { segmentService } from "@/modules/customer/segment.service";
import { legacyRuleToTree } from "@/lib/promotions/rule-tree";
import { buildSegmentSqlCtx, segmentMemberIdsSql } from "@/lib/promotions/rule-tree-sql";
import { csvCell } from "@/lib/csv/cell";
import { selectCsvFields, csvHeaderLine, csvRowLine } from "@/lib/csv/fields";
import { CUSTOMER_CSV_FIELDS, type CustomerExportRow } from "@/lib/export/customer-row";

/**
 * Per-segment member export → CSV download.
 *
 * The segment's LIVE members (a DYNAMIC segment resolved through the shared SQL
 * compiler — the SAME roster targeting/mailing use; a MANUAL segment from its member
 * rows) enriched with email, streamed as UTF-8 CSV (BOM + CRLF for Excel).
 * Reuses the Clients export's column catalog + accessors (CUSTOMER_CSV_FIELDS) and
 * the `?fields=` picker contract, so the two exports never drift.
 *
 * GATED ON `customers:export` — a segment export is the same bulk customer-PII
 * surface as the Clients export, so it shares that grant (no new RBAC key). Unlike a
 * BLAST, an export is the full roster: it is NOT opt-in filtered (the operator is
 * exporting the audience, not mailing it). Emits `data.exported` (resource
 * "customers") for the RGPD accountability trail.
 */
export const dynamic = "force-dynamic";

const EXPORT_CAP = 10_000;

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("customers", "export");
  const { id } = await context.params;

  const seg = await segmentService.get(id);
  if (!seg) return new Response("Segment introuvable", { status: 404 });

  // Resolve the member profile-id set (LIVE profiles only). +1 over the cap detects
  // truncation without a second query.
  let pids: string[];
  if (seg.kind === "dynamic") {
    const ctx = await buildSegmentSqlCtx();
    pids = await segmentMemberIdsSql(seg.rule_tree ?? legacyRuleToTree(seg.rule), ctx, {
      cap: EXPORT_CAP + 1,
    });
  } else {
    pids = (await segmentService.listMembers(id)).map((m) => m.profileId);
  }
  const truncated = pids.length > EXPORT_CAP;
  if (truncated) pids = pids.slice(0, EXPORT_CAP);

  const profiles = await customerService.findProfilesByIds(pids);
  await bus
    .emit("data.exported", { resource: "customers", count: profiles.length }, { actorUserId: session.user.id })
    .catch(() => {});
  const linkMap = await customerUserLink.findByProfileIds(profiles.map((p) => p.id));
  const emailMap = await authService.listEmailsByIds([...new Set(linkMap.values())]);

  const rows: CustomerExportRow[] = profiles.map((p) => {
    const userId = linkMap.get(p.id);
    return {
      p,
      email: userId ? (emailMap.get(userId) ?? "") : "",
    };
  });

  const fields = selectCsvFields(CUSTOMER_CSV_FIELDS, new URL(req.url).searchParams.get("fields"));
  const lines = [csvHeaderLine(fields), ...rows.map((r) => csvRowLine(fields, r))];
  if (truncated) {
    lines.push(csvCell(`# tronqué à ${EXPORT_CAP} membres (les plus récents) — l'export complet dépasse ce plafond`));
  }

  const body = "﻿" + lines.join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = seg.name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).toLowerCase() || "segment";
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="segment-${slug}-${stamp}.csv"`,
      "Cache-Control": "no-store",
      ...(truncated ? { "X-Export-Truncated": "1" } : {}),
    },
  });
}
