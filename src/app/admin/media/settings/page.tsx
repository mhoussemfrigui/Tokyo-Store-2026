import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { bustStorefrontForUnbustedJobs } from "@/lib/cache/bust-finished-jobs";
import { mediaSettingsService } from "@/modules/media/settings.service";
import { AdminPageHeader } from "@/components/admin/page-header";

import { MediaSettingsForm } from "./media-settings-form";
import { MediaSubtabs } from "../media-subtabs";

export const metadata: Metadata = { title: "Réglages média" };

export default async function MediaSettingsPage() {
  await requirePermission("system_media", "view");
  // A détourage reprocess finished while nobody watched its card → bust the
  // storefront now (deferred to `after()` from this render) so cached PDPs stop
  // pointing at the deleted image keys.
  await bustStorefrontForUnbustedJobs();
  const settings = await mediaSettingsService.get();

  return (
    <div className="space-y-5">
      <MediaSubtabs active="settings" canSettings />
      <AdminPageHeader
        title="Réglages média"
        description="Pipeline d'optimisation appliqué à chaque téléversement. Les changements prennent effet pour les nouvelles images (les anciennes peuvent être ré-uploadées si besoin)."
      />

      <MediaSettingsForm
        initial={{
          generateWebp: settings.generate_webp,
          generateAvif: settings.generate_avif,
          keepOriginal: settings.keep_original,
          productWhiteBg: settings.product_white_bg,
          productWhiteBgMainOnly: settings.product_white_bg_main_only,
          stripExif: settings.strip_exif,
          maxWidthPx: settings.max_width_px,
          maxHeightPx: settings.max_height_px,
          webpQuality: settings.webp_quality,
          avifQuality: settings.avif_quality,
          jpegQuality: settings.jpeg_quality,
          maxUploadMb: settings.max_upload_mb,
          defaultAltText: settings.default_alt_text,
          cdnBaseUrl: settings.cdn_base_url,
        }}
      />
    </div>
  );
}
