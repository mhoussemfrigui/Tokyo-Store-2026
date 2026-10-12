import "server-only";

/**
 * The page BLOCK render fallback chain (getPageForRender / getEditBlocks in
 * @/lib/pages/page-blocks-data), which every storefront page surface shares:
 *
 *   1. a NON-NULL blocks column is authoritative — even "[]" (an operator who
 *      cleared the composer): the legacy sections are NOT resurrected;
 *   2. a NULL blocks column (a page never saved in the composer) SYNTHESISES
 *      blocks from the legacy page_sections (non-destructive rollover);
 *   3. a system legal slug always renders ≥1 block (built-in default HTML), so
 *      cgu/cgv/cookies/privacy/mentions-legales/help are never blank;
 *   4. an unpublished CUSTOM slug renders nothing (getPageForRender → null).
 *
 * Self-cleaning (`zztest-render` slugs). Run against the isolated test DB:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/page-render-fallback.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { pageService } from "@/modules/cms/page/service";
import { page_sections, text_sections } from "@/modules/cms/page/schema";
import { getEditBlocks, getPageForRender } from "@/lib/pages/page-blocks-data";
import { SYSTEM_PAGE_SLUGS } from "@/lib/legal/system-page-content";

const TAG = "zztest-render";

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
  // CASCADE FKs sweep the section subtype rows when the page (and its
  // page_sections) go, but delete sections explicitly too for older baselines.
  await db.execute(
    sql`delete from page_sections where page_id in (select id from pages where slug like ${TAG + "%"})`,
  );
  await db.execute(sql`delete from pages where slug like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  // 1. NON-NULL blocks wins (published page with a saved composer layout).
  const withBlocks = await pageService.insert({
    slug: `${TAG}-blocks`,
    title: "Avec blocs",
    is_published: true,
    published_at: new Date(),
    blocks: JSON.stringify([
      { id: "b1", type: "rich_text", visible: true, config: { body: "<p>Composé</p>" } },
    ]),
  });
  const r1 = await getPageForRender(`${TAG}-blocks`);
  check(
    "stored blocks win: one rich_text block from pages.blocks",
    r1?.blocks.length === 1 && r1.blocks[0].type === "rich_text",
  );

  // 2. Cleared composer ("[]") on a CUSTOM slug → honoured (no section resurrection).
  const cleared = await pageService.insert({
    slug: `${TAG}-cleared`,
    title: "Vidé",
    is_published: true,
    published_at: new Date(),
    blocks: "[]",
  });
  const r2 = await getPageForRender(`${TAG}-cleared`);
  check("cleared custom page ([]) → zero blocks (no resurrection)", r2?.blocks.length === 0);
  check(
    "getEditBlocks mirrors the cleared state (authoritative empty list)",
    (await getEditBlocks({ id: cleared.id, slug: cleared.slug, blocks: "[]" })).length === 0,
  );

  // 3. NULL blocks + legacy sections → synthesis (non-destructive rollover).
  const legacy = await pageService.insert({
    slug: `${TAG}-legacy`,
    title: "Ancienne",
    is_published: true,
    published_at: new Date(),
    // blocks left NULL (never saved in the composer)
  });
  const [section] = await db
    .insert(page_sections)
    .values({ page_id: legacy.id, type: "text", display_order: 0, is_visible: true })
    .returning();
  await db.insert(text_sections).values({
    page_section_id: section.id,
    heading: null,
    body: "<p>Contenu hérité</p>",
    alignment: "left",
  });
  const r3 = await getPageForRender(`${TAG}-legacy`);
  check(
    "null blocks + a visible text section → synthesised rich_text block",
    r3?.blocks.length === 1 &&
      r3.blocks[0].type === "rich_text" &&
      r3.blocks[0].config.body === "<p>Contenu hérité</p>",
  );
  const edit3 = await getEditBlocks({ id: legacy.id, slug: legacy.slug, blocks: null });
  check("getEditBlocks synthesises the same legacy section", edit3.length === 1 && edit3[0].type === "rich_text");

  // A HIDDEN legacy section is not synthesised (synthesis keeps visible only).
  await db
    .update(page_sections)
    .set({ is_visible: false })
    .where(sql`id = ${section.id}`);
  const r3b = await getPageForRender(`${TAG}-legacy`);
  check("a hidden legacy section is dropped from synthesis", (r3b?.blocks.length ?? -1) === 0);

  // 4. Unpublished CUSTOM slug → null (no built-in default for a non-system slug).
  await pageService.insert({ slug: `${TAG}-draft`, title: "Brouillon", is_published: false });
  const r4 = await getPageForRender(`${TAG}-draft`);
  check("unpublished custom page → null (renders nothing)", r4 === null);

  // 5. Every SYSTEM slug renders at least one block (never blank), whatever its DB state.
  for (const slug of SYSTEM_PAGE_SLUGS) {
    const r = await getPageForRender(slug);
    check(`system slug "${slug}" renders ≥1 block`, (r?.blocks.length ?? 0) >= 1);
  }

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
