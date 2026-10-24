import type { Metadata } from "next";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { firstUrlByPlatform, resolveSocialList } from "@/lib/cms/social-list";
import { resolveReelsVideos } from "@/lib/cms/reels-content";
import { getProductBySlug } from "@/storefront/lib/api/products";
import type { Product } from "@/storefront/types/catalog";
import { ReelsView, type ReelCard } from "@/storefront/components/storefront/reels-view";

export const metadata: Metadata = {
  title: "Nos vidéos — unboxings, tests & gaming en Tunisie",
  description:
    "Toutes les vidéos Tokyo Store : unboxings, tests produits, comparatifs et gaming (TikTok, Instagram, Facebook), avec les produits présentés disponibles en un clic.",
  alternates: { canonical: "/reels" },
  openGraph: { url: "/reels", type: "website" },
};

export default async function ReelsPage() {
  // Everything is backend-truth: the reels come from « Contenu & Design → Vidéos »
  // (reels.videos setting), and the shop's REAL account URLs from « Identité &
  // contact » (social.links). Both degrade to empty on any failure — never invented.
  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const socialUrls = firstUrlByPlatform(resolveSocialList(settings));
  // Resolve each reel's tagged products LIVE from the backend (catalogSource → Postgres),
  // not the retired bundled snapshot. A slug that no longer resolves is dropped.
  const videos: ReelCard[] = await Promise.all(
    resolveReelsVideos(settings).map(async (r) => {
      const resolved = await Promise.all(
        r.productSlugs.map((slug) => getProductBySlug(slug).catch(() => null)),
      );
      return {
        id: r.id,
        title: r.title,
        platform: r.platform,
        topic: r.topic,
        videoUrl: r.videoUrl,
        posterUrl: r.posterUrl,
        products: resolved
          .filter((p): p is Product => Boolean(p))
          .map((p) => ({ slug: p.slug, title: p.title, price: p.price, image: p.image })),
      };
    }),
  );
  return <ReelsView videos={videos} socialUrls={socialUrls} />;
}
