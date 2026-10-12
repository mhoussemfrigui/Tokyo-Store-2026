/**
 * Pure PDP variant matcher (src/lib/catalog/variant-match.ts). No React/DOM/DB.
 * The key regression: a variant carrying a STALE option value id for an axis
 * that is no longer displayed must still resolve (otherwise checkout is blocked
 * with "Choisissez une option… avant de commander.").
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/variant-match.test.ts
 */
import { resolveVariant, axisValueIdSet } from "@/lib/catalog/variant-match";

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

// One axis "edition" (E1/E2), one axis "platform" (P1/P2).
const edition = { attributeId: "edition", values: [{ id: "E1" }, { id: "E2" }] };
const platform = { attributeId: "platform", values: [{ id: "P1" }, { id: "P2" }] };

function main() {
  console.log("axisValueIdSet:");
  check(
    "collects all displayed value ids",
    (() => {
      const s = axisValueIdSet([edition, platform]);
      return s.has("E1") && s.has("E2") && s.has("P1") && s.has("P2") && s.size === 4;
    })(),
  );

  console.log("single-axis resolve:");
  const oneAxisVariants = [
    { id: "v1", optionValueIds: ["E1"] },
    { id: "v2", optionValueIds: ["E2"] },
  ];
  check("matches selected value", resolveVariant([edition], oneAxisVariants, { edition: "E2" })?.id === "v2");
  check("incomplete selection → null", resolveVariant([edition], oneAxisVariants, {}) === null);

  console.log("two-axis resolve:");
  const twoAxisVariants = [
    { id: "a", optionValueIds: ["E1", "P1"] },
    { id: "b", optionValueIds: ["E1", "P2"] },
    { id: "c", optionValueIds: ["E2", "P1"] },
  ];
  check(
    "matches a complete combo (order-independent)",
    resolveVariant([edition, platform], twoAxisVariants, { platform: "P2", edition: "E1" })?.id === "b",
  );
  check(
    "missing one axis → null",
    resolveVariant([edition, platform], twoAxisVariants, { edition: "E1" }) === null,
  );
  check(
    "no matching combo → null",
    resolveVariant([edition, platform], twoAxisVariants, { edition: "E2", platform: "P2" }) === null,
  );

  console.log("STALE id regression (dropped axis):");
  // The "platform" axis was removed → only `edition` is displayed, but the
  // variants still carry the stale platform ids. Selecting an edition must still
  // resolve (this is the buy-blocking bug being fixed).
  const staleVariants = [
    { id: "x", optionValueIds: ["E1", "P1"] },
    { id: "y", optionValueIds: ["E2", "P9-removed"] },
  ];
  check(
    "stale platform id ignored → edition resolves",
    resolveVariant([edition], staleVariants, { edition: "E1" })?.id === "x",
  );
  check(
    "stale unknown id ignored → other edition resolves",
    resolveVariant([edition], staleVariants, { edition: "E2" })?.id === "y",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
