import { NAV_ALIASES } from "@/storefront/lib/navAliases";

export type Faq = { q: string; a: string };
export type Intro = { lead: string; paragraphs: string[] };

/* French spacing is non-breaking so a mark never wraps onto a line of its
   own: U+202F (narrow no-break space) before "?", U+00A0 before ":" and
   inside « ». */

/* "e-mail" with a word joiner (U+2060) after the hyphen, so it never splits
   into "e-" / "mail" at a line end. Not U+2011: Figtree has no non-breaking
   hyphen, it would render from a fallback font. */
const EMAIL = "e-\u2060mail";

/* ---------- Shared FAQ entries ---------- */

/* Real categories name themselves in two questions ("un produit iPhones
   Neufs"). A nav alias is not a kind of product ("un produit Bons plans"),
   so it gets the label-free wording. */
function faqDelivery(label?: string): Faq {
  return {
    q: label
      ? `Quels sont les délais de livraison pour un produit ${label}\u202f?`
      : "Quels sont les délais de livraison\u202f?",
    a: "Les commandes validées avant 15h sont expédiées le jour même et livrées sous 24 à 48h partout en Tunisie. Vous pouvez aussi retirer gratuitement votre commande dans l'une de nos 3 boutiques (Lac 2, La Marsa, Menzah 5).",
  };
}

function faqRepair(label?: string): Faq {
  return {
    q: label
      ? `Puis-je faire réparer mon produit ${label} chez Tokyo Store\u202f?`
      : "Puis-je faire réparer mon appareil chez Tokyo Store\u202f?",
    a: "Notre atelier Tokyo Repair prend en charge smartphones, tablettes, ordinateurs, consoles et objets connectés\u00a0: diagnostic gratuit, pièces de qualité et réparation souvent le jour même.",
  };
}

const FAQ_WARRANTY: Faq = {
  q: "Quelle garantie est appliquée sur les produits Tokyo Store\u202f?",
  a: "Les produits neufs bénéficient de la garantie constructeur et les produits reconditionnés d'une garantie Tokyo Store allant jusqu'à 24 mois, couvrant les pannes matérielles hors casse et oxydation.",
};

const FAQ_REFURB: Faq = {
  q: "Que signifie «\u00a0reconditionné certifié\u00a0» chez Tokyo Store\u202f?",
  a: "Chaque appareil est diagnostiqué, nettoyé et testé (batterie, écran, caméras, réseau, boutons). Il est ensuite classé selon son état esthétique et vendu avec garantie, câble de charge et facture.",
};

const FAQ_COD: Faq = {
  q: "Puis-je payer à la livraison\u202f?",
  a: "Oui, le paiement à la livraison est disponible partout en Tunisie. Vous pouvez également régler par carte bancaire ou directement en boutique.",
};

const FAQ_TRADE_IN: Faq = {
  q: "Proposez-vous la reprise de mon ancien appareil\u202f?",
  a: "Oui. Tokyo Store reprend votre ancien téléphone, tablette ou console et déduit immédiatement sa valeur de votre nouvel achat après une estimation gratuite en boutique.",
};

/* ---------- Nav alias listings ---------- */

type ListingCopy = {
  /** Page <title> (before the " — Tokyo Store" template) and meta description. */
  title: string;
  description: string;
  /** The line under the h1. */
  blurb: string;
  intro: Intro;
  faq: Faq[];
};

/**
 * Copy for the nav aliases (src/lib/navAliases.ts), keyed by their slug. An
 * alias is a curated product set, not a category, so the category templates
 * read wrong on it: "Précommande testés et garantis, livrés en 24h" over
 * products that ship when their stock lands, "livrés en 24h" over gift-card
 * codes sent by e-mail, "Nouveautés testés" (the agreement). Each writes its
 * own, and keeps only the shared FAQ entries that are true for it.
 */
const ALIAS_COPY: Record<string, ListingCopy> = {
  precommande: {
    title: "Précommande en Tunisie — Réservez les nouveautés",
    description:
      "Précommandez chez Tokyo Store les nouveautés high-tech avant leur arrivée en Tunisie\u00a0: livraison sous 24 à 48h ou retrait gratuit en boutique dès réception du stock.",
    blurb:
      "Réservez les nouveautés avant leur arrivée en Tunisie, livrées ou à retirer en boutique dès réception du stock.",
    intro: {
      lead: "Précommandez chez Tokyo Store les appareils les plus attendus avant leur arrivée en Tunisie\u00a0: votre commande est enregistrée dès aujourd'hui, puis livrée partout en Tunisie ou mise de côté dans l'une de nos 3 boutiques (Lac 2 · La Marsa · Menzah 5) dès réception du stock.",
      paragraphs: [
        "Chaque produit en précommande est vendu avec sa facture et sa garantie, comme le reste du catalogue. Nos conseillers vous indiquent la date d'arrivée prévue et vous accompagnent avant et après l'achat au 50 059 160.",
        "Utilisez les filtres (marque, prix, état) pour trouver le modèle que vous attendez\u00a0: il se précommande depuis la liste ou depuis sa fiche, comme n'importe quel autre produit.",
      ],
    },
    faq: [
      {
        q: "Comment fonctionne la précommande\u202f?",
        a: "Vous commandez dès maintenant un produit dont le stock n'est pas encore arrivé en Tunisie. Votre commande est enregistrée, puis expédiée ou mise de côté dans la boutique de votre choix dès réception du stock.",
      },
      {
        q: "Quand vais-je recevoir un produit en précommande\u202f?",
        a: "Dès que le stock arrive chez Tokyo Store\u00a0: votre commande est alors livrée sous 24 à 48h partout en Tunisie, ou disponible au retrait gratuit dans l'une de nos 3 boutiques (Lac 2, La Marsa, Menzah 5). Nos conseillers vous donnent la date d'arrivée prévue au 50 059 160.",
      },
      FAQ_WARRANTY,
      FAQ_TRADE_IN,
    ],
  },

  "gift-cards": {
    title: "Gift Cards en Tunisie — Codes envoyés par e-mail",
    description:
      "Cartes PlayStation, Xbox, Nintendo eShop, Steam, iTunes, Netflix, Roblox, V-Bucks et plus chez Tokyo Store. Prix affichés en TND, codes envoyés par e-mail.",
    blurb: `Cartes cadeaux et recharges de jeux, codes envoyés par ${EMAIL} et utilisables dès réception.`,
    intro: {
      lead: "Achetez vos cartes cadeaux et recharges en Tunisie chez Tokyo Store\u00a0: PlayStation Network, Xbox, Nintendo eShop, Steam, iTunes, Netflix, Amazon, Paysafecard et les monnaies de jeu (Roblox, V-Bucks Fortnite, Valorant, League of Legends, PUBG, Free Fire), prix affichés en TND.",
      paragraphs: [
        `Le code de votre carte vous est envoyé par ${EMAIL}\u00a0: il s'utilise dès réception sur la plateforme concernée (PlayStation Store, Xbox, Nintendo eShop, Steam…), sans attendre de livraison.`,
        "Les cartes cadeaux sont des produits dématérialisés\u00a0: elles ne sont ni garanties ni remboursables une fois le code communiqué. Vérifiez la région de votre compte avant l'achat et, en cas de doute, appelez nos conseillers au 50 059 160.",
      ],
    },
    faq: [
      {
        q: "Comment vais-je recevoir ma carte cadeau\u202f?",
        a: `Le code est envoyé par ${EMAIL} et s'utilise dès réception sur la plateforme concernée (PlayStation Store, Xbox, Nintendo eShop, Steam…). Aucune livraison n'est nécessaire.`,
      },
      {
        q: "Quelles cartes cadeaux proposez-vous\u202f?",
        a: "PlayStation Network, Xbox, Nintendo eShop, Steam, iTunes, Netflix, Amazon et Paysafecard, ainsi que les monnaies de jeu Roblox, V-Bucks Fortnite, Valorant, League of Legends, PUBG et Free Fire.",
      },
      {
        q: "Ma carte fonctionnera-t-elle sur mon compte\u202f?",
        a: "Certaines cartes sont liées à une région (PlayStation, Xbox, Nintendo eShop, iTunes). Vérifiez la région de votre compte avant l'achat, ou demandez conseil à nos conseillers au 50 059 160.",
      },
      {
        q: "Une carte cadeau est-elle remboursable\u202f?",
        a: "Non. Il s'agit d'un produit dématérialisé\u00a0: il n'est ni garanti ni remboursable une fois le code communiqué.",
      },
    ],
  },

  "bons-plans": {
    title: "Bons plans high-tech en Tunisie — Prix réduits & Livraison 24h",
    description:
      "Toutes les remises Tokyo Store du moment, de la plus forte à la plus petite. Livraison 24h, garantie jusqu'à 24 mois, 3 boutiques\u00a0: Lac 2, La Marsa, Menzah 5.",
    blurb: "Toutes nos remises du moment, classées de la plus forte à la plus petite.",
    intro: {
      lead: "Retrouvez chez Tokyo Store tous nos produits high-tech à prix réduit en Tunisie\u00a0: chaque remise est calculée sur le prix barré affiché, en TND, et la liste est classée de la plus forte à la plus petite.",
      paragraphs: [
        "Un prix réduit ne change rien au reste\u00a0: livraison 24h partout en Tunisie, retrait gratuit dans nos 3 boutiques (Lac 2 · La Marsa · Menzah 5), paiement à la livraison et garantie jusqu'à 24 mois selon le produit.",
        "Utilisez les filtres (marque, prix, état, disponibilité) pour trouver la bonne affaire. Nos conseillers vous aident à choisir au 50 059 160.",
      ],
    },
    faq: [
      {
        q: "Les produits en bons plans sont-ils garantis\u202f?",
        a: "Oui. Une remise ne change rien à la garantie\u00a0: garantie constructeur pour les produits neufs, garantie Tokyo Store allant jusqu'à 24 mois pour les reconditionnés.",
      },
      faqDelivery(),
      FAQ_REFURB,
      FAQ_COD,
      FAQ_TRADE_IN,
    ],
  },

  nouveautes: {
    title: "Nouveautés high-tech en Tunisie — Prix & Livraison 24h",
    description:
      "Les derniers iPhone, smartphones, Mac, tablettes, consoles et jeux arrivés chez Tokyo Store. Livraison 24h, garantie jusqu'à 24 mois, 3 boutiques\u00a0: Lac 2, La Marsa, Menzah 5.",
    blurb: "Les derniers iPhone, smartphones, Mac, tablettes, consoles et jeux arrivés chez Tokyo Store.",
    intro: {
      lead: "Découvrez les dernières arrivées chez Tokyo Store\u00a0: iPhone, smartphones, Mac, tablettes, Nintendo Switch 2 et les nouveaux jeux PS5 et Switch, au meilleur prix en Tunisie, livrés en 24h ou à retirer gratuitement dans nos 3 boutiques (Lac 2 · La Marsa · Menzah 5).",
      paragraphs: [
        "Chaque nouveauté est vendue avec sa facture et sa garantie, et nos conseillers vous accompagnent avant et après l'achat au 50 059 160.",
        "Un modèle attendu n'est pas encore arrivé\u202f? Retrouvez-le dans nos précommandes. Utilisez les filtres (marque, prix, état, disponibilité) pour affiner la sélection.",
      ],
    },
    faq: [faqDelivery(), FAQ_WARRANTY, FAQ_COD, FAQ_TRADE_IN, faqRepair()],
  },

  "notre-selection": {
    title: "Notre sélection high-tech en Tunisie — Prix & Livraison 24h",
    description:
      "Les incontournables de nos rayons phares\u00a0: iPhone, Mac, PlayStation 5, écouteurs, montres connectées, tablettes, smartphones et casques. Livraison 24h, garantie jusqu'à 24 mois, 3 boutiques.",
    blurb: "Les incontournables de nos rayons phares\u00a0: iPhone, Mac, PlayStation 5, audio, montres et tablettes.",
    intro: {
      lead: "Notre sélection réunit les incontournables de nos rayons phares\u00a0: iPhone, Mac, PlayStation 5, écouteurs, montres connectées, tablettes, smartphones et casques, au meilleur prix en Tunisie, livrés en 24h ou à retirer gratuitement dans nos 3 boutiques (Lac 2 · La Marsa · Menzah 5).",
      paragraphs: [
        "Produits neufs sous garantie constructeur ou reconditionnés certifiés et garantis par Tokyo Store\u00a0: nos conseillers vous aident à choisir, avant et après l'achat, au 50 059 160.",
        "Utilisez les filtres (marque, prix, état, disponibilité) pour affiner la sélection.",
      ],
    },
    faq: [faqDelivery(), FAQ_WARRANTY, FAQ_REFURB, FAQ_COD, FAQ_TRADE_IN, faqRepair()],
  },
};

/* The listing components pass these helpers the display label, and for an
   alias that is its own label (aliases resolve before categories in the
   [slug] route), so the label identifies the alias. */
function aliasCopy(label: string): ListingCopy | undefined {
  const slug = Object.keys(NAV_ALIASES).find((s) => NAV_ALIASES[s].label === label);
  return slug ? ALIAS_COPY[slug] : undefined;
}

/* ---------- Public helpers (category template, alias copy first) ---------- */

/** Page <title> (before the site template) and meta description. */
export function getCategoryMeta(label: string): { title: string; description: string } {
  const alias = aliasCopy(label);
  if (alias) return { title: alias.title, description: alias.description };
  return {
    title: `${label} en Tunisie — Prix & Livraison 24h`,
    description: `${label} neufs et reconditionnés certifiés au meilleur prix en Tunisie. Livraison 24h, garantie jusqu'à 24 mois, 3 boutiques\u00a0: Lac 2, La Marsa, Menzah 5.`,
  };
}

/**
 * One line for the category header bloc. Deliberately shorter than — and
 * different from — the SEO lead further down the same page, which it sits
 * above. It does not repeat the label (the h1 right above names it): "{label}
 * testés et garantis" failed agreement on most labels ("Console Gaming
 * testés", "Enceintes testés").
 */
export function getCategoryBlurb(label: string) {
  return (
    aliasCopy(label)?.blurb ??
    "Produits testés et garantis, livrés en 24h partout en Tunisie ou à retirer dans nos 3 boutiques."
  );
}

export function getCategoryIntro(label: string): Intro {
  const alias = aliasCopy(label);
  if (alias) return alias.intro;
  return {
    lead: `Achetez vos produits ${label} au meilleur prix en Tunisie chez Tokyo Store\u00a0: produits neufs et reconditionnés certifiés, prix affichés en TND, livraison 24h partout en Tunisie et retrait gratuit dans nos 3 boutiques (Lac 2 · La Marsa · Menzah 5).`,
    paragraphs: [
      `Notre équipe sélectionne chaque référence ${label} pour vous garantir un rapport qualité/prix réel\u00a0: appareils testés point par point, accessoires d'origine ou compatibles de qualité, et un accompagnement avant et après l'achat par des conseillers disponibles au 50 059 160.`,
      `Utilisez les filtres (marque, prix, état, disponibilité) pour affiner votre recherche ${label}. Chaque produit reconditionné passe par un contrôle complet de la batterie, de l'écran, des connecteurs et des fonctions réseau avant d'être remis en vente avec sa garantie Tokyo Store.`,
    ],
  };
}

/** The visible FAQ and its FAQPage JSON-LD (the [slug] route) read the same list. */
export function getCategoryFaq(label: string): Faq[] {
  return (
    aliasCopy(label)?.faq ?? [
      faqDelivery(label),
      FAQ_WARRANTY,
      FAQ_REFURB,
      FAQ_COD,
      FAQ_TRADE_IN,
      faqRepair(label),
    ]
  );
}
