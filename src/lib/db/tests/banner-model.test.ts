/**
 * Banner MODEL — pure unit tests for the editable-buttons parse/serialize +
 * back-compat synthesis and the grid-position / strip-tone coercers
 * (src/lib/cms/banner-model.ts). Guards the validation seam the admin form, the
 * workflow (cleanButtons) and the storefront renderers rely on.
 *
 * Pure (no DB). Run:
 *   tsx --conditions=react-server src/lib/db/tests/banner-model.test.ts
 */
import {
  parseBannerButtons,
  serializeBannerButtons,
  effectiveBannerButtons,
  coerceGridPosition,
  coerceStripTone,
  MAX_BANNER_BUTTONS,
  BANNER_BUTTON_VARIANTS,
} from "@/lib/cms/banner-model";

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

console.log("parseBannerButtons:");
check(
  "null / blank / garbled / non-array → []",
  parseBannerButtons(null).length === 0 &&
    parseBannerButtons(undefined).length === 0 &&
    parseBannerButtons("").length === 0 &&
    parseBannerButtons("{bad").length === 0 &&
    parseBannerButtons('{"a":1}').length === 0,
);
check(
  "a valid button round-trips (label, href, variant)",
  (() => {
    const [b] = parseBannerButtons(
      JSON.stringify([{ label: "Voir", href: "/boutique", variant: "primary" }]),
    );
    return b?.label === "Voir" && b?.href === "/boutique" && b?.variant === "primary";
  })(),
);
check(
  "a row missing a label OR a real link is dropped",
  parseBannerButtons(
    JSON.stringify([
      { label: "", href: "/x", variant: "primary" },
      { label: "No link", href: "", variant: "primary" },
      { label: "Only hash", href: "#", variant: "primary" },
    ]),
  ).length === 0,
);
check(
  "javascript: href is dropped (safe-href → not a real link)",
  parseBannerButtons(JSON.stringify([{ label: "x", href: "javascript:alert(1)", variant: "primary" }]))
    .length === 0,
);
check(
  "an unknown variant falls back to 'primary'",
  parseBannerButtons(JSON.stringify([{ label: "x", href: "/x", variant: "nope" }]))[0]?.variant ===
    "primary",
);
check(
  "every declared design is accepted as-is",
  BANNER_BUTTON_VARIANTS.every(
    (v) =>
      parseBannerButtons(JSON.stringify([{ label: "x", href: "/x", variant: v }]))[0]?.variant === v,
  ),
);
check(
  `capped at MAX_BANNER_BUTTONS (${MAX_BANNER_BUTTONS})`,
  parseBannerButtons(
    JSON.stringify(
      Array.from({ length: MAX_BANNER_BUTTONS + 5 }, () => ({
        label: "x",
        href: "/x",
        variant: "primary",
      })),
    ),
  ).length === MAX_BANNER_BUTTONS,
);
check(
  "label is trimmed + capped at 80 chars",
  (() => {
    const [b] = parseBannerButtons(
      JSON.stringify([{ label: "  " + "a".repeat(200) + "  ", href: "/x", variant: "primary" }]),
    );
    return b?.label.length === 80;
  })(),
);

console.log("serializeBannerButtons:");
check(
  "serialize → parse is a round-trip",
  (() => {
    const bs = parseBannerButtons(
      JSON.stringify([{ label: "A", href: "/a", variant: "onyx" }]),
    );
    const again = parseBannerButtons(serializeBannerButtons(bs));
    return again.length === 1 && again[0].label === "A" && again[0].variant === "onyx";
  })(),
);

console.log("effectiveBannerButtons (back-compat):");
check(
  "stored buttons win when present",
  effectiveBannerButtons({
    buttons: JSON.stringify([{ label: "New", href: "/new", variant: "secondary" }]),
    cta_label: "Legacy",
    cta_href: "/legacy",
    secondary_cta_label: null,
    secondary_cta_href: null,
  }).every((b) => b.label === "New"),
);
check(
  "legacy cta_* synthesised when no stored buttons (primary = on-photo, secondary = link)",
  (() => {
    const bs = effectiveBannerButtons({
      buttons: null,
      cta_label: "Acheter",
      cta_href: "/boutique",
      secondary_cta_label: "En savoir plus",
      secondary_cta_href: "/maison",
    });
    return (
      bs.length === 2 &&
      bs[0].label === "Acheter" &&
      bs[0].variant === "on-photo" &&
      bs[1].label === "En savoir plus" &&
      bs[1].variant === "link"
    );
  })(),
);
check(
  "legacy cta with a blank/unsafe href is dropped",
  effectiveBannerButtons({
    buttons: null,
    cta_label: "Nope",
    cta_href: "javascript:x",
    secondary_cta_label: "Blank",
    secondary_cta_href: "",
  }).length === 0,
);
check(
  "an explicit empty buttons '[]' is AUTHORITATIVE — no CTAs, legacy IGNORED (operator cleared them)",
  effectiveBannerButtons({
    buttons: "[]",
    cta_label: "Legacy",
    cta_href: "/x",
    secondary_cta_label: "Also legacy",
    secondary_cta_href: "/y",
  }).length === 0,
);
check(
  "only a NULL buttons column falls back to the legacy cta_*",
  effectiveBannerButtons({
    buttons: null,
    cta_label: "Fallback",
    cta_href: "/x",
    secondary_cta_label: null,
    secondary_cta_href: null,
  }).length === 1,
);

console.log("coerceGridPosition / coerceStripTone:");
check(
  "grid position: valid kept, anything else → after_rows",
  coerceGridPosition("top") === "top" &&
    coerceGridPosition("after_load_more") === "after_load_more" &&
    coerceGridPosition("after_rows") === "after_rows" &&
    coerceGridPosition("bogus") === "after_rows" &&
    coerceGridPosition(null) === "after_rows" &&
    coerceGridPosition(undefined) === "after_rows",
);
check(
  "strip tone: valid kept, anything else → olive",
  coerceStripTone("olive") === "olive" &&
    coerceStripTone("dark") === "dark" &&
    coerceStripTone("gold") === "gold" &&
    coerceStripTone("burgundy") === "burgundy" &&
    coerceStripTone("bogus") === "olive" &&
    coerceStripTone(null) === "olive",
);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
