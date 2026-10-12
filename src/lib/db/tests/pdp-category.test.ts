import "server-only";

/**
 * Storefront category VISIBILITY — a category is public only when it AND every
 * live ancestor are active (deactivating a parent hides its whole subtree, the
 * way the mega menu already did). Covers the three storefront readers that must
 * agree, plus the PDP breadcrumb trail:
 *
 *  1. Pure rules: `isCategoryChainActive` (child → root chain) and
 *     `cutTrailAtInactive` (root → leaf trail cut before the first inactive node).
 *  2. `getCategoryBySlug` (flat /[slug] resolver, also the /[parent]/[sub]
 *     parent resolver): an active child / grand-child of a deactivated parent
 *     resolves to null (404) instead of staying public.
 *  3. `listSitemapCategories`: the same rows are dropped from the sitemap.
 *  4. `getStorefrontCategoryTrail` (PDP breadcrumb + BreadcrumbList): cut at the
 *     first deactivated node — `[]` when the root is off, `null` for an id that
 *     doesn't resolve (the PDP then falls back to the flat crumb).
 *  5. Orphan-as-root (soft-deleted parent) keeps an active child public, and a
 *     corrupt parent_id cycle terminates instead of looping.
 *
 * Self-cleaning (`zztest-pdpcat-*` slugs). Run ONLY against a disposable DB:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/pdp-category.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { categories } from "@/modules/catalog/category/schema";
import { categoryQueries } from "@/modules/catalog/category";

const TAG = "zztest-pdpcat";

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
  // Detach first so a parent row never blocks its child's delete (self-FK).
  await db.update(categories).set({ parent_id: null }).where(like(categories.slug, `${TAG}-%`));
  await db.delete(categories).where(like(categories.slug, `${TAG}-%`));
}

async function makeCategory(
  suffix: string,
  opts: { parentId?: string | null; active?: boolean } = {},
): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({
      slug: `${TAG}-${suffix}`,
      name: `${TAG} ${suffix}`,
      parent_id: opts.parentId ?? null,
      is_active: opts.active ?? true,
    } as never)
    .returning({ id: categories.id });
  return row.id;
}

const slugOf = (suffix: string) => `${TAG}-${suffix}`;

function pureRules() {
  console.log("1. pure rules:");
  const { isCategoryChainActive, cutTrailAtInactive } = categoryQueries;
  check("empty chain → not visible (nothing resolved)", !isCategoryChainActive([]));
  check(
    "all-active chain → visible",
    isCategoryChainActive([{ is_active: true }, { is_active: true }, { is_active: true }]),
  );
  check(
    "an inactive ANCESTOR hides the node",
    !isCategoryChainActive([{ is_active: true }, { is_active: false }, { is_active: true }]),
  );
  check("an inactive node itself → not visible", !isCategoryChainActive([{ is_active: false }]));

  const a = { slug: "a", is_active: true };
  const b = { slug: "b", is_active: false };
  const c = { slug: "c", is_active: true };
  const full = [a, { ...c, slug: "c2" }];
  const cutFull = cutTrailAtInactive(full);
  check(
    "all-active trail kept whole (as a copy)",
    cutFull.length === 2 && cutFull !== full && cutFull[1].slug === "c2",
  );
  check(
    "trail cut BEFORE the first inactive node (a › [b off] › c → a)",
    cutTrailAtInactive([a, b, c]).map((n) => n.slug).join(",") === "a",
  );
  check("inactive root → empty trail", cutTrailAtInactive([b, a, c]).length === 0);
  check("inactive leaf → its ancestors only", cutTrailAtInactive([a, c, b]).length === 2);
}

async function main() {
  pureRules();

  await cleanup();

  // Fixture tree:
  //   off (INACTIVE) › off-child › off-grand          → whole subtree hidden
  //   on › on-child                                    → public
  //   on › on-mid (INACTIVE) › on-mid-leaf             → mid + leaf hidden
  //   gone (SOFT-DELETED) › orphan                     → orphan public (root rule)
  //   cyc-a ⇄ cyc-b (corrupt parent_id cycle, active)  → terminates
  const off = await makeCategory("off", { active: false });
  const offChild = await makeCategory("off-child", { parentId: off });
  const offGrand = await makeCategory("off-grand", { parentId: offChild });
  const on = await makeCategory("on");
  const onChild = await makeCategory("on-child", { parentId: on });
  const onMid = await makeCategory("on-mid", { parentId: on, active: false });
  const onMidLeaf = await makeCategory("on-mid-leaf", { parentId: onMid });
  const gone = await makeCategory("gone");
  const orphan = await makeCategory("orphan", { parentId: gone });
  await db.update(categories).set({ deleted_at: sql`now()` }).where(eq(categories.id, gone));
  const cycA = await makeCategory("cyc-a");
  const cycB = await makeCategory("cyc-b", { parentId: cycA });
  await db.update(categories).set({ parent_id: cycB }).where(eq(categories.id, cycA));

  console.log("2. getCategoryBySlug (flat /[slug] + /[parent]/[sub] parent):");
  const resolves = async (suffix: string) =>
    (await categoryQueries.getCategoryBySlug(slugOf(suffix)))?.slug === slugOf(suffix);
  check("inactive root → 404", !(await resolves("off")));
  check("active CHILD of an inactive root → 404 (was public)", !(await resolves("off-child")));
  check("active GRAND-child of an inactive root → 404", !(await resolves("off-grand")));
  check("active root → resolves", await resolves("on"));
  check("active child of an active root → resolves", await resolves("on-child"));
  check("inactive mid-node → 404", !(await resolves("on-mid")));
  check("active leaf under an inactive mid-node → 404", !(await resolves("on-mid-leaf")));
  check("active child of a SOFT-DELETED parent → resolves (orphan = root)", await resolves("orphan"));
  check("parent_id cycle terminates (active cycle stays resolvable)", await resolves("cyc-a"));

  console.log("3. listSitemapCategories:");
  const sitemapSlugs = new Set(
    (await categoryQueries.listSitemapCategories())
      .map((c) => c.slug)
      .filter((s) => s.startsWith(`${TAG}-`)),
  );
  check(
    "lists exactly the storefront-visible fixtures",
    ["on", "on-child", "orphan", "cyc-a", "cyc-b"].every((s) => sitemapSlugs.has(slugOf(s))),
  );
  check(
    "drops the inactive nodes AND their active descendants",
    ["off", "off-child", "off-grand", "on-mid", "on-mid-leaf", "gone"].every(
      (s) => !sitemapSlugs.has(slugOf(s)),
    ),
  );

  console.log("4. getStorefrontCategoryTrail (PDP breadcrumb):");
  const trail = async (id: string) =>
    (await categoryQueries.getStorefrontCategoryTrail(id))?.map((c) => c.slug) ?? null;
  const onChildTrail = await trail(onChild);
  check(
    "all-active chain → root › … › category",
    onChildTrail?.join(",") === [slugOf("on"), slugOf("on-child")].join(","),
  );
  const onMidLeafTrail = await trail(onMidLeaf);
  check(
    "cut at the first inactive node (on › [on-mid off] › leaf → on)",
    onMidLeafTrail?.join(",") === slugOf("on"),
  );
  const offGrandTrail = await trail(offGrand);
  check(
    "inactive root → EMPTY trail (resolved, but nothing linkable)",
    Array.isArray(offGrandTrail) && offGrandTrail.length === 0,
  );
  check("unknown id → null (PDP falls back to the flat crumb)", (await trail(randomUUID())) === null);
  check(
    "soft-deleted parent ends the chain (orphan › itself)",
    (await trail(orphan))?.join(",") === slugOf("orphan"),
  );

  // Sanity: the fixtures really are live rows (guards a vacuous pass).
  const live = await db
    .select({ id: categories.id })
    .from(categories)
    .where(inArray(categories.id, [off, offChild, offGrand, on, onChild, onMid, onMidLeaf, orphan]));
  check("fixture rows exist", live.length === 8);

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
