import "server-only";

/**
 * Public NON-PAGE surface gating (A–Z audit 2026-09-23, phase 2):
 *
 *  1. The public category API listing strips internal fields (externalRef).
 *  2. /md product twin quotes the PDP's LIVE-PROMO price (not the base price).
 *  3. /md sub-category twin: parent/child validated like the HTML page (junk or
 *     non-parent → null), FLAT canonical, canonical_url override honoured, and
 *     the route's Link header carries that canonical.
 *  4. Public /api/reviews honours the reviews.enabled master switch.
 *  5. site.mode maintenance / coming_soon closes EVERY non-page surface:
 *     isSiteGatedForViewer, /api/store/search (empty), /feeds (404),
 *     sitemap.xml (empty), robots.txt (Disallow: /), llms.txt (minimal), /md (404).
 *
 * Self-cleaning (`zzpg…` slugs / names) and restores every setting it touches.
 * Run ONLY against the isolated test DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/public-gating.test.ts
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { productQueries } from "@/modules/catalog/product";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow } from "@/modules/promotion/schema";
import { getApiProductByRef, listApiProductsByCategory } from "@/lib/api/products";
import { getApiProductReviews } from "@/lib/api/reviews";
import { buildProductTwin, resolveMarkdownForPath } from "@/lib/seo/markdown/generate";
import { isSiteGatedForViewer } from "@/lib/site-mode/config";
import { GET as mdGET } from "@/app/md/[...path]/route";
import { GET as searchGET } from "@/app/api/store/search/route";
import { GET as feedsGET } from "@/app/feeds/[file]/route";
import { GET as robotsGET } from "@/app/robots.txt/route";
import { GET as llmsGET } from "@/app/llms.txt/route";
import sitemap from "@/app/sitemap";

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

const RUN = randomBytes(3).toString("hex");
const TAG = "zzpg";
const ORIGIN = "https://shop.test";
const CTX = { origin: ORIGIN, currency: "TND", priceDecimals: 3 };

// ── settings helpers (capture → override → restore exactly as found) ─────────
type Prior = string | null | undefined;
const priors = new Map<string, Prior>();

function rowsOf<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? (res as T[])) as T[];
}

async function readSetting(key: string): Promise<Prior> {
  const rows = rowsOf<{ value: string | null }>(
    await db.execute(sql`select value from site_settings where key = ${key}`),
  );
  return rows.length > 0 ? rows[0].value : undefined;
}

async function writeSetting(key: string, value: string) {
  if (!priors.has(key)) priors.set(key, await readSetting(key));
  await db.execute(
    sql`insert into site_settings (key, value, label) values (${key}, ${value}, ${"zzpg test"})
        on conflict (key) do update set value = ${value}`,
  );
}

async function restoreSettings() {
  for (const [key, prior] of priors) {
    if (prior === undefined) await db.execute(sql`delete from site_settings where key = ${key}`);
    else await db.execute(sql`update site_settings set value = ${prior} where key = ${key}`);
  }
  priors.clear();
}

async function cleanup() {
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(
    sql`delete from product_reviews where product_id in (select id from products where slug like ${TAG + "%"})`,
  );
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from categories where slug like ${TAG + "%"} and parent_id is not null`);
  await db.execute(sql`delete from categories where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from brands where slug like ${TAG + "%"}`);
}

async function insertId(q: ReturnType<typeof sql>): Promise<string> {
  return rowsOf<{ id: string }>(await db.execute(q))[0].id;
}

// Released fixtures: is_published true with a published_at well in the past, so they
// appear in the public listings / twins under test.
const mkProduct = (tag: string, priceCents: number) =>
  insertId(sql`insert into products (slug, name, price_cents, is_published, published_at)
               values (${`${TAG}-${RUN}-${tag}`}, ${`${TAG} ${RUN} ${tag}`}, ${priceCents}, true, now() - interval '400 days')
               returning id`);

async function main() {
  await cleanup();

  await writeSetting("site.mode", "live");

  // ── fixtures ────────────────────────────────────────────────────────────
  const parentSlug = `${TAG}-${RUN}-parent`;
  const childSlug = `${TAG}-${RUN}-child`;
  const otherRootSlug = `${TAG}-${RUN}-other`;
  const brandSlug = `${TAG}-${RUN}-brand`;
  const parentId = await insertId(
    sql`insert into categories (slug, name, is_active) values (${parentSlug}, ${"zzpg Parent"}, true) returning id`,
  );
  const childId = await insertId(
    sql`insert into categories (slug, name, parent_id, is_active) values (${childSlug}, ${"zzpg Enfant"}, ${parentId}, true) returning id`,
  );
  await insertId(
    sql`insert into categories (slug, name, is_active) values (${otherRootSlug}, ${"zzpg Autre"}, true) returning id`,
  );
  const brandId = await insertId(
    sql`insert into brands (slug, name, is_active) values (${brandSlug}, ${"zzpg Marque"}, true) returning id`,
  );

  const visibleId = await mkProduct("visible", 100_000);
  const exclusiveId = await mkProduct("exclusive", 250_000);
  for (const pid of [visibleId, exclusiveId]) {
    await db.execute(
      sql`insert into product_categories (product_id, category_id, is_primary) values (${pid}, ${childId}, true)`,
    );
    await db.execute(sql`insert into product_brands (product_id, brand_id) values (${pid}, ${brandId})`);
  }
  const visibleSlug = `${TAG}-${RUN}-visible`;
  const visibleName = `${TAG} ${RUN} visible`;

  // ── 1) public API listings strip internal fields ─────────────────────────
  console.log("public listings:");
  const catPublic = await listApiProductsByCategory(childSlug, { limit: 100, public: true });
  check("category public listing keeps the published product", catPublic.some((p) => p.slug === visibleSlug));
  check("category public listing strips externalRef", catPublic.every((p) => p.externalRef === null));

  // ── 2) /md product twin: live-promo price ─────────────────────────────────
  console.log("\n/md product twin:");
  const pairFor = async (slug: string) => {
    const row = await productQueries.getProductBySlug(slug);
    const product = await getApiProductByRef({ slug }, { includeUnpublished: true });
    if (!row || !product) throw new Error(`fixture ${slug} missing`);
    return { row, product };
  };
  const visiblePair = await pairFor(visibleSlug);
  const plainDoc = await buildProductTwin(visiblePair, CTX);
  check("released product twin renders", plainDoc !== null && plainDoc.body.includes(visibleName));
  check("twin url = flat canonical", plainDoc?.frontmatter.url === `${ORIGIN}/${visibleSlug}`);
  check("no promo → base price", plainDoc?.frontmatter.price === "100.000");

  await promotionService.insert({
    name: `${TAG}-${RUN}-pct`,
    trigger_kind: "auto",
    scope: "product",
    scope_id: visibleId,
    discount_type: "percent",
    discount_value: 10,
    is_stackable: false,
    is_active: true,
  } as NewPromotionRow);
  // The product HAS a category + brand link — which used to make the PDP's
  // per-product lookup (promotionService.listLiveAutoForProduct, `= ANY(${ids})`)
  // throw, silently dropping every auto-promo. Same `visiblePair` object as
  // above: the helper must price a COPY, never the (cached) DTO handed in.
  const promoDoc = await buildProductTwin(visiblePair, CTX);
  check("live auto-promo → twin headline = PDP effective price", promoDoc?.frontmatter.price === "90.000");
  check(
    "live auto-promo → struck-through original in the body",
    !!promoDoc?.body.includes("**Prix :** 90.000 TND (au lieu de 100.000 TND)"),
  );
  check("the DTO handed in is NOT mutated (copy priced)", visiblePair.product.priceCents === 100_000);

  // Regression: category/brand-scoped lookup with 1 and 2 ids (drizzle expands a
  // JS array in a sql template into a param LIST, which broke `= ANY(…)`).
  const catPromo = await promotionService.insert({
    name: `${TAG}-${RUN}-cat`,
    trigger_kind: "auto",
    scope: "category",
    scope_id: childId,
    discount_type: "fixed",
    discount_value: 1_000,
    is_stackable: false,
    is_active: true,
  } as NewPromotionRow);
  const one = await promotionService.listLiveAutoForProduct({
    productId: exclusiveId,
    categoryIds: [childId],
    brandIds: [brandId],
  });
  check("listLiveAutoForProduct: 1 category id + 1 brand id → category promo matched", one.some((p) => p.id === catPromo.id));
  const two = await promotionService.listLiveAutoForProduct({
    productId: exclusiveId,
    categoryIds: [parentId, childId],
    brandIds: [],
  });
  check("listLiveAutoForProduct: 2 category ids → category promo matched", two.some((p) => p.id === catPromo.id));
  await db.execute(sql`delete from promotions where id = ${catPromo.id}`);

  await db.execute(sql`update products set canonical_url = ${"https://master.test/montre"} where id = ${visibleId}`);
  const canonDoc = await buildProductTwin(await pairFor(visibleSlug), CTX);
  check("product canonical_url override → twin url", canonDoc?.frontmatter.url === "https://master.test/montre");

  // ── 3) /md sub-category twin (2-segment branch) ──────────────────────────
  console.log("\n/md sub-category twin:");
  const sub = await resolveMarkdownForPath(`/${parentSlug}/${childSlug}.md`, CTX);
  check("valid parent/child → twin", sub !== null);
  check("canonical is the FLAT /<sub>", sub?.canonicalUrl === `${ORIGIN}/${childSlug}`);
  check("frontmatter url == canonical", !!sub?.markdown.includes(`url: ${ORIGIN}/${childSlug}`) || !!sub?.markdown.includes(`url: "${ORIGIN}/${childSlug}"`));
  check("listing shows the published product", !!sub?.markdown.includes(visibleName));
  check("junk parent → null (404)", (await resolveMarkdownForPath(`/${TAG}-${RUN}-junk/${childSlug}`, CTX)) === null);
  check(
    "real category that is NOT the parent → null (404)",
    (await resolveMarkdownForPath(`/${otherRootSlug}/${childSlug}`, CTX)) === null,
  );
  await db.execute(sql`update categories set canonical_url = ${"/master-cat"} where id = ${childId}`);
  const subCanon = await resolveMarkdownForPath(`/${parentSlug}/${childSlug}`, CTX);
  check("sub-category canonical_url override (root-relative) honoured", subCanon?.canonicalUrl === `${ORIGIN}/master-cat`);
  await db.execute(sql`update categories set is_active = false where id = ${childId}`);
  check("inactive child → null", (await resolveMarkdownForPath(`/${parentSlug}/${childSlug}`, CTX)) === null);
  await db.execute(sql`update categories set is_active = true where id = ${childId}`);

  // The route's Link header carries the page canonical, anonymous ⇒ public cache.
  const mdRes = await mdGET(new Request(`${ORIGIN}/md/${parentSlug}/${childSlug}`), {
    params: Promise.resolve({ path: [parentSlug, childSlug] }),
  });
  check("md route 200 for a valid sub-category", mdRes.status === 200);
  check("md route Link rel=canonical = override, not the nested path", (mdRes.headers.get("link") ?? "").includes("/master-cat>"));
  check("md route anonymous body is publicly cacheable", (mdRes.headers.get("cache-control") ?? "").startsWith("public"));

  // ── 4) public /api/reviews: reviews.enabled master switch ─────────────────
  console.log("\npublic reviews API:");
  for (const pid of [visibleId, exclusiveId]) {
    await db.execute(
      sql`insert into product_reviews (product_id, author_name, rating, title, body, status, source)
          values (${pid}, ${"zzpg"}, 5, ${"Top"}, ${"Très bien"}, 'approved', 'manual')`,
    );
  }
  await writeSetting("reviews.enabled", "true");
  const onRes = await getApiProductReviews({ slug: visibleSlug }, { public: true });
  check("reviews ON → public caller gets the approved review", onRes?.items.length === 1);
  await writeSetting("reviews.enabled", "false");
  const offRes = await getApiProductReviews({ slug: visibleSlug }, { public: true });
  check("reviews OFF → public caller gets an EMPTY list", offRes !== null && offRes.items.length === 0 && offRes.summary.count === 0);
  const offKeyed = await getApiProductReviews({ slug: visibleSlug }, { includeUnpublished: true });
  check("reviews OFF → keyed caller still reads them", offKeyed?.items.length === 1);

  // ── 5) site.mode gate on every non-page surface ──────────────────────────
  console.log("\nsite.mode gate:");
  await writeSetting("seo.feed_google_enabled", "true");
  check("live → not gated", (await isSiteGatedForViewer()) === false);
  for (const mode of ["coming_soon", "maintenance"] as const) {
    await writeSetting("site.mode", mode);
    check(`${mode}: gated for the (anonymous) viewer`, (await isSiteGatedForViewer()) === true);
    check(`${mode}: gated with allowStaff:false`, (await isSiteGatedForViewer({ allowStaff: false })) === true);

    const s = await searchGET(
      new Request(`${ORIGIN}/api/store/search?q=${encodeURIComponent(visibleName)}`, {
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    const sBody = (await s.json()) as { hits: unknown[]; total: number };
    check(`${mode}: /api/store/search → no hits, no-store`, sBody.hits.length === 0 && sBody.total === 0 && s.headers.get("cache-control") === "no-store");

    const f = await feedsGET(new Request(`${ORIGIN}/feeds/google-merchant.xml`), {
      params: Promise.resolve({ file: "google-merchant.xml" }),
    });
    check(`${mode}: enabled feed → 404`, f.status === 404);

    check(`${mode}: sitemap → empty`, (await sitemap()).length === 0);

    const robots = await (await robotsGET()).text();
    check(`${mode}: robots.txt → Disallow: / and no sitemap`, robots.includes("User-agent: *\nDisallow: /\n") && !robots.includes("Sitemap:"));

    const llms = await (await llmsGET()).text();
    check(`${mode}: llms.txt → minimal body (no catalogue)`, !llms.includes("zzpg Enfant") && !llms.includes("/sitemap.xml") && llms.startsWith("# "));

    const md = await mdGET(new Request(`${ORIGIN}/md/${parentSlug}/${childSlug}`), {
      params: Promise.resolve({ path: [parentSlug, childSlug] }),
    });
    check(`${mode}: /md twin → 404`, md.status === 404);
  }

  await writeSetting("site.mode", "live");
  check("back to live → not gated", (await isSiteGatedForViewer({ allowStaff: false })) === false);
  const robotsLive = await (await robotsGET()).text();
  check("live robots.txt → normal body (Allow: / + sitemap)", robotsLive.includes("Allow: /") && robotsLive.includes("Sitemap:"));
  const llmsLive = await (await llmsGET()).text();
  check("live llms.txt → full map again", llmsLive.includes("/sitemap.xml"));

  await restoreSettings();
  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await restoreSettings();
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
