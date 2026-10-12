import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/session";
import { IMPORT_TEMPLATE_CSV, IMPORT_TEMPLATE_XML } from "@/lib/import/templates";

/**
 * Admin-only import-template download.
 *
 *   GET /api/admin/import/template?format=xml → exemple de flux Google Merchant
 *   GET /api/admin/import/template?format=csv → exemple CSV
 *
 * Permission-gated like the other admin API routes: `requirePermission(
 * "system_import", "view")` falls through to 404 for anonymous / non-admin
 * callers (or an admin without the import permission), so the endpoint never
 * leaks its existence. Read-only GET — no CSRF/origin concern, like the CSV exports.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await requirePermission("system_import", "view");

  const format = new URL(request.url).searchParams.get("format");

  if (format === "xml") {
    return new Response(IMPORT_TEMPLATE_XML, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="tokyo-import-exemple.xml"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (format === "csv") {
    return new Response(IMPORT_TEMPLATE_CSV, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tokyo-import-exemple.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // `?format=` inconnu — refus explicite, même forme d'erreur que les autres
  // routes admin (cf. /api/admin/system/demo).
  return NextResponse.json(
    { error: { code: "invalid_input", message: "Unknown format" } },
    { status: 400 },
  );
}
