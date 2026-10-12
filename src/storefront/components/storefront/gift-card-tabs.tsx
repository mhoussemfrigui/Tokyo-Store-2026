"use client";

import {
  TabbedProducts,
  categoryTab as tab,
  type ProductTab,
} from "@/storefront/components/storefront/tabbed-products";

/**
 * Cartes cadeaux et recharges — dematerialised codes, grouped by the platform
 * people ask for them by. The in-game currencies share one tab: on their own
 * they are two to eight products each, which would make for a tab strip nobody
 * can read.
 */
const tabs: ProductTab[] = [
  tab("Tout", [
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
  ]),
  tab("iTunes", ["itunes"]),
  tab("PlayStation", ["playstation-network"]),
  tab("Xbox", ["xbox-cartes"]),
  tab("Nintendo", ["eshop-nintendo-switch"]),
  tab("Steam", ["steams-cards"]),
  tab("Jeux en ligne", [
    "roblox-cartes",
    "v-bucks-fortnite",
    "valorant",
    "league-of-legends-lol",
    "pubg",
    "free-fire",
  ]),
  tab("Streaming", ["netflix"]),
  tab("Autres", ["amazon-carte", "jeux-video-recharge", "paysafe-card"]),
];

export function GiftCardTabs() {
  return (
    <TabbedProducts
      /* "e-mail" never splits at its hyphen ("E-" / "MAIL"). Not U+2011:
         Figtree has no non-breaking hyphen, it would render from a fallback. */
      eyebrow={
        <>
          Cartes cadeaux · Codes envoyés par <span className="whitespace-nowrap">e-mail</span>
        </>
      }
      title="Cartes cadeaux & recharges"
      tabs={tabs}
      viewAllHref="/gift-cards"
    />
  );
}
