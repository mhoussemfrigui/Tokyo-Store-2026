import type { Metadata } from "next";

import { TrackOrderView } from "./track-order-view";

export const metadata: Metadata = {
  title: "Suivi de commande",
  description:
    "Suivez l'avancement de votre commande Tokyo Store avec votre numéro de commande et votre téléphone.",
  alternates: { canonical: "/suivi-de-commande" },
  robots: { index: false, follow: true },
};

export default function SuiviDeCommandePage() {
  return <TrackOrderView />;
}
