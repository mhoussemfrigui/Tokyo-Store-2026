import { permanentRedirect } from "next/navigation";

/**
 * MOVED — « Import catalogue » was merged into « Import data »
 * (/admin/system/import-data), whose Produits sub-tab hosts the file/URL upload.
 * This route stays as a permanent (308) redirect so bookmarks + old deep links
 * keep working; the target page carries the real RBAC guard (requirePermissionAny
 * over IMPORT_DATA_VIEW_GRANTS), so no guard is needed on this pure stub.
 */
export default function ImportCatalogueRedirect(): never {
  permanentRedirect("/admin/system/import-data");
}
