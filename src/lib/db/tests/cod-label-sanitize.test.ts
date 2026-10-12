import "server-only";

/**
 * sanitizeCodLabel — the BUG1 autofill guard. The Paiement settings form has
 * password inputs, so a password manager can autofill the operator's saved
 * login email into the empty COD-label text field; persisted verbatim it became
 * the storefront's COD option title ("admin@tokyostore.tn"). This pure guard
 * drops an email-shaped value to null (→ the "Paiement à la livraison" default
 * downstream) while preserving legitimate labels. No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/cod-label-sanitize.test.ts
 */
import { sanitizeCodLabel } from "@/lib/checkout/quick-buy-config";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function main() {
  // Legitimate labels pass through (trimmed).
  check(
    "default label preserved",
    sanitizeCodLabel("Paiement à la livraison") === "Paiement à la livraison",
  );
  check("surrounding whitespace trimmed", sanitizeCodLabel("  Payer au facteur  ") === "Payer au facteur");
  check(
    "label containing '@' but not an email is kept (anchored regex)",
    sanitizeCodLabel("Payer @ domicile") === "Payer @ domicile",
  );

  // Email-shaped autofill → null (the BUG1 regression).
  check("admin email → null", sanitizeCodLabel("admin@tokyostore.tn") === null);
  check("any email → null", sanitizeCodLabel("john.doe+tag@example.co.uk") === null);

  // Empty / blank / nullish → null (falls back to the default downstream).
  check("empty string → null", sanitizeCodLabel("") === null);
  check("whitespace-only → null", sanitizeCodLabel("   ") === null);
  check("null → null", sanitizeCodLabel(null) === null);
  check("undefined → null", sanitizeCodLabel(undefined) === null);

  // Length is capped at 80.
  const long = sanitizeCodLabel("x".repeat(200));
  check("over-long label capped to ≤ 80", long !== null && long.length <= 80);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
