import type { Metadata } from "next";

import { JsonLd } from "@/storefront/components/seo/json-ld";
import { listHomeHeroSlides } from "@/lib/api/cms";
import { CategoryTabs } from "@/storefront/components/storefront/category-tabs";
import { HeroCarousel, type Slide } from "@/storefront/components/storefront/hero-carousel";
import { HomeExtras } from "@/storefront/components/storefront/home-extras";
import { Newsletter } from "@/storefront/components/storefront/newsletter";
import { PromoGrid } from "@/storefront/components/storefront/promo-grid";
import { listEnabledPickups } from "@/modules/delivery/queries";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/** The page's only h1 (the hero is baked-in artwork, so without this the heading outline
 *  starts at h2 and the page never states what it is). */
const HOME_H1 = "Tokyo Store — iPhone, Mac & high-tech neufs et reconditionnés en Tunisie";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { url: "/" },
};

// The home reads LIVE backend data (CMS hero + real in-store pickups + live catalogue
// strips), so it must render per request — never be frozen into a build-time static export.
export const dynamic = "force-dynamic";

/** Map the backend hero slides (CMS → Bannières, placement home_hero, médiathèque-backed)
 *  to the carousel's slide shape. A slide with no resolved desktop image is skipped. */
async function getHeroSlides(): Promise<Slide[]> {
  const slides = await listHomeHeroSlides().catch(() => []);
  return slides.flatMap((s): Slide[] => {
    if (!s.image) return [];
    return [
      {
        id: s.id,
        image: s.image,
        imageMobile: s.imageMobile,
        alt: s.imageAlt || s.title || "",
        href: s.buttons[0]?.href ?? "#",
        showText: s.showText,
        eyebrow: s.eyebrow,
        title: s.title,
        subtitle: s.subtitle,
        buttons: s.buttons,
      },
    ];
  });
}

const GRAPH = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Tokyo Store",
    url: SITE_URL,
    slogan: "iPhone, Mac & High-Tech en Tunisie",
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Tokyo Store",
    url: SITE_URL,
  },
];

export default async function HomePage() {
  // The Tokyo home is a FIXED bespoke layout (the operator's real design) — there is no
  // block-composer alternative. The hero is DB-backed (CMS Bannières → home_hero) and the
  // « Nos boutiques » cards come from the REAL in-store pickup locations (delivery module).
  // Fail CLOSED: a transient delivery/CMS read degrades a section to empty, never a 500.
  const [heroSlides, pickups] = await Promise.all([
    getHeroSlides(),
    listEnabledPickups("in_store").catch(() => []),
  ]);
  const stores = pickups.map((p) => ({
    city: p.name,
    address: p.address_line ?? [p.city, p.region].filter(Boolean).join(", "),
    hours: p.hours_label ?? "",
    phone: p.phone ?? "",
  }));

  return (
    <>
      <JsonLd data={GRAPH} />
      <h1 className="sr-only">{HOME_H1}</h1>
      <HeroCarousel slides={heroSlides} />
      <CategoryTabs />
      <HomeExtras />
      <PromoGrid stores={stores} />
      <Newsletter />
    </>
  );
}
