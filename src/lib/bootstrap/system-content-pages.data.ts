/**
 * Pure content/data for the storefront's system content pages — NO server-only
 * imports and NO DB access, so it can be consumed BOTH by the server-side
 * bootstrap (`system-content-pages.ts`, runs on every boot) AND by the dev
 * re-seed script (`scripts/seed-system-pages.ts`, raw `pg`). One source of
 * truth for the copy; the two runners only differ in HOW they write it.
 *
 * Copy is faithfully reproduced from the client's documents (returns / exchange
 * / CGV) and the real Tokyo Store coordinates. No image is hardcoded —
 * hero imagery is resolved at seed time from the product médiathèque.
 */

import type { PageBlockType } from "@/lib/pages/page-blocks";

export type Section =
  | {
      type: "hero";
      eyebrow?: string;
      title: string;
      subtitle?: string;
      description?: string;
      heroIndex?: number;
      ctaLabel?: string;
      ctaHref?: string;
    }
  | { type: "text"; heading?: string; body: string }
  | {
      type: "cta";
      title: string;
      description?: string;
      ctaLabel: string;
      ctaHref: string;
      style?: "dark" | "light" | "brand";
    }
  | {
      type: "stats";
      heading?: string;
      layout?: "grid" | "row";
      items: { label: string; value: string; caption?: string }[];
    }
  | { type: "timeline"; heading?: string; items: { year: string; title: string; description?: string }[] };

/**
 * A hand-authored PAGE BLOCK for the instance-based composer — the richer, "properly
 * designed" representation (feature_cards / trust / steps / editorial / gallery …, the full
 * `PAGE_BLOCK_TYPES` catalog) the relational `Section` list can't express. When a page seed
 * carries `blocks`, the seeder serialises them to the `pages.blocks` JSON column (the
 * authoritative composer layout, fully editable in /admin/cms/pages) INSTEAD of the legacy
 * relational sections. `config` is the loose composer config for that block type (it is
 * re-validated by `parsePageBlocks` at read, so extra/missing fields are safe); médiathèque
 * imagery is referenced by `{ heroIndex }` (resolved to a real media id at seed time via
 * `resolveSeedBlockImages`) so THIS module stays DB-free and shareable by both runners.
 */
export type SeedImageRef = { heroIndex: number; alt?: string } | { mediaFile: string; alt?: string };
export type BlockSeed = {
  type: PageBlockType;
  visible?: boolean;
  config: Record<string, unknown>;
};

export type PageSeed = {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  /**
   * Protected page (not deletable, slug locked). MUST be true for every page
   * whose slug a hard-coded storefront route renders (`(shop)/<slug>/page.tsx`
   * → LegalPageRenderer — the Maison pages, /cgv): deleting or renaming one
   * would leave its route (linked from the header) on a placeholder. The
   * bootstrap re-syncs this flag onto existing rows on every boot. The policy
   * pages served only by `/[slug]` stay protected too (published + sitemapped).
   */
  isSystem: boolean;
  /** Keep this slug OUT of the sitemap + set robots noindex. For a page that only exists to
   *  redirect (e.g. /about → /notre-histoire): the sitemap must not advertise a URL that 308s. */
  noindex?: boolean;
  /** Legacy relational sections (hero/text/cta/stats/timeline). Written to page_sections
   *  ONLY when `blocks` is absent. Optional — a page defines either `blocks` or `sections`. */
  sections?: Section[];
  /** Rich instance-based block layout → serialised to the `pages.blocks` column. Takes
   *  precedence over `sections` (the render + admin both read the column first). */
  blocks?: BlockSeed[];
};

/** Reference a page-hero médiathèque image by index (resolved at seed time). Keeps the
 *  copy DB-free: `{ heroIndex: n }` becomes `{ mediaId, alt }` — or is dropped when the
 *  deploy has no product imagery yet (the block then renders its graceful no-image state). */
export const heroImageRef = (heroIndex: number, alt = ""): SeedImageRef => ({ heroIndex, alt });

/** Reference a médiathèque image by its FILENAME (e.g. a demo lifestyle photo
 *  « boutique.jpg »). Resolved at seed time; dropped when the file isn't in the
 *  médiathèque (the block then falls back to its typographic no-image layout). */
export const mediaFileRef = (mediaFile: string, alt = ""): SeedImageRef => ({ mediaFile, alt });

type ImgResolvers = {
  heroImg: (i: number | undefined) => string | null;
  fileImg?: (filename: string) => string | null;
};

/** Swap a seed image slot (`{ heroIndex }` / `{ mediaFile }`) for `{ mediaId, alt }`, or null. */
function resolveSeedImage(im: unknown, r: ImgResolvers): { mediaId: string; alt: string } | null {
  if (!im || typeof im !== "object") return null;
  const o = im as Record<string, unknown>;
  const alt = typeof o.alt === "string" ? o.alt : "";
  if (typeof o.heroIndex === "number") {
    const mediaId = r.heroImg(o.heroIndex);
    return mediaId ? { mediaId, alt } : null;
  }
  if (typeof o.mediaFile === "string") {
    const mediaId = r.fileImg?.(o.mediaFile) ?? null;
    return mediaId ? { mediaId, alt } : null;
  }
  if (typeof o.mediaId === "string" && o.mediaId) return { mediaId: o.mediaId, alt };
  return null;
}

/** Deep-resolve every médiathèque slot a block config can carry (image / imageMobile /
 *  images[] / cards[].image / stores[].image), leaving the rest of the config untouched.
 *  Pure — no DB; the caller supplies the resolvers. */
function resolveConfigMedia(config: Record<string, unknown>, r: ImgResolvers): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  if ("image" in out) out.image = resolveSeedImage(out.image, r);
  if ("imageMobile" in out) out.imageMobile = resolveSeedImage(out.imageMobile, r);
  if (Array.isArray(out.images)) {
    out.images = out.images.map((im) => resolveSeedImage(im, r)).filter(Boolean);
  }
  for (const key of ["cards", "stores"] as const) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map((item) => {
        const c = { ...(item as Record<string, unknown>) };
        if ("image" in c) c.image = resolveSeedImage(c.image, r);
        return c;
      });
    }
  }
  return out;
}

/** Every `{ mediaFile }` filename referenced by the seeds — the runners resolve them to
 *  media ids in ONE query before serialising. */
export function seedMediaFiles(pages: PageSeed[]): string[] {
  const files = new Set<string>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    if (typeof o.mediaFile === "string") files.add(o.mediaFile);
    Object.values(o).forEach(walk);
  };
  for (const p of pages) for (const b of p.blocks ?? []) walk(b.config);
  return [...files];
}

/**
 * Serialise a page's hand-authored `blocks` to the stored `pages.blocks` JSON string:
 * resolve each block's média (`{ heroIndex }` / `{ mediaFile }`) to a real id, assign a
 * stable, deterministic id (so a re-seed keeps the same ids), and default `visible` to
 * true. Shared by the boot bootstrap AND the dev re-seed script so the two never drift.
 */
export function buildSeedBlocksJson(
  blocks: BlockSeed[],
  heroImg: (i: number | undefined) => string | null,
  fileImg?: (filename: string) => string | null,
): string {
  const r: ImgResolvers = { heroImg, fileImg };
  return JSON.stringify(
    blocks.map((b, i) => ({
      id: `seed_${i}_${b.type}`,
      type: b.type,
      visible: b.visible ?? true,
      config: resolveConfigMedia(b.config, r),
    })),
  );
}

export const PAGES: PageSeed[] = [
  {
    slug: "apropos",
    title: "À propos",
    metaTitle: "À propos — Tokyo Store",
    metaDescription: "La tech choisie, testée et livrée partout en Tunisie, avec le conseil d'une vraie boutique.",
    isSystem: true,
    blocks: [
      {
        type: "editorial",
        config: {
          header: {
            eyebrow: "Notre histoire",
            title: "Trois boutiques à Tunis, une référence tech en ligne.",
          },
          body: "Tokyo Store est né d'une idée simple : rendre la technologie de qualité accessible partout en Tunisie, avec le conseil d'un vrai magasin et la simplicité d'une commande en ligne.\n\nSmartphones, audio, gaming et accessoires : chaque produit est sélectionné, contrôlé par nos techniciens et livré avec sa facture officielle. Les appareils d'occasion et reconditionnés passent par un protocole de test complet avant d'être mis en vente.",
          imageSide: "right",
        },
      },
      {
        type: "trust",
        config: {
          header: {
            eyebrow: "Nos engagements",
            title: "Ce qui ne change jamais chez nous.",
          },
          layout: "cards",
          presentation: { background: "surface" },
          cards: [
            {
              icon: "Check",
              title: "Produits contrôlés",
              body: "Chaque appareil est vérifié par nos techniciens avant expédition, neuf comme reconditionné.",
            },
            {
              icon: "ShieldCheck",
              title: "Garantie réelle",
              body: "Garantie constructeur de 12 mois sur le neuf, prolongeable avec Tokyo Care.",
            },
            {
              icon: "Truck",
              title: "Livraison nationale",
              body: "Livraison en 24h à 72h dans les 24 gouvernorats, paiement à la réception.",
            },
            {
              icon: "RefreshCw",
              title: "Reprise immédiate",
              body: "Votre ancien appareil estimé gratuitement et déduit de votre achat.",
            },
          ],
        },
      },
      {
        type: "stores",
        config: {
          header: {
            eyebrow: "Nos boutiques",
            title: "3 boutiques dans le Grand Tunis.",
          },
          layout: "directory",
          anchor: "boutiques",
          stores: [
            { name: "Mall Lac 2", address: "Les Berges du Lac 2", city: "Tunis" },
            { name: "La Marsa", address: "La Marsa", city: "Tunis" },
            { name: "Menzah 5", address: "El Menzah 5", city: "Ariana" },
          ],
        },
      },
      {
        type: "cta_band",
        config: {
          header: {
            eyebrow: "Rejoindre l'équipe",
            title: "Passionné·e de tech ? On recrute.",
            subtitle: "Vente, technique, logistique ou e-commerce : découvrez nos postes ouverts.",
            ctaLabel: "Voir les offres",
            ctaHref: "/recrutement",
          },
          style: "brand",
        },
      },
    ],
  },
  {
    slug: "recrutement",
    title: "Recrutement",
    metaTitle: "Recrutement — Tokyo Store",
    metaDescription: "Rejoignez une équipe passionnée de technologie, dans nos boutiques du Grand Tunis et en ligne.",
    isSystem: true,
    blocks: [
      {
        type: "trust",
        config: {
          header: {
            eyebrow: "Pourquoi Tokyo Store",
            title: "Travailler avec des produits que vous aimez.",
          },
          layout: "cards",
          presentation: { background: "surface" },
          cards: [
            {
              icon: "Star",
              title: "Formation continue",
              body: "Formations produits régulières et accès aux nouveautés avant leur sortie.",
            },
            {
              icon: "CreditCard",
              title: "Avantages équipe",
              body: "Remise collaborateur sur tout le catalogue et primes sur objectifs.",
            },
            {
              icon: "Zap",
              title: "Évolution réelle",
              body: "Une équipe à taille humaine où les initiatives sont écoutées.",
            },
          ],
        },
      },
      {
        type: "jobs",
        config: {
          header: {
            eyebrow: "Postes ouverts",
            title: "3 postes à pourvoir",
          },
          jobs: [
            {
              title: "Conseiller·ère de vente",
              location: "Lac 2 · La Marsa · Menzah 5",
              contract: "CDI",
              team: "Temps plein",
              missions: "Accueillir et conseiller les clients en boutique, présenter les produits et l'option Tokyo Care, gérer les encaissements et la mise en rayon.",
              profile: "Bon relationnel, passion pour la tech, maîtrise de l'arabe et du français. Une première expérience en vente est un plus.",
              applyHref: "#candidature",
            },
            {
              title: "Technicien·ne smartphones",
              location: "Grand Tunis",
              contract: "CDI",
              team: "Atelier",
              missions: "Tester et reconditionner les appareils d'occasion, réaliser les diagnostics et réparations SAV, documenter chaque intervention.",
              profile: "Formation en électronique ou expérience en réparation de smartphones, rigueur et minutie.",
              applyHref: "#candidature",
            },
            {
              title: "Chargé·e e-commerce",
              location: "Tunis ou hybride",
              contract: "CDI",
              missions: "Mettre à jour les fiches produits, suivre les commandes en ligne, animer les promotions et coordonner les réseaux sociaux.",
              profile: "Aisance rédactionnelle, maîtrise des outils web, sens du détail. Connaissance des réseaux sociaux appréciée.",
              applyHref: "#candidature",
            },
          ],
        },
      },
      {
        type: "apply_form",
        config: {
          header: {
            eyebrow: "Candidature",
            title: "Postuler chez Tokyo Store",
            subtitle: "Envoyez-nous votre CV, nous revenons vers vous sous 10 jours ouvrables.",
          },
          anchor: "candidature",
          jobOptions: [
            "Conseiller·ère de vente",
            "Technicien·ne smartphones",
            "Chargé·e e-commerce",
          ],
          consentText: "J'accepte que Tokyo Store traite mes données pour ma candidature, conformément à la loi organique n° 2004-63 du 27 juillet 2004. Elles sont conservées 2 ans au maximum.",
        },
      },
    ],
  },
  {
    slug: "aide",
    title: "Aide & contact",
    metaTitle: "Aide & contact — Tokyo Store",
    metaDescription: "Une question sur une commande, un produit ou un retour ? Nous répondons du lundi au samedi.",
    isSystem: true,
    blocks: [
      {
        type: "contact_channels",
        config: {
          layout: "cards",
          channels: [
            { key: "phone", enabled: true },
            { key: "whatsapp", enabled: true },
            { key: "email", enabled: true },
            { key: "stores", enabled: true },
          ],
        },
      },
      {
        type: "faq",
        config: {
          header: {
            eyebrow: "Questions fréquentes",
            title: "Trouvez une réponse.",
          },
          faqSearch: true,
          faqTopics: [
            { key: "commande", label: "Commande" },
            { key: "livraison", label: "Livraison" },
            { key: "paiement", label: "Paiement" },
            { key: "retours", label: "Retours" },
            { key: "garantie", label: "Garantie" },
          ],
          faq: [
            {
              question: "Quels sont les délais de livraison ?",
              answer: "Nous livrons partout en Tunisie en 24h à 72h selon votre gouvernorat. Vous recevez un SMS à l'expédition, puis le livreur vous appelle avant de passer.",
              topic: "livraison",
              linkLabel: "Livraison & retours",
              linkHref: "/livraison",
            },
            {
              question: "Puis-je payer à la livraison ?",
              answer: "Oui. Vous pouvez régler en espèces au livreur après avoir vérifié votre colis, ou payer en ligne par carte bancaire de façon sécurisée.",
              topic: "paiement",
            },
            {
              question: "Comment retourner un produit ?",
              answer: "Vous disposez de 10 jours ouvrables après réception pour vous rétracter. Contactez-nous avec votre n° de commande, puis retournez le produit complet dans son emballage d'origine.",
              topic: "retours",
              linkLabel: "Conditions de retour",
              linkHref: "/livraison",
            },
            {
              question: "Quelle garantie sur un produit neuf ?",
              answer: "Les produits neufs sont couverts par la garantie constructeur de 12 mois, avec facture officielle. Vous pouvez la prolonger avec Tokyo Care sur les produits éligibles.",
              topic: "garantie",
              linkLabel: "Garantie & SAV",
              linkHref: "/garantie",
            },
            {
              question: "Les produits reconditionnés sont-ils garantis ?",
              answer: "Oui. Chaque appareil est testé par nos techniciens et bénéficie d'une garantie Tokyo Store dont la durée est indiquée sur la fiche produit et sur la facture.",
              topic: "garantie",
            },
            {
              question: "Comment suivre ma commande ?",
              answer: "Depuis Mon compte > Commandes, ou via le lien reçu par SMS. Vous y voyez chaque étape, de la préparation à la livraison.",
              topic: "commande",
              linkLabel: "Mon compte",
              linkHref: "/account",
            },
            {
              question: "Puis-je reprendre mon ancien appareil ?",
              answer: "Oui, nous proposons une reprise immédiate : votre appareil est estimé gratuitement en boutique et la valeur est déduite de votre achat.",
              topic: "commande",
            },
          ],
        },
      },
      {
        type: "contact_form",
        config: {
          header: {
            eyebrow: "Nous écrire",
            title: "Une demande précise ?",
          },
          subjects: ["Commande", "Retour", "SAV", "Produit", "Autre"],
          showOrderField: true,
        },
      },
    ],
  },
  {
    slug: "livraison",
    title: "Livraison & retours",
    metaTitle: "Livraison & retours — Tokyo Store",
    metaDescription: "Livraison en 24h à 72h dans toute la Tunisie, paiement à la réception et 10 jours ouvrables pour changer d'avis.",
    isSystem: true,
    blocks: [
      {
        type: "trust",
        config: {
          layout: "cards",
          presentation: { background: "default" },
          cards: [
            {
              icon: "Truck",
              title: "24h à 72h",
              body: "Partout en Tunisie, selon votre gouvernorat.",
            },
            {
              icon: "CreditCard",
              title: "Paiement à la livraison",
              body: "En espèces au livreur, ou par carte bancaire en ligne.",
            },
            {
              icon: "MessageCircle",
              title: "Suivi par SMS",
              body: "Vous êtes prévenu à chaque étape, puis le livreur vous appelle.",
            },
            {
              icon: "RefreshCw",
              title: "10 jours pour changer d'avis",
              body: "Droit de rétractation prévu par la loi n° 2000-83.",
            },
          ],
        },
      },
      {
        type: "steps",
        config: {
          header: {
            eyebrow: "Livraison",
            title: "Du clic à votre porte.",
          },
          steps: [
            { title: "Commande confirmée", body: "Un conseiller vous appelle pour confirmer la commande et l'adresse." },
            { title: "Préparation", body: "Le produit est contrôlé, emballé et accompagné de sa facture." },
            { title: "Expédition", body: "Remise au transporteur, suivi envoyé par SMS." },
            { title: "Livraison", body: "Le livreur vous appelle. Vérifiez le colis avant de payer." },
          ],
        },
      },
      {
        type: "trust",
        config: {
          layout: "cards",
          presentation: { background: "surface" },
          cards: [
            {
              title: "Frais de livraison",
              body: "Calculés selon le gouvernorat et affichés au panier, avant validation de la commande. Aucun frais supplémentaire à la réception.",
            },
            {
              title: "Colis endommagé ?",
              body: "Refusez le colis en présence du livreur ou signalez-le dès réception. Nous le remplaçons sans frais.",
            },
          ],
        },
      },
      {
        type: "steps",
        config: {
          header: {
            eyebrow: "Retours & rétractation",
            title: "Changer d'avis, simplement.",
            subtitle: "Conformément à l'article 30 de la loi n° 2000-83 du 9 août 2000 relative aux échanges et au commerce électroniques, vous disposez de 10 jours ouvrables à compter de la réception pour vous rétracter, sans avoir à vous justifier.",
          },
          steps: [
            { title: "Demande", body: "Contactez-nous par téléphone, WhatsApp ou via le formulaire avec votre n° de commande." },
            { title: "Retour du produit", body: "Complet, dans son emballage d'origine, avec ses accessoires et sa facture." },
            { title: "Vérification", body: "Nos techniciens contrôlent l'état du produit à réception." },
            { title: "Remboursement", body: "Sous 10 jours à compter du retour, par le moyen de paiement choisi." },
          ],
        },
      },
      {
        type: "checklist",
        config: {
          columns: [
            {
              title: "Conditions",
              variant: "include",
              items: [
                "Produit non utilisé, en parfait état de revente",
                "Emballage d'origine, accessoires et notices complets",
                "Facture ou bon de livraison joint",
                "Frais de retour à la charge du client, sauf produit défectueux ou non conforme",
              ],
            },
            {
              title: "Exclus de la rétractation",
              variant: "exclude",
              items: [
                "Produits personnalisés ou fabriqués à la demande",
                "Logiciels, jeux et cartes cadeaux dont le scellé ou le code a été utilisé",
                "Écouteurs intra-auriculaires descellés, pour des raisons d'hygiène",
              ],
            },
          ],
        },
      },
      {
        type: "cta_band",
        config: {
          header: {
            title: "Un retour à effectuer ?",
            ctaLabel: "Demander un retour",
            ctaHref: "/aide",
          },
          style: "brand",
          secondaryCtaLabel: "Lire les CGV",
          secondaryCtaHref: "/cgv",
        },
      },
    ],
  },
  {
    slug: "garantie",
    title: "Garantie & SAV",
    metaTitle: "Garantie & SAV — Tokyo Store",
    metaDescription: "Tous nos produits sont garantis et suivis par nos techniciens, avant comme après l'achat.",
    isSystem: true,
    blocks: [
      {
        type: "tiers",
        config: {
          tiers: [
            {
              eyebrow: "Produits neufs",
              value: "12",
              unit: "mois",
              body: "Garantie constructeur, facture officielle fournie.",
              tone: "light",
              icon: "ShieldCheck",
            },
            {
              eyebrow: "Occasion & reconditionné",
              value: "Garantie Tokyo Store",
              unit: "",
              body: "Durée indiquée sur chaque fiche produit et sur votre facture.",
              tone: "light",
              icon: "RefreshCw",
            },
            {
              eyebrow: "Tokyo Care",
              value: "Prolongez votre garantie",
              unit: "",
              body: "Option proposée à l'achat sur les produits éligibles.",
              tone: "dark",
              icon: "Plus",
            },
          ],
        },
      },
      {
        type: "steps",
        config: {
          header: {
            eyebrow: "Service après-vente",
            title: "Une panne ? On s'en occupe.",
          },
          steps: [
            { title: "Déclarez la panne", body: "Par téléphone, WhatsApp ou formulaire, avec votre n° de commande." },
            { title: "Diagnostic", body: "Premier diagnostic à distance, puis dépôt en boutique ou envoi." },
            { title: "Réparation", body: "Par nos techniciens ou le centre agréé de la marque." },
            { title: "Restitution", body: "Appareil réparé ou remplacé, vous êtes prévenu par SMS." },
          ],
        },
      },
      {
        type: "checklist",
        config: {
          columns: [
            {
              title: "Couvert par la garantie",
              variant: "include",
              items: [
                "Défauts de fabrication et pannes matérielles",
                "Batterie défaillante dans des conditions d'usage normales",
                "Dysfonctionnement d'origine des composants",
              ],
            },
            {
              title: "Non couvert",
              variant: "exclude",
              items: [
                "Casse, chute, oxydation ou contact avec un liquide",
                "Intervention ou réparation par un tiers non agréé",
                "Usure normale et dommages esthétiques",
              ],
            },
          ],
        },
      },
      {
        type: "rich_text",
        config: {
          header: { title: "Garantie légale" },
          body: "<p>Indépendamment de la garantie commerciale, vous bénéficiez de la garantie légale contre les vices cachés prévue par les articles 647 et suivants du Code des obligations et des contrats, ainsi que des droits issus de la loi n° 92-117 du 7 décembre 1992 relative à la protection du consommateur.</p>",
        },
      },
      {
        type: "cta_band",
        config: {
          header: {
            title: "Une panne à signaler ?",
            ctaLabel: "Ouvrir une demande SAV",
            ctaHref: "/aide",
          },
          style: "brand",
          secondaryCtaLabel: "Suivre ma réparation",
          secondaryCtaHref: "/suivi-de-commande",
        },
      },
    ],
  },
  {
    slug: "mentions",
    title: "Mentions légales",
    metaTitle: "Mentions légales — Tokyo Store",
    metaDescription: "Informations relatives à l'éditeur et à l'hébergement du site tokyostores.tn.",
    isSystem: true,
    blocks: [
      {
        type: "legal_doc",
        config: {
          draftNote: "Les champs marqués « à compléter » doivent être renseignés avec les informations officielles de la société (RNE, matricule fiscal) avant mise en ligne.",
          showToc: true,
          facts: [
            { label: "Raison sociale", value: "Tokyo Store (À compléter : forme juridique)", pending: true },
            { label: "Siège social", value: "À compléter", pending: true },
            { label: "Points de vente", value: "Mall Lac 2 · La Marsa · Menzah 5", pending: false },
            { label: "Identifiant unique RNE", value: "À compléter", pending: true },
            { label: "Matricule fiscal", value: "À compléter", pending: true },
            { label: "Capital social", value: "À compléter", pending: true },
            { label: "Directeur de la publication", value: "À compléter", pending: true },
            { label: "Téléphone", value: "+216 50 059 160", pending: false },
            { label: "E-mail", value: "contact@tokyostores.tn", pending: false },
            { label: "Hébergeur", value: "À compléter (nom, adresse, téléphone)", pending: true },
            { label: "Conception", value: "Kawn Digital Studio", pending: false },
          ],
          sections: [
            {
              heading: "Éditeur du site",
              body: [
                "Le site tokyostores.tn est édité par la société Tokyo Store, dont les informations d'identification figurent ci-dessus, conformément à l'article 25 de la loi n° 2000-83 du 9 août 2000 relative aux échanges et au commerce électroniques.",
              ],
            },
            {
              heading: "Hébergement",
              body: [
                "Le site est hébergé par le prestataire indiqué ci-dessus. Les données des clients sont stockées dans des conditions conformes à la loi organique n° 2004-63 du 27 juillet 2004.",
              ],
            },
            {
              heading: "Propriété intellectuelle",
              body: [
                "L'ensemble des contenus du site (textes, photographies, logos, vidéos, éléments graphiques) est la propriété de Tokyo Store ou de ses partenaires et est protégé par la loi n° 94-36 du 24 février 1994 relative à la propriété littéraire et artistique, telle que modifiée.",
                "Les marques citées appartiennent à leurs titulaires respectifs. Toute reproduction, même partielle, sans autorisation écrite préalable est interdite.",
              ],
            },
            {
              heading: "Données personnelles",
              body: [
                "Le traitement des données personnelles est décrit dans notre Politique de confidentialité. Il est soumis à la loi organique n° 2004-63 et au contrôle de l'Instance Nationale de Protection des Données Personnelles (INPDP).",
              ],
            },
            {
              heading: "Droit applicable",
              body: [
                "Les présentes mentions sont régies par le droit tunisien. Tout litige relève de la compétence des tribunaux de Tunis, sous réserve des règles impératives applicables aux consommateurs.",
              ],
            },
          ],
        },
      },
    ],
  },
  {
    slug: "cgv",
    title: "Conditions générales de vente",
    metaTitle: "Conditions générales de vente — Tokyo Store",
    metaDescription: "Les règles applicables à toute commande passée sur tokyostores.tn.",
    isSystem: true,
    blocks: [
      {
        type: "legal_doc",
        config: {
          showToc: true,
          sections: [
            {
              heading: "Objet et champ d'application",
              body: [
                "Les présentes conditions générales de vente (CGV) régissent les ventes conclues à distance entre Tokyo Store et toute personne effectuant un achat sur tokyostores.tn (le « Client »). Elles s'appliquent conformément à la loi n° 2000-83 du 9 août 2000 et à la loi n° 92-117 du 7 décembre 1992 relative à la protection du consommateur.",
                "Toute commande implique l'acceptation sans réserve des CGV en vigueur au jour de la commande.",
              ],
            },
            {
              heading: "Produits",
              body: [
                "Les caractéristiques essentielles de chaque produit (état neuf, occasion ou reconditionné, capacité, couleur, garantie) sont présentées sur sa fiche. Les photographies ne sont pas contractuelles. Les offres sont valables dans la limite des stocks disponibles.",
              ],
            },
            {
              heading: "Prix",
              body: [
                "Les prix sont indiqués en dinars tunisiens (TND), toutes taxes comprises (TVA incluse). Les frais de livraison sont précisés avant la validation de la commande.",
                "Tokyo Store peut modifier ses prix à tout moment ; le prix facturé est celui affiché au moment de la validation de la commande.",
              ],
            },
            {
              heading: "Commande",
              body: [
                "Le Client sélectionne ses produits, vérifie le récapitulatif puis valide sa commande. Un récapitulatif lui est transmis par SMS ou e-mail, et un conseiller peut l'appeler pour confirmer la commande et l'adresse de livraison.",
                "Tokyo Store se réserve le droit d'annuler toute commande présentant un caractère anormal ou en cas de litige antérieur avec le Client.",
              ],
            },
            {
              heading: "Paiement",
              body: [
                "Le paiement s'effectue au choix en espèces à la livraison ou par carte bancaire via une plateforme de paiement sécurisée agréée. Les données bancaires ne transitent pas par les serveurs de Tokyo Store.",
              ],
            },
            {
              heading: "Livraison",
              body: [
                "Les produits sont livrés à l'adresse indiquée, sur tout le territoire tunisien, dans un délai indicatif de 24h à 72h. Le Client vérifie l'état du colis en présence du livreur et signale toute anomalie dès réception.",
              ],
            },
            {
              heading: "Droit de rétractation",
              body: [
                "Conformément à l'article 30 de la loi n° 2000-83, le Client dispose d'un délai de dix (10) jours ouvrables à compter de la réception du produit pour se rétracter. Le produit doit être retourné complet, dans son emballage d'origine et en parfait état ; les frais de retour sont à la charge du Client.",
                "Tokyo Store rembourse le montant payé dans un délai de dix (10) jours à compter du retour du produit. Conformément à l'article 32 de la même loi, la rétractation ne s'applique pas notamment aux produits personnalisés et aux logiciels descellés.",
              ],
            },
            {
              heading: "Garanties",
              body: [
                "Les produits neufs bénéficient de la garantie constructeur indiquée sur leur fiche, généralement de 12 mois. Les produits d'occasion et reconditionnés bénéficient d'une garantie Tokyo Store dont la durée est précisée sur la fiche et la facture. L'option Tokyo Care permet, pour les produits éligibles, de prolonger cette durée.",
                "Ces garanties commerciales s'ajoutent à la garantie légale des vices cachés prévue par les articles 647 et suivants du Code des obligations et des contrats.",
              ],
            },
            {
              heading: "Réclamations et litiges",
              body: [
                "Toute réclamation peut être adressée au service client par téléphone au +216 50 059 160 ou par e-mail à contact@tokyostores.tn. Les parties recherchent une solution amiable avant toute action.",
                "Les présentes CGV sont soumises au droit tunisien. À défaut d'accord amiable, les tribunaux de Tunis sont compétents.",
              ],
            },
          ],
        },
      },
    ],
  },
  {
    slug: "cgu",
    title: "Conditions générales d'utilisation",
    metaTitle: "Conditions générales d'utilisation — Tokyo Store",
    metaDescription: "Les règles d'accès et d'utilisation du site tokyostores.tn et de votre compte client.",
    isSystem: true,
    blocks: [
      {
        type: "legal_doc",
        config: {
          showToc: true,
          sections: [
            {
              heading: "Objet",
              body: [
                "Les présentes conditions générales d'utilisation (CGU) définissent les modalités d'accès et d'utilisation du site tokyostores.tn. En naviguant sur le site, l'utilisateur les accepte.",
              ],
            },
            {
              heading: "Accès au site",
              body: [
                "Le site est accessible gratuitement à tout utilisateur disposant d'un accès à Internet. Tokyo Store peut suspendre l'accès pour maintenance ou mise à jour, sans que sa responsabilité puisse être engagée.",
              ],
            },
            {
              heading: "Compte client",
              body: [
                "La création d'un compte permet de suivre ses commandes, enregistrer ses favoris et ses adresses. L'utilisateur s'engage à fournir des informations exactes et à préserver la confidentialité de ses moyens de connexion (mot de passe, lien ou code reçu).",
                "Toute activité réalisée depuis le compte est réputée effectuée par son titulaire. L'utilisateur peut demander la clôture de son compte à tout moment.",
              ],
            },
            {
              heading: "Avis et contenus publiés",
              body: [
                "Les avis publiés doivent être loyaux, porter sur un produit réellement acheté et respecter la loi. Tokyo Store se réserve le droit de modérer ou de retirer tout contenu injurieux, diffamatoire, trompeur ou sans rapport avec le produit.",
              ],
            },
            {
              heading: "Comportements interdits",
              body: [
                "Il est interdit d'utiliser le site à des fins frauduleuses, de tenter d'accéder sans autorisation à ses systèmes, d'en extraire massivement les contenus ou de perturber son fonctionnement. Ces agissements peuvent être sanctionnés conformément à la législation tunisienne en vigueur.",
              ],
            },
            {
              heading: "Propriété intellectuelle",
              body: [
                "Les contenus du site sont protégés. Leur utilisation est limitée à un usage personnel et non commercial.",
              ],
            },
            {
              heading: "Responsabilité",
              body: [
                "Tokyo Store met tout en œuvre pour fournir des informations exactes mais ne peut garantir l'absence totale d'erreurs. Les liens vers des sites tiers, notamment nos réseaux sociaux TikTok, Instagram et Facebook, relèvent de la responsabilité de leurs éditeurs.",
              ],
            },
            {
              heading: "Modification et droit applicable",
              body: [
                "Tokyo Store peut modifier les présentes CGU ; la version applicable est celle en ligne lors de la visite. Les CGU sont régies par le droit tunisien.",
              ],
            },
          ],
        },
      },
    ],
  },
  {
    slug: "confidentialite",
    title: "Politique de confidentialité",
    metaTitle: "Politique de confidentialité — Tokyo Store",
    metaDescription: "Comment nous collectons, utilisons et protégeons vos données personnelles.",
    isSystem: true,
    blocks: [
      {
        type: "legal_doc",
        config: {
          draftNote: "Les champs marqués « à compléter » doivent être renseignés avec les informations officielles de la société (RNE, matricule fiscal) avant mise en ligne.",
          showToc: true,
          sections: [
            {
              heading: "Responsable du traitement",
              body: [
                "Le responsable du traitement est Tokyo Store, dont le siège social est indiqué dans les mentions légales. Les traitements sont réalisés conformément à la loi organique n° 2004-63 du 27 juillet 2004 portant sur la protection des données à caractère personnel et ont fait l'objet des formalités requises auprès de l'INPDP (n° de déclaration : à compléter).",
              ],
            },
            {
              heading: "Données collectées",
              body: [
                "Identité et coordonnées (nom, téléphone, e-mail, adresse de livraison), historique de commandes, favoris, échanges avec le service client, et données de navigation lorsque vous y consentez. Aucune donnée bancaire n'est conservée par Tokyo Store.",
              ],
            },
            {
              heading: "Finalités",
              body: [
                "Traiter et livrer vos commandes, gérer votre compte et les garanties, répondre à vos demandes, prévenir la fraude, et, avec votre accord, vous adresser nos offres et mesurer l'audience du site.",
              ],
            },
            {
              heading: "Destinataires",
              body: [
                "Vos données sont destinées aux équipes habilitées de Tokyo Store et, pour ce qui les concerne, à nos prestataires : transporteurs, plateforme de paiement, hébergeur et outils d'envoi de SMS ou d'e-mails. Elles ne sont jamais vendues.",
                "Tout transfert de données vers l'étranger n'intervient que dans les conditions prévues par la loi organique n° 2004-63 et, le cas échéant, avec l'autorisation de l'INPDP.",
              ],
            },
            {
              heading: "Durées de conservation",
              body: [
                "Données de compte : jusqu'à la clôture du compte puis 3 ans. Données de commande et factures : pendant la durée légale de conservation des documents comptables. Candidatures : 2 ans au maximum. Données de prospection : 3 ans à compter du dernier contact.",
              ],
            },
            {
              heading: "Vos droits",
              body: [
                "Vous disposez d'un droit d'accès, de rectification et d'opposition au traitement de vos données, ainsi que du droit de retirer votre consentement à tout moment. Pour les exercer, écrivez à contact@tokyostores.tn en joignant un justificatif d'identité.",
                "Vous pouvez également saisir l'Instance Nationale de Protection des Données Personnelles (INPDP), 1 rue Mohamed Moalla, Mutuelleville, 1082 Tunis.",
              ],
            },
            {
              heading: "Sécurité",
              body: [
                "Tokyo Store met en œuvre des mesures techniques et organisationnelles adaptées : connexion chiffrée (HTTPS), accès restreint aux données, connexion sans mot de passe par lien ou code à usage unique.",
              ],
            },
          ],
        },
      },
    ],
  },
  {
    slug: "cookies",
    title: "Politique cookies",
    metaTitle: "Politique cookies — Tokyo Store",
    metaDescription: "Les cookies utilisés sur tokyostores.tn et la manière de gérer vos choix.",
    isSystem: true,
    blocks: [
      {
        type: "legal_doc",
        config: {
          showToc: true,
          sections: [
            {
              heading: "Qu'est-ce qu'un cookie ?",
              body: [
                "Un cookie est un petit fichier déposé sur votre appareil lors de la visite d'un site. Il permet notamment de mémoriser votre panier, votre session et vos préférences.",
              ],
            },
            {
              heading: "Cookies nécessaires",
              body: [
                "Indispensables au fonctionnement du site : panier, connexion à votre compte, sécurité et mémorisation de vos choix de cookies. Ils ne peuvent pas être désactivés.",
              ],
            },
            {
              heading: "Mesure d'audience",
              body: [
                "Ils nous permettent de connaître la fréquentation du site et d'améliorer nos pages. Ils ne sont déposés qu'avec votre accord.",
              ],
            },
            {
              heading: "Marketing",
              body: [
                "Déposés par nos partenaires publicitaires (par exemple Meta ou TikTok), ils permettent de vous proposer des offres adaptées sur d'autres sites et réseaux sociaux. Ils ne sont déposés qu'avec votre accord.",
              ],
            },
            {
              heading: "Durée et gestion",
              body: [
                "Votre choix est conservé 6 mois. Vous pouvez le modifier à tout moment ci-dessous ou depuis le lien « Cookies » en bas de chaque page, ainsi que dans les réglages de votre navigateur. Ces traitements sont soumis à la loi organique n° 2004-63.",
              ],
            },
          ],
          cookiePrefs: [
            { key: "need", label: "Nécessaires", description: "Panier, connexion et sécurité. Toujours actifs.", locked: true },
            { key: "stats", label: "Mesure d'audience", description: "Statistiques de fréquentation anonymisées.", locked: false },
            { key: "ads", label: "Marketing", description: "Publicités personnalisées sur les réseaux sociaux.", locked: false },
          ],
        },
      },
    ],
  },
];

export const CONTACT_DEFAULTS: { key: string; value: string; label: string; group: string }[] = [
  { key: "site.address", value: "Mall Lac 2, Les Berges du Lac 2, Tunis", label: "Adresse", group: "contact" },
  { key: "site.addresses", value: '[{"v":"Mall Lac 2, Les Berges du Lac 2, Tunis","f":true},{"v":"La Marsa, Tunis","f":true},{"v":"El Menzah 5, Ariana","f":true}]', label: "Adresses", group: "contact" },
  { key: "site.contact_phone", value: "+216 50 059 160", label: "Téléphone", group: "contact" },
  { key: "site.contact_email", value: "contact@tokyostores.tn", label: "Email de contact", group: "contact" },
];
