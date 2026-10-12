/**
 * Seeds the Tokyo Lovable 2 design content into the live DB (idempotent):
 *   - 3 mega-menu featured banners (nav_boutique / nav_marques / nav_maison)
 *   - the new home blocks (home.fiftyfifty / appointment / complications / heritage)
 *     as site_settings (copy = text, image_media_id = media), pointing images at
 *     already-imported médiathèque rows
 *   - refreshes the home_hero slides' copy + images to the source design
 *
 * Direct SQL via pg (no app imports) so it runs regardless of code-compile state.
 *   pnpm tsx --env-file-if-exists=.env.local scripts/seed-tokyo-design.ts
 */
import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo",
});
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

async function main() {
  // ── pick distinct WATCH images from the médiathèque: only images attached to
  //    Homme/Femme products (real watches), excluding Zippo lighters / accessories
  //    so the hero + blocks never show a briquet. Falls back to any product image
  //    if the join yields too few. ──
  let media = (
    await q(
      `SELECT m.id, COALESCE(m.alt_text, p.name) AS alt_text
       FROM media m
       JOIN product_media pm ON pm.media_id = m.id
       JOIN products p ON p.id = pm.product_id
       JOIN product_categories pc ON pc.product_id = p.id
       JOIN categories c ON c.id = pc.category_id
       WHERE c.slug IN ('femme', 'homme')
         AND m.kind = 'image' AND m.webp_url IS NOT NULL AND m.deleted_at IS NULL
         AND COALESCE(m.width, 0) >= 400
         AND p.name NOT ILIKE '%zippo%'
       GROUP BY m.id, m.alt_text, p.name
       ORDER BY m.id
       LIMIT 30`,
    )
  ).rows as { id: string; alt_text: string | null }[];
  if (media.length < 11) {
    media = (
      await q(
        `SELECT id, alt_text FROM media
         WHERE kind = 'image' AND webp_url IS NOT NULL AND deleted_at IS NULL
           AND (alt_text IS NULL OR alt_text <> 'Tokyo Store')
           AND COALESCE(width, 0) >= 400
         ORDER BY created_at DESC LIMIT 24`,
      )
    ).rows as { id: string; alt_text: string | null }[];
  }
  if (media.length < 11) throw new Error(`Not enough média (${media.length}); run the product import first.`);
  const pick = (i: number) => media[i % media.length].id;
  const img = {
    heroA: pick(0), heroB: pick(1), heroC: pick(2),
    navBoutique: pick(3), navMarques: pick(4), navMaison: pick(6),
    fifty1: pick(7), fifty2: pick(8),
    appointment: pick(9),
    comp1: pick(10), comp2: pick(11),
    heritage: pick(12),
  };

  // ── settings upsert helper ──
  const settings: { key: string; value: string; type: "text" | "media" | "boolean"; label: string }[] = [];
  const txt = (key: string, value: string, label: string) => settings.push({ key, value, type: "text", label });
  const mediaSet = (key: string, value: string, label: string) => settings.push({ key, value, type: "media", label });
  const bool = (key: string, value: boolean, label: string) => settings.push({ key, value: String(value), type: "boolean", label });

  // FiftyFifty (Powermatic Rosé / Le Locle Vert)
  bool("home.fiftyfifty.visible", true, "Bloc 50/50 visible");
  txt("home.fiftyfifty.card1.label", "Collection Habillée", "Carte 1 — surtitre");
  txt("home.fiftyfifty.card1.title", "Powermatic Rosé", "Carte 1 — titre");
  txt("home.fiftyfifty.card1.desc", "Élégance intemporelle pour les moments d'exception", "Carte 1 — description");
  mediaSet("home.fiftyfifty.card1.image_media_id", img.fifty1, "Carte 1 — image");
  txt("home.fiftyfifty.card1.href", "/femme", "Carte 1 — lien");
  txt("home.fiftyfifty.card2.label", "Collection Classique", "Carte 2 — surtitre");
  txt("home.fiftyfifty.card2.title", "Le Locle Vert", "Carte 2 — titre");
  txt("home.fiftyfifty.card2.desc", "Précision conçue pour l'esprit aventurier", "Carte 2 — description");
  mediaSet("home.fiftyfifty.card2.image_media_id", img.fifty2, "Carte 2 — image");
  txt("home.fiftyfifty.card2.href", "/homme", "Carte 2 — lien");

  // Appointment banner (Prenez Rendez-vous)
  bool("home.appointment.visible", true, "Bandeau RDV visible");
  txt("home.appointment.eyebrow", "Expérience Privée", "RDV — surtitre");
  txt("home.appointment.title", "Prenez", "RDV — titre");
  txt("home.appointment.title_accent", "Rendez-vous", "RDV — titre accent");
  txt("home.appointment.description", "Réservez une consultation privée avec nos experts et découvrez nos collections dans l'intimité de nos salons exclusifs.", "RDV — description");
  mediaSet("home.appointment.image_media_id", img.appointment, "RDV — image");
  txt("home.appointment.href", "/service-client", "RDV — lien");

  // Complications (Complications Exceptionnelles)
  bool("home.complications.visible", true, "Bloc complications visible");
  txt("home.complications.label", "Haute Horlogerie", "Complications — surtitre");
  txt("home.complications.title", "Complications", "Complications — titre");
  txt("home.complications.title_accent", "Exceptionnelles", "Complications — titre accent");
  txt("home.complications.card1.tag", "Prestige", "Compl. carte 1 — étiquette");
  txt("home.complications.card1.title", "Classique Cuir", "Compl. carte 1 — titre");
  txt("home.complications.card1.desc", "Le savoir-faire à cœur ouvert", "Compl. carte 1 — description");
  txt("home.complications.card1.price", "Sur demande", "Compl. carte 1 — prix");
  mediaSet("home.complications.card1.image_media_id", img.comp1, "Compl. carte 1 — image");
  txt("home.complications.card1.href", "/homme", "Compl. carte 1 — lien");
  txt("home.complications.card2.tag", "Grande Complication", "Compl. carte 2 — étiquette");
  txt("home.complications.card2.title", "Signature Or", "Compl. carte 2 — titre");
  txt("home.complications.card2.desc", "Design audacieux et moderne", "Compl. carte 2 — description");
  txt("home.complications.card2.price", "Sur demande", "Compl. carte 2 — prix");
  mediaSet("home.complications.card2.image_media_id", img.comp2, "Compl. carte 2 — image");
  txt("home.complications.card2.href", "/femme", "Compl. carte 2 — lien");

  // Heritage (Un Héritage d'Excellence Depuis 1950)
  bool("home.heritage.visible", true, "Bloc héritage visible");
  txt("home.heritage.eyebrow", "Notre Héritage", "Héritage — surtitre");
  txt("home.heritage.title_line1", "Un Héritage", "Héritage — ligne 1");
  txt("home.heritage.title_line2", "d'Excellence", "Héritage — ligne 2");
  txt("home.heritage.title_line3", "Depuis 1950", "Héritage — ligne 3 (italique)");
  txt("home.heritage.description", "Depuis 1950, Tokyo Store est la destination des collectionneurs exigeants en Tunisie. Chaque montre est un témoin précieux, un gardien de vos histoires.", "Héritage — description");
  txt("home.heritage.cta_label", "Découvrir Notre Histoire", "Héritage — bouton");
  txt("home.heritage.cta_href", "/notre-histoire", "Héritage — lien");
  mediaSet("home.heritage.image_media_id", img.heritage, "Héritage — image");

  for (const s of settings) {
    await q(
      `INSERT INTO site_settings (key, value, type, group_key, label)
       VALUES ($1, $2, $3, 'home', $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, type = EXCLUDED.type, label = EXCLUDED.label, updated_at = now()`,
      [s.key, s.value, s.type, s.label],
    );
  }
  console.log(`[seed-design] upserted ${settings.length} home settings`);

  // ── nav-featured banners (one per dropdown) ──
  const navBanners = [
    { placement: "nav_boutique", name: "Nav — Boutique", eyebrow: "La Boutique", title: "Toutes les Montres", href: "/femme", image: img.navBoutique },
    { placement: "nav_marques", name: "Nav — Marques", eyebrow: "Nos Marques", title: "Horlogerie d'Exception", href: "/marques", image: img.navMarques },
    { placement: "nav_maison", name: "Nav — Maison", eyebrow: "Depuis 1950", title: "Tokyo Store", href: "/notre-histoire", image: img.navMaison },
  ];
  await q(`DELETE FROM banners WHERE placement IN ('nav_boutique','nav_marques','nav_maison')`);
  for (const b of navBanners) {
    await q(
      `INSERT INTO banners (placement, name, eyebrow, title, cta_href, image_media_id, display_order, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, true, now(), now())`,
      [b.placement, b.name, b.eyebrow, b.title, b.href, b.image],
    );
  }
  console.log(`[seed-design] inserted ${navBanners.length} nav-featured banners`);

  // ── refresh the home_hero slides (copy + images) to the source design ──
  const heroSlides = [
    { eyebrow: "Nouvelle Collection 2026", title: "L'Art du", subtitle: "Temps", description: "Chaque seconde est un souvenir. Des garde-temps forgés avec passion depuis 1950.", cta: "Explorer la Collection", href: "/femme", image: img.heroA },
    { eyebrow: "Horlogerie d'Exception", title: "Casio", subtitle: "Edifice", description: "L'élégance intemporelle rencontre le design contemporain.", cta: "Découvrir", href: "/marques", image: img.heroB },
    { eyebrow: "Service Expert", title: "Entretien &", subtitle: "Réparation", description: "Confiez votre montre à nos horlogers experts. Un savoir-faire artisanal depuis trois générations.", cta: "En Savoir Plus", href: "/service-client", image: img.heroC },
  ];
  const existingHeroes = (
    await q(`SELECT id FROM banners WHERE placement = 'home_hero' AND deleted_at IS NULL ORDER BY display_order, created_at`)
  ).rows as { id: string }[];
  for (let i = 0; i < heroSlides.length; i++) {
    const s = heroSlides[i];
    if (existingHeroes[i]) {
      await q(
        `UPDATE banners SET eyebrow=$1, title=$2, subtitle=$3, description=$4, cta_label=$5, cta_href=$6, image_media_id=$7, is_active=true, updated_at=now() WHERE id=$8`,
        [s.eyebrow, s.title, s.subtitle, s.description, s.cta, s.href, s.image, existingHeroes[i].id],
      );
    } else {
      await q(
        `INSERT INTO banners (placement, name, eyebrow, title, subtitle, description, cta_label, cta_href, image_media_id, display_order, is_active, created_at, updated_at)
         VALUES ('home_hero', $1, $2, $3, $4, $5, $6, $7, $8, $9, true, now(), now())`,
        [`Hero — ${s.title} ${s.subtitle}`, s.eyebrow, s.title, s.subtitle, s.description, s.cta, s.href, s.image, i],
      );
    }
  }
  console.log(`[seed-design] refreshed ${heroSlides.length} home_hero slides`);

  console.log("[seed-design] done.");
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed-design] error:", e);
  process.exit(1);
});
