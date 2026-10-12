import "server-only";

/**
 * Fiscal document-number test. Verifies documentService.nextNumber is gapless
 * and atomic: sequential draws increment 1,2,3…; (kind, period) sequences are
 * independent; the pad + prefix format is `{prefix}-{period}-{NNNNNN}`; and 12
 * CONCURRENT draws on the same counter yield 12 DISTINCT consecutive numbers
 * (no skips, no collisions) — the property fiscal numbering must guarantee.
 * Self-cleaning (period `__dntest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/document-number.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { documentService } from "@/modules/document";

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
  await db.execute(sql`delete from document_sequences where period like '__dntest%'`);
}

async function main() {
  await cleanup();

  // 1) Sequential, gapless, formatted.
  const a1 = await documentService.nextNumber("invoice", { prefix: "FA", period: "__dntestA" });
  const a2 = await documentService.nextNumber("invoice", { prefix: "FA", period: "__dntestA" });
  const a3 = await documentService.nextNumber("invoice", { prefix: "FA", period: "__dntestA" });
  check("first = FA-__dntestA-000001", a1 === "FA-__dntestA-000001");
  check("second = FA-__dntestA-000002", a2 === "FA-__dntestA-000002");
  check("third = FA-__dntestA-000003", a3 === "FA-__dntestA-000003");

  // 2) Different kind, same period → its own sequence.
  const c1 = await documentService.nextNumber("credit_note", { prefix: "AV", period: "__dntestA" });
  check("credit_note independent → AV-__dntestA-000001", c1 === "AV-__dntestA-000001");

  // 3) Different period → its own sequence.
  const b1 = await documentService.nextNumber("invoice", { prefix: "FA", period: "__dntestB" });
  check("new period resets → FA-__dntestB-000001", b1 === "FA-__dntestB-000001");

  // 4) Custom pad width.
  const p1 = await documentService.nextNumber("delivery_note", { prefix: "BL", period: "__dntestC", pad: 4 });
  check("custom pad → BL-__dntestC-0001", p1 === "BL-__dntestC-0001");

  // 5) Concurrency: 12 parallel draws → 12 distinct consecutive numbers.
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      documentService.nextNumber("invoice", { prefix: "FA", period: "__dntestD" }),
    ),
  );
  const ints = results.map((s) => Number(s.split("-").pop())).sort((x, y) => x - y);
  const distinct = new Set(ints);
  check("concurrent: 12 distinct numbers (no collision)", distinct.size === N);
  check("concurrent: gapless 1..12 (no skips)", ints.every((v, i) => v === i + 1));

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
