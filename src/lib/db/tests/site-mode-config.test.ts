/**
 * PURE unit test for the site-availability resolver. No DB, no server-only — runs
 * in the `test:pure` chain.
 *
 *   npx tsx --conditions=react-server src/lib/db/tests/site-mode-config.test.ts
 *
 * The load-bearing invariant is FAIL-OPEN: anything unrecognised resolves to `live`,
 * so a settings typo or a DB read that threw (config.ts passes `{}`) can never blank
 * the storefront behind a maintenance wall.
 */
import {
  parseSiteMode,
  isSiteGated,
  normalizeLaunchAt,
  resolveSiteModeConfig,
  SITE_MODE_DEFAULT_COPY,
} from "@/lib/site-mode/parse";
import { isSiteGateExemptPath, SITE_GATE_EXEMPT_PATHS } from "@/lib/site-mode/gate-exempt";

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
  console.log("parseSiteMode — valid + fail-open:");
  check("live → live", parseSiteMode("live") === "live");
  check("maintenance → maintenance", parseSiteMode("maintenance") === "maintenance");
  check("coming_soon → coming_soon", parseSiteMode("coming_soon") === "coming_soon");
  check("case/space insensitive", parseSiteMode("  Maintenance ") === "maintenance");
  check("unknown → live", parseSiteMode("closed") === "live");
  check("empty → live", parseSiteMode("") === "live");
  check("null → live", parseSiteMode(null) === "live");
  check("undefined → live", parseSiteMode(undefined) === "live");

  console.log("isSiteGated:");
  check("live is NOT gated", isSiteGated("live") === false);
  check("maintenance is gated", isSiteGated("maintenance") === true);
  check("coming_soon is gated", isSiteGated("coming_soon") === true);

  console.log("resolveSiteModeConfig — FAIL OPEN:");
  check("empty map → live (DB error path)", resolveSiteModeConfig({}).mode === "live");
  check("garbage mode → live", resolveSiteModeConfig({ "site.mode": "banana" }).mode === "live");
  check(
    "live never gated even with title/date set",
    isSiteGated(resolveSiteModeConfig({ "site.mode": "live", "site.launch_at": "2999-01-01" }).mode) === false,
  );

  console.log("default copy per mode when blank:");
  const maint = resolveSiteModeConfig({ "site.mode": "maintenance" });
  check("maintenance default title", maint.title === SITE_MODE_DEFAULT_COPY.maintenance.title);
  check("maintenance default message", maint.message === SITE_MODE_DEFAULT_COPY.maintenance.message);
  const soon = resolveSiteModeConfig({ "site.mode": "coming_soon" });
  check("coming_soon default title", soon.title === SITE_MODE_DEFAULT_COPY.coming_soon.title);
  check(
    "coming_soon default differs from maintenance",
    SITE_MODE_DEFAULT_COPY.coming_soon.title !== SITE_MODE_DEFAULT_COPY.maintenance.title,
  );

  console.log("custom copy overrides defaults + trims/blank-falls-through:");
  const custom = resolveSiteModeConfig({
    "site.mode": "maintenance",
    "site.maintenance_title": "  De retour à 14h  ",
    "site.maintenance_message": "",
  });
  check("custom title trimmed", custom.title === "De retour à 14h");
  check("blank message → default", custom.message === SITE_MODE_DEFAULT_COPY.maintenance.message);

  console.log("normalizeLaunchAt:");
  check("empty → null", normalizeLaunchAt("") === null);
  check("null → null", normalizeLaunchAt(null) === null);
  check("garbage → null", normalizeLaunchAt("not-a-date") === null);
  check(
    "ISO passes through as ISO",
    normalizeLaunchAt("2026-12-01T09:00:00.000Z") === "2026-12-01T09:00:00.000Z",
  );
  check(
    "datetime-local → ISO",
    typeof normalizeLaunchAt("2026-12-01T09:00") === "string" &&
      normalizeLaunchAt("2026-12-01T09:00")!.includes("2026-12-01"),
  );

  console.log("showCountdown gating (independent toggle, EITHER mode):");
  check(
    "coming_soon + date + toggle default → true",
    resolveSiteModeConfig({ "site.mode": "coming_soon", "site.launch_at": "2026-12-01T09:00" }).showCountdown === true,
  );
  check(
    "coming_soon + date + toggle off → false",
    resolveSiteModeConfig({
      "site.mode": "coming_soon",
      "site.launch_at": "2026-12-01T09:00",
      "site.show_countdown": "off",
    }).showCountdown === false,
  );
  check(
    "coming_soon WITHOUT date → false (nothing to count down to)",
    resolveSiteModeConfig({ "site.mode": "coming_soon" }).showCountdown === false,
  );
  check(
    "maintenance + date + toggle default → true (countdown works in both modes)",
    resolveSiteModeConfig({ "site.mode": "maintenance", "site.launch_at": "2026-12-01T09:00" }).showCountdown === true,
  );
  check(
    "maintenance + date + toggle off → false (deactivatable)",
    resolveSiteModeConfig({
      "site.mode": "maintenance",
      "site.launch_at": "2026-12-01T09:00",
      "site.show_countdown": "off",
    }).showCountdown === false,
  );
  check(
    "maintenance WITHOUT date → false",
    resolveSiteModeConfig({ "site.mode": "maintenance" }).showCountdown === false,
  );

  // The gate must NOT lock out the session-less auth continuation pages (TOTP
  // step after /admin-login, invite / reset links) nor the unsubscribe link —
  // while everything else (incl. /register) stays gated.
  console.log("isSiteGateExemptPath — auth + unsubscribe pages pass the gate:");
  for (const p of [
    "/login",
    "/login/2fa",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
    "/se-desabonner",
  ]) {
    check(`${p} is exempt`, isSiteGateExemptPath(p));
  }
  check("trailing slash tolerated (/login/2fa/)", isSiteGateExemptPath("/login/2fa/"));
  check("every allow-listed base is exempt", SITE_GATE_EXEMPT_PATHS.every((p) => isSiteGateExemptPath(p)));

  console.log("isSiteGateExemptPath — everything else stays gated:");
  for (const p of ["/", "/register", "/account", "/panier", "/checkout", "/pro/login", "/catalogue"]) {
    check(`${p} is NOT exempt`, !isSiteGateExemptPath(p));
  }
  check("near-miss /reset-passwordX is NOT exempt", !isSiteGateExemptPath("/reset-passwordX"));
  check("near-miss /login-x is NOT exempt", !isSiteGateExemptPath("/login-x"));
  check("prefix-only /log is NOT exempt", !isSiteGateExemptPath("/log"));
  check("case-sensitive /LOGIN is NOT exempt", !isSiteGateExemptPath("/LOGIN"));
  check("missing header (null) → gated", !isSiteGateExemptPath(null));
  check("empty header → gated", !isSiteGateExemptPath(""));

  console.log(`\nsite-mode-config.test.ts — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
