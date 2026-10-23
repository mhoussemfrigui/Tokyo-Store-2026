import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asBool, asEnum, asStr } from "@/lib/cms/setting-coerce";
import {
  COLLECTION_SLUGS,
  isCollectionSlug,
  type CollectionSlug,
} from "@/lib/pages/collection-slugs";

// Re-exported from the isomorphic single source so existing server-side imports
// from this module keep working (the slug list itself now lives in
// `collection-slugs.ts` so client/reserved-route consumers can share it).
export { COLLECTION_SLUGS, isCollectionSlug, type CollectionSlug };

/**
 * Typed, admin-controllable config for the "showcase" collection pages.
 * Modeled on `src/lib/checkout/quick-buy-config.ts`: read namespaced
 * `pages.<slug>.*` keys from `site_settings`, fall back to defaults that
 * REPRODUCE the previous hardcoded behaviour, return a plain object.
 *
 * The selection STRATEGY is intrinsic to each page (Nouveautés is always "new
 * arrivals") so it's derived from the slug, not editable. Admins tune the
 * presentation, limit, window, promo strategy, SEO and visibility. There is no
 * design-variant switch: the storefront always renders the one showcase
 * layout, so the former `pages.<slug>.design_variant` key is no longer read.
 */

export type CollectionStrategy = "new_arrivals" | "best_sellers" | "on_promotion" | "preorder";
export type PromoStrategy = "engine" | "compare_at" | "both";

/**
 * The top navigation bar on a showcase page (where a real category page shows its
 * sub-category/category drill chips). A showcase has no sub-categories, so the
 * operator chooses what that bar does:
 *   - `hidden`     — no bar at all.
 *   - `categories` — a jump strip of the site's MAIN (root) categories.
 *   - `retour`     — just a refined, standalone "← Retour" control (default).
 */
export type ShowcaseNavBar = "hidden" | "categories" | "retour";
export const SHOWCASE_NAV_BARS: readonly ShowcaseNavBar[] = ["hidden", "categories", "retour"];

export const STRATEGY_BY_SLUG: Record<CollectionSlug, CollectionStrategy> = {
  nouveautes: "new_arrivals",
  "top-ventes": "best_sellers",
  promotions: "on_promotion",
  precommandes: "preorder",
};

/** The empty-state card shown when the collection currently has no products. */
export type CollectionEmptyCopy = { title: string; body: string };

/** The closing call-to-action band at the bottom of each showcase. */
export type CollectionCtaBandCopy = {
  eyebrow: string;
  title: string;
  subtitle: string;
  ctaLabel: string;
  ctaHref: string;
};

export type CollectionPageConfig = {
  slug: CollectionSlug;
  visible: boolean;
  eyebrow: string;
  title: string;
  subtitle: string;
  ctaLabel: string;
  ctaHref: string;
  heroMediaId: string | null;
  strategy: CollectionStrategy;
  limit: number;
  windowDays: number;
  promoStrategy: PromoStrategy;
  /** Seed the listing's initial sort (a SORT_OPTIONS value; "" → the default "featured"). */
  defaultSort: string;
  /** The top nav bar behaviour (hidden / main categories / standalone Retour). */
  navBar: ShowcaseNavBar;
  /** Show the closing CTA band at the foot of the page (opt-in; copy below). */
  showClosingCta: boolean;
  seo: { metaTitle: string; metaDescription: string; noindex: boolean };
  /** Editable copy for the empty-state card (rendered when the page has no products). */
  empty: CollectionEmptyCopy;
  /** Editable copy for the closing CTA band (rendered when showClosingCta is on). */
  ctaBand: CollectionCtaBandCopy;
};

/**
 * Per-page literal defaults. `title`/`metaTitle`/`metaDescription` + the empty-state
 * and CTA-band copy default to the CURRENT hardcoded strings so an un-configured store
 * renders the right identity. (The decorative `eyebrow`/`subtitle` have no default — an
 * unset value renders nothing, PageHero hides them — so they're not kept here.)
 */
const DEFAULTS: Record<
  CollectionSlug,
  {
    title: string;
    metaTitle: string;
    metaDescription: string;
    empty: CollectionEmptyCopy;
    ctaBand: CollectionCtaBandCopy;
  }
> = {
  nouveautes: {
    title: "Nouveautés",
    metaTitle: "Nouveautés — Tokyo Store",
    metaDescription: "Découvrez les derniers produits high-tech arrivés chez Tokyo Store : smartphones, audio, gaming et accessoires.",
    empty: {
      title: "Les prochaines nouveautés arrivent bientôt.",
      body: "Nos derniers produits sont en route. Repassez très vite pour découvrir les nouveautés fraîchement arrivées chez Tokyo Store.",
    },
    ctaBand: {
      eyebrow: "Ne manquez aucune nouveauté",
      title: "Toujours une longueur d'avance.",
      subtitle: "Explorez tout le catalogue Tokyo Store — les nouveautés arrivent en premier ici.",
      ctaLabel: "Explorer la boutique",
      ctaHref: "/",
    },
  },
  "top-ventes": {
    title: "Top ventes",
    metaTitle: "Top ventes — Tokyo Store",
    metaDescription: "Le classement des meilleures ventes Tokyo Store, par popularité.",
    empty: {
      title: "Bientôt le classement",
      body: "Les premières ventes démarrent tout juste. Revenez vite pour découvrir les produits les plus plébiscités chez Tokyo Store.",
    },
    ctaBand: {
      eyebrow: "Trouvez votre prochain produit high-tech",
      title: "Rejoignez les best-sellers.",
      subtitle: "Parcourez tout le catalogue Tokyo Store et découvrez les produits les plus plébiscités.",
      ctaLabel: "Voir le catalogue",
      ctaHref: "/",
    },
  },
  promotions: {
    title: "Promotions",
    metaTitle: "Promotions — Tokyo Store",
    metaDescription: "Toutes les promotions et bons plans en cours chez Tokyo Store.",
    empty: {
      title: "Aucune promotion en cours pour le moment.",
      body: "Revenez vite : les meilleurs bons plans Tokyo Store arrivent régulièrement. En attendant, explorez tout le catalogue.",
    },
    ctaBand: {
      eyebrow: "Encore plus de choix",
      title: "Pas trouvé votre bonheur ?",
      subtitle: "Parcourez tout le catalogue Tokyo Store — nouvelles offres ajoutées chaque semaine.",
      ctaLabel: "Voir le catalogue",
      ctaHref: "/",
    },
  },
  precommandes: {
    title: "Précommandes",
    metaTitle: "Précommandes — Tokyo Store",
    metaDescription: "Réservez en avant-première les prochaines sorties high-tech chez Tokyo Store : smartphones, consoles, audio et plus encore.",
    empty: {
      title: "Aucune précommande ouverte pour le moment.",
      body: "Les prochaines sorties arrivent bientôt. Revenez vite pour réserver en avant-première les nouveautés high-tech de Tokyo Store.",
    },
    ctaBand: {
      eyebrow: "Soyez les premiers servis",
      title: "Réservez avant tout le monde.",
      subtitle: "Explorez tout le catalogue Tokyo Store — les précommandes vous garantissent la prochaine sortie dès son arrivée.",
      ctaLabel: "Explorer la boutique",
      ctaHref: "/",
    },
  },
};

const asNum = (v: string | null | undefined, fb: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fb;
  return Math.min(Math.floor(n), max);
};

export async function getCollectionPageConfig(slug: CollectionSlug): Promise<CollectionPageConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // settings table unavailable — defaults below keep the page working
  }
  const d = DEFAULTS[slug];
  const k = (field: string) => s[`pages.${slug}.${field}`];

  // Default "both" = live promotion engine UNION the legacy compare-at filter,
  // so the page surfaces every discounted product (engine-driven AND manually
  // marked-down) — a superset of the previous compare-at-only behaviour.
  const promo = asStr(k("promo_strategy"), "both");

  return {
    slug,
    visible: asBool(k("visible"), true),
    // Decorative kicker + subtitle have NO default — an unset value renders
    // nothing (PageHero hides empty eyebrow/subtitle). `title` keeps a default:
    // it's the H1 / identity of a built-in system page, which must always exist.
    eyebrow: asStr(k("eyebrow"), ""),
    title: asStr(k("title"), d.title),
    subtitle: asStr(k("subtitle"), ""),
    ctaLabel: asStr(k("cta_label"), ""),
    ctaHref: asStr(k("cta_href"), ""),
    heroMediaId: k("hero_media_id")?.trim() || null,
    strategy: STRATEGY_BY_SLUG[slug],
    limit: asNum(k("limit"), 24, 100),
    windowDays: asNum(k("window_days"), 90, 365),
    promoStrategy:
      promo === "engine" || promo === "compare_at" || promo === "both" ? promo : "both",
    // Listing presentation + the opt-in closing CTA band (edited in the Catalogues panel).
    defaultSort: asStr(k("default_sort"), ""),
    navBar: asEnum(k("nav_bar"), SHOWCASE_NAV_BARS, "retour"),
    showClosingCta: asBool(k("show_closing_cta"), false),
    seo: {
      metaTitle: asStr(k("meta_title"), d.metaTitle),
      metaDescription: asStr(k("meta_description"), d.metaDescription),
      noindex: asBool(k("noindex"), false),
    },
    // Empty-state + CTA-band copy: each field defaults to the current hardcoded literal,
    // so an un-configured store renders the right page-specific copy. Both groups ARE
    // editable in the Catalogues panel and rendered on the storefront (the empty state
    // always, the CTA band when `showClosingCta` is on). The former `grid_*` section-header
    // keys were dropped — the P4 listing has no separate "rest of the collection" section.
    empty: {
      title: asStr(k("empty_title"), d.empty.title),
      body: asStr(k("empty_body"), d.empty.body),
    },
    ctaBand: {
      eyebrow: asStr(k("cta_band_eyebrow"), d.ctaBand.eyebrow),
      title: asStr(k("cta_band_title"), d.ctaBand.title),
      subtitle: asStr(k("cta_band_subtitle"), d.ctaBand.subtitle),
      ctaLabel: asStr(k("cta_band_label"), d.ctaBand.ctaLabel),
      ctaHref: asStr(k("cta_band_href"), d.ctaBand.ctaHref),
    },
  };
}
