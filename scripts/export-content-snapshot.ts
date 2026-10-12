/**
 * Build-time EXPORT of the current store CONTENT → public/demo-assets/tokyo-content.json.
 *
 * Captures the site's content "exactly as is" from the DEV DB so the one-click
 * "Import data → Contenu" reproduces it verbatim on a fresh prod DB:
 *   site_settings (home.blocks / theme / footer / nav config / identity / SEO / …),
 *   pages, banners, nav_menus, nav_items, faq_categories, faqs.
 *
 * MEDIA REMAP: content references médiathèque media by UUID, which won't exist in a
 * fresh DB. Every media id is rewritten to a stable token `@@IMG:<stem>@@` where
 * `<stem>` is the image's logical name (storage_key basename, uuid-prefix + extension
 * stripped) — which matches a bundled `public/demo-assets/<stem>.<ext>` file. The
 * apply step (seedContentSnapshot) uploads that file and substitutes the new media id.
 *
 * CATEGORY REMAP: a few content rows soft-link a CATEGORY by its UUID (e.g. a
 * help FAQ tagged `faqs.category_id`), which also won't survive a reseed (the
 * catalog tree gets fresh ids). Those ids are rewritten to `@@CAT:<slug>@@`
 * (category slugs ARE stable — they come from `CATALOG_TREE`), and the apply
 * step resolves the slug back to the freshly-seeded category id (null when the
 * tree isn't present yet, e.g. a content-only import). Category/brand/collection
 * references elsewhere in the snapshot are by SLUG already (nav `internal_ref`,
 * home blocks) and need no remap — only raw UUIDs do.
 *
 * SECRETS: site_settings here are content/config only (verified: no key|secret|
 * password|token|_enc|api|webhook|oauth matches); provider credentials live in
 * dedicated tables (payment/oauth/ai provider settings) that are NOT exported.
 *
 * Re-run after CMS edits:
 *   npx tsx --env-file-if-exists=.env.development.local scripts/export-content-snapshot.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";

const CONTENT_TABLES = [
  "site_settings",
  "pages",
  "banners",
  "nav_menus",
  "nav_items",
  "faq_categories",
  "faqs",
] as const;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SECRET_KEY_RE = /key|secret|password|token|_enc|resend|smtp|\bapi\b|webhook|oauth|credential/i;

async function main(): Promise<void> {
  // media id → logical stem (storage_key basename, uuid-prefix + extension stripped)
  const media = (await db.execute(
    sql`select id::text as id, storage_key from media`,
  )).rows as { id: string; storage_key: string }[];
  const idToStem = new Map<string, string>();
  for (const m of media) {
    const base = (m.storage_key ?? "").split("/").pop() ?? "";
    const stem = base.replace(/^[0-9a-f-]{36}-/i, "").replace(/\.[a-z0-9]+$/i, "");
    if (stem) idToStem.set(m.id.toLowerCase(), stem);
  }

  // category id → slug (slugs are stable across reseeds — see CATALOG_TREE)
  const cats = (await db.execute(
    sql`select id::text as id, slug from categories where deleted_at is null`,
  )).rows as { id: string; slug: string }[];
  const idToCatSlug = new Map<string, string>();
  for (const c of cats) if (c.slug) idToCatSlug.set(c.id.toLowerCase(), c.slug);

  const tokenize = (s: string): string =>
    s.replace(UUID_RE, (id) => {
      const low = id.toLowerCase();
      const stem = idToStem.get(low);
      if (stem) return `@@IMG:${stem}@@`;
      const slug = idToCatSlug.get(low);
      if (slug) return `@@CAT:${slug}@@`;
      return id;
    });

  // Category slugs removed by the Homme/Femme/Enfants × Montres/Accessoires reshape —
  // any nav item still targeting one is dropped so the snapshot has no dead links.
  const DEAD_CATEGORY_SLUGS = new Set([
    "accessoires",
    "bracelets",
    "ceintures",
    "sacs-a-main",
    "portefeuilles",
    "colliers",
    "briquets",
  ]);

  const out: Record<string, unknown> = {};
  let settingsSafe = 0;
  let navDropped = 0;
  for (const t of CONTENT_TABLES) {
    let rows = (await db.execute(sql`select row_to_json(x) as j from ${sql.identifier(t)} x`)).rows.map(
      (r) => (r as { j: unknown }).j,
    );
    if (t === "site_settings") {
      // Defence in depth: drop any row whose key looks secret (none expected).
      rows = (rows as { key: string }[]).filter((r) => !SECRET_KEY_RE.test(r.key));
      settingsSafe = rows.length;
    }
    if (t === "nav_items") {
      const before = rows.length;
      rows = (rows as { internal_kind?: string; internal_ref?: string }[]).filter(
        (r) => !(r.internal_kind === "category" && r.internal_ref && DEAD_CATEGORY_SLUGS.has(r.internal_ref)),
      );
      navDropped = before - rows.length;
    }
    out[t] = JSON.parse(tokenize(JSON.stringify(rows)));
  }
  if (navDropped) console.log(`  reconciled: dropped ${navDropped} nav item(s) targeting removed categories`);

  // Manifest of the image stems the apply step must upload + remap.
  const serialized = JSON.stringify(out);
  const stems = new Set<string>();
  for (const m of serialized.matchAll(/@@IMG:([^@]+)@@/g)) stems.add(m[1]);
  out._images = [...stems].sort();
  // Manifest of the category slugs the apply step must resolve (soft-link remap).
  const catSlugs = new Set<string>();
  for (const m of serialized.matchAll(/@@CAT:([^@]+)@@/g)) catSlugs.add(m[1]);
  out._categoryRefs = [...catSlugs].sort();
  out._exportedAt = new Date().toISOString();

  const dest = join(process.cwd(), "public", "demo-assets", "tokyo-content.json");
  writeFileSync(dest, JSON.stringify(out));
  const counts = CONTENT_TABLES.map((t) => `${t}=${(out[t] as unknown[]).length}`).join(", ");
  console.log(`content snapshot → ${dest}`);
  console.log(`  ${counts}`);
  console.log(`  settings kept: ${settingsSafe}  image stems: ${[...stems].length} (${[...stems].join(", ")})`);
  console.log(`  category refs: ${[...catSlugs].length} (${[...catSlugs].join(", ") || "none"})`);
  await db.$client.end?.().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
