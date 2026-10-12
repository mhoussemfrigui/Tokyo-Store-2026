import "server-only";

/**
 * Warranty claims (SAV / RMA) lifecycle — create → update → resolve, against a
 * live DB through the real workflows.
 *
 *   T1  — create snapshots coverage (was_covered) from the order-line warranty +
 *         emits warranty.claim.created; status = open.
 *   T2  — a second OPEN claim on the same sold line is refused (conflict).
 *   T3  — update: open → in_repair + comment, emits warranty.claim.updated{changed}.
 *   T4  — resolve (repaired) → status resolved, resolution + processed_at set,
 *         emits warranty.claim.resolved{resolution:"repaired"}.
 *   T5  — resolve / update on a terminal claim → conflict (idempotent guard).
 *   T6  — after resolution, a NEW claim on the same line IS allowed (re-claim).
 *   T7  — out-of-warranty line (0 months) → was_covered = false.
 *   T8  — reject resolution closes the claim as `rejected`.
 *   T9  — service reads: listForOrder / orderIdsWithClaims / hasOpenClaimForOrderItem.
 *
 * Self-cleaning (`__wclaim…`). Run:
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env.development.local|cut -d= -f2-)
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/warranty-claims.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orders, order_items } from "@/modules/order/schema";
import { warranty_claims } from "@/modules/warranty-claim/schema";
import { warrantyClaimService } from "@/modules/warranty-claim/service";
import { workflows } from "@/workflows";
import { bus } from "@/events/bus";
import type { EventPayload } from "@/events/types";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__wclaim";

async function cleanup() {
  const mine = sql`(select id from orders where order_number like ${TAG + "%"})`;
  await db.execute(sql`delete from warranty_claims where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
}

async function mkOrderWithItem(tag: string, warrantyMonths: number | null, status = "delivered", quantity = 1) {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${tag}-${Date.now()}`,
      contact_email: "sav@example.test",
      status,
      payment_method: "cod",
      paid_at: new Date(),
      subtotal_cents: 50_000,
      total_cents: 50_000,
      ship_full_name: "SAV",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id });
  const [it] = await db
    .insert(order_items)
    .values({
      order_id: o.id,
      product_id: sql`uuid_generate_v7()`,
      product_name: `${TAG} Montre`,
      product_slug: `${TAG}-montre`,
      unit_price_cents: 50_000,
      quantity,
      subtotal_cents: 50_000 * quantity,
      warranty_months: warrantyMonths,
      warranty_label: warrantyMonths ? "Garantie constructeur" : null,
    } as never)
    .returning({ id: order_items.id });
  return { orderId: o.id, itemId: it.id };
}

async function claimRow(id: string) {
  const [r] = await db.select().from(warranty_claims).where(eq(warranty_claims.id, id));
  return r;
}

async function main() {
  await cleanup();
  const created: EventPayload<"warranty.claim.created">[] = [];
  const updated: EventPayload<"warranty.claim.updated">[] = [];
  const resolved: EventPayload<"warranty.claim.resolved">[] = [];
  bus.on("warranty.claim.created", ({ payload }) => void created.push(payload));
  bus.on("warranty.claim.updated", ({ payload }) => void updated.push(payload));
  bus.on("warranty.claim.resolved", ({ payload }) => void resolved.push(payload));

  // ── T1: create with an active-coverage snapshot ─────────────────────────────
  const a = await mkOrderWithItem("t1", 24, "delivered");
  const c1 = await workflows.warranty.createClaim(
    { orderId: a.orderId, orderItemId: a.itemId, reasonCode: "battery", reason: "Ne tient plus la charge" },
    { actorUserId: `${TAG}-actor` },
  );
  check("T1: create ok", c1.ok === true);
  if (!c1.ok) { await cleanup(); console.log(`\n=== done: ${passed} passed, ${failed} failed ===`); process.exit(1); }
  const r1 = await claimRow(c1.data.claimId);
  check("T1: status open", r1.status === "open");
  check("T1: coverage snapshot months = 24", r1.warranty_months === 24);
  check("T1: was_covered = true (delivered, within 24mo)", r1.was_covered === true);
  check("T1: covered_until stamped", r1.covered_until != null);
  check("T1: product_name snapshotted", r1.product_name === `${TAG} Montre`);
  check("T1: emitted warranty.claim.created", created.some((e) => e.claimId === c1.data.claimId));

  // ── T2: duplicate OPEN claim refused ────────────────────────────────────────
  const dup = await workflows.warranty.createClaim({ orderId: a.orderId, orderItemId: a.itemId }, { actorUserId: `${TAG}-actor` });
  check("T2: duplicate open claim refused (conflict)", dup.ok === false && (dup as { error?: string }).error === "conflict");

  // ── T3: update open → in_repair + comment ───────────────────────────────────
  const u1 = await workflows.warranty.updateClaim(
    { claimId: c1.data.claimId, status: "in_repair", comment: "Envoyée à l'atelier" },
    { actorUserId: `${TAG}-actor` },
  );
  check("T3: update ok", u1.ok === true);
  const r3 = await claimRow(c1.data.claimId);
  check("T3: status → in_repair", r3.status === "in_repair");
  check("T3: comment saved", r3.comment === "Envoyée à l'atelier");
  check(
    "T3: emitted warranty.claim.updated{status,comment}",
    updated.some((e) => e.claimId === c1.data.claimId && e.changedFields?.includes("status") && e.changedFields?.includes("comment")),
  );

  // ── T4: resolve (repaired) ──────────────────────────────────────────────────
  const res1 = await workflows.warranty.resolveClaim(
    { claimId: c1.data.claimId, resolution: "repaired", resolutionNote: "Pile remplacée" },
    { actorUserId: `${TAG}-actor` },
  );
  check("T4: resolve ok, status resolved", res1.ok === true && res1.data.status === "resolved");
  const r4 = await claimRow(c1.data.claimId);
  check("T4: resolution = repaired", r4.resolution === "repaired");
  check("T4: processed_at + processed_by stamped", r4.processed_at != null && r4.processed_by_user_id === `${TAG}-actor`);
  check("T4: emitted warranty.claim.resolved{repaired}", resolved.some((e) => e.claimId === c1.data.claimId && e.resolution === "repaired"));

  // ── T5: terminal-claim guards ───────────────────────────────────────────────
  const reRes = await workflows.warranty.resolveClaim({ claimId: c1.data.claimId, resolution: "replaced" }, { actorUserId: null });
  check("T5: re-resolve refused (conflict)", reRes.ok === false && (reRes as { error?: string }).error === "conflict");
  const reUpd = await workflows.warranty.updateClaim({ claimId: c1.data.claimId, comment: "x" }, { actorUserId: null });
  check("T5: update on resolved refused (conflict)", reUpd.ok === false && (reUpd as { error?: string }).error === "conflict");

  // ── T6: re-claim on the same line after resolution ──────────────────────────
  const c2 = await workflows.warranty.createClaim({ orderId: a.orderId, orderItemId: a.itemId, reasonCode: "movement" }, { actorUserId: null });
  check("T6: new claim allowed after the prior one resolved", c2.ok === true);

  // ── T7: out-of-warranty snapshot ────────────────────────────────────────────
  const b = await mkOrderWithItem("t7", 0, "delivered");
  const c3 = await workflows.warranty.createClaim({ orderId: b.orderId, orderItemId: b.itemId }, { actorUserId: null });
  check("T7: create ok (out of warranty)", c3.ok === true);
  if (c3.ok) check("T7: was_covered = false (0 months)", (await claimRow(c3.data.claimId)).was_covered === false);

  // ── T8: reject resolution ───────────────────────────────────────────────────
  const d = await mkOrderWithItem("t8", 24, "delivered");
  const c4 = await workflows.warranty.createClaim({ orderId: d.orderId, orderItemId: d.itemId }, { actorUserId: null });
  if (c4.ok) {
    const rej = await workflows.warranty.resolveClaim({ claimId: c4.data.claimId, resolution: "rejected", resolutionNote: "Hors garantie" }, { actorUserId: null });
    check("T8: reject resolution closes as rejected", rej.ok === true && rej.data.status === "rejected");
    check("T8: emitted resolved{rejected}", resolved.some((e) => e.claimId === c4.data.claimId && e.resolution === "rejected"));
  }

  // ── T9: service reads ───────────────────────────────────────────────────────
  check("T9: listForOrder returns both claims on order A", (await warrantyClaimService.listForOrder(a.orderId)).length === 2);
  const withClaims = await warrantyClaimService.orderIdsWithClaims([a.orderId, b.orderId, d.orderId]);
  check("T9: orderIdsWithClaims finds all three", withClaims.has(a.orderId) && withClaims.has(b.orderId) && withClaims.has(d.orderId));
  check("T9: hasOpenClaimForOrderItem true for the re-claim (c2 open)", (await warrantyClaimService.hasOpenClaimForOrderItem(a.itemId)) === true);

  // ── T10: qty>1 line allows one OPEN claim PER unit (V11) ─────────────────────
  const q = await mkOrderWithItem("t10", 24, "delivered", 2); // a line of TWO watches
  const q1 = await workflows.warranty.createClaim({ orderId: q.orderId, orderItemId: q.itemId }, { actorUserId: null });
  check("T10: 1st claim on a qty-2 line ok", q1.ok === true);
  const q2 = await workflows.warranty.createClaim({ orderId: q.orderId, orderItemId: q.itemId }, { actorUserId: null });
  check("T10: 2nd open claim on the SAME qty-2 line ALSO ok (one per unit)", q2.ok === true);
  const q3 = await workflows.warranty.createClaim({ orderId: q.orderId, orderItemId: q.itemId }, { actorUserId: null });
  check("T10: 3rd claim REFUSED — both units already have an open case", q3.ok === false && (q3 as { error?: string }).error === "conflict");
  check("T10: countOpenClaimsForOrderItem === 2", (await warrantyClaimService.countOpenClaimsForOrderItem(q.itemId)) === 2);

  // ── T11: open work is counted + listed UNWINDOWED (V12) ──────────────────────
  // Backdate one of the qty line's open claims well beyond the 365-day stats window.
  await db.execute(
    sql`update warranty_claims set created_at = now() - interval '800 days' where id = ${q1.ok ? q1.data.claimId : ""}`,
  );
  const openNow = await warrantyClaimService.countOpen();
  const stats = await warrantyClaimService.dashboardStats(365);
  check("T11: countOpen() counts the 800-day-old open claim", openNow >= 1);
  check("T11: dashboardStats.openCount is UNWINDOWED (=== countOpen)", stats.openCount === openNow);
  const openList = await warrantyClaimService.listOpenWithOrder();
  check(
    "T11: listOpenWithOrder surfaces the 800-day-old open claim",
    q1.ok ? openList.some((c) => c.id === q1.data.claimId) : false,
  );
  check(
    "T11: listOpenWithOrder contains only non-terminal claims",
    openList.every((c) => c.status !== "resolved" && c.status !== "rejected"),
  );

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
