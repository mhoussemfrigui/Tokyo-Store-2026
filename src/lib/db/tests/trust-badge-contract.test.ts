/**
 * Trust-badge CONTRACT (pure, no DB): the icon resolver's safety + fallback, the
 * name↔component map exhaustiveness, the migration seed icons, and the appearance
 * config coercion. These guard the edge cases the subsystem fixes introduced
 * (prototype-unsafe icon lookup, icon-set drift, bad settings values).
 *
 * Run: pnpm exec tsx src/lib/db/tests/trust-badge-contract.test.ts
 */
import { TRUST_ICON_MAP, TRUST_ICON_NAMES, trustIcon } from "@/lib/home/trust-icons";
import { isTrustIconName } from "@/lib/home/trust-icon-names";
import {
  getTrustBadgeAppearance,
  isSurfaceEnabled,
  TRUST_BADGE_APPEARANCE_DEFAULTS,
  TRUST_BADGE_SETTING_KEYS,
} from "@/lib/cms/trust-badge-appearance";

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

// The icons migration 0060 seeds — must stay inside the curated set.
const SEED_ICONS = ["Lock", "Truck", "RotateCcw", "ShieldCheck"];

function main() {
  console.log("icon map ↔ names:");
  check(
    "every name has a component and vice-versa (no drift)",
    TRUST_ICON_NAMES.every((n) => Boolean(TRUST_ICON_MAP[n])) &&
      Object.keys(TRUST_ICON_MAP).length === TRUST_ICON_NAMES.length,
  );
  check("every migration-0060 seed icon is in the curated set", SEED_ICONS.every((n) => isTrustIconName(n)));

  console.log("trustIcon() resolution:");
  check("a known name resolves to its own component", trustIcon("Truck") === TRUST_ICON_MAP.Truck);
  check("an unknown name falls back to ShieldCheck", trustIcon("Nope") === TRUST_ICON_MAP.ShieldCheck);
  check("null/empty falls back to ShieldCheck", trustIcon(null) === TRUST_ICON_MAP.ShieldCheck && trustIcon("") === TRUST_ICON_MAP.ShieldCheck);
  // Prototype-safety: a stored key like "constructor"/"__proto__"/"toString" must
  // NOT resolve to an Object.prototype member (rendering that would crash).
  for (const proto of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    check(`prototype key "${proto}" → ShieldCheck (not an Object member)`, trustIcon(proto) === TRUST_ICON_MAP.ShieldCheck);
    check(`isTrustIconName("${proto}") is false`, !isTrustIconName(proto));
  }

  console.log("appearance config coercion:");
  const empty = getTrustBadgeAppearance({});
  check("missing settings → documented defaults", JSON.stringify(empty) === JSON.stringify(TRUST_BADGE_APPEARANCE_DEFAULTS));
  const valid = getTrustBadgeAppearance({
    [TRUST_BADGE_SETTING_KEYS.style]: "grid",
    [TRUST_BADGE_SETTING_KEYS.iconStyle]: "square",
    [TRUST_BADGE_SETTING_KEYS.showOnProduct]: "false",
    [TRUST_BADGE_SETTING_KEYS.showOnCart]: "false",
    [TRUST_BADGE_SETTING_KEYS.showOnCheckout]: "true",
  });
  check("valid values parse", valid.style === "grid" && valid.iconStyle === "square" && !valid.showOnProduct && !valid.showOnCart && valid.showOnCheckout);
  const bad = getTrustBadgeAppearance({
    [TRUST_BADGE_SETTING_KEYS.style]: "fancy",
    [TRUST_BADGE_SETTING_KEYS.iconStyle]: "neon",
    [TRUST_BADGE_SETTING_KEYS.showOnProduct]: "maybe",
  });
  check("unknown enum / bool values fall back to defaults", bad.style === "list" && bad.iconStyle === "circle" && bad.showOnProduct === true);

  console.log("isSurfaceEnabled:");
  check(
    "maps each surface to its toggle",
    isSurfaceEnabled(valid, "checkout") &&
      !isSurfaceEnabled(valid, "product") &&
      !isSurfaceEnabled(valid, "cart"),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
