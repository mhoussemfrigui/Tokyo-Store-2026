import "server-only";

import {
  listPreorderProducts,
  listProductsByCategory,
  listPromotions,
} from "@/storefront/lib/api/products";
import { NAV_ALIAS_LABELS } from "@/storefront/lib/nav-alias-labels";
import type { Product } from "@/storefront/types/catalog";

/**
 * Nav destinations that are NOT catalogue categories.
 *
 * The header + mobile dropdown link to "Bons plans", "Notre sélection", "Gift Cards"
 * and "Précommande", none of which is a category slug — so each is defined here as a
 * real product set the `[slug]` route renders through CategoryView (filters, grid, SEO),
 * exactly like a category. ("Nouveautés" is an admin-managed Vitrine, not here.)
 *
 * All selections are resolved LIVE from the backend (catalogSource → Postgres): promotions
 * + pre-orders from the live engines, curated universes from live category reads. No bundled
 * snapshot.
 */
export type NavAlias = {
  label: string;
  resolve: () => Promise<Product[]>;
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

/** Fetch each category LIVE, then round-robin across them (deduped) so the first
 *  screen shows the whole range rather than one category's depth. */
async function interleaveCategories(slugs: string[]): Promise<Product[]> {
  const lists = await Promise.all(slugs.map((s) => listProductsByCategory(s).catch(() => [] as Product[])));
  const out: Product[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of lists) {
      const p = l[i];
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }
  }
  return out;
}

export const NAV_ALIASES: Record<string, NavAlias> = {
  // Everything actually on promotion, best discounts first (the live auto-promo engine —
  // same pool + effective prices the /promotions vitrine + place-order use).
  "bons-plans": { label: NAV_ALIAS_LABELS["bons-plans"], resolve: () => listPromotions(60) },
  "notre-selection": {
    label: NAV_ALIAS_LABELS["notre-selection"],
    resolve: () => interleaveCategories(SELECTION_CATEGORIES),
  },
  "gift-cards": {
    label: NAV_ALIAS_LABELS["gift-cards"],
    resolve: () => interleaveCategories(GIFT_CARD_CATEGORIES),
  },
  // Products orderable ahead of stock (active pre-orders, soonest release first).
  precommande: { label: NAV_ALIAS_LABELS["precommande"], resolve: () => listPreorderProducts(60) },
};

export function getNavAlias(slug: string): NavAlias | undefined {
  return NAV_ALIASES[slug];
}
