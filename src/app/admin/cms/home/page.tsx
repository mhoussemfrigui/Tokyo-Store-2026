import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { getHomeBlocks, hasStoredHomeBlocks } from "@/lib/pages/home-blocks-data";
import { listCategories } from "@/lib/api/categories";
import { listNavBrands } from "@/lib/api/brands";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { pickSettings } from "@/lib/settings/pick-settings";
import { bannerService } from "@/modules/cms/banner/service";
import { bannerRowToFormInitial } from "@/lib/cms/banner-form-data";
import { mediaQueries } from "@/modules/media";
import { HeroSlidesEditor } from "./hero-slides-editor";
import { HomeComposer } from "./home-composer";
import { ListingSettingsPanel } from "./listing-settings-panel";

export const metadata: Metadata = { title: "Page d'accueil" };
export const dynamic = "force-dynamic";

/**
 * « Page d'accueil » admin — the instance-based BLOCK COMPOSER. Loads the stored block
 * layout (or the synthesised legacy one when the composer has never been saved) plus the
 * live catalogue choices (categories / brands / collections) that feed the block pickers,
 * and hands them to the client composer. The storefront home renders the same blocks via
 * getHomeBlocks() + resolveHomeBlocks(). A failed read reaches the admin error boundary
 * (retry) rather than rendering an empty composer whose save would wipe the layout.
 */
export default async function AdminHomePage() {
  await requirePermission("home", "view");

  // getSettingsMap is read STRICTLY (no fail-soft to {}): a failed settings read reaches
  // the admin error boundary (retry) instead of rendering the listing panel with blank
  // values that a save would then persist as empty. Only the home./storefront. prefixes
  // are handed to the client panel (pickSettings), not the whole settings map.
  const [blocks, usingStored, categories, brands, settings, allBanners] = await Promise.all([
    getHomeBlocks(),
    hasStoredHomeBlocks(),
    listCategories().catch(() => []),
    listNavBrands().catch(() => []),
    getSettingsMap(),
    bannerService.listAll().catch(() => []),
  ]);

  // Hero carousel slides = the `home_hero` banners, in carousel order. Their
  // desktop images resolve to thumbnails for the row previews.
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
      <HomeComposer
        initialBlocks={blocks}
        usingLegacy={!usingStored}
        description="Composez la page d'accueil : ajoutez, réorganisez et configurez des blocs (rails de produits filtrables, bannières, éditoriaux…). Chaque image passe par la médiathèque et chaque lien produit/catégorie/marque par le catalogue."
        categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
        brands={brands.map((b) => ({ slug: b.slug, name: b.name }))}
      />
      <ListingSettingsPanel values={pickSettings(settings, ["home.", "storefront."])} />
    </div>
  );
}
