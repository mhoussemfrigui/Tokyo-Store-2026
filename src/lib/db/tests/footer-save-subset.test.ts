/**
 * Footer save data-safety invariants (pure, no DB). The Footer tab writes the
 * SAME site./social. keys as « Réglages site » PLUS its storefront.footer.*
 * appearance keys; this pins the properties that keep that save from losing data:
 *
 *   - CONTENT keys are a STRICT SUBSET of SITE_TEXT_FIELDS → the footer save can
 *     never blank a non-footer identity key (business.*, site.whatsapp).
 *   - shared keys carry the SAME label + group in both tabs → no `setting.upserted`
 *     audit ping-pong when the two tabs alternate.
 *   - every APPEARANCE key lives under storefront.footer. → can't reach a site.* key.
 *   - every action key has a matching form input and vice-versa → a renamed/removed
 *     input can't silently blank a shared key (null → "" on save).
 *   - footerToggleValue maps an unchecked checkbox (null) to "false" (toggle sticks).
 *
 * Run: pnpm exec tsx src/lib/db/tests/footer-save-subset.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SITE_TEXT_FIELDS } from "@/lib/cms/site-fields";
import {
  FOOTER_CONTENT_FIELDS,
  FOOTER_ENUM_FIELDS,
  FOOTER_BOOL_FIELDS,
  footerToggleValue,
} from "@/lib/cms/footer-fields";
import { FOOTER_SETTING_KEYS } from "@/lib/cms/footer-appearance";
import { CONTACT_LISTS } from "@/lib/cms/contact-list";

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

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function subsetCases() {
  console.log("content keys are a safe subset of the site settings:");
  const siteByKey = new Map(SITE_TEXT_FIELDS.map((f) => [f.key, f]));
  const contentKeys = FOOTER_CONTENT_FIELDS.map((f) => f.key);

  check("every footer content key exists in SITE_TEXT_FIELDS", contentKeys.every((k) => siteByKey.has(k)));
  check(
    "footer NEVER writes business.* / site.whatsapp (would blank them)",
    !contentKeys.some((k) => k.startsWith("business.") || k === "site.whatsapp"),
  );
  check(
    "shared keys carry the SAME label + group in both tabs (no audit ping-pong)",
    FOOTER_CONTENT_FIELDS.every((f) => {
      const site = siteByKey.get(f.key);
      return !!site && site.label === f.label && site.group === f.group;
    }),
  );
  check(
    "appearance enum + bool keys all live under storefront.footer. (never a site.* key)",
    [...FOOTER_ENUM_FIELDS, ...FOOTER_BOOL_FIELDS].every((f) => f.key.startsWith("storefront.footer.")),
  );
  check("no content key is also an appearance key", !contentKeys.some((k) => k.startsWith("storefront.footer.")));
}

function formMappingCases() {
  console.log("every action key has a matching form input (and vice-versa):");
  const form = src("src/app/admin/cms/footer/footer-content-form.tsx");

  // name="site.x" / name="social.x" literals (content fields + logo MediaPicker).
  const literals = [...form.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).filter((n) => n.includes("."));
  // name={FOOTER_SETTING_KEYS.x} references (the appearance selects + toggles).
  const refs = [...form.matchAll(/name=\{FOOTER_SETTING_KEYS\.(\w+)\}/g)].map((m) => {
    const key = (FOOTER_SETTING_KEYS as Record<string, string>)[m[1]];
    if (!key) throw new Error(`form references unknown FOOTER_SETTING_KEYS.${m[1]}`);
    return key;
  });
  const inputs = new Set([...literals, ...refs]);
  const fieldKeys = new Set(
    [...FOOTER_CONTENT_FIELDS, ...FOOTER_ENUM_FIELDS, ...FOOTER_BOOL_FIELDS].map((f) => f.key),
  );

  const orphanKeys = [...fieldKeys].filter((k) => !inputs.has(k)); // no input → blanks on save
  const orphanInputs = [...inputs].filter((k) => !fieldKeys.has(k)); // not saved → silently dropped
  check(`every saved key has an input (orphans: ${orphanKeys.join(", ") || "none"})`, orphanKeys.length === 0);
  check(`every input maps to a saved key (orphans: ${orphanInputs.join(", ") || "none"})`, orphanInputs.length === 0);
}

function toggleCases() {
  console.log("footerToggleValue (unchecked checkbox → stored OFF):");
  check('"true" → "true"', footerToggleValue("true") === "true");
  check("null (unchecked) → \"false\"", footerToggleValue(null) === "false");
  check('"on" / "1" / "" / "false" → "false" (only literal "true" is ON)',
    footerToggleValue("on") === "false" &&
      footerToggleValue("1") === "false" &&
      footerToggleValue("") === "false" &&
      footerToggleValue("false") === "false");
}

function contactListCases() {
  // buildContactListSettings ALWAYS writes each list's array key + its legacy
  // primary (= first entry). So a form that stopped rendering a ContactListField
  // would, on save, read [] and BLANK that list AND its primary (which invoice /
  // SEO / llms / email brand read). Pin that both forms still render all three.
  console.log("both forms render all three contact-list editors (else a save blanks the list + its primary):");
  const footer = src("src/app/admin/cms/footer/footer-content-form.tsx");
  const settings = src("src/app/admin/cms/settings/settings-panel.tsx");
  for (const { base } of CONTACT_LISTS) {
    check(`footer-content-form renders base="${base}"`, footer.includes(`base="${base}"`));
    check(`settings-panel renders base="${base}"`, settings.includes(`base="${base}"`));
  }
}

function main() {
  subsetCases();
  formMappingCases();
  toggleCases();
  contactListCases();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
