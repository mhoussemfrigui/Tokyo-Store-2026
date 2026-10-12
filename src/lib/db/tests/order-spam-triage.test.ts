import "server-only";

/**
 * Order spam-triage — setOrderSpamWorkflow + the list/queue exclusion, against a
 * live DB.
 *
 *   T1 — flag stamps flagged_spam_at + the actor; unflag clears both; emits
 *        order.edited{changedFields:["flagged_spam"]} each way.
 *   T2 — a flagged order DROPS OUT of the default list() and APPEARS in
 *        list({spam:true}); the reverse after unflag.
 *   T3 — a flagged pending-COD order (normally « À traiter ») is EXCLUDED from the
 *        actionable count + queue; listFilterCounts.spam counts it and byStatus
 *        no longer does.
 *
 * Self-cleaning (`__spamtri…`, unique run token). Run:
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env.development.local|cut -d= -f2-)
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/order-spam-triage.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orders } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { workflows } from "@/workflows";
import { bus } from "@/events/bus";
import type { EventPayload } from "@/events/types";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__spamtri";
// A per-run token so list()/counts searches only ever see THIS run's orders
// (the suite may run against a shared dev DB with other data).
const RUN = `${TAG}-${Math.floor(Date.now() % 1_000_000)}`;

async function cleanup() {
  await db.execute(sql`delete from order_status_history where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
}

async function mkOrder(tag: string, opts: { status: string; method: string; paidAt?: Date | null }) {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${RUN}-${tag}`,
      contact_email: "spam@example.test",
      status: opts.status,
      payment_method: opts.method,
      paid_at: opts.paidAt ?? null,
      subtotal_cents: 20_000,
      total_cents: 20_000,
      ship_full_name: "SP",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id });
  return o.id;
}

async function spamCols(id: string): Promise<{ at: Date | null; by: string | null }> {
  const [r] = await db
    .select({ at: orders.flagged_spam_at, by: orders.flagged_spam_by_user_id })
    .from(orders)
    .where(eq(orders.id, id));
  return r;
}
const inList = async (opts: { spam?: boolean }) =>
  new Set((await orderService.list({ search: RUN, limit: 100, ...opts })).items.map((o) => o.id));

async function main() {
  await cleanup();
  const edits: EventPayload<"order.edited">[] = [];
  bus.on("order.edited", ({ payload }) => void edits.push(payload));

  // ── T1: flag / unflag stamps + clears + emits ───────────────────────────────
  {
    const o = await mkOrder("t1", { status: "pending", method: "cod" });
    const flag = await workflows.order.setSpam({ orderId: o, spam: true }, { actorUserId: `${TAG}-actor` });
    check("T1: flag ok", flag.ok === true);
    const afterFlag = await spamCols(o);
    check("T1: flagged_spam_at stamped", afterFlag.at != null);
    check("T1: flagged_spam_by_user_id = actor", afterFlag.by === `${TAG}-actor`);
    check(
      "T1: emitted order.edited{flagged_spam} on flag",
      edits.some((e) => e.orderId === o && e.changedFields?.includes("flagged_spam")),
    );

    const unflag = await workflows.order.setSpam({ orderId: o, spam: false }, { actorUserId: `${TAG}-actor` });
    check("T1: unflag ok", unflag.ok === true);
    const afterUnflag = await spamCols(o);
    check("T1: flagged_spam_at cleared", afterUnflag.at === null);
    check("T1: flagged_spam_by_user_id cleared", afterUnflag.by === null);
  }

  // ── T2: default list hides spam; the spam scope shows only spam ──────────────
  {
    const keep = await mkOrder("t2keep", { status: "paid", method: "flouci", paidAt: new Date() });
    const junk = await mkOrder("t2junk", { status: "paid", method: "flouci", paidAt: new Date() });
    await workflows.order.setSpam({ orderId: junk, spam: true }, { actorUserId: `${TAG}-actor` });

    const def = await inList({});
    check("T2: default list INCLUDES the kept order", def.has(keep));
    check("T2: default list EXCLUDES the flagged order", !def.has(junk));

    const spamView = await inList({ spam: true });
    check("T2: spam view INCLUDES the flagged order", spamView.has(junk));
    check("T2: spam view EXCLUDES the kept order", !spamView.has(keep));

    // Unflag → back in the default view, gone from the spam view.
    await workflows.order.setSpam({ orderId: junk, spam: false }, { actorUserId: `${TAG}-actor` });
    check("T2: after unflag, default list includes it again", (await inList({})).has(junk));
    check("T2: after unflag, spam view no longer has it", !(await inList({ spam: true })).has(junk));
  }

  // ── T3: a flagged actionable order drops out of the queue + counts ──────────
  {
    // A pending COD order IS « À traiter ». Flagging it must remove it from the
    // actionable count, and move it from byStatus.pending into the spam count.
    const o = await mkOrder("t3", { status: "pending", method: "cod" });
    const before = await orderService.listFilterCounts({ search: RUN });
    check("T3: pending-COD order counts as actionable before flag", (before.actionable ?? 0) >= 1);
    const pendingBefore = before.byStatus.pending ?? 0;

    await workflows.order.setSpam({ orderId: o, spam: true }, { actorUserId: `${TAG}-actor` });
    const after = await orderService.listFilterCounts({ search: RUN });
    check("T3: actionable count dropped by 1 after flag", (after.actionable ?? 0) === (before.actionable ?? 0) - 1);
    check("T3: byStatus.pending dropped by 1 (spam hidden from status chips)", (after.byStatus.pending ?? 0) === pendingBefore - 1);
    check("T3: spam count went up", (after.spam ?? 0) === (before.spam ?? 0) + 1);
    // The SQL actionable predicate agrees with the JS twin on the flagged row.
    const act = await db.execute<{ a: boolean }>(
      sql`select (${sql.raw("(orders.flagged_spam_at IS NULL AND (orders.status IN ('paid','preparing') OR (orders.status='pending' AND (orders.payment_method IS NULL OR orders.payment_method NOT IN ('flouci','clictopay','konnect','card_stripe','cash','bank_transfer') OR orders.paid_at IS NOT NULL))))")}) as a from orders where id = ${o}`,
    );
    check("T3: SQL says flagged order NOT actionable", act.rows[0]?.a === false);
  }

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch { /* best-effort */ }
    process.exit(1);
  })
  .then(() => process.exit(0));
