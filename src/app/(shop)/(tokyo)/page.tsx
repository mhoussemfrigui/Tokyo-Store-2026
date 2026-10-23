import type { Metadata } from "next";

import { JsonLd } from "@/storefront/components/seo/json-ld";
import { listHomeHeroSlides } from "@/lib/api/cms";
import { CategoryTabs } from "@/storefront/components/storefront/category-tabs";
import { HeroCarousel, type Slide } from "@/storefront/components/storefront/hero-carousel";
import { HomeExtras } from "@/storefront/components/storefront/home-extras";
import { Newsletter } from "@/storefront/components/storefront/newsletter";
import { PromoGrid } from "@/storefront/components/storefront/promo-grid";
import { listEnabledPickups } from "@/modules/delivery/queries";
import { getHomeBlocks, hasStoredHomeBlocks, resolveHomeBlocks } from "@/lib/pages/home-blocks-data";
import { HomeBlocksRenderer } from "@/components/storefront/home/home-blocks-render";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/** The page's only h1 (the hero is baked-in artwork, so without this the heading outline
 *  started at h2 and the page never stated what it is). In the composed path the hero block
 *  prints its own h1; this is the sr-only fallback the renderer falls back to. */
const HOME_H1 = "Tokyo Store — iPhone, Mac & high-tech neufs et reconditionnés en Tunisie";

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
  // The home renders the OPERATOR'S block composition only once they SAVE a layout in
  // Contenu → Page d'accueil (a `home.blocks` settings row then exists). Until then —
  // and on a DB hiccup — it renders the fixed Tokyo sections below, byte-for-byte the
  // same as before the composer was wired: H-02 is ADDITIVE, never a redesign of the
  // default home. Branch on PRESENCE, not length: a deliberately-emptied layout ("[]")
  // is the operator's and still wins over the default sections (an empty home, not a
  // silent revert). Fail CLOSED to the default home so a settings read error never 500s.
  const configured = await hasStoredHomeBlocks().catch(() => false);
  // Resolve the saved layout up front. resolveHomeBlocks ALWAYS returns a (possibly
  // empty) object — `null` means it THREW (a transient catalogue/media query error).
  // A valid layout (incl. a deliberately-emptied `[]`) renders the composed home; a
  // resolve FAILURE degrades to the default sections below, never a blank homepage.
  const resolved = configured
    ? await getHomeBlocks().then(resolveHomeBlocks).catch(() => null)
    : null;

  if (configured && resolved) {
    return (
      <>
        <JsonLd data={GRAPH} />
        {/* The renderer prints the <h1> from a visible hero carousel block; with no hero
            (or no slides) it falls back to this sr-only heading, so the page always has
            exactly one h1 and never emits an empty body. */}
        <HomeBlocksRenderer resolved={resolved} fallbackHeading={HOME_H1} />
      </>
    );
  }

  // ── Default home — no composer layout saved, OR the saved layout failed to resolve.
  //    The fixed Tokyo sections (pixel-identical to before H-02). The hero is still
  //    DB-backed (CMS Bannières → home_hero). ──
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

  return (
    <>
      <JsonLd data={GRAPH} />
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
