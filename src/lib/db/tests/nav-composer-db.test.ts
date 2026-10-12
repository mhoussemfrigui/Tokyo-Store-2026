import "server-only";

/**
 * Nav composer DB seam — the média-reference guard for nav_items.config image
 * blocks. A média id placed in a nav root's dropdown config MUST be seen by
 * listReferencedMediaIds / countMediaReferences (the destructive-sweep guard),
 * or a demo clear / orphan purge would hard-delete an in-use mega-menu image.
 *
 * Self-cleaning (zztest-navcomposer prefix). Run (isolated DB):
 *   pnpm exec tsx --conditions=react-server --env-file=.env.development.local \
 *     src/lib/db/tests/nav-composer-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { media } from "@/modules/media/schema";
import { nav_menus, nav_items } from "@/modules/cms/navigation/schema";
import { countMediaReferences, listReferencedMediaIds } from "@/modules/media/queries";
import { serializeNavConfig } from "@/lib/cms/nav-composer-model";

const TAG = "zztest-navcomposer";
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
  await db.execute(sql`DELETE FROM nav_items WHERE menu_id IN (SELECT id FROM nav_menus WHERE key LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM nav_menus WHERE key LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM media WHERE filename LIKE ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  const base = `nav/${randomUUID()}-${TAG}`;
  const [m] = await db
    .insert(media)
    .values({
      storage_key: `${base}.jpg`,
      url: `/cdn/${base}.jpg`,
      filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
      mime_type: "image/jpeg",
      size_bytes: 1000,
    } as never)
    .returning({ id: media.id });

  const mobileBase = `nav/${randomUUID()}-${TAG}`;
  const [mobile] = await db
    .insert(media)
    .values({
      storage_key: `${mobileBase}.jpg`,
      url: `/cdn/${mobileBase}.jpg`,
      filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
      mime_type: "image/jpeg",
      size_bytes: 1000,
    } as never)
    .returning({ id: media.id });

  console.log("nav config média seam:");
  check("baseline: an unreferenced média is NOT referenced", !(await listReferencedMediaIds([m.id])).has(m.id));

  const [menu] = await db
    .insert(nav_menus)
    .values({ key: `${TAG}-menu`, name: "Test" } as never)
    .returning({ id: nav_menus.id });
  const config = serializeNavConfig({
    mobileVisible: true,
    columns: [{ blocks: [{ type: "image", mediaId: m.id, mediaMobileId: mobile.id, showOnMobile: true }] }],
  });
  const [item] = await db
    .insert(nav_items)
    .values({ menu_id: menu.id, label: "Root", display_order: 0, config } as never)
    .returning({ id: nav_items.id });

  check("a média in a nav image block IS referenced (protected from reclaim)", (await listReferencedMediaIds([m.id])).has(m.id));
  check("the mobile-variant média id is ALSO referenced", (await listReferencedMediaIds([mobile.id])).has(mobile.id));
  check("countMediaReferences counts the nav config reference", (await countMediaReferences(m.id)) >= 1);

  await db.delete(nav_items).where(eq(nav_items.id, item.id));
  check("after the nav_item is deleted, the média is reclaimable again", !(await listReferencedMediaIds([m.id])).has(m.id));
  check("…and countMediaReferences is back to 0", (await countMediaReferences(m.id)) === 0);

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
