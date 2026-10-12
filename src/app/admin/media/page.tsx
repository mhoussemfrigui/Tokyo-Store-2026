import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { mediaService } from "@/modules/media/service";
import { mediaSettingsService } from "@/modules/media/settings.service";
import { primeCdnBase, getCdnBaseSync } from "@/modules/media/cdn-base";
import { countOrphans, listOrphans } from "@/modules/media/queries";
import { resolveMediaUrl, resolveMediaThumbUrl } from "@/modules/media/url-resolver";
import { normalizePublicUrl } from "@/lib/utils/public-url";

import { MediaPanel } from "./media-panel";
import { MediaSubtabs } from "./media-subtabs";

export const metadata: Metadata = { title: "Médiathèque" };

/** Library page size — the first server page and each « Charger plus » batch
 *  (/api/admin/media caps `limit` at 100). */
const LIBRARY_PAGE = 100;
/** Orphans view cap (listOrphans has no cursor; the total discloses the rest). */
const ORPHANS_CAP = 200;

export default async function MediaAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const session = await requirePermission("media", "view");
  const perms = await resolveUserPermissions(session.user.id);
  const canSettings = permissionSetAllows(perms, "system_media", "view");
  // Write controls mirror the action gates (upload/import → media:create, the
  // alt/filename/CDN edit → media:update, single + bulk delete → media:delete):
  // a view-only role gets a read-only library instead of controls whose action
  // would 404 the page. The actions re-check server-side.
  const canCreate = permissionSetAllows(perms, "media", "create");
  const canUpdate = permissionSetAllows(perms, "media", "update");
  const canDelete = permissionSetAllows(perms, "media", "delete");
  const orphansMode = sp.view === "orphans";
  // Library search is SERVER-side so it spans the whole library, not just the
  // newest 100 loaded into the grid (orphans view keeps its own client filter).
  const search = (sp.q ?? "").trim() || undefined;

  // Prime the effective CDN base from the DB before the sync `normalizePublicUrl`
  // calls below, then read it synchronously — so the Médiathèque displays and
  // (client-side) copies the SAME CDN-based URLs the storefront serves, not a
  // window.location.origin fallback.
  await primeCdnBase();
  const cdnBase = getCdnBaseSync();

  const [settings, page, total] = await Promise.all([
    mediaSettingsService.get(),
    // Library: the newest 100 (search-filtered server-side) + the keyset cursor
    // the panel's « Charger plus » continues from via /api/admin/media?cursor=.
    // Orphans: the newest 200 (no cursor — delete, then reload for the rest).
    orphansMode
      ? listOrphans(ORPHANS_CAP).then((items) => ({ items, nextCursor: null }))
      : mediaService.list({ search, limit: LIBRARY_PAGE }),
    // The real total so the panel can say « N affichés sur M » instead of
    // passing a capped page off as everything: live media (library — only
    // meaningful with no active search) or every orphan (orphans view).
    orphansMode ? countOrphans() : mediaService.count(),
  ]);
  const { items, nextCursor } = page;

  return (
    <div className="space-y-5">
      <MediaSubtabs active="library" canSettings={canSettings} />
      <MediaPanel
      orphansMode={orphansMode}
      initialSearch={search ?? ""}
      maxUploadMb={settings.max_upload_mb}
      cdnBase={cdnBase}
      total={total}
      nextCursor={nextCursor}
      pageSize={LIBRARY_PAGE}
      canCreate={canCreate}
      canUpdate={canUpdate}
      canDelete={canDelete}
      items={items.map((m) => ({
        id: m.id,
        // Canonical resolver chains (empty-string-safe firstNonEmpty; avif-first
        // for display, webp-first for the raw-<img> thumbnail) — the SAME ones the
        // « Charger plus » API (route.ts mapMedia) and the storefront use. A bare
        // `url_override ?? url` skips only null, so an empty-string override (which
        // imports write) would blank the URL and diverge from the paged batches.
        url: resolveMediaUrl(m) ?? "",
        thumbUrl: resolveMediaThumbUrl(m) ?? "",
        filename: m.filename,
        width: m.width,
        height: m.height,
        sizeBytes: m.size_bytes,
        altText: m.alt_text,
        urlOverride: m.url_override,
        // Each variant carries its absolute URL so the badge can link to
        // the actual asset; `null` when the variant wasn't generated.
        variants: {
          webp: normalizePublicUrl(m.webp_url, cdnBase),
          avif: normalizePublicUrl(m.avif_url, cdnBase),
          original: normalizePublicUrl(m.original_url, cdnBase),
        },
        createdAt: m.created_at.toISOString(),
      }))}
      />
    </div>
  );
}
