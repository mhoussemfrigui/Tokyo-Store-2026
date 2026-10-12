/**
 * Pure unit tests for the shared recipient-list parser. NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/email-recipients.test.ts
 */
import { parseEmailRecipients, DEFAULT_RECIPIENT_CAP } from "@/lib/format/email-recipients";

let passed = 0;
let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

console.log("email-recipients:");

eq("null/empty → []", parseEmailRecipients(null), []);
eq("blank → []", parseEmailRecipients("   "), []);
eq("split on comma/semicolon/space + lowercase", parseEmailRecipients("A@x.tn, b@x.tn ; c@x.tn"), [
  "a@x.tn",
  "b@x.tn",
  "c@x.tn",
]);
eq("dedupe (case-insensitive)", parseEmailRecipients("A@x.tn, a@x.tn"), ["a@x.tn"]);
// EMAIL_RE rejects malformed addresses (the divergence the low-stock copy had).
eq("reject bare '@' and missing TLD dot", parseEmailRecipients("hello, foo@, a@b, x@y.tn"), ["x@y.tn"]);
eq("non-email tokens dropped", parseEmailRecipients("hello world, ok@ex.tn"), ["ok@ex.tn"]);

// Fan-out cap: a paste of >cap addresses is truncated.
const many = Array.from({ length: 30 }, (_, i) => `u${i}@x.tn`).join(",");
eq("default cap = 20", parseEmailRecipients(many).length, DEFAULT_RECIPIENT_CAP);
eq("explicit cap honored", parseEmailRecipients(many, 5).length, 5);
eq("cap 0 → []", parseEmailRecipients("a@x.tn,b@x.tn", 0), []);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
