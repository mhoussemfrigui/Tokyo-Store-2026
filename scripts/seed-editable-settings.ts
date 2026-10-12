/**
 * Seeds the storefront's newly-extracted editable settings (nav labels, home
 * rail labels, SEO, footer CTA) as site_settings rows so the operator can see
 * and edit them — each value equals the current default, so nothing changes
 * on screen. Idempotent (upsert by key).
 *   pnpm tsx --env-file-if-exists=.env.local scripts/seed-editable-settings.ts
 */
import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo",
});

const S: { key: string; value: string; group: string; label: string }[] = [
  // Home product-rail eyebrows / titles
  { key: "home.rail.new.label", value: "Sélection Exclusive", group: "home", label: "Rail Nouveautés — surtitre" },
  { key: "home.rail.promotions.label", value: "Les Plus Convoitées", group: "home", label: "Rail Meilleures Ventes — surtitre" },
  { key: "home.rail.promotions.title", value: "Meilleures Ventes", group: "home", label: "Rail Meilleures Ventes — titre" },
  // Mega-menu labels
  { key: "nav.boutique.name", value: "Boutique", group: "nav", label: "Menu — Boutique" },
  { key: "nav.marques.name", value: "Marques", group: "nav", label: "Menu — Marques" },
  { key: "nav.maison.name", value: "Maison", group: "nav", label: "Menu — Maison" },
  { key: "nav.maison.histoire", value: "Notre Histoire", group: "nav", label: "Maison — Notre Histoire" },
  { key: "nav.maison.support", value: "Service Client", group: "nav", label: "Maison — Service Client" },
  { key: "nav.maison.boutiques", value: "Nos Boutiques", group: "nav", label: "Maison — Nos Boutiques" },
  { key: "nav.maison.carrieres", value: "Carrières", group: "nav", label: "Maison — Carrières" },
  { key: "nav.maison.blog", value: "Blog", group: "nav", label: "Maison — Blog" },
  // SEO
  { key: "seo.title_home", value: "Montres de luxe & horlogerie d'exception", group: "seo", label: "SEO — titre accueil" },
  { key: "seo.keywords", value: "montres, montres de luxe, horlogerie, watches, accessoires, Tunisie", group: "seo", label: "SEO — mots-clés" },
  // (footer.newsletter_cta_default retired: the footer newsletter button label is
  // the banner's ctaLabel, falling back directly to "S'inscrire" — no middle tier.)
];

async function main() {
  let n = 0;
  for (const s of S) {
    await pool.query(
      `INSERT INTO site_settings (key, value, type, group_key, label)
       VALUES ($1, $2, 'text', $3, $4)
       ON CONFLICT (key) DO UPDATE SET group_key = EXCLUDED.group_key, label = EXCLUDED.label, updated_at = now()`,
      // On conflict we keep the operator's existing value (only refresh group/label),
      // so re-running never overwrites an edited string.
      [s.key, s.value, s.group, s.label],
    );
    n++;
  }
  console.log(`[seed-settings] upserted ${n} editable settings`);
  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error("[seed-settings] error:", e); process.exit(1); });
