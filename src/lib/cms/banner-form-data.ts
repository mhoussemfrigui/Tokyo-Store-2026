import { effectiveBannerButtons } from "@/lib/cms/banner-model";
import type { BannerRow } from "@/modules/cms/banner/schema";
import type { BannerFormInitial } from "@/components/admin/banner-form";

/**
 * Map a stored banner row → the BannerForm's `initial` seed. Shared by every
 * admin editor that embeds `BannerForm` (CMS → Footer newsletter banner, CMS →
 * Page d'accueil hero slides) so the row → form shape stays in ONE place.
 * `effectiveBannerButtons` resolves the editable CTAs (back-compat-synthesising
 * the legacy cta_* columns), and timestamps become ISO strings for the client.
 */
export function bannerRowToFormInitial(row: BannerRow): BannerFormInitial {
  return {
    id: row.id,
    placement: row.placement,
    name: row.name,
    eyebrow: row.eyebrow,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    ctaLabel: row.cta_label,
    ctaHref: row.cta_href,
    imageMediaId: row.image_media_id,
    imageMobileMediaId: row.image_mobile_media_id,
    videoUrl: row.video_url,
    showText: row.show_text,
    buttons: effectiveBannerButtons(row),
    startAt: row.start_at?.toISOString() ?? null,
    endAt: row.end_at?.toISOString() ?? null,
    displayOrder: row.display_order,
    isActive: row.is_active,
    targetKind: row.target_kind,
    targetRef: row.target_ref,
    afterLoadMoreCount: row.after_load_more_count,
    gridPosition: row.grid_position,
    stripTone: row.strip_tone,
    stripIcon: row.strip_icon,
    showCountdown: row.show_countdown,
  };
}
