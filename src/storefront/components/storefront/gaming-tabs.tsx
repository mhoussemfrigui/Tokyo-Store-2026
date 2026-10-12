"use client";

import {
  TabbedProducts,
  categoryTab as tab,
  type ProductTab,
} from "@/storefront/components/storefront/tabbed-products";

/**
 * The gaming universe, split the way people shop it: the machine first, then
 * the games for it. Every tab maps to a real catalogue category — Xbox has no
 * console shelf in this catalogue, so it appears under Jeux only.
 */
const VARIANTS = {
  consoles: {
    eyebrow: "Gaming · PlayStation, Nintendo & packs prêts à jouer",
    title: "Choisissez votre console",
    viewAllHref: "/console-gaming",
    tabs: [
      tab("Tout", [
        "consoles-playstation-5",
        "consoles-nintendo-switch",
        "consoles-nintendo-switch-2",
        "consoles-playstation-4",
        "consoles-portable",
        "consoles",
      ]),
      tab("PlayStation 5", ["consoles-playstation-5"]),
      tab("PlayStation 4", ["consoles-playstation-4"]),
      tab("Switch", ["consoles-nintendo-switch"]),
      tab("Switch 2", ["consoles-nintendo-switch-2"]),
      tab("Portables", ["consoles-portable", "consoles"]),
    ] as ProductTab[],
  },
  jeux: {
    eyebrow: "Gaming · PS5, PS4, Switch, Xbox & PC",
    title: "Les jeux du moment",
    viewAllHref: "/jeux-console",
    tabs: [
      tab("Tout", ["jeux-ps5", "jeux-switch", "jeux-pc", "jeux-ps4", "jeux-xbox", "jeux-console"]),
      tab("PS5", ["jeux-ps5"]),
      tab("PS4", ["jeux-ps4"]),
      tab("Switch", ["jeux-switch"]),
      tab("Xbox", ["jeux-xbox"]),
      tab("PC", ["jeux-pc"]),
    ] as ProductTab[],
  },
};

export function GamingTabs({ variant }: { variant: keyof typeof VARIANTS }) {
  const { tabs, eyebrow, title, viewAllHref } = VARIANTS[variant];
  return <TabbedProducts eyebrow={eyebrow} title={title} tabs={tabs} viewAllHref={viewAllHref} />;
}
