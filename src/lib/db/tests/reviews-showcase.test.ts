import "server-only";

/**
 * Reviews & showcase correctness (A–Z 2026-09-23, phase 5 — p5-reviews-showcase):
 *
 *   A. PURE / SOURCE — « Achat vérifié » excludes pending / cancelled / REFUNDED
 *      orders; the showcase pin workflow's slug enum derives from COLLECTION_SLUGS
 *      (an unknown slug is refused before any DB access); the dead
 *      `design_variant` key is no longer written by the showcase save nor exposed
 *      by the page config; the product picker accepts a showcase editor.
 *   B. REVIEW SUBMISSION — a customer review is refused (« Produit introuvable »)
 *      on a draft, a soft-deleted or a nonexistent product; accepted on a live
 *      published one; under `buyers_only` a REFUNDED order no longer qualifies
 *      while a delivered one does (and sets verified_purchase).
 *   E. MODERATION LIST — the product-name filter (`q`, LIKE-escaped) + its count
 *      agree; a review whose product was soft-deleted / unpublished is flagged.
 *   F. SHOWCASE PINS — every COLLECTION_SLUG round-trips through the workflow.
 *   G. PUBLIC RATING — the denormalised rating/count source + the status × source
 *      matrix (only approved reviews, manual or customer, count).
 *
 * Self-cleaning (`__rvsc…`). Writes products / orders / reviews — run
 * it ONLY against a throwaway test DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/reviews-showcase.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { COLLECTION_SLUGS } from "@/lib/pages/collection-slugs";
import { getCollectionPageConfig } from "@/lib/pages/collection-page-config";
import { products } from "@/modules/catalog/product/schema";
import { brands } from "@/modules/catalog/brand/schema";
import { orders, order_items } from "@/modules/order/schema";
import { product_reviews } from "@/modules/catalog/review/schema";
import {
  reviewService,
  type ReviewSource,
  type ReviewStatus,
} from "@/modules/catalog/review";
import { showcaseService } from "@/modules/showcase";
import { createReviewWorkflow, UNVERIFIED_ORDER_STATUSES } from "@/workflows/catalog/review";
import { setShowcasePinsWorkflow } from "@/workflows/showcase/set-pins";

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

const TAG = "__rvsc";
const ROOT = process.cwd();
const REVIEW_KEYS = [
  "reviews.enabled",
  "reviews.policy",
  "reviews.require_approval",
  "reviews.rating_source",
] as const;
async function cleanup() {
  const mine = sql`(select id from products where slug like ${TAG + "%"})`;
  await db.execute(sql`delete from product_reviews where product_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.delete(orders).where(like(orders.order_number, `${TAG}%`));
  await db.execute(sql`delete from product_brands where product_id in ${mine}`);
  await db.delete(brands).where(like(brands.slug, `${TAG}%`));
  await db.delete(products).where(like(products.slug, `${TAG}%`));
}

// ── fixtures ────────────────────────────────────────────────────────────────
const LONG_AGO = new Date(Date.now() - 400 * 24 * 3600 * 1000); // past any early-access delay

async function makeProduct(
  suffix: string,
  opts: { published?: boolean; deleted?: boolean } = {},
): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}`,
      name: `${TAG} Montre ${suffix}`,
      price_cents: 100_000,
      is_published: opts.published ?? true,
      published_at: opts.published === false ? null : LONG_AGO,
      deleted_at: opts.deleted ? new Date() : null,
    } as never)
    .returning({ id: products.id });
  return row.id;
}

async function makeOrder(userId: string, productId: string, status: (typeof orders.$inferInsert)["status"]) {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}${randomUUID().slice(0, 8)}`,
      user_id: userId,
      contact_email: "rvsc@example.test",
      status,
      subtotal_cents: 100_000,
      total_cents: 100_000,
      ship_full_name: "RVSC Test",
      ship_street_line1: "1 rue du Test",
      ship_city: "Tunis",
    })
    .returning({ id: orders.id });
  await db.insert(order_items).values({
    order_id: o.id,
    product_id: productId,
    product_name: `${TAG} line`,
    product_slug: `${TAG}-line`,
    unit_price_cents: 100_000,
    quantity: 1,
    subtotal_cents: 100_000,
  });
}

async function setReviewSettings(values: Partial<Record<(typeof REVIEW_KEYS)[number], string>>) {
  for (const [key, value] of Object.entries(values)) {
    await db.execute(
      sql`insert into site_settings (key, value, type, label) values (${key}, ${value}, 'text', 'test')
          on conflict (key) do update set value = ${value}`,
    );
  }
}

// ── A. pure / source ─────────────────────────────────────────────────────────
async function pureAndSource() {
  console.log("A. pure / source invariants");
  const unverified = new Set<string>(UNVERIFIED_ORDER_STATUSES);
  check("refunded orders are NOT a verified purchase", unverified.has("refunded"));
  check("pending + cancelled stay excluded", unverified.has("pending") && unverified.has("cancelled"));
  check(
    "paid / preparing / shipped / delivered still count",
    ["paid", "preparing", "shipped", "delivered"].every((s) => !unverified.has(s)),
  );

  const bad = await setShowcasePinsWorkflow({ slug: "soldes" as never, productIds: [] }, { actorUserId: "x" });
  check("set-pins refuses an unknown slug (validation, no DB write)", !bad.ok && bad.error === "validation");
  const src = readFileSync(join(ROOT, "src", "workflows", "showcase", "set-pins.ts"), "utf8");
  check("set-pins slug enum derives from COLLECTION_SLUGS", /z\.enum\(COLLECTION_SLUGS/.test(src));

  const action = readFileSync(join(ROOT, "src", "lib", "actions", "showcase-settings.ts"), "utf8");
  check("showcase save no longer writes the dead design_variant key", !/key:\s*"design_variant"/.test(action));
  const cfg = await getCollectionPageConfig("nouveautes");
  check("collection page config no longer exposes designVariant", !("designVariant" in cfg));

  const picker = readFileSync(join(ROOT, "src", "lib", "actions", "related-products.ts"), "utf8");
  check(
    "product picker search accepts a showcase editor (showcase:update)",
    /\{\s*module:\s*"showcase",\s*action:\s*"update"\s*\}/.test(picker),
  );
}

// ── B. review submission gate ───────────────────────────────────────────────
async function submission() {
  console.log("B. customer review submission");
  const live = await makeProduct("live");
  const draft = await makeProduct("draft", { published: false });
  const gone = await makeProduct("gone", { deleted: true });
  const input = (productId: string) => ({ productId, rating: 5, title: "Superbe", body: "Montre magnifique, conforme." });
  const ctx = () => ({ userId: `${TAG}-user-${randomUUID().slice(0, 8)}`, authorName: "Testeur" });

  await setReviewSettings({ "reviews.enabled": "true", "reviews.policy": "all", "reviews.require_approval": "true" });
  const onDraft = await createReviewWorkflow(input(draft), ctx());
  check("draft product → refused « Produit introuvable »", !onDraft.ok && onDraft.error === "not_found");
  const onGone = await createReviewWorkflow(input(gone), ctx());
  check("soft-deleted product → refused", !onGone.ok && onGone.error === "not_found");
  const onGhost = await createReviewWorkflow(input(randomUUID()), ctx());
  check("nonexistent product → refused", !onGhost.ok && onGhost.error === "not_found");
  const noRows = await db.select({ id: product_reviews.id }).from(product_reviews).where(inArray(product_reviews.product_id, [draft, gone]));
  check("…no review row was written for the hidden products", noRows.length === 0);
  const onLive = await createReviewWorkflow(input(live), ctx());
  check("live published product → accepted (pending, moderated)", onLive.ok && onLive.data.status === "pending");

  // buyers_only: a REFUNDED purchase no longer qualifies; a delivered one does.
  await setReviewSettings({ "reviews.enabled": "true", "reviews.policy": "buyers_only", "reviews.require_approval": "true" });
  const refundedBuyer = ctx();
  await makeOrder(refundedBuyer.userId, live, "refunded");
  const refused = await createReviewWorkflow(input(live), refundedBuyer);
  check("buyers_only: refunded order → « not_buyer »", !refused.ok && refused.error === "not_buyer");
  const realBuyer = ctx();
  await makeOrder(realBuyer.userId, live, "delivered");
  const accepted = await createReviewWorkflow(input(live), realBuyer);
  check("buyers_only: delivered order → accepted", accepted.ok);
  if (accepted.ok) {
    const row = await reviewService.findById(accepted.data.id);
    check("…and flagged « Achat vérifié »", row?.verified_purchase === true);
  }
}
// ── E. moderation list ───────────────────────────────────────────────────────
async function moderationList() {
  console.log("E. moderation list filter + flags");
  const shown = await makeProduct("modlist");
  const doomed = await makeProduct("modgone");
  const hidden = await makeProduct("moddraft");
  for (const product_id of [shown, doomed, hidden]) {
    await reviewService.insert({
      product_id,
      user_id: null,
      author_name: "Modérateur",
      rating: 4,
      title: "Avis test",
      body: "Avis de test pour la modération.",
      status: "pending",
      source: "manual",
    });
  }
  await db.update(products).set({ deleted_at: new Date() }).where(eq(products.id, doomed));
  await db.update(products).set({ is_published: false }).where(eq(products.id, hidden));

  const q = `${TAG} Montre mod`;
  const rows = await reviewService.listForAdmin({ q, limit: 50 });
  const count = await reviewService.countForAdmin({ q });
  check("product-name filter returns exactly the matching reviews", rows.length === 3 && count === 3);
  const byProduct = new Map(rows.map((r) => [r.review.product_id, r]));
  check("live product row: not flagged", byProduct.get(shown)?.productDeleted === false && byProduct.get(shown)?.productPublished === true);
  check("soft-deleted product row: flagged deleted", byProduct.get(doomed)?.productDeleted === true);
  check("unpublished product row: flagged unpublished", byProduct.get(hidden)?.productPublished === false);
  check("LIKE metacharacters are literal (no wildcard match)", (await reviewService.countForAdmin({ q: `${TAG}%` })) === 0);
  const page2 = await reviewService.listForAdmin({ q, limit: 2, offset: 2 });
  check("offset paging reaches the remaining row", page2.length === 1);
}

// ── F. showcase pins round-trip ──────────────────────────────────────────────
async function showcasePins() {
  console.log("F. showcase pins");
  for (const slug of COLLECTION_SLUGS) {
    const before = await showcaseService.listPinnedProductIds(slug);
    const res = await setShowcasePinsWorkflow({ slug, productIds: before }, { actorUserId: `${TAG}-admin` });
    const after = await showcaseService.listPinnedProductIds(slug);
    check(`« ${slug} » pins save (unchanged)`, res.ok && after.join(",") === before.join(","));
  }
}

// ── G. public-rating source (reviews.rating_source) ───────────────────────────
async function ratingSourceAggregate() {
  console.log("G. public-rating source + status×source matrix");
  const pid = await makeProduct("ratingsrc");
  const seed = (source: ReviewSource, status: ReviewStatus, rating: number, n: number) =>
    Array.from({ length: n }, () => ({
      product_id: pid,
      user_id: null,
      author_name: "G Testeur",
      rating,
      title: "Avis test G",
      body: "Corps de l'avis de test G.",
      status,
      source,
    }));

  // Matrix delta isolates THIS product's contribution from the shared DB.
  const before = await reviewService.statusSourceMatrix();
  await reviewService.insertMany([
    ...seed("customer", "approved", 5, 4), // 4×5 = 20
    ...seed("ai", "approved", 2, 2), //       2×2 = 4
    ...seed("manual", "approved", 3, 2), //   2×3 = 6
    ...seed("customer", "pending", 1, 1), //  not approved → never counts
  ]);
  const after = await reviewService.statusSourceMatrix();
  const d = (st: ReviewStatus, sr: ReviewSource) => after[st][sr] - before[st][sr];
  check("matrix: approved.customer +4", d("approved", "customer") === 4);
  check("matrix: approved.ai +2", d("approved", "ai") === 2);
  check("matrix: approved.manual +2", d("approved", "manual") === 2);
  check("matrix: pending.customer +1", d("pending", "customer") === 1);

  // "all" → every approved review counts: 8 rows, avg 30/8 = 3.75.
  await reviewService.recomputeProduct(pid, db, "all");
  let agg = await reviewService.storedAggregate(pid);
  check("all: count = 8 approved (customer+ai+manual)", agg.count === 8);
  check("all: rating = 3.75", agg.average === 3.75);

  // "customers" → only genuine customer approved: 4 rows, avg 5.00. AI/manual excluded.
  await reviewService.recomputeProduct(pid, db, "customers");
  agg = await reviewService.storedAggregate(pid);
  check("customers: count = 4 (ai + manual excluded from the public rating)", agg.count === 4);
  check("customers: rating = 5.00", agg.average === 5);

  // The bulk recompute (setting flip) matches the per-product path for both sources.
  await reviewService.recomputeAll("customers");
  agg = await reviewService.storedAggregate(pid);
  check("recomputeAll('customers') matches per-product (4)", agg.count === 4);
  await reviewService.recomputeAll("all");
  agg = await reviewService.storedAggregate(pid);
  check("recomputeAll('all') matches per-product (8) + restores default", agg.count === 8);

  // The histogram honours the source (matches the headline it sits under).
  const distAll = await reviewService.distribution(pid, "all");
  check("all: distribution {2:2, 3:2, 5:4}", distAll[2] === 2 && distAll[3] === 2 && distAll[5] === 4);
  const distCust = await reviewService.distribution(pid, "customers");
  check(
    "customers: distribution {5:4} only",
    distCust[5] === 4 && distCust[2] === 0 && distCust[3] === 0,
  );
}

async function main() {
  const saved = await db.execute<{ key: string; value: string | null }>(
    sql`select key, value from site_settings where key in ${[...REVIEW_KEYS]}`,
  );
  try {
    await cleanup();
    await pureAndSource();
    await submission();
    await moderationList();
    await showcasePins();
    await ratingSourceAggregate();
  } finally {
    const prev = new Map(saved.rows.map((r) => [r.key, r.value]));
    for (const key of REVIEW_KEYS) {
      if (prev.has(key)) {
        await db.execute(sql`update site_settings set value = ${prev.get(key) ?? null} where key = ${key}`);
      } else {
        await db.execute(sql`delete from site_settings where key = ${key}`);
      }
    }
    await cleanup();
  }

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
