import { products } from "@/storefront/lib/catalog";
import { productStrike } from "@/storefront/lib/productMeta";
import type { Product } from "@/storefront/types/catalog";

/**
 * Nav destinations that are NOT catalogue categories.
 *
 * The header and the mobile dropdown link to "Bons plans", "Notre sélection",
 * "Gift Cards" and "Précommande", none of which exist as a category slug — so
 * every one of them 404ed. Each is defined here as a real product set so the
 * `[slug]` route can render them through CategoryView, with its filters, grid
 * and SEO, exactly like a category. ("Nouveautés" is no longer here — it is an
 * admin-managed Vitrine collection resolved from `getCollectionPageConfig`.)
 *
 * These selections are derived from the static catalogue. When the backend
 * lands it will own "on sale" / "new in" / curated lists, and this table is
 * the single place to repoint.
 */
export type NavAlias = {
  label: string;
  resolve: () => Product[];
};

const GIFT_CARD_CATEGORIES = [
  "itunes",
  "playstation-network",
  "xbox-cartes",
  "eshop-nintendo-switch",
  "steams-cards",
  "roblox-cartes",
  "v-bucks-fortnite",
  "valorant",
  "league-of-legends-lol",
  "pubg",
  "free-fire",
  "netflix",
  "amazon-carte",
  "jeux-video-recharge",
  "paysafe-card",
];

/** One flagship shelf per universe, interleaved so no single one dominates. */
const SELECTION_CATEGORIES = [
  "iphones-neufs",
  "mac",
  "consoles-playstation-5",
  "ecouteurs",
  "montres-connectees",
  "tablettes",
  "smartphones",
  "casques",
];

function inCategories(slugs: string[]): Product[] {
  return products.filter((p) => slugs.includes(p.category));
}

/** Round-robin across the categories so the first screen shows the range. */
function interleaveByCategory(pool: Product[]): Product[] {
  const groups = new Map<string, Product[]>();
  for (const p of pool) {
    const g = groups.get(p.category);
    if (g) g.push(p);
    else groups.set(p.category, [p]);
  }
  const lists = [...groups.values()];
  const out: Product[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

export const NAV_ALIASES: Record<string, NavAlias> = {
  "bons-plans": {
    label: "Bons plans",
    /* Everything actually carrying a reduction, deepest first — which is what
       the promo bar's "jusqu'à -30%" is promising. */
    resolve: () =>
      products
        .map((p) => ({ p, pct: productStrike(p)?.pct ?? 0 }))
        .filter((x) => x.pct >= 10)
        .sort((a, b) => b.pct - a.pct)
        .map((x) => x.p),
  },
  "notre-selection": {
    label: "Notre sélection",
    resolve: () => interleaveByCategory(inCategories(SELECTION_CATEGORIES)),
  },
  "gift-cards": {
    label: "Gift Cards",
    resolve: () => interleaveByCategory(inCategories(GIFT_CARD_CATEGORIES)),
  },
  /* Products the shop already takes orders for, ahead of stock (the header's
     "Précommande" link in Univers Tokyo). */
  precommande: {
    label: "Précommande",
    resolve: () => products.filter((p) => p.availability === "backorder"),
  },
};

export function getNavAlias(slug: string): NavAlias | undefined {
  return NAV_ALIASES[slug];
}
