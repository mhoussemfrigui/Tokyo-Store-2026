/**
 * Seeds the Tokyo Store brand identity into site_settings, so every surface that
 * reads the admin-controlled settings (SEO <title> template, home title/meta,
 * auth page copy, JSON-LD Organization) renders "Tokyo Store" instead of the
 * bundled "Tokyo Store" watch-shop defaults. Backend-driven: the operator
 * can further edit all of these in Contenu & Design / Système → SEO / Clients →
 * Connexion & comptes. Values sourced from the live site (tokyostores.tn).
 *
 * UNLIKE seed-editable-settings (which preserves an operator's value), this
 * OVERWRITES — it is a one-off identity correction. Idempotent.
 *   pnpm tsx --env-file-if-exists=.env.local scripts/tokyo-seed-identity.ts
 */
import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo",
});

const DESCRIPTION =
  "Tokyo Store — iPhones, smartphones, gaming, accessoires et produits high-tech en Tunisie. " +
  "Neuf et reconditionné certifié, livraison 24h partout en Tunisie.";

const S: { key: string; value: string; group: string; label: string }[] = [
  // ── Brand identity (site.*)
  { key: "site.name", value: "Tokyo Store", group: "site", label: "Nom du site" },
  { key: "site.tagline", value: "Votre expert en produits technologiques de pointe", group: "site", label: "Slogan" },
  { key: "site.description", value: DESCRIPTION, group: "site", label: "Description du site" },
  { key: "site.contact_phone", value: "+216 50 059 160", group: "site", label: "Téléphone de contact" },
  { key: "site.contact_email", value: "contact@tokyostore.tn", group: "site", label: "Email de contact" },
  // ── Social networks (social.*) — read by the footer + JSON-LD sameAs
  { key: "social.instagram", value: "https://www.instagram.com/tokyostore.tn/", group: "social", label: "Instagram" },
  { key: "social.facebook", value: "https://www.facebook.com/tokyostore.tn", group: "social", label: "Facebook" },
  { key: "social.tiktok", value: "https://www.tiktok.com/@tokyostore.tn", group: "social", label: "TikTok" },
  // ── Legal entity (business.*) — printed on invoices + the Mentions légales page
  { key: "business.legal_name", value: "TOKYO STORE", group: "business", label: "Raison sociale" },
  { key: "business.tax_id", value: "1702961F/A/M/000", group: "business", label: "Matricule fiscal / RNE" },
  // ── SEO (seo.*)
  { key: "seo.default_description", value: DESCRIPTION, group: "seo", label: "SEO — description par défaut" },
  { key: "seo.title_home", value: "iPhones, Smartphones, Gaming & High-Tech en Tunisie", group: "seo", label: "SEO — titre accueil" },
  // Title template = the page title verbatim, with NO site-name suffix appended
  // (owner preference). "%s" is the page title; the layout applies this template.
  { key: "seo.title_template", value: "%s", group: "seo", label: "SEO — modèle de titre" },
  {
    key: "seo.keywords",
    value: "iPhone, smartphone, Apple, AirPods, Apple Watch, gaming, console, jeux, accessoires, high-tech, Tunisie, Tokyo Store",
    group: "seo",
    label: "SEO — mots-clés",
  },
  // ── Auth page copy (auth.*)
  { key: "auth.register.title", value: "Rejoignez Tokyo Store", group: "auth", label: "Inscription — titre" },
  { key: "auth.register.panel_badge", value: "Club Tokyo Store", group: "auth", label: "Inscription — badge panneau" },
];

async function main() {
  let n = 0;
  for (const s of S) {
    await pool.query(
      `INSERT INTO site_settings (key, value, type, group_key, label)
       VALUES ($1, $2, 'text', $3, $4)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value, group_key = EXCLUDED.group_key,
         label = EXCLUDED.label, updated_at = now()`,
      [s.key, s.value, s.group, s.label],
    );
    n++;
  }
  console.log(`[tokyo-seed-identity] upserted ${n} identity settings`);
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("[tokyo-seed-identity] error:", e);
  process.exit(1);
});
