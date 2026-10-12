/**
 * Admin settings fail-closed + settings round-trip hygiene (A–Z gap-hunt
 * 2026-09-23 — gap-settings-form-roundtrip-01/05/07/08/10). PURE (no DB):
 *   - `pickSettings` narrows a settings map to a panel's prefixes (no whole
 *     site_settings table — ciphertext, SMTP identity, promo codes — shipped to
 *     a "use client" panel);
 *   - a blank numeric field persists as "unset" — the loyalty level perks use
 *     `nullableInt` (blank → null = perk disabled), session-policy uses parseFormNumber;
 *   - `checkConsentRevision` refuses a LOWER consent revision (blank keeps the
 *     stored one) so a later bump always re-prompts;
 *   - source invariants: every admin page that feeds a settings SAVE form reads
 *     settings strictly (no `getSettingsMap().catch(...)` → admin error
 *     boundary), display-only pages flag a failed read with a banner, the inner
 *     fail-soft readers have strict admin variants, and the marketing /
 *     public-favourites kill-switches fail CLOSED on a settings read error.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/settings-fail-closed.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pickSettings } from "@/lib/settings/pick-settings";
import { parseFormNumber } from "@/lib/settings/form-number";
import { checkConsentRevision } from "@/lib/consent/revision";
import { SITE_TEXT_FIELDS } from "@/lib/cms/site-fields";

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

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function pickSettingsCases() {
  console.log("pickSettings:");
  const map: Record<string, string | null> = {
    "home.hero.visible": "false",
    "homepage.legacy": "x",
    "storefront.listing_display_mode": "pages",
    "mail.smtp_password_enc": "ciphertext",
    "mail.birthday_code": "BDAY",
    "site.name": null,
  };
  const home = pickSettings(map, ["home.", "storefront."]);
  check("keeps the panel's prefixes", home["home.hero.visible"] === "false" && home["storefront.listing_display_mode"] === "pages");
  check("drops other panels' keys (ciphertext, promo codes)", !("mail.smtp_password_enc" in home) && !("mail.birthday_code" in home));
  check("prefix match is dot-bounded (home. ≠ homepage.)", !("homepage.legacy" in home));
  check("exact key count", Object.keys(home).length === 2);
  const site = pickSettings(map, ["site."]);
  check("null values are preserved (not dropped)", "site.name" in site && site["site.name"] === null);
  check("no prefixes → empty map", Object.keys(pickSettings(map, [])).length === 0);
  check("input map is not mutated", Object.keys(map).length === 6);
}

function parseFormNumberCases() {
  console.log("parseFormNumber (blank = default):");
  check("'' → null", parseFormNumber("") === null);
  check("whitespace → null", parseFormNumber("   ") === null);
  check("null → null", parseFormNumber(null) === null);
  check("undefined → null", parseFormNumber(undefined) === null);
  check("non-numeric → null", parseFormNumber("abc") === null);
  check("'Infinity' → null", parseFormNumber("Infinity") === null);
  check("explicit '0' stays 0", parseFormNumber("0") === 0);
  check("' 5 ' → 5", parseFormNumber(" 5 ") === 5);
  check("'2.5' → 2.5", parseFormNumber("2.5") === 2.5);
  check("negative is returned as-is (callers range-check)", parseFormNumber("-3") === -3);
}

function consentRevisionCases() {
  console.log("checkConsentRevision (monotonic):");
  const lower = checkConsentRevision("1", "3");
  check("lower than stored → refused with the current value", !lower.ok && lower.current === 3);
  const same = checkConsentRevision("3", "3");
  check("equal → accepted", same.ok && same.revision === 3);
  const bump = checkConsentRevision("4", "3");
  check("bump → accepted", bump.ok && bump.revision === 4);
  const blank = checkConsentRevision("", "3");
  check("blank keeps the stored revision (never resets to 1)", blank.ok && blank.revision === 3);
  const junk = checkConsentRevision("abc", "5");
  check("garbage keeps the stored revision", junk.ok && junk.revision === 5);
  const zero = checkConsentRevision("0", "2");
  check("'0' keeps the stored revision", zero.ok && zero.revision === 2);
  const fresh = checkConsentRevision("", null);
  check("nothing stored + blank → 1", fresh.ok && fresh.revision === 1);
  const firstSet = checkConsentRevision("2", null);
  check("nothing stored + 2 → 2", firstSet.ok && firstSet.revision === 2);
  const badStored = checkConsentRevision("1", "garbage");
  check("unparsable stored value reads as 1", badStored.ok && badStored.revision === 1);
  const file = checkConsentRevision(null, "4");
  check("missing field keeps the stored revision", file.ok && file.revision === 4);
}

/** Admin pages whose settings read pre-fills a SAVE form → must read strictly. */
const FORM_PAGES = [
  // (catalog/products/page.tsx is NOT here: the « Réglages catalogue » settings
  // sub-tab — the only settings-backed SAVE form on the Produits page — was
  // removed, so the page now reads products/categories/attributes/stats, no
  // `getSettingsMap` pre-fill.)
  "src/app/admin/catalog/stock/page.tsx",
  "src/app/admin/cms/home/page.tsx",
  // (nav-menu/page.tsx is NOT here: the composable Nav Menu builder is backed by
  // nav_items + link-targets + products, not by a `getSettingsMap` pre-fill.)
  "src/app/admin/cms/footer/page.tsx",
  "src/app/admin/cms/settings/page.tsx",
  "src/app/admin/cms/theme/page.tsx",
  "src/app/admin/cms/trust-badges/page.tsx",
  "src/app/admin/cms/showcase/page.tsx",
  "src/app/admin/marketing/mailing/page.tsx",
  "src/app/admin/system/ai/page.tsx",
  "src/app/admin/system/analytics/page.tsx",
  "src/app/admin/system/audit/page.tsx",
  "src/app/admin/system/checkout/page.tsx",
  "src/app/admin/system/cookies/page.tsx",
  "src/app/admin/system/express/page.tsx",
  "src/app/admin/system/payments/page.tsx",
  "src/app/admin/system/performance/page.tsx",
  "src/app/admin/system/redirects/page.tsx",
  "src/app/admin/system/search/page.tsx",
  "src/app/admin/system/seo/page.tsx",
  // Utilisateurs → Réglages (session policy + login/social config) replaced the
  // standalone /admin/system/auth; the Rôles page no longer reads settings.
  "src/app/admin/users/settings/page.tsx",
];

/** A settings read that swallows its failure into an empty map. */
const FAIL_SOFT_SETTINGS = /getSettingsMap\(\)\s*\.catch\(\s*\(\)\s*=>\s*\(\{\}\)/;

function sourceInvariants() {
  console.log("admin form pages read settings strictly:");
  for (const rel of FORM_PAGES) {
    const s = src(rel);
    check(`${rel}: reads getSettingsMap`, /getSettingsMap\(\)/.test(s));
    check(`${rel}: no fail-soft getSettingsMap().catch(() => ({}))`, !FAIL_SOFT_SETTINGS.test(s));
  }

  console.log("display-only pages flag a failed read:");
  for (const rel of ["src/app/admin/system/security/page.tsx", "src/app/admin/system/database/page.tsx"]) {
    const s = src(rel);
    check(`${rel}: failed read → null (not a silent {})`, /getSettingsMap\(\)\.catch\(\(\) => null\)/.test(s));
    check(`${rel}: renders the « Réglages indisponibles » banner`, s.includes("Réglages indisponibles — rechargez la page"));
  }

  console.log("inner readers have strict admin variants:");
  const apiSvc = src("src/modules/api-settings/service.ts");
  check("api-settings: getStrict() exists", /async getStrict\(\): Promise<ApiSettings>/.test(apiSvc));
  check("api-settings: runtime get() still fails CLOSED", /apiEnabled: readFailed \? false :/.test(apiSvc));
  const apiPage = src("src/app/admin/system/api/page.tsx");
  check("system/api page: toggles form uses getStrict()", /apiSettingsService\.getStrict\(\)/.test(apiPage));
  check("system/api page: no fail-soft apiSettingsService.get().catch", !/apiSettingsService\s*\.get\(\)\s*\.catch/.test(apiPage));
  const aiCfg = src("src/lib/ai/config.ts");
  check("ai/config: listAiProviderStatus accepts { strict }", /listAiProviderStatus\(\s*opts: \{ strict\?: boolean \}/.test(aiCfg));
  for (const rel of ["src/app/admin/system/ai/page.tsx", "src/app/admin/system/api/page.tsx"]) {
    const s = src(rel);
    check(`${rel}: listAiProviderStatus({ strict: true }) without .catch`, /listAiProviderStatus\(\{ strict: true \}\),/.test(s));
  }
  const payments = src("src/app/admin/system/payments/page.tsx");
  check("payments page: no .catch on paymentSettingsService.listAll", !/paymentSettingsService\.listAll\(\)\.catch/.test(payments));
  const showcase = src("src/app/admin/cms/showcase/page.tsx");
  check("showcase page: no .catch on listPinnedProductIds", !/listPinnedProductIds\([^)]*\)\.catch/.test(showcase));
  check(
    "showcase page: strict settings read before getCollectionPageConfig",
    /await getSettingsMap\(\);/.test(showcase) &&
      showcase.indexOf("await getSettingsMap();") < showcase.indexOf("getCollectionPageConfig(s)"),
  );

  console.log("client panels get only their prefixes (pickSettings):");
  const narrowed: Array<[string, RegExp]> = [
    ["src/app/admin/cms/home/page.tsx", /pickSettings\(settings, \["home\.", "storefront\."\]\)/],
    ["src/app/admin/cms/settings/page.tsx", /pickSettings\(s, \["site\.", "social\.", "business\."\]\)/],
    ["src/app/admin/cms/footer/page.tsx", /pickSettings\(settingsMap, \["site\.", "social\.", "storefront\.footer\."\]\)/],
    ["src/app/admin/cms/theme/page.tsx", /pickSettings\(s, \["theme\.", "admin\.theme\."\]\)/],
    ["src/app/admin/system/express/page.tsx", /settings=\{pickSettings\(settings, \["checkout\."\]\)\}/],
  ];
  for (const [rel, re] of narrowed) check(`${rel}: narrows the map`, re.test(src(rel)));

  console.log("blank numerics save the default:");
  // A blank numeric field must persist as the documented default, never silently
  // coerce to 0.
  check(
    "session-policy: clamp returns def for a blank field",
    /const v = parseFormNumber\(raw\);\s*if \(v === null\) return c\.def;/.test(src("src/lib/actions/session-policy.ts")),
  );

  console.log("consent revision is checked before any write:");
  const cookies = src("src/lib/actions/cookies.ts");
  const checkAt = cookies.indexOf("checkConsentRevision(");
  const firstWrite = cookies.indexOf("workflows.cms.upsertSetting(");
  check("cookies: checkConsentRevision is called", checkAt > 0);
  check("cookies: … before the first upsert", checkAt > 0 && firstWrite > 0 && checkAt < firstWrite);
  check("cookies: the stored revision is read", /settingService\.findByKey\("consent\.revision"\)/.test(cookies));

  console.log("kill-switches fail CLOSED on a settings read error:");
  const drain = src("src/lib/mailing/drain.ts");
  check("drain: no fail-soft settings read", !FAIL_SOFT_SETTINGS.test(drain));
  check(
    "drain: a failed read returns before claiming a batch",
    drain.indexOf("réglages indisponibles") > 0 &&
      drain.indexOf("réglages indisponibles") < drain.indexOf("claimDueBatch("),
  );
  const dispatch = src("src/modules/mailing/dispatch.ts");
  check("dispatch: no fail-soft settings read", !FAIL_SOFT_SETTINGS.test(dispatch));
  check("dispatch: marketing skipped with reason settings_unavailable", /reason: "settings_unavailable"/.test(dispatch));
  const mailingActions = src("src/lib/actions/mailing.ts");
  check("createAndSendCampaignAction: no fail-soft settings read", !FAIL_SOFT_SETTINGS.test(mailingActions));
  check("createAndSendCampaignAction: refuses on settings_unavailable", /error: "settings_unavailable"/.test(mailingActions));
  const wishlist = src("src/lib/wishlist/config.ts");
  check("favoritesPublicEnabled: no fail-soft settings read", !FAIL_SOFT_SETTINGS.test(wishlist));
  check("favoritesPublicEnabled: returns false on a read error", /catch \{\s*return false;\s*\}/.test(wishlist));
}

function settingsFormInputsCases() {
  // saveSiteSettingsAction writes EVERY SITE_TEXT_FIELDS key unconditionally
  // (String(formData.get(key) ?? "")), so a key with no rendered input would be
  // blanked on save. Pin that the Identité & contact panel renders each one.
  // (The multi-value contact lists are handled separately — see footer-save-subset.)
  console.log("Identité & contact panel renders an input for every saved single-value key:");
  const panel = src("src/app/admin/cms/settings/settings-panel.tsx");
  for (const f of SITE_TEXT_FIELDS) {
    check(`settings-panel renders name="${f.key}"`, panel.includes(`name="${f.key}"`));
  }
}

function main() {
  pickSettingsCases();
  parseFormNumberCases();
  consentRevisionCases();
  sourceInvariants();
  settingsFormInputsCases();

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
