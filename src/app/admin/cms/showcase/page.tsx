import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { getCollectionPageConfig } from "@/lib/pages/collection-page-config";
import { COLLECTION_SLUGS, COLLECTION_PAGE_LABELS } from "@/lib/pages/collection-slugs";
import { showcaseService } from "@/modules/showcase";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { productQueries } from "@/modules/catalog/product";
import { AdminPageHeader } from "@/components/admin/page-header";

import {
  ShowcaseSettingsPanel,
  type ShowcasePageData,
  type ShowcaseProductOption,
} from "./showcase-settings-panel";

export const metadata: Metadata = { title: "Vitrines" };

/**
 * Admin hub for the three controllable showcase collection pages. Loads each
 * page's resolved config + manual pins. The pin picker searches the WHOLE
 * catalogue server-side (searchProductsForPickerAction), so the only products
 * preloaded here are the already-pinned ones — hydrated so each pin renders
 * with its name (a pin whose product was deleted comes back unresolved and is
 * flagged « produit supprimé » by the picker).
 */
export default async function ShowcaseAdminPage() {
  await requirePermission("showcase", "view");
  // Strict settings read FIRST: getCollectionPageConfig swallows a failed read
  // (storefront fail-soft) and would pre-fill the form with defaults that a
  // save then writes over the live config. getSettingsMap is request-cached, so
  // a failure throws to the admin error boundary here and the per-slug reads
  // below reuse this same successful result.
  await getSettingsMap();
  const [configs, pinsArr] = await Promise.all([
    Promise.all(COLLECTION_SLUGS.map((s) => getCollectionPageConfig(s))),
    // No `.catch(() => [])`: an empty pin list would be saved back by the form
    // (setPins with productIds: []) and wipe the curated pins.
    Promise.all(COLLECTION_SLUGS.map((s) => showcaseService.listPinnedProductIds(s))),
  ]);

  // No `.catch(() => [])` here: an unresolved pin is rendered as « produit
  // supprimé », so swallowing a read failure would mislabel every live pin.
  const pinnedIds = [...new Set(pinsArr.flat())];
  const pinnedProducts = pinnedIds.length ? await productQueries.listProductsByIds(pinnedIds) : [];

  const productOptions: ShowcaseProductOption[] = pinnedProducts.map((p) => ({
    id: p.id,
    name: p.name,
    published: p.is_published,
  }));

  const pages: ShowcasePageData[] = COLLECTION_SLUGS.map((slug, i) => ({
    slug,
    label: COLLECTION_PAGE_LABELS[slug],
    config: configs[i],
    pinnedIds: pinsArr[i],
  }));

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Vitrines"
        description="Configurez les pages vitrines Nouveautés, Top ventes et Promotions : contenu, sélection des produits, épingles manuelles et SEO."
      />
      <ShowcaseSettingsPanel pages={pages} products={productOptions} />
    </div>
  );
}
