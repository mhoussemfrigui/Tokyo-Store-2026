import { requirePermission } from "@/lib/auth/session";
import { bus } from "@/events/bus";
import { customerUserLink } from "@/associations/customer-user.service";
import { authService } from "@/modules/auth/service";
import { csvCell } from "@/lib/csv/cell";
import { selectCsvFields, csvHeaderLine, csvRowLine } from "@/lib/csv/fields";
import { collectKeysetPages } from "@/lib/csv/collect-pages";
import { CUSTOMER_CSV_FIELDS, type CustomerExportRow } from "@/lib/export/customer-row";
import { listFilteredCustomerProfiles } from "@/lib/customers/filter";
import { customerFilterFromParams } from "@/lib/customers/filter-shared";

/**
 * Admin customer export → CSV download.
 *
 * Streams the registered-customer database (profile + linked email) as a UTF-8
 * CSV (BOM + CRLF so Excel opens it cleanly). Efficient: the keyset-paged profile
 * reads + one batched profile→user link read + one batched id→email read.
 *
 * GATED ON `customers:export` — a bulk PII download (email, phone, birthday,
 * marketing status) is a materially different surface than paging the list, so it
 * needs its own grant, not `customers:view`. The operator picks WHICH columns via
 * `?fields=` (the CATALOG below is the allow-list; an unknown key is dropped, an
 * empty selection exports every column).
 *
 * `listFilteredCustomerProfiles` (lib/customers/filter.ts) clamps a page at 200, so
 * the export walks its (created_at, id) keyset cursor up to EXPORT_CAP. Past the
 * ceiling a trailing marker row + an `X-Export-Truncated` header flag the file as
 * incomplete.
 *
 * Emits `data.exported` (resource "customers", row count, the downloading admin
 * as actor) — a bulk personal-data export must leave an RGPD accountability row.
 */
export const dynamic = "force-dynamic";

const EXPORT_CAP = 10_000;
const PAGE = 200;

/** One enriched export row: the profile plus its resolved email. */
type Row = CustomerExportRow;

export async function GET(req: Request) {
  const session = await requirePermission("customers", "export");

  // Honour the SAME filter as the Clients list (name/email/phone, gender, coupon,
  // cart, marketing, dates), so « Exporter » downloads exactly the filtered set. No
  // filter → the whole registered-customer base.
  const params = new URL(req.url).searchParams;
  const filter = customerFilterFromParams((k) => params.get(k));
  const { items, truncated } = await collectKeysetPages(
    (cursor) => listFilteredCustomerProfiles(filter, { limit: PAGE, cursor }),
    EXPORT_CAP,
  );
  await bus
    .emit("data.exported", { resource: "customers", count: items.length }, { actorUserId: session.user.id })
    .catch(() => {});
  const linkMap = await customerUserLink.findByProfileIds(items.map((p) => p.id));
  const emailMap = await authService.listEmailsByIds([...new Set(linkMap.values())]);

  const rows: Row[] = items.map((p) => {
    const userId = linkMap.get(p.id);
    return {
      p,
      email: userId ? (emailMap.get(userId) ?? "") : "",
    };
  });

  const fields = selectCsvFields(CUSTOMER_CSV_FIELDS, new URL(req.url).searchParams.get("fields"));
  const lines = [csvHeaderLine(fields), ...rows.map((r) => csvRowLine(fields, r))];
  if (truncated) {
    lines.push(csvCell(`# tronqué à ${EXPORT_CAP} clients (les plus récents) — l'export complet dépasse ce plafond`));
  }

  const body = "﻿" + lines.join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="clients-${stamp}.csv"`,
      "Cache-Control": "no-store",
      ...(truncated ? { "X-Export-Truncated": "1" } : {}),
    },
  });
}
