"use client";

import {
  TabbedProducts,
  categoryTab as tab,
  type ProductTab,
} from "@/storefront/components/storefront/tabbed-products";

/**
 * The Téléphonie universe, split the way the shop stocks it: the handsets
 * first, then the things people buy alongside them. Each tab maps to a real
 * catalogue category so none of them come up empty.
 */
const tabs: ProductTab[] = [
  tab("Tout", [
    "smartphones",
    "coques-et-etuis",
    "telephonie-protection",
    "chargeurs-adaptateurs",
    "telephonie-cables",
    "power-bank",
    "accessoires-telephonie-ecouteurs",
    "telephonie-haut-parleur",
  ]),
  tab("Smartphones", ["smartphones"]),
  tab("Coques & étuis", ["coques-et-etuis"]),
  tab("Protection", ["telephonie-protection"]),
  tab("Chargeurs", ["chargeurs-adaptateurs"]),
  tab("Câbles", ["telephonie-cables"]),
  tab("Power banks", ["power-bank"]),
  tab("Écouteurs", ["accessoires-telephonie-ecouteurs"]),
  tab("Enceintes", ["telephonie-haut-parleur"]),
];

export function TelephonieTabs() {
  return (
    <TabbedProducts
      eyebrow="Téléphonie · Samsung, Xiaomi, OPPO & accessoires"
      title="Tout pour votre téléphone"
      tabs={tabs}
      viewAllHref="/telephonie"
    />
  );
}
