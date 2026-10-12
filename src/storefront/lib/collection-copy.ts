import type { CollectionSlug } from "@/lib/pages/collection-slugs";

/**
 * Editorial copy for the three "Vitrines" / showcase collection pages
 * (Nouveautés / Top ventes / Promotions), keyed by slug.
 *
 * This is the collection equivalent of `categorySeo.ts` (which is label-driven
 * and tuned for real catalogue categories). The copy is HONEST and backend-true:
 * it describes how each page actually works (real sales counts, real arrival
 * dates, real markdowns) and makes no claim the data can't back — e.g. it does
 * NOT promise a "trend vs last period" arrow (no backend source) and names no
 * specific boutique the store settings don't expose. The phone number for the
 * FAQ "une autre question ?" CTA is passed in from the backend contact config,
 * never hardcoded here.
 *
 * Imported BOTH server-side (the FAQ feeds the page's FAQPage JSON-LD) and
 * client-side (the collection view renders it), so this module stays free of
 * "use client"/"server-only" and of any runtime dependency.
 */

export type CollectionFaq = { q: string; a: string };

/** A sort option offered on a collection page. Keys map to sorters in the view. */
export type CollectionSortKey = "best" | "asc" | "desc" | "disc" | "save";
export type CollectionSortOption = { key: CollectionSortKey; label: string };

/** A discount bucket for the Promotions "Remise" filter (min off %, label). */
export type CollectionDiscountBucket = { min: number; label: string };

export type CollectionCopy = {
  /** The paragraph under the H1 (the admin `subtitle`/catDescription overrides it). */
  catDesc: string;
  /** The inline "how it works" link label that scrolls to the About section. */
  aboutLinkLabel: string;
  /** The About section heading + its (expandable) paragraphs. */
  aboutTitle: string;
  aboutParas: string[];
  /** The master-detail FAQ (also emitted as FAQPage JSON-LD on the page). */
  faqs: CollectionFaq[];
  /** The sort menu (first entry is the default = the as-received backend order). */
  sorts: CollectionSortOption[];
  /** Period selector (Top ventes / Nouveautés). Each: [button label, "du mois"-style word]. */
  periods?: { label: string; word: string }[];
  /** The day/age window (days) each period keeps — parallel to `periods`. */
  windows?: number[];
  /** Which period is selected on first render (index into `periods`). */
  defaultPeriod?: number;
  /** The "podium"/"tout juste arrivés" section heading + note. */
  podiumTitle?: string;
  podiumNote?: string;
  /** Promotions-only: the "Remise" radio buckets. */
  discountBuckets?: CollectionDiscountBucket[];
};

const COPY: Record<CollectionSlug, CollectionCopy> = {
  nouveautes: {
    catDesc:
      "Les derniers produits arrivés chez Tokyo Store : smartphones, audio, gaming et accessoires, du plus récent au plus ancien.",
    aboutLinkLabel: "Comment fonctionnent nos arrivages",
    aboutTitle: "Nos nouveautés, chaque semaine",
    aboutParas: [
      "Cette page regroupe les derniers produits arrivés chez Tokyo Store : smartphones, audio, gaming et accessoires, classés du plus récent au plus ancien.",
      "Les produits marqués « Bientôt » sont annoncés mais pas encore en stock : activez une alerte pour être prévenu dès leur arrivée.",
      "Comme le reste du catalogue, les nouveautés sont livrées en 24h à 72h partout en Tunisie, payables à la livraison et couvertes par la garantie constructeur.",
    ],
    faqs: [
      {
        q: "À quelle fréquence arrivent les nouveautés ?",
        a: "Nous recevons de nouveaux produits chaque semaine. Les lancements majeurs, comme les nouveaux Galaxy ou iPhone, sont disponibles dès leur sortie officielle en Tunisie.",
      },
      {
        q: "Puis-je précommander un produit à venir ?",
        a: "Les produits marqués « Bientôt » ne sont pas encore en stock. Activez « Me prévenir » pour recevoir un SMS ou un e-mail dès leur arrivée.",
      },
      {
        q: "Les nouveautés sont-elles disponibles en boutique ?",
        a: "Oui, en ligne et dans nos boutiques, dans la limite des stocks. Vous pouvez vérifier la disponibilité par téléphone.",
      },
      {
        q: "Les nouveautés bénéficient-elles de la garantie ?",
        a: "Oui : garantie constructeur de 12 mois sur tous les produits neufs, avec facture officielle, et Tokyo Care sur les produits éligibles.",
      },
    ],
    sorts: [
      { key: "best", label: "Plus récents" },
      { key: "asc", label: "Prix croissant" },
      { key: "desc", label: "Prix décroissant" },
    ],
    periods: [
      { label: "Cette semaine", word: "de la semaine" },
      { label: "Ce mois", word: "du mois" },
      { label: "3 derniers mois", word: "du trimestre" },
    ],
    windows: [7, 30, 90],
    defaultPeriod: 2,
    podiumTitle: "Tout juste arrivés",
    podiumNote: "Mis à jour chaque jour",
  },
  "top-ventes": {
    catDesc:
      "Les produits que nos clients achètent le plus, en ligne et en boutique. Classés selon les ventes réelles, sans placement sponsorisé.",
    aboutLinkLabel: "Comment est établi le classement",
    aboutTitle: "Comment est établi notre classement",
    aboutParas: [
      "Le Top ventes réunit les produits les plus achetés chez Tokyo Store, en ligne et en boutique. Le classement se base uniquement sur le nombre d'unités vendues sur la période choisie : cette semaine, ce mois ou cette année.",
      "Il est recalculé chaque jour, à partir des commandes réellement payées — aucune marque ne paie pour y figurer.",
      "Tous les produits du classement sont livrés en 24h à 72h partout en Tunisie, payables à la livraison et couverts par la garantie constructeur.",
    ],
    faqs: [
      {
        q: "Comment est calculé le classement ?",
        a: "Le classement est établi à partir du nombre d'unités vendues, en ligne et en boutique, sur la période choisie. Il est mis à jour chaque jour.",
      },
      {
        q: "Les produits sont-ils sponsorisés ?",
        a: "Non. Aucune marque ne paie pour apparaître dans le Top ventes : seules les ventes réelles comptent.",
      },
      {
        q: "Un best-seller est-il toujours en stock ?",
        a: "Les produits les plus vendus partent vite. Si un article est en rupture, activez « Me prévenir » pour être alerté dès son retour.",
      },
      {
        q: "Les best-sellers bénéficient-ils de Tokyo Care ?",
        a: "Oui, sur les produits éligibles. L'option est proposée sur la fiche produit et au panier.",
      },
    ],
    sorts: [
      { key: "best", label: "Meilleures ventes" },
      { key: "asc", label: "Prix croissant" },
      { key: "desc", label: "Prix décroissant" },
    ],
    periods: [
      { label: "Cette semaine", word: "de la semaine" },
      { label: "Ce mois", word: "du mois" },
      { label: "Cette année", word: "de l'année" },
    ],
    windows: [7, 30, 365],
    defaultPeriod: 1,
    podiumTitle: "Le podium",
    podiumNote: "Mis à jour chaque jour",
  },
  promotions: {
    catDesc:
      "Smartphones, audio, gaming et accessoires à prix réduits. Les mêmes garanties qu'au prix normal, livrés en 24h à 72h partout en Tunisie.",
    aboutLinkLabel: "Comment ça marche",
    aboutTitle: "Nos promotions, en toute transparence",
    aboutParas: [
      "Chaque semaine, Tokyo Store sélectionne des offres sur les smartphones, l'audio, le gaming et les accessoires. Toutes les réductions sont calculées sur notre prix de vente habituel, affiché barré à côté du prix promotionnel.",
      "Les produits reconditionnés en promotion sont testés par nos techniciens et garantis, comme le reste du catalogue.",
      "Les promotions ne sont pas cumulables entre elles, sauf mention contraire. Elles s'appliquent en ligne et en boutique, avec livraison en 24h à 72h partout en Tunisie et paiement à la livraison.",
    ],
    faqs: [
      {
        q: "Le prix barré correspond à quoi ?",
        a: "Le prix barré est le prix de vente pratiqué par Tokyo Store avant la promotion. La réduction affichée est calculée sur ce prix, conformément à la loi n° 98-40 du 2 juin 1998 relative aux techniques de vente et à la publicité commerciale.",
      },
      {
        q: "Les produits en promotion sont-ils garantis ?",
        a: "Oui, exactement comme au prix normal : garantie constructeur de 12 mois sur le neuf, garantie Tokyo Store sur le reconditionné, et Tokyo Care disponible sur les produits éligibles.",
      },
      {
        q: "Puis-je retourner un produit acheté en promotion ?",
        a: "Oui. Vous disposez de 10 jours ouvrables après réception pour vous rétracter, dans les mêmes conditions qu'un achat au prix normal.",
      },
      {
        q: "Les promotions sont-elles valables en boutique ?",
        a: "Oui. Les offres sont valables en ligne et en boutique, dans la limite des stocks disponibles.",
      },
    ],
    sorts: [
      { key: "disc", label: "Plus forte remise" },
      { key: "save", label: "Plus grosse économie" },
      { key: "asc", label: "Prix croissant" },
      { key: "desc", label: "Prix décroissant" },
    ],
    discountBuckets: [
      { min: 0, label: "Toutes les remises" },
      { min: 10, label: "−10 % et plus" },
      { min: 20, label: "−20 % et plus" },
      { min: 30, label: "−30 % et plus" },
    ],
  },
};

export function collectionCopy(slug: CollectionSlug): CollectionCopy {
  return COPY[slug];
}
