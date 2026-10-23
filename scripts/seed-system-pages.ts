/**
 * Dev re-seed for the storefront's system content pages (Maison pages, policy
 * pages, CGV) + Tokyo contact defaults. FORCE replace: deletes each page by
 * slug (cascades to sections) and re-inserts from the shared content data, then
 * upserts the contact settings. Idempotent.
 *
 * Production deploys don't need this — `ensureSystemContentPages()` runs from
 * instrumentation.ts on every boot (insert-if-missing). This script is the
 * developer's "refresh the demo DB to the latest copy" button.
 *
 *   pnpm tsx --env-file-if-exists=.env.local scripts/seed-system-pages.ts
 */
import { Pool } from "pg";

import { assertDestructiveTargetAllowed } from "./_safety-guard";
import {
  buildSeedBlocksJson,
  CONTACT_DEFAULTS,
  PAGES,
  seedMediaFiles,
} from "../src/lib/bootstrap/system-content-pages.data";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo",
});
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

async function main() {
  assertDestructiveTargetAllowed(process.env.DATABASE_URL, "DELETE + reseed system pages");
  // A few watch packshots (Homme/Femme, non-Zippo) for the page heroes.
  const media = (
    await q(
      `SELECT m.id FROM media m
       JOIN product_media pm ON pm.media_id = m.id
       JOIN products p ON p.id = pm.product_id
       JOIN product_categories pc ON pc.product_id = p.id
       JOIN categories c ON c.id = pc.category_id AND c.slug IN ('femme','homme')
       WHERE m.kind = 'image' AND m.webp_url IS NOT NULL AND m.deleted_at IS NULL
         AND COALESCE(m.width,0) >= 400 AND p.name NOT ILIKE '%zippo%'
       GROUP BY m.id ORDER BY m.id LIMIT 6`,
    )
  ).rows as { id: string }[];
  const heroImg = (i: number | undefined) =>
    i == null ? null : media[i % Math.max(media.length, 1)]?.id ?? null;
  // Médiathèque files referenced by FILENAME in the block seeds (first upload wins).
  const fileRows = (
    await q(
      `SELECT DISTINCT ON (filename) id, filename FROM media
       WHERE deleted_at IS NULL AND kind = 'image' AND filename = ANY($1::text[])
       ORDER BY filename, created_at ASC`,
      [seedMediaFiles(PAGES)],
    )
  ).rows as { id: string; filename: string }[];
  const files = new Map(fileRows.map((r) => [r.filename, r.id]));
  const fileImg = (f: string) => files.get(f) ?? null;

  for (const page of PAGES) {
    // Idempotent: deleting the page cascades to sections + subtype rows.
    await q(`DELETE FROM pages WHERE slug = $1`, [page.slug]);
    const pageRow = (
      await q(
        `INSERT INTO pages (slug, title, meta_title, meta_description, is_published, published_at, is_system, noindex, created_at, updated_at)
         VALUES ($1,$2,$3,$4,true,now(),$5,$6,now(),now()) RETURNING id`,
        [page.slug, page.title, page.metaTitle, page.metaDescription, page.isSystem, page.noindex ?? false],
      )
    ).rows[0] as { id: string };

    // A page defines EITHER rich composer blocks (→ the pages.blocks JSON column) OR the
    // legacy relational sections — mirror the boot bootstrap so the two paths never drift.
    if (page.blocks && page.blocks.length > 0) {
      await q(`UPDATE pages SET blocks = $1 WHERE id = $2`, [
        buildSeedBlocksJson(page.blocks, heroImg, fileImg),
        pageRow.id,
      ]);
      console.log(`[seed-system-pages] published "${page.title}" (${page.blocks.length} blocks)`);
      continue;
    }

    let order = 0;
    for (const s of page.sections ?? []) {
      const sec = (
        await q(
          `INSERT INTO page_sections (page_id, type, display_order, is_visible, created_at, updated_at)
           VALUES ($1,$2,$3,true,now(),now()) RETURNING id`,
          [pageRow.id, s.type, order++],
        )
      ).rows[0] as { id: string };

      if (s.type === "hero") {
        await q(
          `INSERT INTO hero_sections (page_section_id, eyebrow, title, subtitle, description, image_media_id, primary_cta_label, primary_cta_href)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [sec.id, s.eyebrow ?? null, s.title, s.subtitle ?? null, s.description ?? null, heroImg(s.heroIndex), s.ctaLabel ?? null, s.ctaHref ?? null],
        );
      } else if (s.type === "text") {
        await q(`INSERT INTO text_sections (page_section_id, heading, body, alignment) VALUES ($1,$2,$3,'left')`, [sec.id, s.heading ?? null, s.body]);
      } else if (s.type === "cta") {
        await q(`INSERT INTO cta_sections (page_section_id, title, description, primary_cta_label, primary_cta_href, style) VALUES ($1,$2,$3,$4,$5,$6)`, [sec.id, s.title, s.description ?? null, s.ctaLabel, s.ctaHref, s.style ?? "dark"]);
      } else if (s.type === "stats") {
        await q(`INSERT INTO stats_sections (page_section_id, heading, layout) VALUES ($1,$2,$3)`, [sec.id, s.heading ?? null, s.layout ?? "grid"]);
        let si = 0;
        for (const item of s.items) {
          await q(`INSERT INTO stats_section_items (stats_section_id, label, value, caption, display_order) VALUES ($1,$2,$3,$4,$5)`, [sec.id, item.label, item.value, item.caption ?? null, si++]);
        }
      } else if (s.type === "timeline") {
        await q(`INSERT INTO timeline_sections (page_section_id, heading) VALUES ($1,$2)`, [sec.id, s.heading ?? null]);
        let ti = 0;
        for (const item of s.items) {
          await q(`INSERT INTO timeline_section_items (timeline_section_id, year, title, description, display_order) VALUES ($1,$2,$3,$4,$5)`, [sec.id, item.year, item.title, item.description ?? null, ti++]);
        }
      }
    }
    console.log(`[seed-system-pages] published "${page.title}" (${(page.sections ?? []).length} sections)`);
  }

  // Contact defaults — upsert to the real Tokyo coordinates.
  for (const c of CONTACT_DEFAULTS) {
    await q(
      `INSERT INTO site_settings (key, value, type, group_key, label)
       VALUES ($1,$2,'text',$3,$4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [c.key, c.value, c.group, c.label],
    );
  }
  console.log(`[seed-system-pages] upserted ${CONTACT_DEFAULTS.length} contact settings.`);

  console.log("[seed-system-pages] done.");
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed-system-pages] error:", e);
  process.exit(1);
});
