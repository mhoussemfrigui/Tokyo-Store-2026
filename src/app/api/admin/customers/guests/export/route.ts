import { requirePermission } from "@/lib/auth/session";
import { bus } from "@/events/bus";
import { listFilteredGuests } from "@/lib/customers/guest-filter";
import { guestFilterFromParams } from "@/lib/customers/guest-filter-shared";
import { GUEST_CSV_FIELDS } from "@/lib/export/guest-fields";
import { collectKeysetPages } from "@/lib/csv/collect-pages";
import { selectCsvFields, csvHeaderLine, csvRowLine } from "@/lib/csv/fields";
import { csvCell } from "@/lib/csv/cell";

/**
 * Admin guest-clients export → CSV, honouring the SAME GuestFilter as the on-screen
 * list (so « Exporter (filtré) » downloads exactly the filtered set) and the `?fields=`
 * column picker. Guest orders grouped by (lower(email), phone), account-enriched. Gated on
 * `invites:export` (a bulk guest-PII pull is a materially different surface than paging the
 * list). UTF-8 + BOM + CRLF for clean Excel import. Emits `data.exported` (resource
 * "guests", row count, the downloading admin as actor) for the RGPD accountability trail.
 *
 * `listFilteredGuests` clamps a page at 200, so the export walks its (last_at, email_key,
 * phone) keyset cursor up to EXPORT_CAP; past the ceiling a trailing marker row + an
 * `X-Export-Truncated` header flag the file as incomplete.
 */
export const dynamic = "force-dynamic";

const EXPORT_CAP = 10_000;
const PAGE = 200;

export async function GET(req: Request) {
  const session = await requirePermission("invites", "export");
  const params = new URL(req.url).searchParams;
  const filter = guestFilterFromParams((k) => params.get(k));

  const { items, truncated } = await collectKeysetPages(
    (cursor) => listFilteredGuests(filter, { limit: PAGE, cursor }),
    EXPORT_CAP,
  );
  await bus
    .emit("data.exported", { resource: "guests", count: items.length }, { actorUserId: session.user.id })
    .catch(() => {});

  const fields = selectCsvFields(GUEST_CSV_FIELDS, params.get("fields"));
  const lines = [csvHeaderLine(fields), ...items.map((g) => csvRowLine(fields, g))];
  if (truncated) {
    lines.push(csvCell(`# tronqué à ${EXPORT_CAP} invités (les plus récents) — l'export complet dépasse ce plafond`));
  }

  const body = "﻿" + lines.join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="clients-invites-${stamp}.csv"`,
      "Cache-Control": "no-store",
      ...(truncated ? { "X-Export-Truncated": "1" } : {}),
    },
  });
}
