import { permanentRedirect } from "next/navigation";

/**
 * MOVED — « Importer la démo » was merged into « Import data »
 * (/admin/system/import-data): the bundled one-click (content snapshot +
 * catalog + redirects) and the super-admin purge now live there. This route
 * stays as a permanent (308) redirect so bookmarks + old deep links keep
 * working; the target page carries the real RBAC guard (requirePermissionAny
 * over IMPORT_DATA_VIEW_GRANTS), so no guard is needed on this pure stub.
 */
export default function ImportDemoRedirect(): never {
  permanentRedirect("/admin/system/import-data");
}
