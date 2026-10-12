import "server-only";

/**
 * Storefront listing engine — the SQL halves (gap-storefront-listing-engine-07 /
 * -13 / -15 / -08 / -11, cached-dto-coherence):
 *
 *   - `productQueries.listPublishedCompareAtProducts` selects the compare-at pool
 *     over the WHOLE catalogue (it used to filter the newest-100 slice, so an
 *     older marked-down product never reached /promotions or the home rail), on
 *     the CARD's pricing (cheapest variant for a variable product), published +
 *     live only, by deal then recency (or recency);
 *   - `listShowcaseProducts` (/promotions) + `listPromotions` (home rail) surface
 *     an old compare-at product outside the newest 100, and never a stale
 *     compare-at (old ≤ price) or a parent-only markdown the card doesn't show;
 *   - `listShowcaseProducts` pin + strategy ordering: manual pins render FIRST in
 *     their stored order (never re-sorted, never duplicated in the auto tail), an
 *     unpublished pin drops; `new_arrivals` auto pool is newest-first; `best_sellers`
 *     ranks the auto pool by sold quantity desc and excludes an unpublished seller;
 *   - `productQueries.listPublishedIdsNewestFirst` + the brand/category grids:
 *     published + live filtered and ordered (published_at DESC NULLS LAST, id
 *     DESC) BEFORE the grid cap — deterministic natural order, drafts/deleted
 *     links never listed;
 *   - the listing DTO carries the product UUID (`id`, the GA4 item_id) and a
 *     normalised compare-at (a stale old ≤ price → undefined).
 *
 * Self-cleaning (`zztest-lstng` slug prefix). Run (isolated DB only):
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/listing-engine-db.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { productQueries } from "@/modules/catalog/product";
import { product_variants, products } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { showcaseService } from "@/modules/showcase";
import {
  listProductsByIds,
  listPromotions,
  listRelatedProducts,
  listShowcaseProducts,
} from "@/lib/api/products";
import type { CollectionPageConfig } from "@/lib/pages/collection-page-config";

const TAG = "zztest-lstng";

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
  const mine = sql`(select id from products where slug like ${TAG + "%"})`;
  // order_items FK → orders; delete the test orders (and their lines) first, then
  // the pins keyed on the test showcase slugs, before the products themselves.
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from showcase_pins where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from product_variants where product_id in ${mine}`);
  await db.execute(sql`delete from product_brands where product_id in ${mine}`);
  await db.execute(sql`delete from brands where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

type Seed = {
  slug: string;
  price_cents: number;
  old_price_cents?: number | null;
  is_published?: boolean;
  published_at?: Date | null;
  deleted_at?: Date | null;
  product_type?: "simple" | "variable";
};

async function insertProduct(s: Seed): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      ...s,
      name: s.slug,
      in_stock: true,
      is_published: s.is_published ?? true,
      published_at: s.published_at === undefined ? new Date() : s.published_at,
      old_price_cents: s.old_price_cents ?? null,
      product_type: s.product_type ?? "simple",
    } as never)
    .returning({ id: products.id });
  return row.id;
}

/**
 * A paid order with one line for `productId` × `qty`, so `getTopSellingProducts`
 * (which sums `order_items.quantity` over paid/preparing/shipped/delivered orders
 * in the window) ranks it. `seq` keeps `order_number` unique.
 */
async function insertSale(productId: string, slug: string, qty: number, seq: number): Promise<void> {
  const unit = 100_000;
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-ord-${seq}`,
      contact_email: `${TAG}@example.test`,
      status: "paid",
      subtotal_cents: unit * qty,
      total_cents: unit * qty,
      ship_full_name: "Test Buyer",
      ship_street_line1: "1 rue de Test",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id });
  await db.insert(order_items).values({
    order_id: o.id,
    product_id: productId,
    product_name: slug,
    product_slug: slug,
    unit_price_cents: unit,
    quantity: qty,
    subtotal_cents: unit * qty,
  } as never);
}

async function main() {
  await cleanup();

  // ── > 100 NEWER published products, so anything older sits outside the old
  //    newest-100 slice ─────────────────────────────────────────────────────
  const now = Date.now();
  await db.insert(products).values(
    Array.from({ length: 105 }, (_, i) => ({
      slug: `${TAG}-recent-${i}`,
      name: `${TAG} recent ${i}`,
      price_cents: 100_000,
      in_stock: true,
      is_published: true,
      published_at: new Date(now - i * 60_000),
    })) as never,
  );

  const oldDeal = await insertProduct({
    slug: `${TAG}-old-deal`,
    price_cents: 50_000,
    old_price_cents: 200_000, // 75 %
    published_at: new Date("2001-01-01T00:00:00Z"),
  });
  const smallDeal = await insertProduct({
    slug: `${TAG}-small-deal`,
    price_cents: 90_000,
    old_price_cents: 100_000, // 10 %
    published_at: new Date("2002-01-01T00:00:00Z"),
  });
  const draft = await insertProduct({
    slug: `${TAG}-draft`,
    price_cents: 10_000,
    old_price_cents: 100_000,
    is_published: false,
    published_at: null,
  });
  const deleted = await insertProduct({
    slug: `${TAG}-deleted`,
    price_cents: 10_000,
    old_price_cents: 100_000,
    deleted_at: new Date(),
  });
  const stale = await insertProduct({
    slug: `${TAG}-stale`,
    price_cents: 179_000,
    old_price_cents: 150_000, // left behind by a price increase
    published_at: new Date("2003-01-01T00:00:00Z"),
  });
  // Variable, parent compare-at only — the card shows the cheapest variant,
  // which has NO compare-at → not a markdown anywhere.
  const parentOnly = await insertProduct({
    slug: `${TAG}-var-parent-only`,
    product_type: "variable",
    price_cents: 250_000,
    old_price_cents: 500_000,
    published_at: new Date("2000-06-01T00:00:00Z"),
  });
  await db.insert(product_variants).values([
    { product_id: parentOnly, label: "A", price_cents: 200_000, old_price_cents: null, display_order: 0 },
    { product_id: parentOnly, label: "B", price_cents: 300_000, old_price_cents: 400_000, display_order: 1 },
  ] as never);
  // Variable, markdown on the CHEAPEST variant (25 %) — parent row has none.
  const variantDeal = await insertProduct({
    slug: `${TAG}-var-deal`,
    product_type: "variable",
    price_cents: 250_000,
    old_price_cents: null,
    published_at: new Date("2000-01-01T00:00:00Z"),
  });
  await db.insert(product_variants).values([
    { product_id: variantDeal, label: "A", price_cents: 130_000, display_order: 0 },
    { product_id: variantDeal, label: "B", price_cents: 120_000, old_price_cents: 160_000, display_order: 1 },
  ] as never);

  const mineOnly = (ids: string[], keep: string[]) => ids.filter((id) => keep.includes(id));

  // ── compare-at pool (SQL) ────────────────────────────────────────────────
  console.log("listPublishedCompareAtProducts:");
  const pool = (await productQueries.listPublishedCompareAtProducts({ limit: 500 })).map((r) => r.id);
  check("old markdown outside the newest 100 is selected", pool.includes(oldDeal));
  check("cheapest-variant markdown is selected", pool.includes(variantDeal));
  check("draft excluded", !pool.includes(draft));
  check("soft-deleted excluded", !pool.includes(deleted));
  check("stale compare-at (old ≤ price) excluded", !pool.includes(stale));
  check("parent-only markdown on a variable product excluded", !pool.includes(parentOnly));
  check(
    "ordered by deal: 75 % → 25 % (variant) → 10 %",
    mineOnly(pool, [oldDeal, variantDeal, smallDeal]).join() === [oldDeal, variantDeal, smallDeal].join(),
  );
  const recent = (await productQueries.listPublishedCompareAtProducts({ limit: 500, order: "recent" })).map((r) => r.id);
  check(
    "order « recent »: newest first (2002 → 2001 → 2000)",
    mineOnly(recent, [oldDeal, variantDeal, smallDeal]).join() === [smallDeal, oldDeal, variantDeal].join(),
  );

  // ── /promotions showcase + home rail ─────────────────────────────────────
  console.log("listShowcaseProducts / listPromotions:");
  const config = {
    slug: "promotions",
    strategy: "on_promotion",
    promoStrategy: "compare_at",
    limit: 100,
    windowDays: 30,
  } as unknown as CollectionPageConfig;
  const showcase = await listShowcaseProducts(config);
  const showcaseSlugs = showcase.map((p) => p.slug);
  check("old markdown (outside the newest 100) reaches /promotions", showcaseSlugs.includes(`${TAG}-old-deal`));
  check("stale compare-at never listed as a promotion", !showcaseSlugs.includes(`${TAG}-stale`));
  check("parent-only variable markdown not listed", !showcaseSlugs.includes(`${TAG}-var-parent-only`));
  const vDto = showcase.find((p) => p.slug === `${TAG}-var-deal`);
  check(
    "variant markdown listed with the card's cheapest-variant pair",
    vDto?.priceCents === 120_000 && vDto?.oldPriceCents === 160_000,
  );
  const showcaseMine = showcase
    .filter((p) => [`${TAG}-old-deal`, `${TAG}-var-deal`, `${TAG}-small-deal`].includes(p.slug))
    .map((p) => p.slug);
  check(
    "strongest (card) deal first",
    showcaseMine.join() === [`${TAG}-old-deal`, `${TAG}-var-deal`, `${TAG}-small-deal`].join(),
  );
  const rail = (await listPromotions(1000)).map((p) => p.slug);
  check("home rail reaches the old markdown", rail.includes(`${TAG}-old-deal`));
  check("home rail skips the stale compare-at", !rail.includes(`${TAG}-stale`));
  check(
    "home rail keeps newest-first order",
    rail
      .filter((s) => [`${TAG}-old-deal`, `${TAG}-small-deal`].includes(s))
      .join() === [`${TAG}-small-deal`, `${TAG}-old-deal`].join(),
  );

  // ── listing DTO: id + normalised compare-at ──────────────────────────────
  console.log("listing DTO:");
  const [staleDto, oldDto] = await listProductsByIds([stale, oldDeal]);
  check("DTO carries the product UUID (GA4 item_id)", staleDto?.id === stale && oldDto?.id === oldDeal);
  check("stale compare-at normalised away (no strike-through)", staleDto?.oldPriceCents === undefined && staleDto?.oldPrice === undefined);
  check("real compare-at kept", oldDto?.oldPriceCents === 200_000);

  // ── grid order + cap input ────────────────────────────────────────────────
  console.log("grid order:");
  const undated = await insertProduct({ slug: `${TAG}-undated`, price_cents: 1_000, published_at: null });
  const g1 = await insertProduct({ slug: `${TAG}-g1`, price_cents: 1_000, published_at: new Date("2024-01-01T00:00:00Z") });
  const g2 = await insertProduct({ slug: `${TAG}-g2`, price_cents: 1_000, published_at: new Date("2025-01-01T00:00:00Z") });
  const ordered = await productQueries.listPublishedIdsNewestFirst([undated, g1, draft, g2, deleted, g1]);
  check(
    "published + live only, newest first, undated last, duplicates collapsed",
    ordered.join() === [g2, g1, undated].join(),
  );
  check("empty input → []", (await productQueries.listPublishedIdsNewestFirst([])).length === 0);

  const [brand] = (
    await db.execute<{ id: string }>(
      sql`insert into brands (slug, name) values (${`${TAG}-brand`}, ${`${TAG} brand`}) returning id`,
    )
  ).rows;
  // The brand/category grid loaders resolve their entity through a `'use cache'`
  // query (not callable outside Next), so exercise the SAME productsForIds path
  // through the « same brand » related rail: raw brand-link ids (incl. a draft +
  // a soft-deleted link) → published/live filter + newest-first order in SQL.
  const seed = await insertProduct({ slug: `${TAG}-seed`, price_cents: 1_000 });
  await db.execute(sql`update products set related_mode = 'same_brand' where id = ${seed}::uuid`);
  for (const pid of [seed, g1, draft, undated, g2, deleted]) {
    await db.execute(sql`insert into product_brands (product_id, brand_id) values (${pid}::uuid, ${brand.id}::uuid)`);
  }
  const rail2 = await listRelatedProducts(`${TAG}-seed`, 10);
  check(
    "productsForIds: deterministic newest-first order, drafts/deleted never listed",
    rail2.map((p) => p.slug).join() === [`${TAG}-g2`, `${TAG}-g1`, `${TAG}-undated`].join(),
  );

  // ── Nouveautés (new_arrivals) + pin ordering ──────────────────────────────
  console.log("listShowcaseProducts new_arrivals + pins:");
  // Two future-dated products so they are the NEWEST published rows in the DB
  // (the 105 "recent" rows sit at ≤ now) → they lead the auto section.
  await insertProduct({ slug: `${TAG}-na-new`, price_cents: 1_000, published_at: new Date(now + 10 * 60_000) });
  await insertProduct({ slug: `${TAG}-na-old`, price_cents: 1_000, published_at: new Date(now + 9 * 60_000) });
  const pinA = await insertProduct({ slug: `${TAG}-pin-a`, price_cents: 1_000, published_at: new Date("2010-01-01T00:00:00Z") });
  const pinB = await insertProduct({ slug: `${TAG}-pin-b`, price_cents: 1_000, published_at: new Date("2011-01-01T00:00:00Z") });
  const pinDraft = await insertProduct({ slug: `${TAG}-pin-draft`, price_cents: 1_000, is_published: false, published_at: null });
  // Pin order [B, A, draft] — deliberately NOT chronological, to prove pins keep
  // their stored order (not re-sorted by recency) and the unpublished pin drops.
  await showcaseService.setPins(`${TAG}-na`, [pinB, pinA, pinDraft]);
  const naConfig = { slug: `${TAG}-na`, strategy: "new_arrivals", limit: 100 } as unknown as CollectionPageConfig;
  const na = (await listShowcaseProducts(naConfig)).map((p) => p.slug);
  check("pins render first, in stored pin order (not re-sorted)", na.slice(0, 2).join() === [`${TAG}-pin-b`, `${TAG}-pin-a`].join());
  check("an unpublished pin is dropped", !na.includes(`${TAG}-pin-draft`));
  check(
    "a pinned product is never duplicated in the auto tail",
    na.filter((s) => s === `${TAG}-pin-a`).length === 1 && na.filter((s) => s === `${TAG}-pin-b`).length === 1,
  );
  check(
    "auto pool is newest-first after the pins",
    na.indexOf(`${TAG}-na-new`) < na.indexOf(`${TAG}-na-old`) &&
      na.indexOf(`${TAG}-na-old`) > 1,
  );

  // ── Top ventes (best_sellers): sales ranking ──────────────────────────────
  console.log("listShowcaseProducts best_sellers:");
  const bsConfig = { slug: `${TAG}-bs`, strategy: "best_sellers", limit: 100, windowDays: 90 } as unknown as CollectionPageConfig;
  // NOTE: the cold-start fallback (no sales in the window → newest-first) is NOT
  // asserted here — a shared seeded dev DB has real paid orders, so
  // getTopSellingProducts rarely returns []. The fallback runs the SAME code as
  // the new_arrivals path above (listPublishedProducts newest-first), which is
  // covered. Here we only exercise the ranking branch against known sales.
  check("best_sellers returns a non-empty ranked list", (await listShowcaseProducts(bsConfig)).length > 0);

  // Seed sales: S1 (qty 5000) > S2 (qty 3000) > S3 (qty 1000); a high-selling
  // DRAFT (qty 9000) must still be excluded (auto pool is published-only). The
  // quantities are deliberately large so the three rank at the very top of the
  // window regardless of the shared dev DB's existing seed orders (and so none
  // falls outside the 100-row cap).
  const s1 = await insertProduct({ slug: `${TAG}-bs-1`, price_cents: 1_000 });
  const s2 = await insertProduct({ slug: `${TAG}-bs-2`, price_cents: 1_000 });
  const s3 = await insertProduct({ slug: `${TAG}-bs-3`, price_cents: 1_000 });
  const sDraft = await insertProduct({ slug: `${TAG}-bs-draft`, price_cents: 1_000, is_published: false, published_at: null });
  await insertSale(s1, `${TAG}-bs-1`, 5000, 1);
  await insertSale(s2, `${TAG}-bs-2`, 3000, 2);
  await insertSale(s3, `${TAG}-bs-3`, 1000, 3);
  await insertSale(sDraft, `${TAG}-bs-draft`, 9000, 4);
  await showcaseService.setPins(`${TAG}-bs`, [pinA]);
  const bs = (await listShowcaseProducts(bsConfig)).map((p) => p.slug);
  check("best_sellers lists the pin first, then sellers ranked by quantity desc", bs[0] === `${TAG}-pin-a`);
  const bsSellers = bs.filter((s) => [`${TAG}-bs-1`, `${TAG}-bs-2`, `${TAG}-bs-3`].includes(s));
  check(
    "sellers ordered by quantity desc (5000 → 3000 → 1000)",
    bsSellers.join() === [`${TAG}-bs-1`, `${TAG}-bs-2`, `${TAG}-bs-3`].join(),
  );
  check("an unpublished high-seller is excluded", !bs.includes(`${TAG}-bs-draft`));

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
