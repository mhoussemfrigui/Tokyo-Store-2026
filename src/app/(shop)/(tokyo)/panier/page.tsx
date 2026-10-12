import type { Metadata } from "next";

import { CartView } from "@/storefront/components/storefront/cart-view";

export const metadata: Metadata = {
  title: "Mon panier",
  description:
    "Vérifiez votre panier Tokyo Store : iPhone, smartphones, consoles et accessoires. Livraison 24h partout en Tunisie ou retrait gratuit dans nos 3 boutiques.",
  robots: { index: false, follow: true },
};

export default function CartPage() {
  return <CartView />;
}
