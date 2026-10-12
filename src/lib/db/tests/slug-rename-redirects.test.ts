import "server-only";

/**
 * Slug-rename redirects + the redirect-create contract — DB-backed:
 *
 *  1. `redirectService.create` never overwrites the rule already holding a
 *     source (returns null; the stored destination / notes / state are kept) —
 *     the admin « Ajouter » used to upsert silently while reporting « créée ».
 *  2. `createSlugRenameRedirects`: inserts an active 301 old → new with an
 *     « Automatique » note; never overwrites the operator's rule on the old
 *     source; renaming BACK deactivates the rule that would shadow the entity's
 *     new URL (A→B then B→A) instead of leaving `/A → /B` live over the entity.
 *  3. The update workflows call it only for LIVE entities: a published product /
 *     active brand / active category (flat + nested `/parent/old` for a
 *     sub-category) gets its rule; a DRAFT
 *     product or an INACTIVE brand does not.
 *  4. The automatic rule never makes ANOTHER entity unreachable: creating (and
 *     publishing) a product / brand / sub-category at a URL an
 *     ACTIVE rule holds, or renaming a draft onto it, is refused with a French
 *     « désactivez-la dans Système → Redirections » message (resolveRedirect runs
 *     before the entity lookup); renaming the SAME entity back — directly or
 *     through a chain A→B→C→A, live or offline — is allowed and frees the URL;
 *     publishing / re-activating an entity frees its URL from an operator rule
 *     left on it while it was offline.
 *
 * Self-cleaning (`zztest-slugredir` slugs / sources). Run ONLY against a
 * disposable DB:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/slug-rename-redirects.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { redirects } from "@/modules/redirects/schema";
import { redirectService } from "@/modules/redirects";
import { brands } from "@/modules/catalog/brand/schema";
import { categories } from "@/modules/catalog/category/schema";
import { products } from "@/modules/catalog/product/schema";
import { findActiveBySource } from "@/modules/redirects/queries";
import { createSlugRenameRedirects } from "@/lib/redirects/auto-slug-redirect";
import { checkSlugAvailability } from "@/lib/utils/slug-conflict";
import { createBrandWorkflow, updateBrandWorkflow } from "@/workflows/catalog/create-brand";
import { createCategoryWorkflow, updateCategoryWorkflow } from "@/workflows/catalog/create-category";
import { createProductWorkflow, updateProductWorkflow } from "@/workflows/catalog/create-product";

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

const TAG = "zztest-slugredir";
const ACTOR = { actorUserId: "__slugredir-admin" };

async function cleanup() {
  await db.execute(
    sql`delete from redirects where source_path like ${"%" + TAG + "%"} or destination like ${"%" + TAG + "%"}`,
  );
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from brands where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from categories where slug like ${TAG + "%"}`);
}

async function ruleFor(source: string) {
  const [row] = await db.select().from(redirects).where(eq(redirects.source_path, source)).limit(1);
  return row ?? null;
}

async function main() {
  await cleanup();

  // ── 1. create never overwrites ─────────────────────────────────────────────
  console.log("redirectService.create:");
  const first = await redirectService.create({
    sourcePath: `/${TAG}-dup`,
    destination: `/${TAG}-first`,
    statusCode: 301,
    isActive: false,
    notes: "manuel",
  });
  const second = await redirectService.create({
    sourcePath: `/${TAG}-dup`,
    destination: `/${TAG}-second`,
    statusCode: 302,
  });
  const dup = await ruleFor(`/${TAG}-dup`);
  check("first create returns the row", first !== null && first.source_path === `/${TAG}-dup`);
  check("second create on the same source → null", second === null);
  check(
    "existing rule untouched (destination, status, notes, still inactive)",
    dup?.destination === `/${TAG}-first` && dup.status_code === 301 && dup.notes === "manuel" && !dup.is_active,
  );

  // ── 2. createSlugRenameRedirects ───────────────────────────────────────────
  console.log("createSlugRenameRedirects:");
  await createSlugRenameRedirects([{ from: `/${TAG}-a`, to: `/${TAG}-b` }], { ...ACTOR, label: "test A→B" });
  const ab = await ruleFor(`/${TAG}-a`);
  check(
    "old → new inserted as an active 301 with an « Automatique » note",
    ab?.destination === `/${TAG}-b` && ab.status_code === 301 && ab.is_active && /^Automatique/.test(ab.notes ?? ""),
  );

  // Rename BACK (B → A): /A → /B would shadow the entity now living at /A.
  await createSlugRenameRedirects([{ from: `/${TAG}-b`, to: `/${TAG}-a` }], { ...ACTOR, label: "test B→A" });
  const abAfter = await ruleFor(`/${TAG}-a`);
  const ba = await ruleFor(`/${TAG}-b`);
  check("rename back: the rule on the new URL (/A) is deactivated", abAfter !== null && !abAfter.is_active);
  check("rename back: /B → /A inserted (no loop with the deactivated rule)", ba?.destination === `/${TAG}-a` && ba.is_active);

  // The operator's own rule on the old source is never overwritten.
  await redirectService.create({
    sourcePath: `/${TAG}-c`,
    destination: `/${TAG}-manual`,
    statusCode: 302,
    notes: "règle opérateur",
  });
  await createSlugRenameRedirects([{ from: `/${TAG}-c`, to: `/${TAG}-d` }], { ...ACTOR, label: "test C→D" });
  const c = await ruleFor(`/${TAG}-c`);
  check("operator rule on the old source kept as-is", c?.destination === `/${TAG}-manual` && c.status_code === 302);

  await createSlugRenameRedirects(
    [
      { from: `/${TAG}-same`, to: `/${TAG}-same/` },
      { from: "not a path", to: `/${TAG}-x` },
    ],
    { ...ACTOR, label: "no-op" },
  );
  check("same path (after normalisation) / invalid path → no rule", (await ruleFor(`/${TAG}-same`)) === null);

  // ── 3. Workflow wiring ─────────────────────────────────────────────────────
  console.log("update workflows:");
  const [pub] = await db
    .insert(products)
    .values({ slug: `${TAG}-p-old`, name: `${TAG} P`, price_cents: 1000, is_published: true } as never)
    .returning({ id: products.id });
  const pubRes = await updateProductWorkflow({ productId: pub!.id, slug: `${TAG}-p-new` }, ACTOR);
  const pubRule = await ruleFor(`/${TAG}-p-old`);
  check("published product rename → ok", pubRes.ok);
  check("published product rename → /old → /new", pubRule?.destination === `/${TAG}-p-new` && pubRule.is_active);

  const [draft] = await db
    .insert(products)
    .values({ slug: `${TAG}-d-old`, name: `${TAG} D`, price_cents: 1000, is_published: false } as never)
    .returning({ id: products.id });
  await updateProductWorkflow({ productId: draft!.id, slug: `${TAG}-d-new` }, ACTOR);
  check("DRAFT product rename → no redirect", (await ruleFor(`/${TAG}-d-old`)) === null);

  const [brand] = await db
    .insert(brands)
    .values({ slug: `${TAG}-br-old`, name: `${TAG} Br`, is_active: true } as never)
    .returning({ id: brands.id });
  await updateBrandWorkflow({ brandId: brand!.id, slug: `${TAG}-br-new` }, ACTOR);
  check("active brand rename → /old → /new", (await ruleFor(`/${TAG}-br-old`))?.destination === `/${TAG}-br-new`);

  const [offBrand] = await db
    .insert(brands)
    .values({ slug: `${TAG}-bi-old`, name: `${TAG} Bi`, is_active: false } as never)
    .returning({ id: brands.id });
  await updateBrandWorkflow({ brandId: offBrand!.id, slug: `${TAG}-bi-new` }, ACTOR);
  check("INACTIVE brand rename → no redirect", (await ruleFor(`/${TAG}-bi-old`)) === null);

  const [parent] = await db
    .insert(categories)
    .values({ slug: `${TAG}-cat-parent`, name: `${TAG} Parent`, is_active: true } as never)
    .returning({ id: categories.id });
  const [child] = await db
    .insert(categories)
    .values({ slug: `${TAG}-cat-old`, name: `${TAG} Child`, is_active: true, parent_id: parent!.id } as never)
    .returning({ id: categories.id });
  const catRes = await updateCategoryWorkflow({ categoryId: child!.id, slug: `${TAG}-cat-new` }, ACTOR);
  check("sub-category rename → ok", catRes.ok);
  check("sub-category rename → flat /old → /new", (await ruleFor(`/${TAG}-cat-old`))?.destination === `/${TAG}-cat-new`);
  check(
    "sub-category rename → nested /parent/old → flat /new",
    (await ruleFor(`/${TAG}-cat-parent/${TAG}-cat-old`))?.destination === `/${TAG}-cat-new`,
  );

  // ── 4. The automatic rule never shadows ANOTHER entity ─────────────────────
  console.log("slug reuse vs. active redirects:");
  const isShadowRefusal = (r: { ok: boolean; error?: string; message?: string }) =>
    !r.ok && r.error === "conflict" && /Système → Redirections/.test(r.message ?? "");

  // Reviewer repro: P1 renamed p-old → p-new left `/p-old → /p-new`; a NEW
  // published product at `p-old` must not be created behind that rule.
  const p2 = await createProductWorkflow(
    { name: `${TAG} P2`, slug: `${TAG}-p-old`, priceCents: 1000, publish: true },
    ACTOR,
  );
  check("new published product at a renamed product's old slug → refused (conflict, French)", isShadowRefusal(p2));
  const [p2Row] = await db.select({ id: products.id }).from(products).where(eq(products.slug, `${TAG}-p-old`)).limit(1);
  check("…nothing inserted at the old slug", !p2Row);
  check(
    "…the old URL still 301s to the renamed product",
    (await findActiveBySource(`/${TAG}-p-old`))?.destination === `/${TAG}-p-new`,
  );
  const slugCheck = await checkSlugAvailability(`${TAG}-p-old`);
  check(
    "checkSlugAvailability → kind 'redirect' naming the source",
    !slugCheck.ok && slugCheck.kind === "redirect" && slugCheck.message.includes(`/${TAG}-p-old`),
  );
  check(
    "a brand can't take the old slug either",
    isShadowRefusal(await createBrandWorkflow({ name: `${TAG} B2`, slug: `${TAG}-p-old` }, ACTOR)),
  );

  // A DRAFT renamed onto the old slug (then published) is refused at the rename.
  const [draft2] = await db
    .insert(products)
    .values({ slug: `${TAG}-d2`, name: `${TAG} D2`, price_cents: 1000, is_published: false } as never)
    .returning({ id: products.id });
  check(
    "draft renamed onto the old slug → refused",
    isShadowRefusal(await updateProductWorkflow({ productId: draft2!.id, slug: `${TAG}-p-old` }, ACTOR)),
  );

  // Renaming the SAME product back is allowed and frees the URL.
  const back = await updateProductWorkflow({ productId: pub!.id, slug: `${TAG}-p-old` }, ACTOR);
  check("renaming the product back onto its old slug → ok", back.ok);
  check("…the rule on its URL is deactivated (not shadowed)", (await findActiveBySource(`/${TAG}-p-old`)) === null);
  check(
    "…and /p-new → /p-old now keeps the intermediate URL alive",
    (await findActiveBySource(`/${TAG}-p-new`))?.destination === `/${TAG}-p-old`,
  );

  // Chain: A → B → C, then back to A (the rule on /A leads /B → /C = itself).
  const [chain] = await db
    .insert(products)
    .values({ slug: `${TAG}-ch-a`, name: `${TAG} Ch`, price_cents: 1000, is_published: true } as never)
    .returning({ id: products.id });
  await updateProductWorkflow({ productId: chain!.id, slug: `${TAG}-ch-b` }, ACTOR);
  await updateProductWorkflow({ productId: chain!.id, slug: `${TAG}-ch-c` }, ACTOR);
  const chainBack = await updateProductWorkflow({ productId: chain!.id, slug: `${TAG}-ch-a` }, ACTOR);
  check("chain A→B→C then back to A → ok", chainBack.ok);
  check(
    "…/A freed, /B → /C and /C → /A keep the chain alive (no loop)",
    (await findActiveBySource(`/${TAG}-ch-a`)) === null &&
      (await findActiveBySource(`/${TAG}-ch-b`))?.destination === `/${TAG}-ch-c` &&
      (await findActiveBySource(`/${TAG}-ch-c`))?.destination === `/${TAG}-ch-a`,
  );

  // Offline rename-back: published x → y (rule /x → /y), unpublished, renamed back
  // to x (allowed — the rule leads back to itself) → the rule is released at the
  // rename, so a later publication is not shadowed.
  const [off] = await db
    .insert(products)
    .values({ slug: `${TAG}-off-x`, name: `${TAG} Off`, price_cents: 1000, is_published: true } as never)
    .returning({ id: products.id });
  await updateProductWorkflow({ productId: off!.id, slug: `${TAG}-off-y` }, ACTOR);
  await updateProductWorkflow({ productId: off!.id, publish: false }, ACTOR);
  const offBack = await updateProductWorkflow({ productId: off!.id, slug: `${TAG}-off-x` }, ACTOR);
  check(
    "unpublished product renamed back → ok, and its URL is freed",
    offBack.ok && (await findActiveBySource(`/${TAG}-off-x`)) === null,
  );

  // Publication frees the URL from an operator rule left on it while offline.
  const [dPub] = await db
    .insert(products)
    .values({ slug: `${TAG}-pubme`, name: `${TAG} PubMe`, price_cents: 1000, is_published: false } as never)
    .returning({ id: products.id });
  await redirectService.create({
    sourcePath: `/${TAG}-pubme`,
    destination: `/${TAG}-successor`,
    statusCode: 302,
    notes: "règle opérateur",
  });
  const pubMe = await updateProductWorkflow({ productId: dPub!.id, publish: true }, ACTOR);
  const pubMeRule = await ruleFor(`/${TAG}-pubme`);
  check(
    "publishing a draft → ok, the operator rule on its URL is deactivated (kept, not deleted)",
    pubMe.ok && pubMeRule !== null && !pubMeRule.is_active,
  );

  // Category re-activation, same rule.
  const [offCat] = await db
    .insert(categories)
    .values({ slug: `${TAG}-cat-off`, name: `${TAG} CatOff`, is_active: false } as never)
    .returning({ id: categories.id });
  await redirectService.create({ sourcePath: `/${TAG}-cat-off`, destination: `/${TAG}-ailleurs`, statusCode: 301 });
  await updateCategoryWorkflow({ categoryId: offCat!.id, isActive: true }, ACTOR);
  check("re-activating a category frees its URL", (await findActiveBySource(`/${TAG}-cat-off`)) === null);

  // A sub-category's NESTED URL is checked too (extraPaths).
  await redirectService.create({
    sourcePath: `/${TAG}-cat-parent/${TAG}-nested`,
    destination: `/${TAG}-ailleurs`,
    statusCode: 301,
  });
  check(
    "new sub-category whose nested /parent/slug holds an active rule → refused",
    isShadowRefusal(
      await createCategoryWorkflow({ name: `${TAG} Nested`, slug: `${TAG}-nested`, parentId: parent!.id }, ACTOR),
    ),
  );

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
