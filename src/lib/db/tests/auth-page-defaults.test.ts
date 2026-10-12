import "server-only";

/**
 * Auth-page copy defaults are a SINGLE SOURCE OF TRUTH. Pins that the offline
 * fallback (and, by construction, the admin-panel pre-fill + getAuthPagesConfig,
 * which all import AUTH_PAGE_DEFAULTS) never drift — the drift that let a no-op
 * save silently rewrite the live login/register copy. Pure. Run:
 *   tsx --conditions=react-server src/lib/db/tests/auth-page-defaults.test.ts
 */
import { AUTH_PAGE_DEFAULTS, AUTH_PERKS_AS_TEXT } from "@/lib/auth/pages-defaults";
import { AUTH_PAGES_FALLBACK } from "@/components/auth/pages-fallback";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const D = AUTH_PAGE_DEFAULTS;
const F = AUTH_PAGES_FALLBACK;

// The offline fallback must equal the shared defaults, field by field.
check("fallback login title", F.login.title === D.login.title);
check("fallback login subtitle", F.login.subtitle === D.login.subtitle);
check("fallback login panelTitle", F.login.panelTitle === D.login.panelTitle);
check("fallback login panelSubtitle", F.login.panelSubtitle === D.login.panelSubtitle);
check("fallback login perks", eq(F.login.perks, D.login.perks));
check("fallback register title", F.register.title === D.register.title);
check("fallback register panelBadge", F.register.panelBadge === D.register.panelBadge);
check("fallback register panelTitle", F.register.panelTitle === D.register.panelTitle);
check("fallback register perks", eq(F.register.perks, D.register.perks));
check("fallback register footnote", F.register.footnote === D.register.footnote);
check("fallback forgot", eq(F.forgotPassword, D.forgotPassword));
check("fallback reset", eq(F.resetPassword, D.resetPassword));
check("fallback verify", eq(F.verifyEmail, D.verifyEmail));
check("fallback social defaults OFF", F.social.google === false && F.social.facebook === false);

// The panel pre-fills perks as newline text; it must round-trip to the array.
check("login perks-as-text round-trips", eq(AUTH_PERKS_AS_TEXT.login.split("\n"), D.login.perks));
check("register perks-as-text round-trips", eq(AUTH_PERKS_AS_TEXT.register.split("\n"), D.register.perks));

console.log(`\n=== auth-page-defaults: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
