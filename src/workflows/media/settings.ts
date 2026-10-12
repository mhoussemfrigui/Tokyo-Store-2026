import "server-only";

import { z } from "zod";

import {
  mediaSettingsService,
  MAX_UPLOAD_MB_CEILING,
} from "@/modules/media/settings.service";
import { invalidateCdnBase } from "@/modules/media/cdn-base";
import { bakedMediaHostEntries, isCdnBaseAllowed } from "@/modules/media/cdn-allowlist";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Media settings update — fans out a `media.settings_updated` event so
 * any cache that depends on the singleton can invalidate.
 *
 * Validation here mirrors the schema-level clamping in
 * `mediaSettingsService.update` but it returns user-facing fieldErrors so
 * the admin form can highlight the offending input.
 */

const updateSchema = z.object({
  generate_webp: z.boolean().optional(),
  generate_avif: z.boolean().optional(),
  keep_original: z.boolean().optional(),
  // Auto white-background for product-scope uploads (edge flood-fill removal to transparent, not AI).
  product_white_bg: z.boolean().optional(),
  // Restrict auto-détourage to a product's MAIN (first) image only.
  product_white_bg_main_only: z.boolean().optional(),

  max_width_px: z.number().int().min(0).max(8000).optional(),
  max_height_px: z.number().int().min(0).max(8000).optional(),

  webp_quality: z.number().int().min(30).max(100).optional(),
  avif_quality: z.number().int().min(30).max(100).optional(),
  jpeg_quality: z.number().int().min(30).max(100).optional(),

  strip_exif: z.boolean().optional(),
  // Capped at the Next.js request-body limit (proxyClientMaxBodySize="16mb" in
  // next.config.ts) — beyond it Next truncates the body before the upload
  // handler runs, so a higher value would be unachievable. Mirrors the clamp in
  // mediaSettingsService.update; MAX_UPLOAD_MB_CEILING is the single source.
  max_upload_mb: z.number().int().min(1).max(MAX_UPLOAD_MB_CEILING).optional(),

  default_alt_text: z.string().max(200).nullable().optional(),
  cdn_base_url: z
    .string()
    .url()
    // z.string().url() also accepts javascript:/data:/ftp: — but this value is
    // prefixed onto every media src store-wide, so constrain it to http(s).
    .refine((u) => /^https?:\/\//i.test(u), "L'URL CDN doit commencer par http:// ou https://.")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});

export const updateMediaSettingsWorkflow = workflow<
  [z.input<typeof updateSchema>, { actorUserId: string }],
  { ok: true }
>("media.settings.update", async (input, { actorUserId }) => {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      fieldErrors[i.path[0]?.toString() ?? "form"] = i.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }

  // Guard the next/image + CSP footgun: cdn_base_url is prefixed onto EVERY media
  // src as `<base>/<key>`, but images.remotePatterns + the CSP img-src/media-src
  // are compiled at BUILD time from S3_PUBLIC_URL + MEDIA_CDN_URL — they can't read
  // this DB value. Validate against the SAME build-snapshot allow-list the runtime
  // resolver gate (cdn-base.ts gateToBuild), the form's amber warning, and the
  // sibling url_override validator all use — so the save can't accept a base the
  // resolver will then silently drop back to /cdn. The match pins SCHEME + host
  // (:port) + path prefix: an http:// base on an https host, a wrong port, or a
  // bucket-less path (S3_PUBLIC_URL carries the bucket, e.g. https://host/tokyo)
  // is refused, because each of those makes next/image 400 or the CSP block.
  const cdn = parsed.data.cdn_base_url;
  if (cdn && !isCdnBaseAllowed(cdn, bakedMediaHostEntries())) {
    return fail("validation", "URL CDN non autorisée.", {
      cdn_base_url:
        "Ce schéma/hôte/chemin ne correspond pas à S3_PUBLIC_URL (hôte + préfixe du bucket) ni à un hôte de MEDIA_CDN_URL du build — ajoutez-le à l'env et redéployez, sinon next/image et la CSP rejetteront les images du storefront.",
    });
  }

  const changedFields = Object.keys(parsed.data).filter(
    (k) => (parsed.data as Record<string, unknown>)[k] !== undefined,
  );
  if (changedFields.length === 0) return ok({ ok: true });

  await mediaSettingsService.update(parsed.data);

  // The effective CDN base is memoised module-side off `cdn_base_url`; drop it
  // so the next URL resolution picks up the admin's change immediately.
  invalidateCdnBase();

  await bus.emit(
    "media.settings_updated",
    { changedFields },
    { actorUserId },
  );

  return ok({ ok: true });
});
