/**
 * Footer appearance config (pure, no DB): getFooterAppearance coerces the
 * `storefront.footer.*` settings into a safe config — defaults when unset, the
 * allow-list enum fallback on a bad value, and boolean parsing for the toggles.
 * Guards the one contract the shop layout (read) and the Footer admin (edit) share.
 *
 * Run: pnpm exec tsx src/lib/db/tests/footer-appearance.test.ts
 */
import {
  getFooterAppearance,
  FOOTER_APPEARANCE_DEFAULTS,
  FOOTER_SETTING_KEYS,
  FOOTER_TONES,
  FOOTER_NEWSLETTER_STYLES,
  FOOTER_SOCIAL_STYLES,
} from "@/lib/cms/footer-appearance";

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
  console.log("defaults (no settings):");
  const d = getFooterAppearance({});
  check("empty map → the documented defaults", JSON.stringify(d) === JSON.stringify(FOOTER_APPEARANCE_DEFAULTS));
  check("default tone=onyx, newsletter=banner, social=circle", d.tone === "onyx" && d.newsletterStyle === "banner" && d.socialStyle === "circle");
  check("show-toggles default ON", d.showDescription && d.showContact && d.showSocials);

  console.log("valid values parse:");
  const v = getFooterAppearance({
    [FOOTER_SETTING_KEYS.tone]: "olive",
    [FOOTER_SETTING_KEYS.newsletterStyle]: "card",
    [FOOTER_SETTING_KEYS.socialStyle]: "square",
    [FOOTER_SETTING_KEYS.showDescription]: "false",
    [FOOTER_SETTING_KEYS.showContact]: "true",
    [FOOTER_SETTING_KEYS.showSocials]: "0",
  });
  check("tone/newsletter/social enums parsed", v.tone === "olive" && v.newsletterStyle === "card" && v.socialStyle === "square");
  check("toggles parsed (false / true / 0)", v.showDescription === false && v.showContact === true && v.showSocials === false);

  console.log("bad values fall back to defaults (never an invalid variant):");
  const bad = getFooterAppearance({
    [FOOTER_SETTING_KEYS.tone]: "neon",
    [FOOTER_SETTING_KEYS.newsletterStyle]: "popup",
    [FOOTER_SETTING_KEYS.socialStyle]: "hexagon",
  });
  check("unknown tone → onyx", bad.tone === "onyx");
  check("unknown newsletter style → banner", bad.newsletterStyle === "banner");
  check("unknown social style → circle", bad.socialStyle === "circle");
  check(
    "every resolved enum is in its allow-list",
    (FOOTER_TONES as readonly string[]).includes(bad.tone) &&
      (FOOTER_NEWSLETTER_STYLES as readonly string[]).includes(bad.newsletterStyle) &&
      (FOOTER_SOCIAL_STYLES as readonly string[]).includes(bad.socialStyle),
  );

  console.log("newsletter off:");
  check("style 'off' is honored", getFooterAppearance({ [FOOTER_SETTING_KEYS.newsletterStyle]: "off" }).newsletterStyle === "off");

  console.log("tolerant parse (the contract the admin pre-fill leans on):");
  // The admin form reads the pre-fill through the SAME asBool/asEnum, so these
  // aliases/case/trim must hold or the checkbox/select and the footer disagree.
  const tol = getFooterAppearance({
    [FOOTER_SETTING_KEYS.tone]: " Olive ",
    [FOOTER_SETTING_KEYS.socialStyle]: "SQUARE",
    [FOOTER_SETTING_KEYS.showSocials]: "on",
    [FOOTER_SETTING_KEYS.showDescription]: "off",
  });
  check("enum trims + case-folds (' Olive ' → olive, 'SQUARE' → square)", tol.tone === "olive" && tol.socialStyle === "square");
  check("bool aliases ('on' → true, 'off' → false)", tol.showSocials === true && tol.showDescription === false);
  check(
    "empty string → the field default (not a silent OFF)",
    getFooterAppearance({ [FOOTER_SETTING_KEYS.showContact]: "" }).showContact === FOOTER_APPEARANCE_DEFAULTS.showContact,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
