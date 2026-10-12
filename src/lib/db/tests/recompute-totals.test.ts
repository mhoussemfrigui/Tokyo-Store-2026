/**
 * Pure unit tests for recomputeOrderTotals — the SINGLE place the order-total
 * arithmetic lives for operator line edits ("byte-for-byte the place-order math").
 * NO DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/recompute-totals.test.ts
 */
import { recomputeOrderTotals } from "@/lib/order/recompute-totals";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("recompute-totals:");

const base = {
  shippingCents: 7_000,
  discountCents: 0,
  taxMode: "ht" as const,
  taxDefaultRateBps: 1900, // 19%
  taxOnShipping: false,
};

// subtotal = Σ unit×qty
const r1 = recomputeOrderTotals({
  ...base,
  lines: [
    { unitPriceCents: 100_000, quantity: 2, taxCents: 31_933 },
    { unitPriceCents: 50_000, quantity: 1, taxCents: 7_983 },
  ],
});
ok("subtotal = Σ unit×qty", r1.subtotalCents === 250_000);
ok("ht mode: tax = Σ line tax (shipping tax off)", r1.taxCents === 39_916);
ok("ht mode: total = subtotal + shipping + tax", r1.totalCents === 250_000 + 7_000 + 39_916);

// ttc mode: tax is NOT added to the total (prices already inclusive)
const rTtc = recomputeOrderTotals({
  ...base,
  taxMode: "ttc",
  lines: [{ unitPriceCents: 119_000, quantity: 1, taxCents: 19_000 }],
});
ok("ttc mode: total excludes the tax add", rTtc.totalCents === 119_000 + 7_000);
ok("ttc mode: taxCents still reported", rTtc.taxCents === 19_000);

// disabled mode: no tax anywhere in the total
const rDisabled = recomputeOrderTotals({
  ...base,
  taxMode: "disabled",
  lines: [{ unitPriceCents: 100_000, quantity: 1, taxCents: 0 }],
});
ok("disabled mode: total = subtotal + shipping (no tax)", rDisabled.totalCents === 107_000);

// taxOnShipping adds the shipping tax (ht mode → into the total)
const rShipTax = recomputeOrderTotals({
  ...base,
  taxOnShipping: true,
  lines: [{ unitPriceCents: 100_000, quantity: 1, taxCents: 15_966 }],
});
// shipping tax on 7000 @ 19% ht = round(7000*1900/10000) = 1330 (EXACT — an
// independent expected value, not re-derived from the returned taxCents, so a
// wrong shipping-tax amount is actually caught).
ok("taxOnShipping: taxCents = line tax + shipping tax (1330)", rShipTax.taxCents === 15_966 + 1_330);
ok("taxOnShipping: total = subtotal + shipping + both taxes", rShipTax.totalCents === 100_000 + 7_000 + 15_966 + 1_330);

// shippingTaxCents override: an existing order's OWN shipping-tax term is kept
// as is — never re-derived from the live on_shipping flag / rate (a post-sale
// config change must not re-tax the shipping of an old order).
const rKeepShip = recomputeOrderTotals({
  ...base,
  taxOnShipping: false, // live flag turned OFF since the sale…
  shippingTaxCents: 1_330, // …but the order was sold with 1.330 of shipping TVA
  lines: [{ unitPriceCents: 100_000, quantity: 2, taxCents: 38_000 }],
});
ok("shippingTaxCents kept although live on_shipping is off", rKeepShip.taxCents === 38_000 + 1_330);
ok("ht: kept shipping TVA still added on top", rKeepShip.totalCents === 200_000 + 7_000 + 38_000 + 1_330);
const rNoShipTax = recomputeOrderTotals({
  ...base,
  taxOnShipping: true, // live flag turned ON since the sale…
  taxDefaultRateBps: 2_000,
  shippingTaxCents: 0, // …the order carried none → none is invented
  lines: [{ unitPriceCents: 100_000, quantity: 1, taxCents: 19_000 }],
});
ok("shippingTaxCents 0 wins over a live on_shipping + rate", rNoShipTax.taxCents === 19_000 && rNoShipTax.totalCents === 126_000);
const rTtcShip = recomputeOrderTotals({
  ...base,
  taxMode: "ttc",
  shippingTaxCents: 1_118,
  lines: [{ unitPriceCents: 119_000, quantity: 1, taxCents: 19_000 }],
});
ok("ttc: kept shipping TVA reported, never added to the total", rTtcShip.taxCents === 20_118 && rTtcShip.totalCents === 126_000);
const rNegShip = recomputeOrderTotals({
  ...base,
  shippingTaxCents: -50,
  lines: [{ unitPriceCents: 10_000, quantity: 1, taxCents: 0 }],
});
ok("negative shippingTaxCents floored at 0", rNegShip.taxCents === 0 && rNegShip.totalCents === 17_000);

// discount re-clamped DOWN to the new (smaller) subtotal
const rClampDisc = recomputeOrderTotals({
  ...base,
  taxMode: "disabled",
  discountCents: 90_000, // bigger than the post-edit subtotal
  lines: [{ unitPriceCents: 40_000, quantity: 1, taxCents: 0 }],
});
ok("discount clamped to subtotal", rClampDisc.clampedDiscountCents === 40_000);
ok("total floored at 0 when discount ≥ subtotal", rClampDisc.totalCents === 7_000); // shipping still due

// discount clamped DOWN to the subtotal (never exceeds it)
const rCoins = recomputeOrderTotals({
  ...base,
  taxMode: "disabled",
  shippingCents: 0,
  discountCents: 120_000, // more than the 100k subtotal
  lines: [{ unitPriceCents: 100_000, quantity: 1, taxCents: 0 }],
});
ok("discount clamped to subtotal", rCoins.clampedDiscountCents === 100_000);
ok("total = 0 when discount consumes subtotal", rCoins.totalCents === 0);

// negative/garbage discount inputs are floored at 0 (never negative-add)
const rNeg = recomputeOrderTotals({
  ...base,
  taxMode: "disabled",
  shippingCents: 0,
  discountCents: -500,
  lines: [{ unitPriceCents: 10_000, quantity: 1, taxCents: 0 }],
});
ok("negative discount floored to 0", rNeg.clampedDiscountCents === 0 && rNeg.totalCents === 10_000);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
