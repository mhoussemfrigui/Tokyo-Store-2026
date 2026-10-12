import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/origin";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseMediaUploadScope } from "@/modules/media/validation";
import { workflows } from "@/workflows";

/**
 * Admin-only "import image from URL" endpoint. The server downloads the URL
 * (SSRF-hardened, see lib/media/fetch-remote-image.ts), runs it through the
 * normal media pipeline (webp/avif/exif/S3), and returns the new média row.
 *
 * POST /api/admin/media/import-url
 *   json: { url: string, scope?: products|categories|brands|cms|uploads, altText? }
 *   → { id, url }
 */

export async function POST(request: Request) {
  // CSRF defense — same as the file-upload route.
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const session = await requirePermission("media", "create");

  // This is the one media route that does an OUTBOUND fetch + sharp re-encode per
  // call — rate-limit it per admin so a compromised/automated session can't use
  // it as an egress/CPU amplifier.
  const rl = await checkRateLimit({
    bucket: `media-import:${session.user.id}`,
    max: 30,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "Trop de requêtes. Réessayez dans un instant." }, { status: 429 });
  }

  let body: { url?: unknown; scope?: unknown; altText?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête invalide." }, { status: 400 });
  }

  const url = String(body.url ?? "").trim();
  if (!url) return NextResponse.json({ error: "URL requise." }, { status: 400 });

  // Single-source allow-list in modules/media/validation (same parser the
  // Server Actions + the upload route use; falls back to the neutral "uploads").
  const scope = parseMediaUploadScope(body.scope);
  const altText =
    typeof body.altText === "string" && body.altText.trim() ? body.altText.trim() : undefined;

  const result = await workflows.media.importFromUrl({
    url,
    scope,
    altText,
    uploadedBy: session.user.id,
  });
  if (!result.ok) {
    // Map the SSRF/validation failures to 4xx (admin error), not 500.
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
  return NextResponse.json({ id: result.data.mediaId, url: result.data.url });
}
