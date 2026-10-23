/**
 * De-duplicate per-product gallery images that are the SAME source photo at
 * different resolutions.
 *
 * The demo catalogue was imported from the tokyostore.xml feed, whose `image_link`
 * and `additional_image_link` frequently point at the SAME photo served at two
 * sizes (e.g. an 800x800 main + a 250x250 thumbnail). The importer attached
 * both, so a product's gallery shows the same photo twice — once crisp, once
 * blurry. This script collapses those duplicates.
 *
 * For each product it groups that product's `product_media` rows by the
 * NORMALIZED base filename of `media.storage_key`:
 *
 *   products/<uuid>-smartec-v2-noir.jpg        →  smartec-v2-noir
 *   products/<uuid>-smartec-v2-noir-nobg.jpg   →  smartec-v2-noir   (white-bg sweep)
 *
 * i.e. strip the `<scope>/<uuid>-` prefix, strip a trailing `-nobg`, strip the
 * extension. Within any group that has >1 link it KEEPS only the largest media
 * by (width * height) and DELETES the other `product_media` link rows (the
 * `media` rows / S3 objects are left alone — they may be referenced elsewhere
 * and this script only prunes the gallery LINKS). Products whose images all
 * have distinct base filenames (genuine multi-angle shots) are untouched.
 *
 * Idempotent: after a run every group has exactly one link, so re-running is a
 * no-op. Logs how many duplicate links were removed.
 *
 *   pnpm tsx --env-file-if-exists=.env.local scripts/dedupe-product-images.ts [--dry]
 */
import { Pool } from "pg";

const DRY = process.argv.includes("--dry");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo",
});
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

// Standard 8-4-4-4-12 hex UUID (v4 / v7) — the random prefix `buildStorageKey`
// puts in front of every key (`<scope>/<uuid>-<safe-filename>`).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

/**
 * Normalize a storage_key down to its source base filename so the same photo at
 * different resolutions / with the `-nobg` white-bg sweep collapses to ONE key:
 *   1. drop the leading `<scope>/` path segment(s)
 *   2. drop the random `<uuid>-` prefix
 *   3. drop the file extension
 *   4. drop a trailing `-nobg` marker
 */
function normalizeBase(storageKey: string): string {
  // Last path segment (after the scope folder, e.g. "products/").
  const last = storageKey.replace(/^\/+/, "").split("/").pop() ?? storageKey;
  // Strip the random UUID prefix when present.
  const noUuid = last.replace(UUID_RE, "");
  // Strip the extension.
  const noExt = noUuid.replace(/\.[^./]+$/, "");
  // Strip a trailing "-nobg" white-bg marker.
  return noExt.replace(/-nobg$/i, "").toLowerCase();
}

type LinkRow = {
  link_id: string;
  product_id: string;
  media_id: string;
  is_primary: boolean;
  storage_key: string;
  width: number | null;
  height: number | null;
};

async function main() {
  // All product_media links joined to their (live) media row, ordered so we can
  // walk product-by-product. Skip soft-deleted media defensively.
  const rows = (
    await q(
      `SELECT pm.id AS link_id, pm.product_id, pm.media_id, pm.is_primary,
              m.storage_key, m.width, m.height
         FROM product_media pm
         JOIN media m ON m.id = pm.media_id
        WHERE m.deleted_at IS NULL
        ORDER BY pm.product_id`,
    )
  ).rows as LinkRow[];

  // Group links per product.
  const byProduct = new Map<string, LinkRow[]>();
  for (const r of rows) {
    const arr = byProduct.get(r.product_id);
    if (arr) arr.push(r);
    else byProduct.set(r.product_id, [r]);
  }

  const toDelete: string[] = []; // product_media link ids to remove
  let productsAffected = 0;

  for (const [, links] of byProduct) {
    // Group this product's links by normalized base filename.
    const groups = new Map<string, LinkRow[]>();
    for (const l of links) {
      const base = normalizeBase(l.storage_key);
      const g = groups.get(base);
      if (g) g.push(l);
      else groups.set(base, [l]);
    }

    let touched = false;
    for (const [, group] of groups) {
      if (group.length <= 1) continue; // distinct filename → genuine multi-angle, leave alone

      // Keep the largest by pixel area; ties → keep the primary, else the first.
      // Treat null width/height as 0 area so a sized variant always wins over an
      // unsized one.
      const area = (l: LinkRow) => (l.width ?? 0) * (l.height ?? 0);
      const keep = group.reduce((best, l) => {
        if (area(l) > area(best)) return l;
        if (area(l) === area(best) && l.is_primary && !best.is_primary) return l;
        return best;
      }, group[0]);

      for (const l of group) {
        if (l.link_id !== keep.link_id) {
          toDelete.push(l.link_id);
          touched = true;
        }
      }
    }
    if (touched) productsAffected++;
  }

  console.log(
    `[dedupe-images] scanned ${byProduct.size} product(s), ${rows.length} link(s); ` +
      `${toDelete.length} duplicate link(s) across ${productsAffected} product(s)` +
      `${DRY ? " (dry run — nothing deleted)" : ""}.`,
  );

  if (!DRY && toDelete.length > 0) {
    // Delete in chunks so the parameter list never gets unwieldy.
    const CHUNK = 500;
    let removed = 0;
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const slice = toDelete.slice(i, i + CHUNK);
      const res = await q(
        `DELETE FROM product_media WHERE id = ANY($1::uuid[])`,
        [slice],
      );
      removed += res.rowCount ?? 0;
    }
    console.log(`[dedupe-images] removed ${removed} duplicate product_media link(s).`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("[dedupe-images] fatal:", e);
  process.exit(1);
});
