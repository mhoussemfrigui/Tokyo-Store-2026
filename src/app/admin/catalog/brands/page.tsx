import type { Metadata } from "next";

import { brandService } from "@/modules/catalog/brand/service";
import { findMediaByIds } from "@/modules/media/queries";
import { resolveMediaThumbUrl } from "@/modules/media/url-resolver";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";

import { BrandsPanel } from "./brands-panel";

export const metadata: Metadata = { title: "Marques" };

const PAGE_SIZE = 20;

export default async function BrandsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const session = await requirePermission("brands", "view");
  // Resolve the viewer's grants ONCE, then derive every gate from it (mirrors the
  // categories admin page): CRUD controls hide when the action would 404, the
  // « Auto-affecter » panel loads only for system_ai:view (read-only reports) with
  // its start/apply gated on system_ai:manage, and « Génération IA » needs
  // brands:update.
  const perms = await resolveUserPermissions(session.user.id);
  const canCreate = permissionSetAllows(perms, "brands", "create");
  const canUpdate = permissionSetAllows(perms, "brands", "update");
  const canDelete = permissionSetAllows(perms, "brands", "delete");
  const q = (sp.q ?? "").trim() || undefined;
  const rawPage = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  // Resolve the count FIRST so we can CLAMP an out-of-range page to the real
  // last page — otherwise page > totalPages would render an empty list with a
  // nonsensical "19961–5 sur 5" count and hide the pagination bar (no recovery).
  const total = await brandService.count({ search: q });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(rawPage, totalPages);

  // Paginated + searchable (admin sees inactive too — no activeOnly).
  const rows = await brandService.list({
    search: q,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  // The FULL live ordered set powers the "Réorganiser" mode (brands are dozens,
  // so loading all is cheap); its logos are a superset of the paginated page's.
  const fullList = await brandService.listAll().catch(() => []);
  // Resolve logos once for the full set (covers both the paginated rows + reorder).
  const mediaMap = await findMediaByIds(
    fullList.map((b) => b.logo_media_id).filter((x): x is string => Boolean(x)),
  );
  const logoUrlOf = (id: string | null) => (id ? resolveMediaThumbUrl(mediaMap.get(id)) : null);

  return (
    <BrandsPanel
      brands={rows.map((b) => ({
        id: b.id,
        slug: b.slug,
        name: b.name,
        description: b.description,
        isActive: b.is_active,
        logoUrl: logoUrlOf(b.logo_media_id),
      }))}
      query={sp.q ?? ""}
      pagination={{ page, pageSize: PAGE_SIZE, total }}
      canCreate={canCreate}
      canUpdate={canUpdate}
      canDelete={canDelete}
      reorderBrands={fullList.map((b) => ({ id: b.id, name: b.name, logoUrl: logoUrlOf(b.logo_media_id) }))}
    />
  );
}
