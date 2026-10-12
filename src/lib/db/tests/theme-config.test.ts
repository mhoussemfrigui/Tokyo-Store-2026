import "server-only";

/**
 * Theme config — the injection-safety + validation invariant for the DB-driven
 * theme tokens. `getThemeConfig()` feeds `buildThemeCss()`, whose output is
 * injected RAW into a storefront <style> (src/app/(shop)/layout.tsx). The ONLY
 * thing standing between an admin-set settings string and a CSS/HTML injection
 * is the validation in getThemeConfig (strict hex / clamped radius / allowlisted
 * font). This locks that down: a malicious color must be OMITTED (so the
 * globals.css scope default stands), radius must clamp, an unknown font must be
 * ignored, and the emitted CSS must contain no angle brackets. buildThemeCss now
 * injects ONLY the tokens the operator SET, scoped to BOTH `.tokyo` +
 * `.storefront`, so an unconfigured store emits nothing (byte-identical to
 * today). Radius 0 (square corners) is a real value that must survive, while a
 * BLANK / missing radius is NOT emitted (the 20px default stands). Self-cleaning.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/theme-config.test.ts
 */
import { db } from "@/lib/db/client";
import { settingService } from "@/modules/cms/setting/service";
import {
  getThemeConfig,
  buildThemeCss,
  THEME_DEFAULTS,
  THEME_FONT_STACKS,
  radiusPx,
} from "@/lib/theme/config";
import {
  getAdminThemeConfig,
  buildAdminThemeCss,
  ADMIN_THEME_DEFAULTS,
} from "@/lib/theme/admin-config";
import { getEmailBrand, BRAND_PRIMARY } from "@/modules/mailing/brand";

void db; // keep the client import warm for the cleanup path below

const KEYS = [
  "theme.primary_color",
  "theme.accent_color",
  "theme.border_radius_base",
  "theme.font_family",
  // Admin-panel theme (separate injected surface, same injection-safety contract).
  "admin.theme.accent_color",
  "admin.theme.font",
];

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

async function cleanup() {
  // deleteByKeys deletes exactly the keys it is handed (no namespace guard); the
  // test owns these theme.* keys.
  await settingService.deleteByKeys(KEYS);
}

async function main() {
  await cleanup();

  // Seed one batch: a MALICIOUS primary (CSS/HTML-injection attempt), a valid
  // accent, an out-of-range radius, and a valid allowlisted font. Read once.
  await settingService.upsert({
    key: "theme.primary_color",
    value: "#0131B4;}</style><script>alert(1)</script>",
    label: "test",
    group_key: "theme",
    type: "text",
  });
  await settingService.upsert({ key: "theme.accent_color", value: "#00FF00", label: "test", group_key: "theme", type: "text" });
  await settingService.upsert({ key: "theme.border_radius_base", value: "9999", label: "test", group_key: "theme", type: "number" });
  await settingService.upsert({ key: "theme.font_family", value: "system", label: "test", group_key: "theme", type: "text" });

  const cfg = await getThemeConfig();
  check("malicious primary color rejected → default", cfg.primaryColor === THEME_DEFAULTS.primaryColor);
  check("valid accent color accepted", cfg.accentColor === "#00FF00");
  check("out-of-range radius clamped to 28", cfg.radiusBasePx === 28);
  check("allowlisted font resolved into the overrides", cfg.cssOverrides["--font-body"] === THEME_FONT_STACKS.system && cfg.cssOverrides["--font-sans"] === THEME_FONT_STACKS.system);

  const css = buildThemeCss(cfg);
  check("injected CSS contains NO angle brackets (injection-safe)", !css.includes("<") && !css.includes(">"));
  check("rejected primary is OMITTED (globals default stands, not materialised)", !css.includes("--primary:"));
  check("injected CSS carries the valid accent", css.includes("--gold:#00FF00"));
  check("injected CSS carries the clamped radius", css.includes("--radius:28px"));
  check("injected CSS scopes to BOTH .tokyo and .storefront", css.includes(".tokyo{") && css.includes(".storefront{"));

  // ── dark-mode: BRAND/ACCENT tokens must also win over the higher-specificity
  //    globals `html.dark .tokyo` palette; TEXT/surface tokens must NOT (the
  //    operator's light-mode ink must not land on the dark background). ──────────
  await settingService.upsert({ key: "theme.primary_color", value: "#0055FF", label: "test", group_key: "theme", type: "text" });
  await settingService.upsert({ key: "theme.foreground_color", value: "#123456", label: "test", group_key: "theme", type: "text" });
  const cfg2 = await getThemeConfig();
  const css2 = buildThemeCss(cfg2);
  check("accent (--gold) is a dark-safe override", cfg2.cssOverridesDark["--gold"] === "#00FF00");
  check("primary is a dark-safe override", cfg2.cssOverridesDark["--primary"] === "#0055ff" || cfg2.cssOverridesDark["--primary"] === "#0055FF");
  check("foreground is NOT a dark-safe override (stays on the dark palette)", cfg2.cssOverridesDark["--foreground"] === undefined);
  check("dark rule re-emits brand under html.dark .tokyo", css2.includes("html.dark .tokyo{") && /html\.dark \.tokyo\{[^}]*--primary:/.test(css2));
  check("dark rule does NOT re-emit --foreground", !/html\.dark \.tokyo\{[^}]*--foreground:/.test(css2));
  await settingService.deleteByKeys(["theme.primary_color", "theme.foreground_color"]);

  // Email brand colors sync with the theme (same validation): the valid accent
  // flows through, the malicious primary falls back to the brand constant.
  const brand = await getEmailBrand();
  check("email brand accent follows valid theme accent", brand.accentColor === "#00FF00");
  check("email brand primary rejects malicious value → fallback", brand.primaryColor === BRAND_PRIMARY);

  // ── Admin-panel theme: same injection-safety + token-mapping contract, on the
  //    separate `.admin{}` surface (buildAdminThemeCss output is injected RAW too).
  await settingService.upsert({
    key: "admin.theme.accent_color",
    value: "#5E6135;}</style><script>alert(1)</script>",
    label: "test",
    group_key: "theme",
    type: "text",
  });
  await settingService.upsert({ key: "admin.theme.font", value: "bogus-font", label: "test", group_key: "theme", type: "text" });
  const admin = await getAdminThemeConfig();
  check("admin: malicious accent rejected → default", admin.accentColor === ADMIN_THEME_DEFAULTS.accentColor);
  check("admin: unknown font ignored (no override)", admin.fontFamily === null);
  const adminCss = buildAdminThemeCss(admin);
  check("admin CSS contains NO angle brackets (injection-safe)", !adminCss.includes("<") && !adminCss.includes(">"));
  check(
    "admin CSS carries the mapped tokens",
    adminCss.includes("--admin-accent-strong:") &&
      adminCss.includes("--secondary:") &&
      adminCss.includes("--admin-side-bg:") &&
      adminCss.includes("--admin-accent-soft:color-mix"),
  );
  check(
    "admin CSS drives --primary/--olive from the accent",
    adminCss.includes(`--primary:${ADMIN_THEME_DEFAULTS.accentColor}`) &&
      adminCss.includes(`--olive:${ADMIN_THEME_DEFAULTS.accentColor}`),
  );
  // Regression lock: the bare --admin-accent alias was removed (nothing read it);
  // the -soft/-strong tints must still be present (checked above).
  check("admin CSS does not emit the dead bare --admin-accent token", !/--admin-accent:/.test(adminCss));

  // ── radius: 0 is kept, blank / invalid → the 20px default (NOT emitted) ─────
  const def = THEME_DEFAULTS.radiusBasePx;
  check("THEME_DEFAULTS radius is 20 (= .tokyo 1.25rem)", def === 20);
  check("radiusPx keeps 0 (square corners)", radiusPx("0", def) === 0);
  check("radiusPx blank → default", radiusPx("", def) === def && radiusPx("  ", def) === def);
  check("radiusPx missing → default", radiusPx(null, def) === def && radiusPx(undefined, def) === def);
  check("radiusPx non-numeric → default", radiusPx("abc", def) === def);
  check("radiusPx clamps + rounds", radiusPx("-5", def) === 0 && radiusPx(" 7.6 ", def) === 8);
  await settingService.upsert({ key: "theme.border_radius_base", value: "0", label: "test", group_key: "theme", type: "number" });
  const square = await getThemeConfig();
  check("stored radius 0 is honoured", square.radiusBasePx === 0);
  check("…and emitted as --radius:0px (0 is a real set value)", buildThemeCss(square).includes("--radius:0px"));
  await settingService.upsert({ key: "theme.border_radius_base", value: "", label: "test", group_key: "theme", type: "number" });
  const blankCfg = await getThemeConfig();
  check("blank stored radius → 20px default", blankCfg.radiusBasePx === def);
  check("…and NOT emitted (globals .tokyo 1.25rem stands)", !buildThemeCss(blankCfg).includes("--radius"));
  await settingService.deleteByKeys(["theme.border_radius_base"]);
  const unset = await getThemeConfig();
  check("unset radius → 20px default (matches globals.css)", unset.radiusBasePx === def);
  check("…and NOT emitted (byte-identical)", !buildThemeCss(unset).includes("--radius"));

  // ── Option-A: a fully-unset theme emits NOTHING (no <style> injected) ───────
  await cleanup();
  const bare = await getThemeConfig();
  check("unconfigured theme → buildThemeCss is empty (globals untouched)", buildThemeCss(bare) === "");

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
