import "server-only";

import { sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import {
  buildSeedBlocksJson,
  CONTACT_DEFAULTS,
  PAGES,
  seedMediaFiles,
  type Section,
} from "@/lib/bootstrap/system-content-pages.data";

/**
 * Auto-deploy the storefront's "system" content pages.
 *
 * These are operational pages every Tokyo Store deploy must ship with —
 * the Maison pages (Notre Histoire, Service Client, Nos Boutiques, Carrières,
 * À propos), the policy pages (Garantie & retours, Suivi de commande) and the
 * full CGV. They are seeded as ordinary CMS `pages` rows + sections so they:
 *   - deploy AUTOMATICALLY (this runs from `instrumentation.ts` on every boot);
 *   - render through the existing storefront renderers (`LegalPageRenderer` on
 *     the dedicated file routes — the Maison pages + `/cgv` — and the universal
 *     `/[slug]` resolver for the policy pages); and
 *   - stay fully EDITABLE at `/admin/cms/pages` afterwards.
 *
 * Idempotency (the whole reason this is safe to run on every boot):
 *   - page missing → insert it (+ its sections), published;
 *   - page exists, 0 sections, PRISTINE (never published, never edited — e.g.
 *     the `cgv` shell from migration 0061) → populate + publish;
 *   - page exists with sections, OR emptied / edited by an admin → SKIP (never
 *     clobber edits, never re-publish a page an admin emptied), unless `force`;
 *   - `force` → refresh title/meta + replace sections.
 * Every live row also gets its `is_system` flag re-synced from the data (the
 * route-bound Maison pages used to be seeded unprotected) — a structural fix,
 * so it doesn't bump `updated_at`.
 *
 * Each page is written in ONE transaction under a per-slug advisory lock: a
 * crash / SIGTERM mid-seed rolls back (no permanently partial page that the
 * idempotency rule would then skip forever), and two instances booting at once
 * (rolling deploy) can't interleave DELETE + INSERTs into duplicated sections.
 *
 * The page COPY lives in `system-content-pages.data.ts` (a pure module with no
 * server-only / DB deps) so the dev re-seed script can share it verbatim.
 */

/** Resolve up to N watch packshots for page heroes (null on a productless deploy). */
async function resolveHeroMedia(): Promise<(string | null)[]> {
  try {
    const rows = (
      await db.execute<{ id: string }>(sql`
        SELECT m.id FROM media m
        JOIN product_media pm ON pm.media_id = m.id
        JOIN products p ON p.id = pm.product_id
        JOIN product_categories pc ON pc.product_id = p.id
        JOIN categories c ON c.id = pc.category_id AND c.slug IN ('femme','homme')
        WHERE m.kind = 'image' AND m.webp_url IS NOT NULL AND m.deleted_at IS NULL
          AND COALESCE(m.width, 0) >= 400 AND p.name NOT ILIKE '%zippo%'
        GROUP BY m.id ORDER BY m.id LIMIT 6
      `)
    ).rows;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/** Resolve the médiathèque files the block seeds reference by FILENAME (e.g. the demo
 *  lifestyle photos) → id, in one query (first upload wins). Empty on a fresh deploy
 *  without those files — the blocks then render their no-image layout. */
async function resolveSeedFiles(): Promise<Map<string, string>> {
  const files = seedMediaFiles(PAGES);
  if (files.length === 0) return new Map();
  try {
    const rows = (
      await db.execute<{ id: string; filename: string }>(sql`
        SELECT DISTINCT ON (filename) id, filename FROM media
        WHERE deleted_at IS NULL AND kind = 'image'
          AND filename IN (${sql.join(files.map((f) => sql`${f}`), sql`, `)})
        ORDER BY filename, created_at ASC
      `)
    ).rows;
    return new Map(rows.map((r) => [r.filename, r.id]));
  } catch {
    return new Map();
  }
}

async function insertSections(
  exec: DbOrTx,
  pageId: string,
  sections: Section[],
  heroes: (string | null)[],
) {
  let order = 0;
  for (const s of sections) {
    const sec = (
      await exec.execute<{ id: string }>(sql`
        INSERT INTO page_sections (page_id, type, display_order, is_visible, created_at, updated_at)
        VALUES (${pageId}, ${s.type}, ${order++}, true, now(), now()) RETURNING id
      `)
    ).rows[0];

    if (s.type === "hero") {
      const img = s.heroIndex != null ? heroes[s.heroIndex % Math.max(heroes.length, 1)] ?? null : null;
      await exec.execute(sql`
        INSERT INTO hero_sections (page_section_id, eyebrow, title, subtitle, description, image_media_id, primary_cta_label, primary_cta_href)
        VALUES (${sec.id}, ${s.eyebrow ?? null}, ${s.title}, ${s.subtitle ?? null}, ${s.description ?? null}, ${img}, ${s.ctaLabel ?? null}, ${s.ctaHref ?? null})
      `);
    } else if (s.type === "text") {
      await exec.execute(sql`
        INSERT INTO text_sections (page_section_id, heading, body, alignment)
        VALUES (${sec.id}, ${s.heading ?? null}, ${s.body}, 'left')
      `);
    } else if (s.type === "cta") {
      await exec.execute(sql`
        INSERT INTO cta_sections (page_section_id, title, description, primary_cta_label, primary_cta_href, style)
        VALUES (${sec.id}, ${s.title}, ${s.description ?? null}, ${s.ctaLabel}, ${s.ctaHref}, ${s.style ?? "dark"})
      `);
    } else if (s.type === "stats") {
      await exec.execute(sql`
        INSERT INTO stats_sections (page_section_id, heading, layout)
        VALUES (${sec.id}, ${s.heading ?? null}, ${s.layout ?? "grid"})
      `);
      let si = 0;
      for (const item of s.items) {
        await exec.execute(sql`
          INSERT INTO stats_section_items (stats_section_id, label, value, caption, display_order)
          VALUES (${sec.id}, ${item.label}, ${item.value}, ${item.caption ?? null}, ${si++})
        `);
      }
    } else if (s.type === "timeline") {
      await exec.execute(sql`
        INSERT INTO timeline_sections (page_section_id, heading) VALUES (${sec.id}, ${s.heading ?? null})
      `);
      let ti = 0;
      for (const item of s.items) {
        await exec.execute(sql`
          INSERT INTO timeline_section_items (timeline_section_id, year, title, description, display_order)
          VALUES (${sec.id}, ${item.year}, ${item.title}, ${item.description ?? null}, ${ti++})
        `);
      }
    }
  }
}

async function ensureContactDefaults(force: boolean) {
  for (const c of CONTACT_DEFAULTS) {
    if (force) {
      await db.execute(sql`
        INSERT INTO site_settings (key, value, type, group_key, label)
        VALUES (${c.key}, ${c.value}, 'text', ${c.group}, ${c.label})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `);
    } else {
      await db.execute(sql`
        INSERT INTO site_settings (key, value, type, group_key, label)
        VALUES (${c.key}, ${c.value}, 'text', ${c.group}, ${c.label})
        ON CONFLICT (key) DO NOTHING
      `);
    }
  }
}

/**
 * Seed/refresh the system content pages + contact defaults.
 *
 * @param opts.force  when true, REPLACE existing page sections (used by the dev
 *                    re-seed script). Default false = safe insert-if-missing.
 */
export async function ensureSystemContentPages(opts: { force?: boolean } = {}): Promise<void> {
  const force = opts.force ?? false;
  const heroes = await resolveHeroMedia();
  // Resolve a page-hero média by index (for the hand-authored block seeds), mirroring
  // insertSections' per-hero logic so a page's relational hero and its block hero pick
  // the same packshot.
  const heroImg = (i?: number): string | null =>
    i == null ? null : heroes[i % Math.max(heroes.length, 1)] ?? null;
  const seedFiles = await resolveSeedFiles();
  const fileImg = (f: string): string | null => seedFiles.get(f) ?? null;
  let seeded = 0;

  for (const page of PAGES) {
    const didSeed = await db.transaction(async (tx) => {
      // Serialise concurrent boots per slug for the whole probe → write →
      // sections sequence (the lock also covers the "row doesn't exist yet"
      // case a FOR UPDATE can't). Released at commit / rollback.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`system-page:${page.slug}`}))`);

      // Probe WITHOUT a deleted_at filter: `pages_slug_unique` is a TOTAL unique
      // index, so there is at most one row per slug — live OR soft-deleted. We
      // must see the tombstone, both to respect a deliberate admin deletion and
      // to avoid a bare INSERT colliding with it (23505).
      const existing = (
        await tx.execute<{
          id: string;
          tombstoned: boolean;
          is_system: boolean;
          pristine: boolean;
          section_count: number;
        }>(sql`
          SELECT p.id, (p.deleted_at IS NOT NULL) AS tombstoned, p.is_system,
                 (p.published_at IS NULL AND p.updated_at = p.created_at) AS pristine,
                 (SELECT count(*)::int FROM page_sections s WHERE s.page_id = p.id) AS section_count
          FROM pages p WHERE p.slug = ${page.slug} LIMIT 1
          FOR UPDATE OF p
        `)
      ).rows[0];

      let pageId: string;
      if (existing) {
        // An admin soft-deleted this page → respect that; don't resurrect it.
        if (existing.tombstoned) return false;
        // Re-sync the protection flag (a route-bound page must be undeletable).
        if (existing.is_system !== page.isSystem) {
          await tx.execute(sql`UPDATE pages SET is_system = ${page.isSystem} WHERE id = ${existing.id}`);
        }
        // Populated, or emptied / edited / published by an admin → never
        // clobber (or silently re-publish) it, unless force.
        if (!force && (existing.section_count > 0 || !existing.pristine)) return false;
        // Pristine shell (e.g. the migration-0061 cgv row) or a forced refresh.
        pageId = existing.id;
        await tx.execute(sql`
          UPDATE pages SET title = ${page.title}, meta_title = ${page.metaTitle},
            meta_description = ${page.metaDescription}, is_published = true, published_at = now(),
            is_system = ${page.isSystem}, noindex = ${page.noindex ?? false}, updated_at = now()
          WHERE id = ${pageId}
        `);
        await tx.execute(sql`DELETE FROM page_sections WHERE page_id = ${pageId}`);
      } else {
        // ON CONFLICT DO NOTHING stays as a backstop (the advisory lock already
        // serialises this path against a concurrent boot): the loser gets no
        // row back and defers to the winner, which seeds the sections.
        const ins = (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO pages (slug, title, meta_title, meta_description, is_published, published_at, is_system, noindex, created_at, updated_at)
            VALUES (${page.slug}, ${page.title}, ${page.metaTitle}, ${page.metaDescription}, true, now(), ${page.isSystem}, ${page.noindex ?? false}, now(), now())
            ON CONFLICT (slug) DO NOTHING
            RETURNING id
          `)
        ).rows[0];
        if (!ins) return false; // lost the race — the concurrent winner seeds it
        pageId = ins.id;
      }

      // A page defines EITHER rich composer blocks (→ the authoritative `pages.blocks`
      // JSON column, fully editable in /admin/cms/pages) OR the legacy relational sections.
      // When it carries blocks, write the serialised layout and leave page_sections empty
      // (the render + admin both read the blocks column first).
      if (page.blocks && page.blocks.length > 0) {
        await tx.execute(
          sql`UPDATE pages SET blocks = ${buildSeedBlocksJson(page.blocks, heroImg, fileImg)} WHERE id = ${pageId}`,
        );
      } else {
        // Section-based page: keep the blocks column NULL so the render/admin fall through
        // to the relational sections (a forced refresh also clears any prior block JSON).
        await tx.execute(sql`UPDATE pages SET blocks = NULL WHERE id = ${pageId}`);
        await insertSections(tx, pageId, page.sections ?? [], heroes);
      }
      return true;
    });
    if (didSeed) seeded++;
  }

  await ensureContactDefaults(force);

  if (seeded > 0 || force) {
    console.log(
      `[system-pages] ensured ${seeded}/${PAGES.length} content page(s) + contact defaults${force ? " (force)" : ""}.`,
    );
  }
}
