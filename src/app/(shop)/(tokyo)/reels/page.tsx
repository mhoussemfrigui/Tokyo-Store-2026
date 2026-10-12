import type { Metadata } from "next";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { firstUrlByPlatform, resolveSocialList } from "@/lib/cms/social-list";
import { ReelsView } from "@/storefront/components/storefront/reels-view";

export const metadata: Metadata = {
  title: "Nos vidéos — unboxings, tests & gaming en Tunisie",
  description:
    "Toutes les vidéos Tokyo Store : unboxings, tests produits, comparatifs et gaming (TikTok, Instagram, Facebook), avec les produits présentés disponibles en un clic.",
  alternates: { canonical: "/reels" },
  openGraph: { url: "/reels", type: "website" },
};

export default async function ReelsPage() {
  // Real store accounts for the reels "Suivre" / "Voir sur …" links — the first
  // configured link per platform from « Identité & contact » (social.links).
  // Degrades to {} on any failure → those links fall back to "#" (never invented).
  const socialUrls = await getSettingsMap()
    .then((s) => firstUrlByPlatform(resolveSocialList(s)))
    .catch(() => ({}));
  return <ReelsView socialUrls={socialUrls} />;
}
