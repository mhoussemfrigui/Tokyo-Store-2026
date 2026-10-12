import { requirePermission } from "@/lib/auth/session";
import { bus } from "@/events/bus";
import { listFavoritedProducts } from "@/lib/wishlist/favorites-filter";
import { favoritesFilterFromParams } from "@/lib/wishlist/favorites-filter-shared";
import { FAVORITES_CSV_FIELDS } from "@/lib/export/favorites-fields";
import { collectKeysetPages } from "@/lib/csv/collect-pages";
import { selectCsvFields, csvHeaderLine, csvRowLine } from "@/lib/csv/fields";
import { csvCell } from "@/lib/csv/cell";

/**
 * Admin Favoris demand export → CSV, honouring the SAME FavoritesFilter as the on-screen
 * ranked list (so « Exporter (filtré) » downloads exactly the filtered set) and the
 * `?fields=` column picker. Ranked favorited products with counts + stock + category.
 * Gated on `favorites:export`. UTF-8 + BOM + CRLF for clean Excel import. Emits
 * `data.exported` (resource "favorites", row count, the downloading admin as actor).
 *
 * `listFavoritedProducts` clamps a page at 200, so the export walks its (count, product_id)
 * keyset cursor up to EXPORT_CAP; past the ceiling a trailing marker row + an
 * `X-Export-Truncated` header flag the file as incomplete.
 */
export const dynamic = "force-dynamic";

const EXPORT_CAP = 10_000;
const PAGE = 200;

export async function GET(req: Request) {
  const session = await requirePermission("favorites", "export");
  const params = new URL(req.url).searchParams;
  const filter = favoritesFilterFromParams((k) => params.get(k));

  const { items, truncated } = await collectKeysetPages(
    (cursor) => listFavoritedProducts(filter, { limit: PAGE, cursor }),
    EXPORT_CAP,
  );
  await bus
    .emit("data.exported", { resource: "favorites", count: items.length }, { actorUserId: session.user.id })
    .catch(() => {});

  const fields = selectCsvFields(FAVORITES_CSV_FIELDS, params.get("fields"));
  const lines = [csvHeaderLine(fields), ...items.map((r) => csvRowLine(fields, r))];
  if (truncated) {
    lines.push(csvCell(`# tronqué à ${EXPORT_CAP} produits (les plus favoris) — l'export complet dépasse ce plafond`));
  }

  const body = "﻿" + lines.join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="favoris-${stamp}.csv"`,
      "Cache-Control": "no-store",
      ...(truncated ? { "X-Export-Truncated": "1" } : {}),
    },
  });
}
