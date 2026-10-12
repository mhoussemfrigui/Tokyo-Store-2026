import "server-only";

/**
 * System pages (the editable CMS content/info + legal pages) protection
 * invariant: is_system pages cannot be deleted, and their slug cannot be changed
 * (the storefront resolves them by slug) — but every other edit (title / meta /
 * sections / publish) is allowed. A custom page deletes normally. Guards live in
 * deletePageWorkflow + updatePageWorkflow. Self-cleaning (`zztest-syspage`).
 *
 * The content/info + legal pages are NO LONGER dedicated file routes: they are
 * CMS "system pages" (apropos, recrutement, aide, livraison, garantie, mentions,
 * cgv, cgu, confidentialite, cookies) seeded on every boot — published +
 * is_system — and served by the `(shop)/(tokyo)/[slug]` resolver. Their slugs are
 * reserved via CMS_SYSTEM_PAGE_SLUGS so no other entity can claim them.
 *
 * Plus the boot bootstrap (ensureSystemContentPages) contract:
 *   - the seeded set is exactly CMS_SYSTEM_PAGE_SLUGS, each `isSystem`, and the
 *     flag is re-synced onto existing rows;
 *   - a 0-section page is re-populated ONLY while pristine (never published,
 *     never edited) — one an admin emptied is never overwritten / re-published.
 * Those run against a real seeded slug (`apropos`): the live row is parked under
 * a zztest slug for the duration and restored afterwards.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/system-pages.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { ensureSystemContentPages } from "@/lib/bootstrap/system-content-pages";
import { PAGES } from "@/lib/bootstrap/system-content-pages.data";
import { CMS_SYSTEM_PAGE_SLUGS } from "@/lib/pages/reserved-routes";
import { pageService } from "@/modules/cms/page/service";
import { workflows } from "@/workflows";

const TAG = "zztest-syspage";
/** Real seeded CMS system-page slug used for the bootstrap checks (served by /[slug]). */
const SEED_SLUG = "apropos";
const PARKED_SLUG = `${TAG}-parked`;

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
  // Restore a parked live seed row first (drop the test stand-in), then sweep.
  const parked = await db.execute(sql`select 1 from pages where slug = ${PARKED_SLUG}`);
  if (parked.rows.length > 0) {
    await db.execute(sql`delete from pages where slug = ${SEED_SLUG}`);
    await db.execute(sql`update pages set slug = ${SEED_SLUG} where slug = ${PARKED_SLUG}`);
  }
  await db.execute(sql`delete from pages where slug like ${TAG + "%"}`);
}

async function seedRow(slug: string) {
  return (
    await db.execute<{ is_system: boolean; is_published: boolean; sections: number; blocks: string | null }>(sql`
      select p.is_system, p.is_published, p.blocks,
             (select count(*)::int from page_sections s where s.page_id = p.id) as sections
      from pages p where p.slug = ${slug} and p.deleted_at is null
    `)
  ).rows[0];
}

/** A page is populated either relationally (page_sections) or via the composer (blocks
 *  JSON). Count whichever representation the seed uses so the bootstrap checks hold for
 *  both a legacy section page and a rich block page. */
function blockCount(blocks: string | null | undefined): number {
  if (!blocks) return 0;
  try {
    const arr = JSON.parse(blocks);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

async function main() {
  await cleanup();

  // ── a system page is protected ───────────────────────────────────────────
  const sys = await pageService.insert({ slug: `${TAG}-sys`, title: "Sys", is_system: true });

  const delSys = await workflows.cms.deletePage({ pageId: sys.id });
  check("delete of a system page is refused (forbidden)", delSys.ok === false && (delSys as { error?: string }).error === "forbidden");
  check("system page still exists after refused delete", (await pageService.findById(sys.id)) !== null);

  const slugChange = await workflows.cms.updatePage({ pageId: sys.id, slug: `${TAG}-renamed` });
  check("slug change on a system page is refused", slugChange.ok === false && (slugChange as { error?: string }).error === "forbidden");

  const titleChange = await workflows.cms.updatePage({ pageId: sys.id, title: "Nouveau titre" });
  check("title change on a system page is allowed", titleChange.ok === true);
  check("system page slug unchanged", (await pageService.findById(sys.id))?.slug === `${TAG}-sys`);

  // ── a custom page deletes normally ───────────────────────────────────────
  const custom = await pageService.insert({ slug: `${TAG}-custom`, title: "Custom", is_system: false });
  const delCustom = await workflows.cms.deletePage({ pageId: custom.id });
  check("delete of a custom page succeeds", delCustom.ok === true);

  // ── the CMS system pages are the expected seeded set (pure invariant) ─────
  // The content/info + legal pages are no longer dedicated file routes: they are
  // editable CMS system pages, seeded on boot (published + is_system) and served
  // by `(shop)/(tokyo)/[slug]`. Assert the seed data carries exactly the reserved
  // CMS_SYSTEM_PAGE_SLUGS, each protected (isSystem). Publication is proven by the
  // pristine-shell bootstrap check (b) below.
  const EXPECTED_SYSTEM_SLUGS = [
    "apropos",
    "recrutement",
    "aide",
    "livraison",
    "garantie",
    "mentions",
    "cgv",
    "cgu",
    "confidentialite",
    "cookies",
  ] as const;
  const seedSlugs = new Set(PAGES.map((p) => p.slug));
  for (const slug of EXPECTED_SYSTEM_SLUGS) {
    const seed = PAGES.find((p) => p.slug === slug);
    check(`CMS system page « ${slug} » is seeded`, seed != null);
    check(`CMS system page « ${slug} » is isSystem`, seed?.isSystem === true);
    check(`CMS system page « ${slug} » is reserved via CMS_SYSTEM_PAGE_SLUGS`, CMS_SYSTEM_PAGE_SLUGS.has(slug));
  }
  // The seed set and the reserved set must not drift — no stale content-page seeds,
  // no reserved slug missing a seed.
  check(
    "the seeded set === CMS_SYSTEM_PAGE_SLUGS (no stale / missing system pages)",
    seedSlugs.size === CMS_SYSTEM_PAGE_SLUGS.size &&
      [...seedSlugs].every((s) => CMS_SYSTEM_PAGE_SLUGS.has(s)) &&
      [...CMS_SYSTEM_PAGE_SLUGS].every((s) => seedSlugs.has(s)),
  );

  // ── bootstrap: is_system re-sync + pristine-only reseed ──────────────────
  // Park the live seed row (if any) so the stand-ins below own the slug.
  await db.execute(sql`update pages set slug = ${PARKED_SLUG} where slug = ${SEED_SLUG}`);
  const seed = PAGES.find((p) => p.slug === SEED_SLUG)!;

  // (a) An admin-EMPTIED page (published before, 0 sections, unprotected) is
  //     re-flagged but neither re-populated nor re-published.
  await db.execute(sql`
    insert into pages (slug, title, is_published, published_at, is_system, created_at, updated_at)
    values (${SEED_SLUG}, 'Vidée', false, now() - interval '1 day', ${!seed.isSystem},
            now() - interval '2 days', now() - interval '1 day')
  `);
  await ensureSystemContentPages();
  const emptied = await seedRow(SEED_SLUG);
  check("bootstrap re-syncs is_system on an existing row", emptied?.is_system === seed.isSystem);
  check("an admin-emptied page is NOT re-populated", emptied?.sections === 0 && blockCount(emptied?.blocks) === 0);
  check("an admin-emptied page is NOT re-published", emptied?.is_published === false);

  // (b) A PRISTINE shell (never published, never edited) IS populated + published.
  await db.execute(sql`delete from pages where slug = ${SEED_SLUG}`);
  await db.execute(sql`
    insert into pages (slug, title, is_published, is_system) values (${SEED_SLUG}, 'Shell', false, true)
  `);
  await ensureSystemContentPages();
  const shell = await seedRow(SEED_SLUG);
  // The seed may be relational (page_sections) or a composer block layout (blocks JSON);
  // assert on whichever representation it carries.
  const expectBlocks = (seed.blocks?.length ?? 0) > 0;
  const populatedUnits = (r: Awaited<ReturnType<typeof seedRow>> | undefined) =>
    expectBlocks ? blockCount(r?.blocks) : r?.sections ?? 0;
  const expectedUnits = expectBlocks ? seed.blocks!.length : seed.sections?.length ?? 0;
  check(
    `a pristine shell is populated with every seeded ${expectBlocks ? "block" : "section"}`,
    populatedUnits(shell) === expectedUnits,
  );
  check("a pristine shell is published", shell?.is_published === true);

  // (c) Idempotent: a second boot leaves the populated page alone (no duplicates).
  await ensureSystemContentPages();
  check(
    `a re-run adds no duplicate ${expectBlocks ? "blocks" : "sections"}`,
    populatedUnits(await seedRow(SEED_SLUG)) === expectedUnits,
  );

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
