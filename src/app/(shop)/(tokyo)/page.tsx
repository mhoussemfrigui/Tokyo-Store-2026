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

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { url: "/" },
};

/** Map the backend hero slides (CMS → Page d'accueil, médiathèque-backed) to the
 *  carousel's slide shape. A slide with no resolved desktop image is skipped. The
 *  full-image link target is the first CTA's href (the baked-in-artwork model);
 *  `showText` slides render the eyebrow/title/subtitle/buttons overlay instead. */
async function getHeroSlides(): Promise<Slide[]> {
  const slides = await listHomeHeroSlides().catch(() => []);
  return slides.flatMap((s): Slide[] => {
    if (!s.image) return []; // no resolved desktop image → skip the slide
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

export default async function HomePage() {
  const [heroSlides, pickups] = await Promise.all([
    getHeroSlides(),
    listEnabledPickups("in_store"),
  ]);
  // « Nos boutiques » cards from the REAL in-store pickup locations (delivery module,
  // admin-editable) — never hardcoded in the component.
  const stores = pickups.map((p) => ({
    city: p.name,
    address: p.address_line ?? [p.city, p.region].filter(Boolean).join(", "),
    hours: p.hours_label ?? "",
    phone: p.phone ?? "",
  }));
  const graph = [
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

  return (
    <>
      <JsonLd data={graph} />
      {/* The page's only h1. The hero is baked-in artwork, so without this the
          heading outline started at h2 and the page never stated what it is. */}
      <h1 className="sr-only">
        Tokyo Store — iPhone, Mac &amp; high-tech neufs et reconditionnés en Tunisie
      </h1>
      <HeroCarousel slides={heroSlides} />
      <CategoryTabs />
      <HomeExtras />
      <PromoGrid stores={stores} />
      <Newsletter />
    </>
  );
}
