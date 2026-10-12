/**
 * Pure unit tests for the low-stock alert config + crossing detection (L10).
 * NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/low-stock.test.ts
 */
import {
  resolveLowStockConfig,
  classifyStockCrossing,
  parseRecipients,
  LOW_STOCK_DEFAULTS,
} from "@/lib/inventory/low-stock";
import { isEffectivelyOutOfStock, isLowStock } from "@/lib/inventory/stock-state";

let passed = 0;
let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

console.log("low-stock:");

// ── resolveLowStockConfig
eq("empty map → defaults", resolveLowStockConfig({}), LOW_STOCK_DEFAULTS);
eq(
  "enabled + threshold + recipients parsed",
  resolveLowStockConfig({
    "stock.alert_enabled": "true",
    "stock.low_threshold_qty": "12",
    "stock.alert_recipients": "Ops@Ex.tn, ops@ex.tn ; buyer@ex.tn",
  }),
  { enabled: true, threshold: 12, recipients: ["ops@ex.tn", "buyer@ex.tn"] },
);
eq(
  "blank threshold → default; off",
  resolveLowStockConfig({ "stock.alert_enabled": "false", "stock.low_threshold_qty": "" }),
  { enabled: false, threshold: LOW_STOCK_DEFAULTS.threshold, recipients: [] },
);
eq(
  "negative threshold clamps to 0",
  resolveLowStockConfig({ "stock.low_threshold_qty": "-4" }).threshold,
  0,
);
eq(
  "fractional threshold truncates",
  resolveLowStockConfig({ "stock.low_threshold_qty": "7.9" }).threshold,
  7,
);
eq(
  "NaN threshold → default",
  resolveLowStockConfig({ "stock.low_threshold_qty": "abc" }).threshold,
  LOW_STOCK_DEFAULTS.threshold,
);
eq("'on' counts as enabled", resolveLowStockConfig({ "stock.alert_enabled": "on" }).enabled, true);

// ── parseRecipients
eq("recipients dedup + lowercase", parseRecipients("A@x.tn, a@x.tn"), ["a@x.tn"]);
eq("non-emails dropped", parseRecipients("hello, b@x.tn, world"), ["b@x.tn"]);
eq("null → []", parseRecipients(null), []);

// ── classifyStockCrossing (threshold 5)
eq("4→0 = depleted", classifyStockCrossing(4, 0, 5), "depleted");
eq("10→0 = depleted (also under threshold but 0 wins)", classifyStockCrossing(10, 0, 5), "depleted");
eq("8→3 = low (crossed 5)", classifyStockCrossing(8, 3, 5), "low");
eq("8→5 = low (lands ON threshold)", classifyStockCrossing(8, 5, 5), "low");
eq("4→3 already below threshold → null (no fresh crossing)", classifyStockCrossing(4, 3, 5), null);
eq("20→10 above threshold → null", classifyStockCrossing(20, 10, 5), null);
eq("increase (restock) → null", classifyStockCrossing(2, 9, 5), null);
eq("no change → null", classifyStockCrossing(5, 5, 5), null);
eq("threshold 0 disables low tier; 3→1 → null", classifyStockCrossing(3, 1, 0), null);
eq("threshold 0 still reports depleted; 3→0", classifyStockCrossing(3, 0, 0), "depleted");
eq("already 0, stays 0 → null", classifyStockCrossing(0, 0, 5), null);

// ── admin display predicates (Stock badges / Produits pill — JS twins of the
//    stock page's SQL filters, so a badge agrees with the chip that lists it)
eq("out: unticked Disponible", isEffectivelyOutOfStock(false, 10), true);
eq("out: tracked 0 left Disponible (unbuyable) → Rupture, not OK", isEffectivelyOutOfStock(true, 0), true);
eq("out: untracked + ticked → sellable", isEffectivelyOutOfStock(true, null), false);
eq("out: untracked + unticked → Rupture", isEffectivelyOutOfStock(false, null), true);
eq("out: tracked 3 + ticked → sellable", isEffectivelyOutOfStock(true, 3), false);
eq("low: 3 ≤ threshold 5", isLowStock(true, 3, 5), true);
eq("low: ON the threshold (5)", isLowStock(true, 5, 5), true);
eq("low: above threshold (6)", isLowStock(true, 6, 5), false);
eq("low: configured threshold honoured (8 ≤ 10)", isLowStock(true, 8, 10), true);
eq("low: configured threshold honoured (3 > 2)", isLowStock(true, 3, 2), false);
eq("low: tracked 0 is Rupture, not Bas", isLowStock(true, 0, 5), false);
eq("low: unticked is Rupture, not Bas", isLowStock(false, 2, 5), false);
eq("low: untracked is never Bas", isLowStock(true, null, 5), false);
eq("low: threshold 0 disables the tier", isLowStock(true, 1, 0), false);
// Bas / Rupture are disjoint for every state (a row is never both).
{
  let disjoint = true;
  for (const inStock of [true, false]) {
    for (const qty of [null, 0, 1, 4, 5, 9]) {
      if (isLowStock(inStock, qty, 5) && isEffectivelyOutOfStock(inStock, qty)) disjoint = false;
    }
  }
  eq("Bas ∩ Rupture = ∅", disjoint, true);
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
