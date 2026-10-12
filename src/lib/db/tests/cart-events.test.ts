import "server-only";

/**
 * Add-to-cart analytics test. Verifies cartEventService.topAdded ranks products
 * by units within the window and reports the correct client/visitor split, and
 * that purgeOlderThan reaps stale rows. Self-cleaning (tagged product ids via a
 * fixed slug prefix). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/cart-events.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { cart_events } from "@/modules/cart-event/schema";
import { cartEventService } from "@/modules/cart-event";

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

const TAG = "__cetest";

async function cleanup() {
  await db.execute(sql`delete from cart_events where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  const [p1] = await db.insert(products).values({ slug: `${TAG}-a`, name: `${TAG} A`, price_cents: 1000 } as never).returning({ id: products.id });
  const [p2] = await db.insert(products).values({ slug: `${TAG}-b`, name: `${TAG} B`, price_cents: 1000 } as never).returning({ id: products.id });

  // P1: 3 client adds (qty 2 each = 6) + 1 visitor add (qty 1) → 7 units, 6 client / 1 visitor.
  for (let i = 0; i < 3; i++) await cartEventService.record({ productId: p1.id, quantity: 2, actorKind: "client" });
  await cartEventService.record({ productId: p1.id, quantity: 1, actorKind: "visitor" });
  // P2: 2 visitor adds (qty 5 each = 10) → 10 units, all visitor.
  for (let i = 0; i < 2; i++) await cartEventService.record({ productId: p2.id, quantity: 5, actorKind: "visitor" });

  const top = await cartEventService.topAdded({ sinceDays: 30, limit: 10 });
  const mine = top.filter((r) => r.productId === p1.id || r.productId === p2.id);
  check("both tagged products present", mine.length === 2);

  const r1 = mine.find((r) => r.productId === p1.id)!;
  const r2 = mine.find((r) => r.productId === p2.id)!;
  check("P1 units = 7", r1.units === 7);
  check("P1 split 6 client / 1 visitor", r1.clientUnits === 6 && r1.visitorUnits === 1);
  check("P1 events = 4", r1.events === 4);
  check("P2 units = 10 (all visitor)", r2.units === 10 && r2.visitorUnits === 10 && r2.clientUnits === 0);

  // Ranking: among the two, P2 (10) outranks P1 (7).
  const idxP1 = top.findIndex((r) => r.productId === p1.id);
  const idxP2 = top.findIndex((r) => r.productId === p2.id);
  check("P2 ranked above P1 (more units)", idxP2 < idxP1);

  // Purge: insert a stale event (400 days old), then purge older than 180.
  await db.insert(cart_events).values({
    product_id: p1.id,
    actor_kind: "visitor",
    quantity: 1,
    occurred_at: sql`now() - make_interval(days => 400)` as never,
  } as never);
  const before = await cartEventService.topAdded({ sinceDays: 3650, limit: 10 });
  const r1Wide = before.find((r) => r.productId === p1.id)!;
  check("wide window includes the stale event (units = 8)", r1Wide.units === 8);
  const purged = await cartEventService.purgeOlderThan(180);
  check("purgeOlderThan removed ≥ 1 stale row", purged >= 1);

  // Quantity is clamped to 99 (matches the add-to-cart workflow): a crafted
  // huge quantity can't skew the units metric beyond what could enter the cart.
  const [p3] = await db.insert(products).values({ slug: `${TAG}-c`, name: `${TAG} C`, price_cents: 1000 } as never).returning({ id: products.id });
  await cartEventService.record({ productId: p3.id, quantity: 1_000_000, actorKind: "visitor" });
  const clampRow = (await cartEventService.topAdded({ sinceDays: 30, limit: 50 })).find((r) => r.productId === p3.id);
  check("quantity clamped to 99 (not 1,000,000)", clampRow?.units === 99);

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
