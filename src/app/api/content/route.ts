import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { getContentBundle } from "@/lib/api/content";

/**
 * GET /api/content — headless rendering bundle (content:read; public-toggleable).
 * Site chrome + PUBLIC settings in one read: hero/header/footer banners, quick
 * buttons, header + footer navigation, logo, and the curated public subset of
 * site settings (payment/mail secrets are filtered out in `getContentBundle`).
 */
export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "content.bundle");
  if (!gate.ok) return gate.response;

  const bundle = await getContentBundle();
  const headers = gate.isPublic
    ? { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" }
    : { "Cache-Control": "private, no-store" };
  return NextResponse.json(bundle, { headers });
}
