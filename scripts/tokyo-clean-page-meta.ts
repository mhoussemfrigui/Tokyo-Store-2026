/**
 * Rewrites the system `pages` rows' meta (meta_title / meta_description) from the
 * legacy watch-era copy (horlogerie / Sfax) to Tokyo Store high-tech
 * copy. These feed the generated `search_vector` (title ‖ meta_title ‖
 * meta_description), so stale meta made the storefront search surface watch-shop
 * terms. The slugs are owned + rendered by the (tokyo) routes; this keeps the
 * backend rows (nav registration + search) in brand. Idempotent.
 *   pnpm tsx --env-file-if-exists=.env.local scripts/tokyo-clean-page-meta.ts
 */
import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo",
});

const SUFFIX = " — Tokyo Store";

const META: Record<string, { title: string; description: string }> = {
  "notre-histoire": {
    title: "Notre Histoire",
    description:
      "Tokyo Store, votre expert tunisien du high-tech : Apple, smartphones, gaming et accessoires, neufs et reconditionnés certifiés, livrés partout en Tunisie.",
  },
  "service-client": {
    title: "Service Client",
    description:
      "Une assistance dédiée Tokyo Store : conseils d'achat, suivi de commande, garantie et SAV de vos produits high-tech.",
  },
  "nos-boutiques": {
    title: "Nos Boutiques",
    description:
      "Découvrez Tokyo Store : boutique en ligne high-tech avec livraison rapide partout en Tunisie et un service client à votre écoute.",
  },
  carrieres: {
    title: "Carrières",
    description:
      "Rejoignez Tokyo Store et construisez votre carrière au sein du spécialiste tunisien des produits Apple, gaming et high-tech.",
  },
  "rendez-vous": {
    title: "Prendre rendez-vous",
    description:
      "Réservez un rendez-vous avec un conseiller Tokyo Store pour un accompagnement personnalisé sur vos produits high-tech.",
  },
  about: {
    title: "À propos",
    description:
      "Tokyo Store : spécialiste tunisien de l'iPhone, des produits Apple, du gaming et du high-tech. Neuf et reconditionné certifié, livraison 24h.",
  },
  "garantie-retours": {
    title: "Garantie & Retours",
    description:
      "Politique de garantie, de retour et d'échange de Tokyo Store sur vos achats high-tech, et modalités du service après-vente.",
  },
  "suivi-de-commande": {
    title: "Suivi de commande",
    description:
      "Suivez l'état et la livraison de votre commande Tokyo Store avec votre numéro de commande et votre téléphone.",
  },
  cgv: {
    title: "Conditions générales de vente",
    description:
      "Les conditions générales de vente de Tokyo Store : commande, paiement (à la livraison ou en ligne via Flouci), livraison et garantie.",
  },
  cgu: {
    title: "Conditions générales d'utilisation",
    description: "Les conditions générales d'utilisation du site Tokyo Store (tokyostores.tn).",
  },
  cookies: {
    title: "Politique de cookies",
    description: "L'usage des cookies et traceurs sur le site Tokyo Store (tokyostores.tn).",
  },
  "mentions-legales": {
    title: "Mentions légales",
    description:
      "Mentions légales et informations sur l'éditeur du site Tokyo Store : raison sociale, matricule fiscal et coordonnées.",
  },
  privacy: {
    title: "Politique de confidentialité",
    description: "Comment Tokyo Store collecte, utilise et protège vos données personnelles.",
  },
  help: {
    title: "Aide & contact",
    description:
      "Besoin d'aide ? Contactez Tokyo Store : FAQ, suivi de commande, livraison, garantie et service après-vente.",
  },
};

async function main() {
  let n = 0;
  for (const [slug, m] of Object.entries(META)) {
    const res = await pool.query(
      `UPDATE pages
         SET meta_title = $2, meta_description = $3, updated_at = now()
       WHERE slug = $1 AND deleted_at IS NULL`,
      [slug, m.title + SUFFIX, m.description],
    );
    if ((res.rowCount ?? 0) > 0) n++;
  }
  console.log(`[tokyo-clean-page-meta] updated meta for ${n} pages`);
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("[tokyo-clean-page-meta] error:", e);
  process.exit(1);
});
