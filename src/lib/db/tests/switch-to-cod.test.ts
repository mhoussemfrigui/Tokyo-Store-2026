import "server-only";

/**
 * « Basculer en paiement à la livraison » — switchOrderToCodWorkflow against a live
 * DB. Rescues a stuck pending online order (gateway payment never completed) by
 * converting it to COD, fail-closed so a captured order can never be downgraded.
 *
 *   T1 — pending online order with NO gateway session (no payment_reference) →
 *        switch OK: payment_method → 'cod', reference cleared, status stays pending;
 *        emits order.edited{changedFields:["payment_method"]}.
 *   T2 — a second switch on the now-COD order is refused (not an online order).
 *   T3 — a genuine COD order → refused (nothing to switch).
 *   T4 — a non-pending online order (paid) → refused (status guard, no gateway call).
 *   T5 — a pending online order WITH a reference whose gateway can't be verified in
 *        the test env → refused `payment_unverified` (fail-closed: never switch when
 *        we can't prove the order is unpaid).
 *
 * Self-cleaning (`__swcod…`). Run:
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env.development.local|cut -d= -f2-)
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/switch-to-cod.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orders } from "@/modules/order/schema";
import { workflows } from "@/workflows";
import { bus } from "@/events/bus";
import type { EventPayload } from "@/events/types";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__swcod";

async function cleanup() {
  await db.execute(sql`delete from order_status_history where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
}

async function mkOrder(tag: string, opts: { status: string; method: string; ref?: string | null; paidAt?: Date | null }) {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${tag}-${Date.now()}`,
      contact_email: "sw@example.test",
      status: opts.status,
      payment_method: opts.method,
      payment_reference: opts.ref ?? null,
      paid_at: opts.paidAt ?? null,
      subtotal_cents: 30_000,
      total_cents: 30_000,
      ship_full_name: "SW",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id });
  return o.id;
}

async function methodOf(id: string): Promise<{ method: string | null; ref: string | null; status: string }> {
  const [r] = await db
    .select({ method: orders.payment_method, ref: orders.payment_reference, status: orders.status })
    .from(orders)
    .where(eq(orders.id, id));
  return r;
}

async function main() {
  await cleanup();

  // Capture order.edited emissions for T1.
  const edits: EventPayload<"order.edited">[] = [];
  bus.on("order.edited", ({ payload }) => void edits.push(payload));

  // ── T1: pending online, no reference → switch OK ────────────────────────────
  {
    const o = await mkOrder("t1", { status: "pending", method: "flouci", ref: null });
    const res = await workflows.order.switchToCod({ orderId: o }, { actorUserId: `${TAG}-actor` });
    check("T1: switch accepted (pending online, no gateway session)", res.ok === true);
    const row = await methodOf(o);
    check("T1: payment_method → cod", row.method === "cod");
    check("T1: payment_reference cleared", row.ref === null);
    check("T1: status stays pending (settles at delivery)", row.status === "pending");
    const mine = edits.filter((e) => e.orderId === o);
    check(
      "T1: emitted order.edited{changedFields:[payment_method]}",
      mine.length === 1 && mine[0].changedFields?.includes("payment_method") === true,
    );

    // ── T2: a second switch on the now-COD order is refused ───────────────────
    const again = await workflows.order.switchToCod({ orderId: o }, { actorUserId: `${TAG}-actor` });
    check("T2: re-switch on a now-COD order refused (conflict)", again.ok === false && (again as { error?: string }).error === "conflict");
  }

  // ── T3: a genuine COD order → refused ───────────────────────────────────────
  {
    const o = await mkOrder("t3", { status: "pending", method: "cod", ref: null });
    const res = await workflows.order.switchToCod({ orderId: o }, { actorUserId: `${TAG}-actor` });
    check("T3: COD order refused (nothing to switch)", res.ok === false && (res as { error?: string }).error === "conflict");
  }

  // ── T4: a non-pending online order → refused (status guard) ─────────────────
  {
    const o = await mkOrder("t4", { status: "paid", method: "flouci", ref: "ref-t4", paidAt: new Date() });
    const res = await workflows.order.switchToCod({ orderId: o }, { actorUserId: `${TAG}-actor` });
    check("T4: paid online order refused (only pending switchable)", res.ok === false && (res as { error?: string }).error === "conflict");
    check("T4: payment_method unchanged (still flouci)", (await methodOf(o)).method === "flouci");
  }

  // ── T5: pending online WITH a reference, gateway unverifiable → fail-closed ──
  {
    const o = await mkOrder("t5", { status: "pending", method: "flouci", ref: "ref-t5-live" });
    const res = await workflows.order.switchToCod({ orderId: o }, { actorUserId: `${TAG}-actor` });
    check(
      "T5: pending online w/ unverifiable gateway refused (payment_unverified, fail-closed)",
      res.ok === false && (res as { error?: string }).error === "payment_unverified",
    );
    check("T5: payment_method unchanged (still flouci — not switched while unproven)", (await methodOf(o)).method === "flouci");
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
