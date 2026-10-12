/**
 * Catalogues (showcase) field LOCKSTEP — the guard against the NULL-overwrite trap.
 *
 * saveShowcaseSettingsAction persists a FIXED list of keys (COMMON_FIELDS + per-slug
 * EXTRA_FIELDS). A key in that list with NO matching input in the panel is overwritten
 * with NULL on every save (the old `design_variant` bug); a panel input NOT in the list
 * is silently never saved; and a saved key the config never reads is dead. This pure
 * source-scan pins all three invariants so the three files can't drift apart.
 *
 * Pure (no DB). Run:
 *   tsx --conditions=react-server src/lib/db/tests/showcase-lockstep.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const root = process.cwd();
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

const actionSrc = read("src", "lib", "actions", "showcase-settings.ts");
const panelSrc = read("src", "app", "admin", "cms", "showcase", "showcase-settings-panel.tsx");
const configSrc = read("src", "lib", "pages", "collection-page-config.ts");

// 1. Keys the action WRITES: every { key: "x", ... } in COMMON_FIELDS + EXTRA_FIELDS, plus pins.
const actionKeys = new Set(
  [...actionSrc.matchAll(/\{\s*key:\s*"([a-z_]+)"\s*,\s*type:/g)].map((m) => m[1]),
);
actionKeys.add("pins"); // handled separately in the action (showcase.setPins), not a setting.

// 2. Keys the panel renders: every f("x") in the panel (f = pages.<slug>.<x>).
const panelKeys = new Set([...panelSrc.matchAll(/\bf\("([a-z_]+)"\)/g)].map((m) => m[1]));

// 3. Keys the config READS: every k("x") in getCollectionPageConfig.
const configKeys = new Set([...configSrc.matchAll(/\bk\("([a-z_]+)"\)/g)].map((m) => m[1]));

console.log("showcase field lockstep:");
check("action writes at least the core fields", actionKeys.has("visible") && actionKeys.has("limit") && actionKeys.has("empty_title") && actionKeys.has("cta_band_title"));
check("panel renders at least the core fields", panelKeys.has("visible") && panelKeys.has("empty_title") && panelKeys.has("cta_band_title") && panelKeys.has("default_sort"));

// (a) Every WRITTEN key has a panel input — else it is NULL-overwritten on every save.
{
  const missing = [...actionKeys].filter((k) => k !== "pins" && !panelKeys.has(k));
  check(
    `every saved key has a panel input (no NULL-overwrite)${missing.length ? " — MISSING: " + missing.join(",") : ""}`,
    missing.length === 0,
  );
}

// (b) Every panel input is saved by the action — else the operator's edit is silently dropped.
{
  const orphan = [...panelKeys].filter((k) => !actionKeys.has(k));
  check(
    `every panel input is saved by the action${orphan.length ? " — ORPHAN: " + orphan.join(",") : ""}`,
    orphan.length === 0,
  );
}

// (c) Every saved key is READ by the config — else it is dead storage.
//     (hero_media_id/visible/noindex etc. are all read via k("..."); pins is separate.)
{
  const dead = [...actionKeys].filter((k) => k !== "pins" && !configKeys.has(k));
  check(
    `every saved key is read by getCollectionPageConfig${dead.length ? " — DEAD: " + dead.join(",") : ""}`,
    dead.length === 0,
  );
}

// (d2) The CTA-band fields must stay UNCONDITIONALLY mounted (only visually hidden) so their
//      keys always post — a `{showCta && (` conditional mount would drop them from the form
//      when the band is off and NULL-overwrite them on save (the trap this test guards).
check(
  "cta_band fields are not conditionally mounted (no `{showCta && (` wrapper)",
  !/\{\s*showCta\s*&&\s*\(/.test(panelSrc),
);

// (d) The dropped grid_* keys are gone from all three files (obsolete section header).
{
  const anyGrid =
    /grid_eyebrow|grid_title|grid_subtitle/.test(actionSrc) ||
    /grid_eyebrow|grid_title|grid_subtitle/.test(panelSrc) ||
    /k\("grid_/.test(configSrc);
  check("obsolete grid_* keys are fully removed", !anyGrid);
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
