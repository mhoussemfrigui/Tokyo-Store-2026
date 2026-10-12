import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/origin";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseMediaUploadScope } from "@/modules/media/validation";
import { workflows } from "@/workflows";

/**
 * Admin-only multipart upload endpoint used by <MediaPicker>'s inline
 * upload button. Identical pipeline to the form action — same workflow,
 * same validation, same variants — but returns JSON instead of triggering
 * a Server Action revalidation.
 *
 * POST /api/admin/media/upload
 *   form-data: file=<File>, scope=<products|categories|brands|cms|uploads>, altText?
 */

export async function POST(request: Request) {
  // CSRF defense — see src/lib/auth/origin.ts. Without this, a malicious
  // tab opened by a logged-in admin can plant arbitrary images into the
  // media library via credentialed cross-site fetch.
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const session = await requirePermission("media", "create");

  // Same heavy sharp re-encode + S3-variant pipeline as import-url, so throttle
  // it the same way — before the (expensive) formData parse. A compromised or
  // automated admin session can't loop uploads into an unbounded CPU/S3 amplifier.
  const rl = await checkRateLimit({
    bucket: `media-upload:${session.user.id}`,
    max: 30,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Trop de requêtes. Réessayez dans un instant." },
      { status: 429 },
    );
  }

  // Next.js truncates request bodies past `experimental.proxyClientMaxBodySize`
  // (set to "16mb" in next.config.ts — the outer ceiling, coupled to
  // MAX_UPLOAD_MB_CEILING) and `request.formData()` then throws "Failed to parse
  // body". Catch that explicitly so the client gets a meaningful 413 instead of 500.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Fichier trop volumineux ou body invalide." },
      { status: 413 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Aucun fichier" }, { status: 400 });
  }

  // Gate MIME at the route boundary so non-image uploads fail with a precise
  // error instead of bouncing through the workflow's generic "format non
  // supporté" path.
  if (!file.type.startsWith("image/")) {
    return NextResponse.json(
      { error: "Format non supporté (image requise)." },
      { status: 415 },
    );
  }

  // Validate scope against the single-source allow-list in
  // modules/media/validation (the same parser the Server Actions use — falls
  // back to the neutral "uploads"). A bare cast would let an arbitrary string
  // become the S3 key prefix (buildStorageKey interpolates it verbatim) —
  // admin+same-origin gated, but don't trust unvalidated input that steers
  // object placement.
  const scope = parseMediaUploadScope(formData.get("scope"));

  const altText = formData.get("altText");

  const result = await workflows.media.upload({
    file,
    scope,
    altText: typeof altText === "string" && altText.trim() ? altText.trim() : undefined,
    uploadedBy: session.user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
  return NextResponse.json({ id: result.data.mediaId, url: result.data.url });
}
