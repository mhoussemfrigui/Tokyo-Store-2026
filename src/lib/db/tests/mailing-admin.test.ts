import "server-only";

/**
 * Newsletter admin read-side + subscribe-workflow state regression test.
 *
 *  1. The admin list is SERVER-driven over the whole table (it used to derive
 *     its stat cards, tabs, search and CSV from the newest 500 rows): status
 *     counts, filtered counts, a LIKE-metacharacter-safe search, offset
 *     pagination, and the id-keyset walk the streamed CSV export uses (every
 *     row exactly once).
 *  2. `subscribeWorkflow` states: created / already_active / reactivated /
 *     validation, with case-normalised emails.
 *
 * Self-cleaning (rows tagged `__mailtest-nladm…`). Run against the isolated
 * test DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/mailing-admin.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { newsletterService } from "@/modules/newsletter/service";
import {
  countSubscribers,
  findSubscriberById,
  listSubscribers,
  listSubscribersForExport,
  subscriberStatusCounts,
} from "@/modules/newsletter/queries";
import { subscribeWorkflow } from "@/workflows/newsletter/subscribe";

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

const TAG = "__mailtest-nladm";

async function cleanup() {
  await db.execute(sql`delete from newsletter_subscriptions where email like ${`${TAG}%`}`);
}

async function main() {
  await cleanup();

  // ── 1) Admin read-side ──
  const before = await subscriberStatusCounts();

  // 3 active + 2 unsubscribed, inserted oldest → newest.
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const row = await newsletterService.insert({
      email: `${TAG}-${i}@example.test`,
      source: "test",
    } as never);
    ids.push(row.id);
    if (i >= 4) await newsletterService.unsubscribe(row.id);
  }

  const after = await subscriberStatusCounts();
  check("status counts: +3 active", after.active - before.active === 3);
  check("status counts: +2 unsubscribed", after.inactive - before.inactive === 2);
  check("status counts: total = active + inactive", after.total === after.active + after.inactive);

  check("filtered count (active + search)", (await countSubscribers({ status: "active", q: TAG })) === 3);
  check("filtered count (inactive + search)", (await countSubscribers({ status: "inactive", q: TAG })) === 2);
  check("filtered count (all + search)", (await countSubscribers({ status: "all", q: TAG })) === 5);
  check(
    "search is case-insensitive",
    (await countSubscribers({ status: "all", q: TAG.toUpperCase() })) === 5,
  );
  // `_` is a LIKE wildcard: unescaped, "mailtest_nladm" would match the
  // "mailtest-nladm" rows. The search must treat it literally.
  check(
    "search escapes LIKE metacharacters (`_` is literal)",
    (await countSubscribers({ status: "all", q: "mailtest_nladm" })) === 0,
  );

  const page1 = await listSubscribers({ status: "all", q: TAG, limit: 2, offset: 0 });
  const page2 = await listSubscribers({ status: "all", q: TAG, limit: 2, offset: 2 });
  const page3 = await listSubscribers({ status: "all", q: TAG, limit: 2, offset: 4 });
  check("pagination: page sizes 2 / 2 / 1", page1.length === 2 && page2.length === 2 && page3.length === 1);
  const paged = [...page1, ...page2, ...page3].map((r) => r.id);
  check("pagination: no row repeated or lost", new Set(paged).size === 5);
  check("pagination: newest first", page1[0]?.id === ids[4]);
  check(
    "status filter applies to the page",
    (await listSubscribers({ status: "inactive", q: TAG })).every((r) => !r.is_active),
  );

  // Export keyset walk (page size 2 → 3 pages): every filtered row exactly once.
  const exported: string[] = [];
  let afterId: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const rows = await listSubscribersForExport({ status: "all", q: TAG }, { limit: 2, afterId });
    exported.push(...rows.map((r) => r.id));
    if (rows.length < 2) break;
    afterId = rows[rows.length - 1].id;
  }
  check("export keyset: all 5 rows, none repeated", exported.length === 5 && new Set(exported).size === 5);
  const exportedActive: string[] = [];
  afterId = undefined;
  for (let guard = 0; guard < 10; guard++) {
    const rows = await listSubscribersForExport({ status: "active", q: TAG }, { limit: 2, afterId });
    exportedActive.push(...rows.map((r) => r.id));
    if (rows.length < 2) break;
    afterId = rows[rows.length - 1].id;
  }
  check("export keyset honours the status filter", exportedActive.length === 3);

  check("findSubscriberById → the row", (await findSubscriberById(ids[0]))?.email === `${TAG}-1@example.test`);
  check(
    "findSubscriberById (unknown) → null",
    (await findSubscriberById("00000000-0000-7000-8000-000000000000")) === null,
  );

  // ── 2) subscribeWorkflow states ──
  const email = `${TAG}-sub@example.test`;
  const r1 = await subscribeWorkflow({ email: email.toUpperCase(), source: "footer" });
  check("new address → created", r1.ok && r1.data.status === "created");
  const created = await newsletterService.findByEmail(email);
  check("created row is active + lowercased", created?.is_active === true && created.email === email);
  check("created row stamps confirmed_at (single opt-in)", created?.confirmed_at != null);

  const r2 = await subscribeWorkflow({ email, source: "footer" });
  check("already subscribed → already_active (no-op)", r2.ok && r2.data.status === "already_active");

  await newsletterService.unsubscribe(created!.id);
  const r3 = await subscribeWorkflow({ email, source: "popup" });
  check("unsubscribed address → reactivated", r3.ok && r3.data.status === "reactivated");
  const reactivated = await newsletterService.findByEmail(email);
  check(
    "reactivated row: active again, unsubscribed_at cleared, same row",
    reactivated?.is_active === true && reactivated.unsubscribed_at === null && reactivated.id === created!.id,
  );

  const r4 = await subscribeWorkflow({ email: "not-an-email", source: "footer" });
  check("invalid email → validation", !r4.ok && r4.error === "validation");

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
