/**
 * Legacy home SYNTHESIS — the fallback every FRESH (un-migrated) shop renders through:
 * with no `home.blocks` row, getHomeBlocks() reproduces today's 7-section home from the
 * dormant `home.*` settings via synthesizeLegacyHomeBlocks(). This is the one home path
 * with no other coverage; it must keep producing a sane, correctly-ordered layout and map
 * the legacy two-tone titles onto the composer's italic `accent` field.
 *
 * Reads live settings (no writes). Run:
 *   tsx --conditions=react-server --env-file-if-exists=.env.local src/lib/db/tests/home-blocks-synthesis.test.ts
 */
import { getHomePageConfig } from "@/lib/pages/home-page-config";
import { synthesizeLegacyHomeBlocks } from "@/lib/pages/home-blocks-data";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

async function main() {
  const config = await getHomePageConfig();
  const blocks = synthesizeLegacyHomeBlocks(config);

  check("synthesises exactly 7 sections", blocks.length === 7);
  check(
    "section order matches today's home",
    blocks.map((b) => b.type).join(",") ===
      ["hero", "product_rail", "fifty_fifty", "cta_band", "feature_cards", "product_rail", "editorial"].join(","),
  );
  check("every block carries a unique id", new Set(blocks.map((b) => b.id)).size === 7);

  const [hero, newRail, , appointment, complications, bestRail, heritage] = blocks;
  check("new-arrivals rail source = 'new'", newRail.config.source?.mode === "new");
  check("best-sellers rail source = 'best_sellers'", bestRail.config.source?.mode === "best_sellers");
  check("heritage editorial image on the right", heritage.config.imageSide === "right");

  // Each block's visibility mirrors its legacy config section.
  check("hero visibility mirrors config.hero", hero.visible === config.hero.visible);
  check("appointment visibility mirrors config.appointment", appointment.visible === config.appointment.visible);
  check("complications visibility mirrors config.complications", complications.visible === config.complications.visible);

  // The legacy two-tone title maps onto the composer's accent field (not concatenated).
  if (config.appointment.titleAccent) {
    check("appointment title_accent → accent field (not merged into title)", appointment.config.accent === config.appointment.titleAccent && !appointment.config.header?.title.includes(config.appointment.titleAccent));
  } else {
    check("appointment accent omitted when no title_accent", appointment.config.accent === undefined);
  }
  if (config.complications.titleAccent) {
    check("complications title_accent → accent field", complications.config.accent === config.complications.titleAccent);
  } else {
    check("complications accent omitted when no title_accent", complications.config.accent === undefined);
  }
  // The heritage editorial block carries a 3-line legacy title; line 3 maps onto the accent
  // field (E1) so « Depuis 1950 » etc. are an explicit, editable Accent, not an invisible
  // last-line side-effect. Lines 1-2 stay in the ink title.
  if (config.heritage.titleLine3) {
    check("heritage title_line3 → accent field", heritage.config.accent === config.heritage.titleLine3 && !(heritage.config.header?.title ?? "").includes(config.heritage.titleLine3));
  } else {
    check("heritage accent omitted when no title_line3", heritage.config.accent === undefined);
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
