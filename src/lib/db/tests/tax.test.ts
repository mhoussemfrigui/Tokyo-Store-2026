import "server-only";

/**
 * Tax (TVA) engine regression test — the PURE resolver + amount math
 * (src/lib/tax/shared.ts). Covers the most-specific-wins cascade
 * (product → rule → brand → category → global), the category-chain collapse, and the
 * disabled/ttc/ht computation incl. rounding + edge cases. No DB. Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/tax.test.ts
 */
import {
  resolveTaxRateBps,
  categoryChainTaxBps,
  computeTaxCents,
  bpsFromPercent,
  percentFromBps,
  formatTaxRate,
} from "@/lib/tax/shared";

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

function main() {
  // ── Cascade precedence: product → rule → brand → category → global ──
  check(
    "product override wins over everything",
    resolveTaxRateBps({ productTaxBps: 700, matchedRuleBps: 1200, categoryChainTaxBps: 1900, globalBps: 1900 }).source === "product",
  );
  check(
    "rule wins when no product override",
    resolveTaxRateBps({ productTaxBps: null, matchedRuleBps: 1200, categoryChainTaxBps: 1900, globalBps: 1900 }).bps === 1200,
  );
  check(
    "brand wins over category (precedence product→filter→brand→category→global)",
    (() => {
      const r = resolveTaxRateBps({ productTaxBps: null, matchedRuleBps: null, brandTaxBps: 1200, categoryChainTaxBps: 700, globalBps: 1900 });
      return r.source === "brand" && r.bps === 1200;
    })(),
  );
  check(
    "rule outranks brand",
    resolveTaxRateBps({ productTaxBps: null, matchedRuleBps: 1300, brandTaxBps: 1200, categoryChainTaxBps: 700, globalBps: 1900 }).source === "rule",
  );
  check(
    "category wins when no product/rule/brand",
    resolveTaxRateBps({ productTaxBps: null, matchedRuleBps: null, brandTaxBps: null, categoryChainTaxBps: 700, globalBps: 1900 }).source === "category",
  );
  check(
    "brand of 0 is honoured (explicit tax-free brand)",
    resolveTaxRateBps({ productTaxBps: null, matchedRuleBps: null, brandTaxBps: 0, categoryChainTaxBps: 1900, globalBps: 1900 }).bps === 0,
  );
  check(
    "global fallback when nothing set",
    (() => {
      const r = resolveTaxRateBps({ productTaxBps: null, matchedRuleBps: null, categoryChainTaxBps: null, globalBps: 1900 });
      return r.bps === 1900 && r.source === "global";
    })(),
  );
  check(
    "product rate of 0 is honoured (not treated as unset)",
    resolveTaxRateBps({ productTaxBps: 0, matchedRuleBps: 1900, categoryChainTaxBps: 1900, globalBps: 1900 }).bps === 0,
  );

  // ── Category chain collapse (child → parent, first non-null) ──
  check("chain: child rate wins over parent", categoryChainTaxBps([700, 1900]) === 700);
  check("chain: parent used when child null", categoryChainTaxBps([null, 1900]) === 1900);
  check("chain: all-null → null", categoryChainTaxBps([null, null]) === null);
  check("chain: empty / undefined → null", categoryChainTaxBps([]) === null && categoryChainTaxBps(undefined) === null);
  // Deep trees (homme → montres-plongee → submariner → …): the ROOT's rate must
  // still reach the leaf — the call sites now pass the FULL ancestor chain
  // (@/lib/catalog/category-chain), not just node + parent.
  check("chain: root rate reaches a depth-4 leaf", categoryChainTaxBps([null, null, null, 700]) === 700);
  check("chain: nearest ancestor wins in a deep chain", categoryChainTaxBps([null, 1300, null, 700]) === 1300);
  check(
    "resolver accepts a raw chain array for the category tier",
    resolveTaxRateBps({ productTaxBps: null, matchedRuleBps: null, categoryChainTaxBps: [null, 700], globalBps: 1900 }).bps === 700,
  );

  // ── computeTaxCents: disabled / ttc (extract) / ht (add) ──
  check("disabled → 0", computeTaxCents(119000, 1900, "disabled") === 0);
  // ht: 19% on 100.000 TND net = 19.000 millimes added.
  check("ht: adds tax on top", computeTaxCents(100000, 1900, "ht") === 19000);
  // ttc: 19% baked into 119.000 gross → extract 19.000 (net 100.000).
  check("ttc: extracts the baked-in tax", computeTaxCents(119000, 1900, "ttc") === 19000);
  check("ttc: extracted tax never exceeds the gross", computeTaxCents(119000, 1900, "ttc") < 119000);
  check("zero base → 0", computeTaxCents(0, 1900, "ht") === 0);
  check("negative base → 0", computeTaxCents(-5000, 1900, "ht") === 0);
  check("zero rate → 0", computeTaxCents(100000, 0, "ht") === 0);
  // Literal expected value (NOT a re-implementation of computeTaxCents' own
  // formula) so the same rounding bug can't be copied into both sides and pass.
  check("rounding: ht 7% on 12.345 → round(864.15)=864", computeTaxCents(12345, 700, "ht") === 864);

  // ── bps ↔ percent + formatting ──
  check("bpsFromPercent(19) === 1900", bpsFromPercent(19) === 1900);
  check("percentFromBps(1900) === 19", percentFromBps(1900) === 19);
  check("formatTaxRate(1900) === '19 %'", formatTaxRate(1900) === "19 %");
  check("formatTaxRate(1950) shows the fraction", /19,5/.test(formatTaxRate(1950)));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);
