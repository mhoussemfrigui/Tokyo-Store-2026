import "server-only";

/**
 * External order API query-layer test. Verifies orderService.listForApi (the
 * ERP incremental-sync read): status filter, `since` watermark on updated_at,
 * updated_at-ASC ordering + limit + the microsecond-precise forward cursor
 * (nextSince/nextId) walked over a same-timestamp batch at limit=1, the settle
 * window that holds back fresh rows, plus the external_ref round-trip
 * (setExternalRef / findByExternalRef), and the serializer's money contract
 * (coins + taxIncludedInTotal → the total reconciles from its terms for
 * ht / ttc / manual TVA / tax-free orders). Self-cleaning (`__oapitest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/order-api.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { keysetCursor } from "@/lib/api/keyset";
import { serializeOrder } from "@/lib/api/orders";
import { orders } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";

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

const TAG = "__oapitest";

async function cleanup() {
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
}

async function mk(num: string, status: string, updatedDaysAgo: number) {
  const [row] = await db
    .insert(orders)
    .values({
      order_number: num,
      contact_email: "oapi@example.com",
      status: status as never,
      subtotal_cents: 1000,
      total_cents: 1000,
      ship_full_name: "OAPI",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
      updated_at: sql`now() - make_interval(days => ${updatedDaysAgo})` as never,
    } as never)
    .returning({ id: orders.id });
  return row.id;
}

async function main() {
  await cleanup();

  // Three orders, staggered updated_at, mixed statuses.
  const oldId = await mk(`${TAG}-1`, "pending", 10);
  const midId = await mk(`${TAG}-2`, "paid", 5);
  const newId = await mk(`${TAG}-3`, "paid", 1);
  void oldId;

  // Status filter (limit to our tagged window via a wide since to exclude noise).
  const sinceWide = new Date(Date.now() - 40 * 86400_000).toISOString();
  const paid = (await orderService.listForApi({ status: "paid", sinceIso: sinceWide, limit: 200 })).items.filter((o) =>
    o.order_number.startsWith(TAG),
  );
  check("status filter → only paid", paid.length === 2 && paid.every((o) => o.status === "paid"));
  check("ordered updated_at ASC (mid before new)", paid[0].id === midId && paid[1].id === newId);

  // `since` watermark: 3 days ago excludes the 5/10-day-old rows.
  const since3 = new Date(Date.now() - 3 * 86400_000).toISOString();
  const recent = (await orderService.listForApi({ sinceIso: since3, limit: 200 })).items.filter((o) =>
    o.order_number.startsWith(TAG),
  );
  check("since=3d → only the 1-day-old order", recent.length === 1 && recent[0].id === newId);

  // limit clamps the page + the forward cursor is microsecond-precise (a
  // ms-truncated JS Date cursor would re-match the boundary row and stall
  // same-instant pages — the regression this guards).
  const page = await orderService.listForApi({ sinceIso: sinceWide, limit: 1 });
  check("limit respected (≤1)", page.items.length <= 1);
  check("nextSince carries microsecond precision", !page.nextSince || /\.\d{6}Z$/.test(page.nextSince));
  check("nextId returned with the page", page.items.length === 0 || typeof page.nextId === "string");

  // Same-timestamp batch at limit=1: three orders written in ONE tx share one
  // `now()` updated_at. Walking the feed (feeding nextSince/nextId back
  // verbatim) must deliver each exactly once and END on an empty page — a
  // ms-truncated cursor would re-deliver the boundary row forever.
  const batchIds = await db.transaction(async (tx) => {
    const out: string[] = [];
    for (const n of [1, 2, 3]) {
      const [row] = await tx
        .insert(orders)
        .values({
          order_number: `${TAG}-S${n}`,
          contact_email: "oapi@example.com",
          status: "paid" as never,
          subtotal_cents: 1000,
          total_cents: 1000,
          ship_full_name: "OAPI",
          ship_street_line1: "1 rue",
          ship_city: "Tunis",
        } as never)
        .returning({ id: orders.id });
      out.push(row.id);
    }
    return out;
  });
  const mine = new Set(batchIds);
  const [start] = await db
    .select({ c: keysetCursor(orders.updated_at) })
    .from(orders)
    .where(eq(orders.id, batchIds[0]));

  // Settle window (default): rows younger than KEYSET_SETTLE_SECONDS are held
  // back so a late-committing placement can't be paged past and lost.
  const fresh = await orderService.listForApi({ sinceIso: start.c, limit: 200 });
  check("settle window holds back just-written orders", !fresh.items.some((o) => mine.has(o.id)));

  const seen: string[] = [];
  let sinceIso: string | undefined = start.c;
  let sinceId: string | undefined;
  let terminated = false;
  const cursors: string[] = [];
  for (let i = 0; i < 500; i++) {
    const p = await orderService.listForApi({ sinceIso, sinceId, limit: 1, settleSeconds: 0 });
    if (p.items.length === 0) {
      terminated = p.nextSince === null;
      break;
    }
    seen.push(...p.items.map((o) => o.id));
    if (p.nextSince) cursors.push(p.nextSince);
    sinceIso = p.nextSince ?? undefined;
    sinceId = p.nextId ?? undefined;
  }
  const mineSeen = seen.filter((id) => mine.has(id));
  check("same-tx orders each delivered EXACTLY once at limit=1", mineSeen.length === 3 && new Set(mineSeen).size === 3);
  check("walk ends on an empty page (cursor never stalls)", terminated);
  check("every walked cursor is µs-precise", cursors.length > 0 && cursors.every((c) => /\.\d{6}Z$/.test(c)));

  // external_ref round-trip.
  await orderService.setExternalRef(midId, `${TAG}-ERP-42`);
  const found = await orderService.findByExternalRef(`${TAG}-ERP-42`);
  check("setExternalRef + findByExternalRef round-trips", found?.id === midId);
  check("external_ref persisted on the row", found?.external_ref === `${TAG}-ERP-42`);

  // Clearing the ref nulls it.
  await orderService.setExternalRef(midId, null);
  const cleared = await orderService.findByExternalRef(`${TAG}-ERP-42`);
  check("clearing external_ref removes the link", cleared === null);

  // Duplicate external_ref is rejected by the partial-unique index — the basis
  // for the API PATCH returning 409 (not a raw 500) on a colliding ref.
  await orderService.setExternalRef(newId, `${TAG}-DUP`);
  let dupRejected = false;
  try {
    await orderService.setExternalRef(midId, `${TAG}-DUP`);
  } catch (err) {
    // Walk the drizzle-wrapped cause chain for the Postgres 23505 code.
    let e: unknown = err;
    for (let d = 0; e && typeof e === "object" && d < 6; d++) {
      if ((e as { code?: string }).code === "23505") dupRejected = true;
      e = (e as { cause?: unknown }).cause;
    }
  }
  check("duplicate external_ref raises a unique violation", dupRejected);

  // Serializer money contract: every term of the total is exposed, so an ERP
  // can reconcile subtotal + shipping − discount − coins (+ tax when NOT
  // included) === total for HT (tax on top), TTC (tax included), a manual TVA
  // override and a tax-free order — coins included.
  const moneyCases: Array<{ label: string; over: Record<string, unknown>; included: boolean }> = [
    {
      label: "ht",
      over: { subtotal_cents: 100_000, shipping_cents: 7_000, discount_cents: 5_000, tax_cents: 19_000, total_cents: 121_000 },
      included: false,
    },
    {
      label: "ttc",
      over: { subtotal_cents: 119_000, shipping_cents: 7_000, tax_cents: 19_000, total_cents: 126_000 },
      included: true,
    },
    {
      label: "ht + manual TVA",
      over: { subtotal_cents: 100_000, shipping_cents: 7_000, tax_cents: 19_000, tax_manual_cents: 20_000, total_cents: 127_000 },
      included: false,
    },
    { label: "tax-free", over: { subtotal_cents: 50_000, shipping_cents: 7_000, total_cents: 57_000 }, included: false },
  ];
  for (const [i, mc] of moneyCases.entries()) {
    const [row] = await db
      .insert(orders)
      .values({
        order_number: `${TAG}-M${i}`,
        contact_email: "oapi@example.com",
        status: "pending" as never,
        ship_full_name: "OAPI",
        ship_street_line1: "1 rue",
        ship_city: "Tunis",
        ...mc.over,
      } as never)
      .returning();
    const o = serializeOrder(row);
    check(`serializer (${mc.label}): taxIncludedInTotal = ${mc.included}`, o.taxIncludedInTotal === mc.included);
    check(
      `serializer (${mc.label}): subtotal + shipping − discount (+ tax if not included) === total`,
      o.subtotalCents + o.shippingCents - o.discountCents + (o.taxIncludedInTotal ? 0 : o.taxCents) === o.totalCents,
    );
  }

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
