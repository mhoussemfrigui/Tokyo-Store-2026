/**
 * buildAutoPromoName — the inline promotion modal's auto-generated internal name
 * (rescan #9). PURE, client-safe, no DB. Pins the benefit/trigger composition AND
 * the schema-safety invariant: the promo `name` column is
 * `z.string().trim().min(2).max(160)`, and this name is submitted via a hidden
 * input the merchant cannot edit, so a value < 2 or > 160 chars would be an
 * un-fixable validation error. Every case below must land in [2, 160].
 *
 * Run: pnpm exec tsx --conditions=react-server src/lib/db/tests/auto-name.test.ts
 */
import { buildAutoPromoName } from "@/lib/promotions/auto-name";

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

type Args = Parameters<typeof buildAutoPromoName>[0];
function build(o: Partial<Args>): string {
  return buildAutoPromoName({
    triggerKind: "auto",
    discountType: "percent",
    discountValue: "10",
    code: "",
    urlSlug: "",
    grantsFreeShipping: false,
    entityName: "Rolex Submariner",
    ...o,
  });
}

function main() {
  console.log("benefit:");
  check("percent", build({ discountType: "percent", discountValue: "20" }) === "−20 % · Rolex Submariner");
  check("fixed", build({ discountType: "fixed", discountValue: "10" }) === "−10 TND · Rolex Submariner");
  check(
    "free-shipping-only (invalid discount + grantsFreeShipping)",
    build({ discountValue: "0", grantsFreeShipping: true }) === "Livraison offerte · Rolex Submariner",
  );
  check(
    "fallback « Promo » (no valid discount, no free shipping)",
    build({ discountValue: "0" }) === "Promo · Rolex Submariner",
  );
  check("NaN discount → Promo", build({ discountValue: "abc" }) === "Promo · Rolex Submariner");
  check("negative discount is invalid → Promo", build({ discountValue: "-5" }) === "Promo · Rolex Submariner");

  console.log("trigger prefix:");
  check(
    "code trigger uppercases",
    build({ triggerKind: "code", code: "vip30", discountValue: "15" }) ===
      "Code VIP30 · −15 % · Rolex Submariner",
  );
  check(
    "url trigger",
    build({ triggerKind: "url", urlSlug: "early-bird", discountValue: "5" }) ===
      "URL early-bird · −5 % · Rolex Submariner",
  );
  check(
    "blank code → no prefix",
    build({ triggerKind: "code", code: "   ", discountValue: "20" }) === "−20 % · Rolex Submariner",
  );
  check(
    "blank url slug → no prefix",
    build({ triggerKind: "url", urlSlug: "", discountValue: "20" }) === "−20 % · Rolex Submariner",
  );

  console.log("schema safety [2, 160]:");
  const worst = build({ discountValue: "0", entityName: "" }); // "Promo"
  check("min: worst case ≥ 2 chars", worst.length >= 2 && worst === "Promo");
  const long = build({ discountValue: "20", entityName: "X".repeat(400) });
  check("max: long entity sliced to ≤ 160", long.length === 160);
  // A representative spread all lands inside the schema bounds.
  const spread = [
    build({}),
    build({ discountType: "fixed", discountValue: "999999" }),
    build({ triggerKind: "code", code: "z".repeat(200), discountValue: "50" }),
    build({ triggerKind: "url", urlSlug: "s".repeat(200), grantsFreeShipping: true, discountValue: "0" }),
    build({ discountValue: "", entityName: "" }),
  ];
  check(
    "every representative name is within [2, 160]",
    spread.every((n) => n.length >= 2 && n.length <= 160),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
