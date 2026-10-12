import "server-only";

/**
 * Phone dial-code split/compose (src/lib/format/country-codes.ts) — PURE, no DB.
 * Locks the round-trip the PhoneNumberField relies on: a bare local number stays
 * Tunisian, an IDD/"+"/"216"-prefixed number resolves to its country, and
 * compose→split is stable.
 *
 * Run: pnpm exec tsx --conditions=react-server src/lib/db/tests/country-codes.test.ts
 */
import { splitPhone, composePhone, DEFAULT_DIAL, COUNTRY_DIAL_CODES } from "@/lib/format/country-codes";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
const eq = (a: { dial: string; national: string }, dial: string, national: string) =>
  a.dial === dial && a.national === national;

// compose
check("compose TN", composePhone("216", "20123456") === "+216 20123456");
check("compose strips non-digits from national", composePhone("216", "20 123 456") === "+216 20123456");
check("compose empty national → empty string", composePhone("216", "") === "");

// split — Tunisia default
check("split empty → TN/empty", eq(splitPhone(""), DEFAULT_DIAL, ""));
check("split null → TN/empty", eq(splitPhone(null), DEFAULT_DIAL, ""));
check("split bare 8-digit → TN", eq(splitPhone("20123456"), "216", "20123456"));
check("split '+216 20123456' → TN", eq(splitPhone("+216 20123456"), "216", "20123456"));
check("split '21620123456' → TN", eq(splitPhone("21620123456"), "216", "20123456"));
check("split IDD '0021620123456' → TN", eq(splitPhone("0021620123456"), "216", "20123456"));

// split — foreign
check("split '+33 612345678' → FR", eq(splitPhone("+33 612345678"), "33", "612345678"));
check("split IDD '0033612345678' → FR", eq(splitPhone("0033612345678"), "33", "612345678"));

// round-trip compose→split for every country (dial equality; shared codes like +1
// US/CA resolve to the same dial, which is all the phone number needs).
let roundOk = true;
for (const c of COUNTRY_DIAL_CODES) {
  const nat = "612345678"; // ≥ 6 digits so the prefix match keeps enough national
  const r = splitPhone(composePhone(c.dial, nat));
  if (!(r.dial === c.dial && r.national === nat)) { roundOk = false; console.error(`   round-trip failed for +${c.dial} (${c.name}) → ${JSON.stringify(r)}`); }
}
check(`compose→split round-trips for all ${COUNTRY_DIAL_CODES.length} countries`, roundOk);

// Comprehensive list, Israel excluded per requirement.
check("has a broad country list (> 150)", COUNTRY_DIAL_CODES.length > 150);
check("Israel (+972 / IL) is excluded", !COUNTRY_DIAL_CODES.some((c) => c.dial === "972" || c.iso === "IL"));
check("Tunisia is first (default)", COUNTRY_DIAL_CODES[0]?.dial === "216");

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
