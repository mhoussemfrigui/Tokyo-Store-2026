import "server-only";

/**
 * Médiathèque orphans total — `countOrphans()` (modules/media/queries.ts).
 *
 * The orphans view loads only the newest `listOrphans(200)`, and used to force
 * its total to 0, so « 200 fichiers » read as EVERY orphan. `countOrphans()`
 * now feeds the « N affichés sur M » notice; it shares listOrphans' anti-join
 * (orphanMediaWhere), so the two must always agree. Pin:
 *   - countOrphans() === the uncapped listOrphans() length;
 *   - a fresh unreferenced row is counted, a referenced one (a `*_media_id`
 *     setting) and a tombstoned one are not — and the count follows.
 *
 * The count is global (other suites may add media concurrently), so each
 * count-vs-list agreement is re-sampled a few times before failing.
 *
 * Self-cleaning (`zztest-orph-` filenames, `zztest.orph_*_media_id` setting).
 *
 * Run (isolated DB only):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/media-orphans-count.test.ts
 */
import { randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { site_settings } from "@/modules/cms/setting/schema";
import { countOrphans, listOrphans } from "@/modules/media/queries";
import { media } from "@/modules/media/schema";

const TAG = "zztest-orph-";
const SETTING_KEY = "zztest.orph_hero_media_id";
/** Far above any real library — "uncapped" for the agreement check. */
const UNCAPPED = 1_000_000;

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

async function cleanup() {
  await db.delete(site_settings).where(eq(site_settings.key, SETTING_KEY));
  await db.delete(media).where(like(media.filename, `${TAG}%`));
}

/** count vs uncapped list, re-sampled to ride out concurrent suites. */
async function countMatchesList(): Promise<{ ok: boolean; count: number; listed: string[] }> {
  let last = { ok: false, count: -1, listed: [] as string[] };
  for (let attempt = 0; attempt < 3; attempt++) {
    const [count, rows] = await Promise.all([countOrphans(), listOrphans(UNCAPPED)]);
    last = { ok: count === rows.length, count, listed: rows.map((r) => r.id) };
    if (last.ok) return last;
  }
  return last;
}

async function insertMedia(n: number): Promise<string[]> {
  const rows = await db
    .insert(media)
    .values(
      Array.from({ length: n }, () => {
        const key = `uploads/${randomUUID()}-${TAG}x.jpg`;
        return {
          storage_key: key,
          url: `/cdn/${key}`,
          filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
          mime_type: "image/jpeg",
          size_bytes: 1234,
        };
      }),
    )
    .returning({ id: media.id });
  return rows.map((r) => r.id);
}

async function main() {
  await cleanup();
  try {
    console.log("countOrphans ⇔ listOrphans:");
    const base = await countMatchesList();
    check(`baseline: count (${base.count}) = uncapped list length`, base.ok);
    check("countOrphans returns a finite number", Number.isFinite(base.count) && base.count >= 0);

    const [free, referenced, tombstoned] = await insertMedia(3);

    const afterInsert = await countMatchesList();
    check("after inserting 3 unreferenced rows: count = list length", afterInsert.ok);
    check(
      "…all 3 are listed as orphans",
      [free, referenced, tombstoned].every((id) => afterInsert.listed.includes(id)),
    );
    check("…and the total grew by at least 3", afterInsert.count >= base.count + 3);

    // A `*_media_id` setting is a reference source → no longer an orphan.
    await db.insert(site_settings).values({
      key: SETTING_KEY,
      value: referenced,
      label: "zztest orphan reference",
    });
    // A tombstoned row is never listed (nor counted).
    await db.update(media).set({ deleted_at: new Date() }).where(inArray(media.id, [tombstoned]));

    const afterRefs = await countMatchesList();
    check("after a reference + a tombstone: count = list length", afterRefs.ok);
    check("…the unreferenced row is still an orphan", afterRefs.listed.includes(free));
    check("…the setting-referenced row is not", !afterRefs.listed.includes(referenced));
    check("…the tombstoned row is not", !afterRefs.listed.includes(tombstoned));

    // Capped list vs total: the notice's premise (M can exceed the page).
    const capped = await listOrphans(1);
    check("listOrphans(1) caps the page while countOrphans keeps the total", capped.length <= 1 && afterRefs.count >= 1);
  } finally {
    await cleanup();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
