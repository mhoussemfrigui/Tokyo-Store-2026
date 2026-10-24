import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { pickSettings } from "@/lib/settings/pick-settings";
import { bannerService } from "@/modules/cms/banner/service";
import { bannerRowToFormInitial } from "@/lib/cms/banner-form-data";
import { mediaQueries } from "@/modules/media";
import { HeroSlidesEditor } from "./hero-slides-editor";
import { ListingSettingsPanel } from "./listing-settings-panel";

export const metadata: Metadata = { title: "Page d'accueil" };
export const dynamic = "force-dynamic";

/**
 * « Page d'accueil » admin — the storefront home is a FIXED bespoke Tokyo layout (there is
 * no block-composer alternative), so this page edits the two things the home reads live:
 * the HERO carousel (the `home_hero` banners) and the listing-page settings. A failed
 * settings read reaches the admin error boundary (retry) rather than rendering blank values
 * a save would then persist.
 */
export default async function AdminHomePage() {
  await requirePermission("home", "view");

  const [settings, allBanners] = await Promise.all([
    getSettingsMap(),
    bannerService.listAll().catch(() => []),
  ]);

  // Hero carousel slides = the `home_hero` banners, in carousel order; their desktop
  // images resolve to thumbnails for the row previews.
  const heroRows = allBanners
    .filter((b) => b.placement === "home_hero")
    .sort((a, b) => a.display_order - b.display_order);
  const heroSlides = heroRows.map(bannerRowToFormInitial);
  const thumbEntries = await Promise.all(
    heroRows
      .filter((r) => r.image_media_id)
      .map(async (r) => [r.image_media_id!, await mediaQueries.resolveUrlById(r.image_media_id!).catch(() => null)] as const),
  );
  const heroThumbs = Object.fromEntries(
    thumbEntries.filter((e): e is [string, string] => Boolean(e[1])),
  );

  return (
    <div className="space-y-5">
      <div className="rounded-[28px] border border-border bg-card p-4 sm:p-6">
        <HeroSlidesEditor slides={heroSlides} thumbs={heroThumbs} />
      </div>
      <ListingSettingsPanel values={pickSettings(settings, ["home.", "storefront."])} />
    </div>
  );
}
