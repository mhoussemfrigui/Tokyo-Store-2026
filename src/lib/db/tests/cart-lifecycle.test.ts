import "server-only";

/**
 * Cart & guest-artefact lifecycle (A–Z 2026-09-23, phase 3 « p3-cart »):
 *
 *   1. LINE CAP — a repeat add (ON CONFLICT merge) and the guest-cart merge on
 *      login cap a line at 99 AND at the product's max_purchase_qty; repeated
 *      adds used to grow a line without bound.
 *   2. ACTIVITY — every line write (upsert / setQuantity / delete) and the merge
 *      bump `carts.updated_at` (it used to stay the creation time forever).
 *   3. ADMIN LIST — `listCartsWithSummary` filters empty + `qb-` carts in SQL
 *      BEFORE the limit, orders by last activity (cart row OR its lines), and its
 *      keyset cursor pages without skipping or repeating ties; a malformed
 *      cursor falls back to the first page.
 *   4. RETENTION — stale guest carts (60 d of no activity) and stale guest
 *      wishlists (180 d) are purged; live / user / quick-buy rows are kept.
 *   5. PLACE-ORDER — a storefront line > 99 is refused (operator / ERP are not
 *      bound); a deleted product's error never shows its raw UUID; a
 *      free-shipping-only coupon's redemption emits `promotion.redeemed`.
 *
 * Self-cleaning (`__cltest…`). Places real orders — run it ONLY against a
 * throwaway test DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/cart-lifecycle.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { products } from "@/modules/catalog/product/schema";
import { carts, cart_items } from "@/modules/cart/schema";
import { cartService, CART_LINE_QTY_MAX } from "@/modules/cart/service";
import { wishlists, wishlist_items } from "@/modules/wishlist/schema";
import { wishlistService } from "@/modules/wishlist";
import { authService } from "@/modules/auth/service";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow } from "@/modules/promotion/schema";
import { RETENTION_WINDOWS } from "@/lib/retention/windows";
import { workflows } from "@/workflows";

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

const TAG = "__cltest";
const U_MERGE = `${TAG}-u-merge`;
const U_OLD = `${TAG}-u-old`;

async function cleanup() {
  const mine = sql`(select id from orders where contact_phone = ${TAG})`;
  await db.execute(sql`delete from promotion_redemptions where order_id in ${mine}`);
  await db.execute(sql`delete from stock_movements where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where contact_phone = ${TAG}`);
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(
    sql`delete from carts where token like ${TAG + "%"} or token like ${"qb-" + TAG + "%"} or user_id like ${TAG + "%"}`,
  );
  await db.execute(sql`delete from wishlists where token like ${TAG + "%"} or user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

async function mkProduct(suffix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${suffix}`,
      name: `${TAG} ${suffix}`,
      price_cents: 50_000,
      in_stock: true,
      is_published: true,
      ...extra,
    } as never)
    .returning({ id: products.id });
  return row.id;
}

async function mkCart(values: { token?: string; user_id?: string }): Promise<string> {
  const [row] = await db.insert(carts).values(values as never).returning({ id: carts.id });
  return row.id;
}

async function addLine(cartId: string, productId: string, quantity: number): Promise<string> {
  const [row] = await db
    .insert(cart_items)
    .values({ cart_id: cartId, product_id: productId, variant_id: "", quantity, unit_price_cents: 50_000 } as never)
    .returning({ id: cart_items.id });
  return row.id;
}

/** Backdate a cart row (and optionally all its lines) by N hours. */
async function age(cartId: string, cartHoursAgo: number, linesHoursAgo?: number) {
  await db.execute(
    sql`update carts set created_at = now() - make_interval(hours => ${cartHoursAgo}), updated_at = now() - make_interval(hours => ${cartHoursAgo}) where id = ${cartId}`,
  );
  if (linesHoursAgo !== undefined) {
    await db.execute(
      sql`update cart_items set created_at = now() - make_interval(hours => ${linesHoursAgo}), updated_at = now() - make_interval(hours => ${linesHoursAgo}) where cart_id = ${cartId}`,
    );
  }
}

async function cartUpdatedAt(cartId: string): Promise<number> {
  const [row] = await db.select({ u: carts.updated_at }).from(carts).where(eq(carts.id, cartId));
  return new Date(row.u).getTime();
}

async function lineQty(cartId: string, productId: string): Promise<number | null> {
  const [row] = await db
    .select({ q: cart_items.quantity })
    .from(cart_items)
    .where(sql`${cart_items.cart_id} = ${cartId} and ${cart_items.product_id} = ${productId}`);
  return row?.q ?? null;
}

async function exists(table: "carts" | "wishlists", id: string): Promise<boolean> {
  const res = await db.execute<{ n: number }>(
    table === "carts"
      ? sql`select count(*)::int as n from carts where id = ${id}`
      : sql`select count(*)::int as n from wishlists where id = ${id}`,
  );
  return Number(res.rows[0]?.n ?? 0) === 1;
}

function place(cartId: string, opts: { actorUserId?: string | null; promotionId?: string; deliveryChannel?: "operator" } = {}) {
  return workflows.order.place(
    {
      cartId,
      contactEmail: "",
      contactPhone: TAG,
      shipping: { fullName: "CL Test", streetLine1: "1 rue du Lac", city: "Tunis", country: "TN" },
      deliveryMethod: "home_delivery",
      paymentMethod: "cod",
      promotionId: opts.promotionId,
    },
    { actorUserId: opts.actorUserId ?? null, deliveryChannel: opts.deliveryChannel },
  );
}

async function main() {
  await cleanup();
  const HOUR_MS = 3_600_000;

  const pA = await mkProduct("a");
  const pMax = await mkProduct("max3", { max_purchase_qty: 3 });

  // ── 1. line cap ─────────────────────────────────────────────────────────────
  console.log("1. line cap");
  {
    const g = await mkCart({ token: `${TAG}-cap` });
    await cartService.upsertItem({ cart_id: g, product_id: pA, variant_id: "", quantity: 60, unit_price_cents: 50_000 });
    await cartService.upsertItem({ cart_id: g, product_id: pA, variant_id: "", quantity: 60, unit_price_cents: 50_000 });
    check(`repeat adds cap the merged line at ${CART_LINE_QTY_MAX} (not 120)`, (await lineQty(g, pA)) === CART_LINE_QTY_MAX);
    await cartService.upsertItem({ cart_id: g, product_id: pMax, variant_id: "", quantity: 2, unit_price_cents: 50_000 });
    await cartService.upsertItem({ cart_id: g, product_id: pMax, variant_id: "", quantity: 2, unit_price_cents: 50_000 });
    check("repeat adds cap at the product's max_purchase_qty (3, not 4)", (await lineQty(g, pMax)) === 3);

    // Guest-cart merge on login: SUM capped the same way.
    const guest = await mkCart({ token: `${TAG}-merge-guest` });
    await addLine(guest, pA, 70);
    await addLine(guest, pMax, 2);
    const userCart = await mkCart({ user_id: U_MERGE });
    await addLine(userCart, pA, 50);
    await addLine(userCart, pMax, 2);
    await age(userCart, 24 * 40, 24 * 40);
    const before = Date.now();
    const moved = await cartService.mergeGuestCart(`${TAG}-merge-guest`, U_MERGE);
    check("merge moved the guest items", moved === true);
    check("merge caps a shared line at 99 (50 + 70)", (await lineQty(userCart, pA)) === CART_LINE_QTY_MAX);
    check("merge caps a shared line at max_purchase_qty (2 + 2 → 3)", (await lineQty(userCart, pMax)) === 3);
    check("guest cart deleted after the merge", !(await exists("carts", guest)));
    check("merge bumps the user cart's updated_at", (await cartUpdatedAt(userCart)) >= before - 5_000);
  }

  // ── 2. activity bump ────────────────────────────────────────────────────────
  console.log("2. updated_at bump");
  {
    const c = await mkCart({ token: `${TAG}-touch` });
    await age(c, 24 * 90);
    const t0 = Date.now() - 5_000;
    const line = await cartService.upsertItem({ cart_id: c, product_id: pA, variant_id: "", quantity: 1, unit_price_cents: 50_000 });
    check("upsertItem bumps carts.updated_at", (await cartUpdatedAt(c)) >= t0);
    await age(c, 24 * 90);
    await cartService.setQuantity(line.id, 4);
    check("setQuantity bumps carts.updated_at", (await cartUpdatedAt(c)) >= t0);
    await age(c, 24 * 90);
    await cartService.deleteItem(line.id);
    check("deleteItem bumps carts.updated_at", (await cartUpdatedAt(c)) >= t0);
    const line2 = await cartService.upsertItem({ cart_id: c, product_id: pA, variant_id: "", quantity: 1, unit_price_cents: 50_000 });
    await age(c, 24 * 90);
    await cartService.setQuantity(line2.id, 0);
    check("setQuantity(0) removes the line AND bumps updated_at", (await cartUpdatedAt(c)) >= t0 && (await lineQty(c, pA)) === null);
  }

  // ── 3. admin list ───────────────────────────────────────────────────────────
  console.log("3. admin « Paniers » list");
  {
    // X: old cart row, but a line touched 1 h ago → most recent activity.
    const x = await mkCart({ token: `${TAG}-list-x` });
    await addLine(x, pA, 2);
    await addLine(x, pMax, 1);
    await age(x, 24 * 10, 1);
    // Y: cart row 2 h ago, lines 5 h ago.
    const y = await mkCart({ token: `${TAG}-list-y` });
    await addLine(y, pA, 1);
    await age(y, 2, 5);
    // Z: everything 3 days ago.
    const z = await mkCart({ user_id: U_OLD });
    await addLine(z, pA, 1);
    await age(z, 72, 72);
    // Ties: three carts sharing ONE exact activity timestamp (keyset tie-break).
    const ties: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await mkCart({ token: `${TAG}-list-tie-${i}` });
      await addLine(t, pA, 1);
      await db.execute(sql`update carts set updated_at = '2020-01-01T00:00:00.123456Z' where id = ${t}`);
      await db.execute(sql`update cart_items set updated_at = '2020-01-01T00:00:00.123456Z' where cart_id = ${t}`);
      ties.push(t);
    }
    // Excluded: an EMPTY cart (most recent of all) and an ephemeral quick-buy cart.
    const empty = await mkCart({ token: `${TAG}-list-empty` });
    const qb = await mkCart({ token: `qb-${TAG}-list` });
    await addLine(qb, pA, 1);

    // Walk every page (other suites may share this DB) with a tiny page size.
    const seen: string[] = [];
    let cursor: string | null = null;
    let firstPageIds: string[] = [];
    for (let page = 0; page < 1000; page++) {
      const res = await cartService.listCartsWithSummary({ cursor, limit: 2 });
      if (page === 0) firstPageIds = res.items.map((r) => r.id);
      seen.push(...res.items.map((r) => r.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    const count = (id: string) => seen.filter((s) => s === id).length;
    check("every non-empty cart listed exactly once across pages", [x, y, z, ...ties].every((id) => count(id) === 1));
    check("tied-timestamp carts all paged (no skip / repeat at the µs boundary)", ties.every((id) => count(id) === 1));
    check("empty cart excluded (in SQL, before the limit)", count(empty) === 0);
    check("quick-buy qb- cart excluded", count(qb) === 0);
    const idx = (id: string) => seen.indexOf(id);
    check("ordered by LAST ACTIVITY: X (line 1 h ago, row 10 d ago) before Y (row 2 h ago)", idx(x) < idx(y));
    check("…and Y before Z (3 days) before the 2020 ties", idx(y) < idx(z) && ties.every((t) => idx(z) < idx(t)));

    const all = await cartService.listCartsWithSummary({ limit: 200 });
    const rowX = all.items.find((r) => r.id === x);
    check("row X: itemCount = Σ quantities (3)", rowX?.itemCount === 3);
    check("row X: subtotal = Σ add-time unit × qty (150 000)", rowX?.subtotalCents === 150_000);
    check(
      "row X: lastActivityAt ≈ its newest line (1 h ago), not the row's 10-day-old updated_at",
      rowX != null && Math.abs(Date.now() - HOUR_MS - rowX.lastActivityAt.getTime()) < 10 * 60_000,
    );
    const malformed = await cartService.listCartsWithSummary({ cursor: "2025-02-30T00:00:00Z__not-a-uuid", limit: 2 });
    check(
      "malformed cursor → first page (no 500 on the casts)",
      JSON.stringify(malformed.items.map((r) => r.id)) === JSON.stringify(firstPageIds),
    );
  }

  // ── 4. retention ────────────────────────────────────────────────────────────
  console.log("4. guest-artefact retention");
  {
    const days = RETENTION_WINDOWS.guest_carts;
    check("guest-cart window (60 d) outlives the 30-day guest cookie", days === 60);
    const old = 24 * (days + 30);
    const s1 = await mkCart({ token: `${TAG}-ret-stale` });
    await addLine(s1, pA, 1);
    await age(s1, old, old);
    const s2 = await mkCart({ token: `${TAG}-ret-recent-line` });
    await addLine(s2, pA, 1);
    await age(s2, old, 24);
    const s3 = await mkCart({ token: `${TAG}-ret-empty` });
    await age(s3, old);
    const s4 = await mkCart({ token: `${TAG}-ret-fresh` });
    await age(s4, 24);
    const sUser = await mkCart({ user_id: `${TAG}-u-ret` });
    await addLine(sUser, pA, 1);
    await age(sUser, old, old);
    const sQb = await mkCart({ token: `qb-${TAG}-ret` });
    await age(sQb, old);

    const purged = await cartService.purgeStaleGuestCarts(days);
    check("purgeStaleGuestCarts reports ≥ 2 removed", purged >= 2);
    check("stale guest cart (row + lines idle) purged", !(await exists("carts", s1)));
    check("emptied stale guest cart purged", !(await exists("carts", s3)));
    check("guest cart with a recently touched line kept (activity ≠ updated_at alone)", await exists("carts", s2));
    check("fresh guest cart kept", await exists("carts", s4));
    check("user cart never purged", await exists("carts", sUser));
    check("qb- cart left to its own ephemeral sweep", await exists("carts", sQb));

    const wDays = RETENTION_WINDOWS.guest_wishlists;
    check("guest-wishlist window = the 180-day cookie max-age", wDays === 180);
    const wOld = wDays + 20;
    const mkList = async (values: { token?: string; user_id?: string }, ageDays: number, itemAgeDays?: number) => {
      const [wl] = await db.insert(wishlists).values(values as never).returning({ id: wishlists.id });
      await db.execute(
        sql`update wishlists set created_at = now() - make_interval(days => ${ageDays}), updated_at = now() - make_interval(days => ${ageDays}) where id = ${wl.id}`,
      );
      if (itemAgeDays !== undefined) {
        await db.insert(wishlist_items).values({ wishlist_id: wl.id, product_id: pA } as never);
        await db.execute(
          sql`update wishlist_items set created_at = now() - make_interval(days => ${itemAgeDays}) where wishlist_id = ${wl.id}`,
        );
      }
      return wl.id;
    };
    const w1 = await mkList({ token: `${TAG}-wl-stale` }, wOld, wOld);
    const w2 = await mkList({ token: `${TAG}-wl-recent-item` }, wOld, 10);
    const w3 = await mkList({ token: `${TAG}-wl-empty` }, wOld);
    const w4 = await mkList({ user_id: `${TAG}-u-wl` }, wOld, wOld);
    const wPurged = await wishlistService.purgeStaleGuestLists(wDays);
    check("purgeStaleGuestLists reports ≥ 2 removed", wPurged >= 2);
    check("stale guest wishlist purged", !(await exists("wishlists", w1)));
    check("empty stale guest wishlist purged", !(await exists("wishlists", w3)));
    check("guest wishlist with a recent item kept", await exists("wishlists", w2));
    check("user wishlist never purged", await exists("wishlists", w4));
  }

  // ── 5. place-order guards + redemption event ────────────────────────────────
  console.log("6. place-order");
  {
    // Storefront line > 99 (legacy / tampered row) → refused, untracked or not.
    const big = await mkCart({ token: `${TAG}-po-big` });
    await addLine(big, pA, 150);
    const r1 = await place(big);
    check(
      "storefront line > 99 → max_purchase_qty refusal naming the 99 cap",
      !r1.ok && r1.error === "max_purchase_qty" && (r1.message ?? "").includes(String(CART_LINE_QTY_MAX)),
    );
    check("refused placement leaves the cart line intact", (await lineQty(big, pA)) === 150);
    // Operator / ERP channel: wholesale quantities are not bound by the cart cap.
    const r2 = await place(big, { deliveryChannel: "operator" });
    check("operator-channel placement of 150 units is accepted", r2.ok === true);

    // Deleted product → generic name, never the raw UUID.
    const pGone = await mkProduct("gone");
    const gone = await mkCart({ token: `${TAG}-po-gone` });
    await addLine(gone, pGone, 1);
    await db.execute(sql`update products set deleted_at = now() where id = ${pGone}`);
    const r3 = await place(gone);
    check(
      "deleted product → friendly message without the product UUID",
      !r3.ok && r3.error === "product_unavailable" && !(r3.message ?? "").includes(pGone) &&
        (r3.message ?? "").startsWith("Un article de votre panier"),
    );

    // Free-shipping-only coupon: a redemption row is written (it zeroed the
    // 7 TND home fee) → promotion.redeemed must fire (discountCents 0).
    const promo = await promotionService.insert({
      name: `${TAG}-fs`,
      trigger_kind: "code",
      code: `${TAG.toUpperCase()}FS`,
      scope: "cart",
      discount_type: "fixed",
      discount_value: 0,
      grants_free_shipping: true,
      is_active: true,
    } as NewPromotionRow);
    const redeemed: Array<{ promotionId: string; discountCents: number }> = [];
    bus.on("promotion.redeemed", (env) => {
      redeemed.push({ promotionId: env.payload.promotionId, discountCents: env.payload.discountCents });
    });
    const fsCart = await mkCart({ token: `${TAG}-po-fs` });
    await addLine(fsCart, pA, 1);
    const r4 = await place(fsCart, { promotionId: promo.id });
    check("free-shipping coupon order placed", r4.ok === true);
    if (r4.ok) {
      const rows = await db.execute<{ n: number; fs: boolean }>(
        sql`select count(*)::int as n, bool_or(free_shipping) as fs from promotion_redemptions where order_id = ${r4.data.orderId}`,
      );
      check("fixture: a free-shipping redemption row was written", Number(rows.rows[0]?.n) === 1 && rows.rows[0]?.fs === true);
      const ev = redeemed.filter((e) => e.promotionId === promo.id);
      check("promotion.redeemed emitted for the free-shipping-only redemption (discountCents 0)", ev.length === 1 && ev[0].discountCents === 0);
    }
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
