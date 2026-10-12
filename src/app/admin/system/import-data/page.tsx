import type { Metadata } from "next";
import { isNull, sql } from "drizzle-orm";

import { requirePermissionAny } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { IMPORT_DATA_VIEW_GRANTS } from "@/lib/rbac/nav-access";
import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { listDataJobsAction } from "@/lib/actions/data-jobs";
import { listImportJobsAction } from "@/lib/actions/import";
import { ImportDataPanel } from "./import-data-panel";

export const metadata: Metadata = { title: "Import data" };

/**
 * Admin: « Import data » — the merged catalogue-import + bundled-bring-up tab
 * (replaces /admin/system/import + /admin/system/import-demo, both of which now
 * 308-redirect here). Gated by IMPORT_DATA_VIEW_GRANTS (system_import:view OR
 * system_demo:view), matching the sidebar item's `visibleWhen`. Each launch
 * re-gates server-side: the bundled one-click runs through the data-jobs actions
 * (system_jobs), the file upload through the import action (system_import), the
 * purge through demo-purge (system_demo:manage + `*`).
 */
export default async function ImportDataPage() {
  const session = await requirePermissionAny(IMPORT_DATA_VIEW_GRANTS);
  const perms = await resolveUserPermissions(session.user.id);

  const canViewJobs = permissionSetAllows(perms, "system_jobs", "view");
  const canRunJobs = permissionSetAllows(perms, "system_jobs", "manage");
  const canImportFile = permissionSetAllows(perms, "system_import", "view");
  const canRepairNav = permissionSetAllows(perms, "navigation", "update");
  const canPurge = perms.has(WILDCARD);

  // listDataJobsAction / listImportJobsAction both gate internally (system_jobs
  // / system_import); only call one the viewer may read, else the whole page
  // 404s on a soft-permission probe.
  const [pRow, initialDataJobs, initialImportJobs] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(products).where(isNull(products.deleted_at)),
    canViewJobs ? listDataJobsAction("import") : Promise.resolve([]),
    canImportFile ? listImportJobsAction() : Promise.resolve([]),
  ]);

  return (
    <ImportDataPanel
      initialDataJobs={initialDataJobs}
      initialImportJobs={initialImportJobs}
      canRunJobs={canRunJobs}
      canViewJobs={canViewJobs}
      canImportFile={canImportFile}
      canRepairNav={canRepairNav}
      canPurge={canPurge}
      productsInDb={pRow[0]?.c ?? 0}
    />
  );
}
