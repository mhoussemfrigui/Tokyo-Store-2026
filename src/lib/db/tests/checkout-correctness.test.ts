import "server-only";

/**
 * Checkout pricing / coupon / express correctness (A–Z 2026-09-23, p3-checkout):
 *
 *   A. PURE — the express home-delivery fee preview (`expressHomeOptionFees`)
 *      re-applies the free-shipping threshold to price × quantity (the PDP config
 *      is built at subtotal 0): base / own / « never free » thresholds, the zone
 *      rate for the chosen gouvernorat, and an unknown option left as-is.
 *   B. LIVE CART PRICING — `priceCartLinesLive` re-prices a cart line at its
 *      CURRENT base + live auto-promos (not the stale add-time price), and the
 *      coupon candidate the place-order action forwards is the one the pages show:
 *      a min-cart code between the stale and live subtotals, and a scoped code
 *      with no matching line falling back to the URL promo.
 *   C. ZERO-TOTAL ONLINE ORDER — `initiatePaymentWorkflow` refuses a 0 amount
 *      (`zero_amount`); `settleZeroTotalOrderWorkflow` moves the pending online
 *      order to `paid` (reference « zero-total ») and refuses anything else.
 *   D. EXPRESS — the master switch is enforced by the workflow (`disabled`); both
 *      cookie candidates are evaluated in order (an ineligible code no longer
 *      hides an eligible URL promo); `redeemedPromotionId` reports only a
 *      promotion the order actually redeemed.
 *
 * Self-cleaning (`__ckctest…`). Sections B–D write rows and place real orders —
 * run ONLY against a throwaway test DB (EMAIL_PROVIDER=console):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/checkout-correctness.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { carts } from "@/modules/cart/schema";
import { cartService } from "@/modules/cart/service";
import { orderService } from "@/modules/order/service";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow, PromotionRow } from "@/modules/promotion/schema";
import { workflows } from "@/workflows";
import {
  initiatePaymentWorkflow,
  settleZeroTotalOrderWorkflow,
  ZERO_TOTAL_PAYMENT_REFERENCE,
} from "@/workflows/order/gateway-payment";
import { resolveCartPromotionFromCandidates } from "@/lib/cart/coupon";
import { couponLinesOf, priceCartLinesLive } from "@/lib/cart/live-lines";
import { expressHomeOptionFees } from "@/lib/checkout/express-delivery-fees";
import type { DeliveryOption } from "@/lib/checkout/delivery";

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

const TAG = "__ckctest";
const HOME_KEY = "delivery.home_enabled";
const QUICK_KEY = "checkout.quick.enabled";
/** Express idempotency keys this run used (their `qb-<key>` carts are cleaned up). */
const usedKeys: string[] = [];

async function cleanup() {
  await db.execute(
    sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like ${TAG + "%"})`,
  );
  const mine = sql`(select id from orders where contact_phone = ${TAG})`;
  await db.execute(sql`delete from stock_movements where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where contact_phone = ${TAG}`);
  await db.execute(sql`delete from carts where token like ${TAG + "%"}`);
  // Express ephemeral carts of this run (`qb-<key>`; a placed order's is kept).
  if (usedKeys.length > 0) {
    await db.delete(carts).where(inArray(carts.token, usedKeys.map((k) => `qb-${k.toLowerCase()}`)));
  }
  await db.execute(sql`delete from cart_items where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

let seq = 0;
async function mkPromo(over: Partial<NewPromotionRow>): Promise<PromotionRow> {
  seq += 1;
  return promotionService.insert({
    name: `${TAG}-${seq}`,
    trigger_kind: "code",
    code: `__CKCTEST${seq}`,
    scope: "cart",
    discount_type: "fixed",
    discount_value: 5_000,
    is_active: true,
    ...over,
  } as NewPromotionRow);
}

async function mkProduct(slug: string, priceCents: number): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${slug}`,
      name: `${TAG} ${slug}`,
      price_cents: priceCents,
      stock_qty: 20,
      in_stock: true,
      is_published: true,
    } as never)
    .returning({ id: products.id });
  return row.id;
}

// ── A. Pure: express fee preview ──────────────────────────────────────────────
function pureExpressFees() {
  console.log("A. express home-delivery fee preview");
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const home: DeliveryOption[] = [
    { method: "home_delivery", label: "Livraison à domicile", feeCents: 7_000, freeApplied: false },
    { method: "home_delivery", id: A, label: "Coursier A", feeCents: 8_000, freeApplied: false },
    { method: "home_delivery", id: B, label: "Coursier B", feeCents: 6_000, freeApplied: false },
    { method: "home_delivery", id: C, label: "Coursier C", feeCents: 5_000, freeApplied: false },
  ];
  // Base 250 TND; A its own 300 TND; B « never free » (0); C unknown to the map.
  const thresholds = { "": 250_000, [A]: 300_000, [B]: 0 };
  const at = (goodsCents: number, region = "", zoneFeeIndex = {}) =>
    expressHomeOptionFees(home, { goodsCents, region, zoneFeeIndex, homeFreeThresholds: thresholds });

  const above = at(273_500); // the live median watch price
  check("base option above its threshold → Offerte (0, freeApplied)", above[0].feeCents === 0 && above[0].freeApplied);
  check("courier with its OWN higher threshold → still charged (8 TND)", above[1].feeCents === 8_000 && !above[1].freeApplied);
  check("courier with threshold 0 (« never free ») → charged (6 TND)", above[2].feeCents === 6_000 && !above[2].freeApplied);
  check("option absent from the threshold map → preview fee kept", above[3].feeCents === 5_000 && !above[3].freeApplied);

  const below = at(100_000);
  check("below every threshold → raw fees", below.map((o) => o.feeCents).join(",") === "7000,8000,6000,5000");
  check("exactly at the base threshold → free (>=)", at(250_000)[0].feeCents === 0);
  check("quantity counts: 2 × 150 TND crosses 250 TND", at(2 * 150_000)[0].freeApplied);

  const zone = { tunis: { [A]: { feeCents: 9_000, thresholdCents: 200_000 } } };
  const zoned = at(273_500, "Tunis", zone);
  check("zone-priced courier for the chosen gouvernorat → zone threshold applies (free)", zoned[1].feeCents === 0 && zoned[1].freeApplied);
  check("…below the zone threshold → the ZONE fee (9 TND), not the flat one", at(150_000, "Tunis", zone)[1].feeCents === 9_000);
  check("another gouvernorat → falls back to the courier's own threshold", at(273_500, "Sfax", zone)[1].feeCents === 8_000);
  check("the base option is never zone-priced", zoned[0].feeCents === 0 && at(150_000, "Tunis", zone)[0].feeCents === 7_000);
  check(
    "no threshold map (older config) → options unchanged",
    expressHomeOptionFees(home, { goodsCents: 999_999, region: "", zoneFeeIndex: {}, homeFreeThresholds: undefined })
      .every((o, i) => o.feeCents === home[i].feeCents),
  );
}

// ── B. Live cart pricing + coupon candidate ───────────────────────────────────
async function liveCartCoupon() {
  console.log("B. live cart pricing → forwarded coupon = displayed coupon");
  // A line added at 480 TND (e.g. during an auto-promo that has since ended); the
  // product's live price is now 520 TND.
  const p1 = await mkProduct("live", 520_000);
  const cart = await cartService.createCart({ user_id: null, token: `${TAG}-cart-${randomUUID()}` });
  await cartService.upsertItem({ cart_id: cart.id, product_id: p1, variant_id: "", quantity: 1, unit_price_cents: 480_000 });

  const live = await priceCartLinesLive(await cartService.listItems(cart.id));
  check("live subtotal = current base (520 TND), not the stale 480 TND", live.subtotalCents === 520_000);
  check(
    "…line carries live unit + base, qty-multiplied line amounts",
    live.lines.length === 1 &&
      live.lines[0].unitCents === 520_000 &&
      live.lines[0].baseCents === 520_000 &&
      live.lines[0].lineCents === 520_000 &&
      live.lines[0].baseLineCents === 520_000,
  );
  check("…not on sale → the whole line is discountable", live.discountableSubtotalCents === 520_000);

  const code = await mkPromo({ min_cart_cents: 500_000 });
  const url = await mkPromo({ discount_value: 2_000 });
  const candidates = [
    { id: code.id, source: "code" as const },
    { id: url.id, source: "url" as const },
  ];
  const liveCtx = {
    subtotalCents: live.subtotalCents,
    userId: null,
    discountableSubtotalCents: live.discountableSubtotalCents,
    lines: couponLinesOf(live),
  };
  const picked = await resolveCartPromotionFromCandidates(candidates, liveCtx);
  check("live basis → the min-cart 500 TND code applies (what /checkout shows)", picked?.promotionId === code.id && picked.source === "code");
  const stale = await resolveCartPromotionFromCandidates(candidates, { subtotalCents: 480_000, userId: null });
  check("(the stale add-time basis would have swapped in the URL promo — the bug)", stale?.promotionId === url.id);

  // A scoped code with no matching line in the cart → the URL promo, as the pages.
  const scoped = await mkPromo({ scope: "product", scope_id: randomUUID(), discount_type: "percent", discount_value: 10 });
  const scopedCandidates = [
    { id: scoped.id, source: "code" as const },
    { id: url.id, source: "url" as const },
  ];
  const scopedLive = await resolveCartPromotionFromCandidates(scopedCandidates, liveCtx);
  check("scoped code without a matching line → falls back to the URL promo", scopedLive?.promotionId === url.id);
  const scopedNoLines = await resolveCartPromotionFromCandidates(scopedCandidates, { subtotalCents: live.subtotalCents, userId: null });
  check("(without the lines the scoped code was forwarded with a 0 discount — the bug)", scopedNoLines?.promotionId === scoped.id);

  // A LIVE auto-promo re-prices the line (unit < base → on sale, not discountable).
  const p2 = await mkProduct("auto", 100_000);
  await mkPromo({ trigger_kind: "auto", code: null, scope: "product", scope_id: p2, discount_type: "percent", discount_value: 20 });
  const onSale = await priceCartLinesLive([
    { product_id: p2, variant_id: "", quantity: 2, unit_price_cents: 100_000 },
  ]);
  check(
    "live auto-promo → unit 80 TND, base 100 TND, line 160 TND",
    onSale.lines[0].unitCents === 80_000 && onSale.lines[0].baseCents === 100_000 && onSale.subtotalCents === 160_000,
  );
  check("…an on-sale line is excluded from the discountable subtotal", onSale.discountableSubtotalCents === 0);

  const gone = await priceCartLinesLive([
    { product_id: randomUUID(), variant_id: "", quantity: 3, unit_price_cents: 10_000 },
  ]);
  check("a line whose product is gone keeps its cached price", gone.subtotalCents === 30_000);
  check("an empty cart prices to 0", (await priceCartLinesLive([])).subtotalCents === 0);
}

// ── C. Zero-total online order ────────────────────────────────────────────────
async function zeroTotal() {
  console.log("C. zero-total online order");
  let n = 0;
  const mkOrder = (paymentMethod: "clictopay" | "flouci" | "cod", totalCents: number) =>
    orderService.insertOrder({
      order_number: `${TAG}-z${++n}-${randomUUID().slice(0, 8)}`,
      contact_email: `${TAG}@example.test`,
      contact_phone: TAG,
      status: "pending",
      subtotal_cents: 50_000,
      discount_cents: 50_000 - totalCents,
      total_cents: totalCents,
      payment_method: paymentMethod,
      ship_full_name: "Zero Test",
      ship_street_line1: "1 rue du Lac",
      ship_city: "Tunis",
    } as never);

  const zero = await mkOrder("clictopay", 0);
  const init = await initiatePaymentWorkflow({ orderId: zero.id }, { actorUserId: null });
  check("initiatePayment refuses a 0 amount → zero_amount", !init.ok && init.error === "zero_amount");

  const settled = await settleZeroTotalOrderWorkflow({ orderId: zero.id }, { actorUserId: null });
  check("settleZeroTotal → ok", settled.ok);
  const after = await orderService.findById(zero.id);
  check("…order is paid", after?.status === "paid");
  check(`…payment_reference = « ${ZERO_TOTAL_PAYMENT_REFERENCE} »`, after?.payment_reference === ZERO_TOTAL_PAYMENT_REFERENCE);
  check("…paid_at stamped", after?.paid_at != null);
  const again = await settleZeroTotalOrderWorkflow({ orderId: zero.id }, { actorUserId: null });
  check("settling again → not_pending", !again.ok && again.error === "not_pending");

  const owed = await mkOrder("flouci", 5_000);
  const owedRes = await settleZeroTotalOrderWorkflow({ orderId: owed.id }, { actorUserId: null });
  check("a pending online order with an amount due → not_zero_total", !owedRes.ok && owedRes.error === "not_zero_total");
  check("…and stays pending", (await orderService.findById(owed.id))?.status === "pending");

  const cod = await mkOrder("cod", 0);
  const codRes = await settleZeroTotalOrderWorkflow({ orderId: cod.id }, { actorUserId: null });
  check("a zero-total COD order → not_online (settles at delivery)", !codRes.ok && codRes.error === "not_online");

  const missing = await settleZeroTotalOrderWorkflow({ orderId: randomUUID() }, { actorUserId: null });
  check("unknown order → not_found", !missing.ok && missing.error === "not_found");
}

// ── D. Express: master switch + candidates + redeemed promotion ───────────────
async function express() {
  console.log("D. express master switch + promotion candidates");
  const productId = await mkProduct("quick", 50_000);
  const quick = (promotionCandidates?: Array<{ id: string; source: "code" | "url" }>) => {
    const idempotencyKey = randomUUID();
    usedKeys.push(idempotencyKey);
    return workflows.order.placeQuick(
      {
        productId,
        quantity: 1,
        contactEmail: "",
        contactPhone: TAG,
        shipping: { fullName: "CKC Test", streetLine1: "1 rue du Lac", city: "Tunis", region: "Tunis" },
        deliveryMethod: "home_delivery",
        paymentMethod: "cod",
        promotionCandidates,
        idempotencyKey,
      },
      { actorUserId: null },
    );
  };
  const discountOf = async (orderId: string) => (await orderService.findById(orderId))?.discount_cents ?? -1;

  await db.execute(
    sql`insert into site_settings (key, value, type, label) values (${QUICK_KEY}, 'false', 'boolean', 'test')
        on conflict (key) do update set value = 'false'`,
  );
  const off = await quick();
  check("express switched OFF → the workflow refuses (disabled)", !off.ok && off.error === "disabled");
  await db.execute(sql`update site_settings set value = 'true' where key = ${QUICK_KEY}`);

  const tooBig = await mkPromo({ min_cart_cents: 10_000_000 }); // code: never eligible here
  const urlPromo = await mkPromo({ discount_value: 5_000 });
  const first = await quick([
    { id: tooBig.id, source: "code" },
    { id: urlPromo.id, source: "url" },
  ]);
  check("ineligible code + eligible URL promo → placed", first.ok);
  check(
    "…the URL promo is applied + reported as redeemed",
    first.ok && first.data.redeemedPromotionId === urlPromo.id && (await discountOf(first.data.orderId)) === 5_000,
  );

  const goodCode = await mkPromo({ discount_value: 3_000 });
  const second = await quick([
    { id: goodCode.id, source: "code" },
    { id: urlPromo.id, source: "url" },
  ]);
  check(
    "eligible code first → the code wins (redeemed, 3 TND)",
    second.ok && second.data.redeemedPromotionId === goodCode.id && (await discountOf(second.data.orderId)) === 3_000,
  );

  const none = await quick();
  check("no candidate → placed, nothing redeemed", none.ok && none.data.redeemedPromotionId === null);

  const onlyBad = await quick([{ id: tooBig.id, source: "code" }]);
  check(
    "only an ineligible code → placed without it (not redeemed → the cookie stays)",
    onlyBad.ok && onlyBad.data.redeemedPromotionId === null && (await discountOf(onlyBad.data.orderId)) === 0,
  );
}

async function readSetting(key: string) {
  return (await db.execute<{ value: string | null }>(sql`select value from site_settings where key = ${key}`)).rows[0];
}
async function restoreSetting(key: string, saved: { value: string | null } | undefined) {
  if (saved) await db.execute(sql`update site_settings set value = ${saved.value} where key = ${key}`);
  else await db.execute(sql`delete from site_settings where key = ${key}`);
}

async function main() {
  pureExpressFees();

  await cleanup();
  const savedHome = await readSetting(HOME_KEY);
  const savedQuick = await readSetting(QUICK_KEY);
  try {
    await db.execute(
      sql`insert into site_settings (key, value, type, label) values (${HOME_KEY}, 'true', 'boolean', 'test')
          on conflict (key) do update set value = 'true'`,
    );
    await liveCartCoupon();
    await zeroTotal();
    await express();
  } finally {
    await restoreSetting(HOME_KEY, savedHome);
    await restoreSetting(QUICK_KEY, savedQuick);
    await cleanup();
  }
  // Sanity: nothing of this run survives.
  const left = await db.select({ id: products.id }).from(products).where(eq(products.slug, `${TAG}-quick`));
  check("cleanup removed the test rows", left.length === 0);

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
