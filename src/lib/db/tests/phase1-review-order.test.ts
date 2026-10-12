import "server-only";

/**
 * Phase-1 review regressions — order placement (A–Z 2026-09-23, phase 3r):
 *
 *   A. PURE — a schema refusal for an over-long free-text field names EACH
 *      offending field with its ORDER_FIELD_MAX cap (téléphone 32, ville 120,
 *      code postal 20, e-mail 254, …), built from the zod issue paths — not a
 *      fixed « nom / adresse / notes » list; any other refusal keeps the generic
 *      message.
 *   B. EXPRESS IDEMPOTENCY — a quick-buy submit carrying the buy form's
 *      idempotency key stages its ephemeral cart under `qb-<key>` (carts.token is
 *      UNIQUE): a replay of an already-placed key — sequential, concurrent or
 *      re-cased — is refused (« Commande déjà enregistrée ») and never places a
 *      second order; a FAILED attempt disposes its cart, so the shopper's retry
 *      with the same key still goes through. A key-less (older) client keeps
 *      working.
 *
 * Self-cleaning (`__p1rotest…`). Section B places real orders — run it ONLY
 * against a throwaway test DB:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *     src/lib/db/tests/phase1-review-order.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { carts } from "@/modules/cart/schema";
import { workflows } from "@/workflows";
import {
  orderFieldTooLongMessage,
  orderValidationMessage,
  placeOrderSchema,
} from "@/workflows/order/place-order";
import {
  placeQuickOrderSchema,
  QUICK_ORDER_REPLAY_MESSAGE,
} from "@/workflows/order/place-quick-order";

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

const TAG = "__p1rotest";
/** Idempotency keys this run used (their `qb-<key>` carts are cleaned up). */
const usedKeys: string[] = [];
const HOME_KEY = "delivery.home_enabled";

async function cleanup() {
  const mine = sql`(select id from orders where contact_phone = ${TAG})`;
  await db.execute(sql`delete from stock_movements where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where contact_phone = ${TAG}`);
  if (usedKeys.length > 0) {
    await db.delete(carts).where(inArray(carts.token, usedKeys.map((k) => `qb-${k.toLowerCase()}`)));
  }
  // Key-less (legacy) express carts are named `qb-<productId>-<ts>-<rand>`.
  await db.execute(sql`
    delete from carts where token like 'qb-%' and exists (
      select 1 from products p
      where p.slug like ${TAG + "%"} and carts.token like 'qb-' || p.id::text || '-%'
    )`);
  await db.execute(sql`delete from cart_items where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

// ── A. Pure: « champ trop long » messages ─────────────────────────────────────
function pureMessages() {
  console.log("A. field-length messages");
  const base = {
    cartId: randomUUID(),
    contactEmail: "",
    contactPhone: "+216 12 345 678",
    shipping: { fullName: "Test", streetLine1: "1 rue du Lac", city: "Tunis", country: "TN" },
  };
  const msg = (patch: Record<string, unknown>, shipping: Record<string, unknown> = {}) => {
    const r = placeOrderSchema.safeParse({ ...base, ...patch, shipping: { ...base.shipping, ...shipping } });
    return r.success ? "OK" : orderValidationMessage(r.error);
  };

  check("baseline input is valid", msg({}) === "OK");
  check(
    "contactPhone > 32 → names the phone + its cap",
    msg({ contactPhone: "+216 12 345 678 / +216 98 765 432 (bureau)" }) ===
      "Champ trop long : téléphone (32 caractères max).",
  );
  check(
    "contactPhone + shipping.phone both too long → named ONCE",
    msg({ contactPhone: "9".repeat(33) }, { phone: "9".repeat(33) }) ===
      "Champ trop long : téléphone (32 caractères max).",
  );
  check(
    "city > 120 → « ville (120 caractères max) »",
    msg({}, { city: "x".repeat(121) }) === "Champ trop long : ville (120 caractères max).",
  );
  check(
    "postalCode > 20 → « code postal (20 caractères max) »",
    msg({}, { postalCode: "1".repeat(21) }) === "Champ trop long : code postal (20 caractères max).",
  );
  check(
    "contactEmail > 254 (inside the email | \"\" union) → « e-mail (254 caractères max) »",
    msg({ contactEmail: `${"a".repeat(250)}@x.tn` }) === "Champ trop long : e-mail (254 caractères max).",
  );
  const multi = msg({ notes: "n".repeat(1001) }, { region: "r".repeat(121) });
  check(
    "several fields → « Champs trop longs » listing each with its cap",
    multi.startsWith("Champs trop longs : ") &&
      multi.includes("gouvernorat (120 caractères max)") &&
      multi.includes("notes (1000 caractères max)"),
  );
  check(
    "externalRef > 200 (ERP push) → « référence externe (200 caractères max) »",
    msg({ externalRef: "E".repeat(201) }) === "Champ trop long : référence externe (200 caractères max).",
  );

  const notLength = placeOrderSchema.safeParse({ ...base, cartId: "not-a-uuid" });
  check(
    "a non-length refusal keeps the generic message (null from the helper)",
    !notLength.success &&
      orderFieldTooLongMessage(notLength.error) === null &&
      orderValidationMessage(notLength.error) === "Validation échouée",
  );

  const quick = placeQuickOrderSchema.safeParse({
    productId: randomUUID(),
    contactEmail: "",
    shipping: { fullName: "Test", streetLine1: "1 rue", city: "c".repeat(121) },
  });
  check(
    "quick-order schema → same field-named message",
    !quick.success && orderValidationMessage(quick.error) === "Champ trop long : ville (120 caractères max).",
  );
  const badKey = placeQuickOrderSchema.safeParse({
    productId: randomUUID(),
    contactEmail: "",
    shipping: { fullName: "Test", streetLine1: "1 rue", city: "Tunis" },
    idempotencyKey: "not-a-uuid",
  });
  check("quick-order schema refuses a non-UUID idempotency key", !badKey.success);
}

// ── B. DB: express idempotency ────────────────────────────────────────────────
async function expressIdempotency() {
  console.log("B. express idempotency");
  const [product] = await db
    .insert(products)
    .values({
      slug: `${TAG}-prod`,
      name: `${TAG} Montre`,
      price_cents: 50_000,
      stock_qty: 10,
      in_stock: true,
      is_published: true,
    } as never)
    .returning({ id: products.id });

  const quick = (key: string | undefined, quantity = 1) =>
    workflows.order.placeQuick(
      {
        productId: product.id,
        quantity,
        contactEmail: "",
        contactPhone: TAG,
        shipping: { fullName: "P1R Test", streetLine1: "1 rue du Lac", city: "Tunis", region: "Tunis" },
        deliveryMethod: "home_delivery",
        paymentMethod: "cod",
        idempotencyKey: key,
      },
      { actorUserId: null },
    );
  const orderCount = async () =>
    Number(
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from orders where contact_phone = ${TAG}`))
        .rows[0]?.n ?? 0,
    );
  const stock = async () =>
    (await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, product.id)))[0]?.s ?? null;
  const cartFor = async (key: string) =>
    (await db.select({ id: carts.id }).from(carts).where(eq(carts.token, `qb-${key.toLowerCase()}`)))[0] ?? null;

  // 1. First submit places the order; its cart row stays as the replay guard.
  const k1 = randomUUID();
  usedKeys.push(k1);
  const first = await quick(k1);
  check("first express submit → placed", first.ok);
  check("…one order, stock 10 → 9", (await orderCount()) === 1 && (await stock()) === 9);
  check("…its `qb-<key>` cart is kept (replay guard)", (await cartFor(k1)) !== null);

  // 2. A replay of the same key never places a second order.
  const replay = await quick(k1);
  check(
    "replay of a placed key → refused « Commande déjà enregistrée »",
    !replay.ok && replay.error === "conflict" && replay.message === QUICK_ORDER_REPLAY_MESSAGE,
  );
  const recased = await quick(k1.toUpperCase());
  check("…also when re-cased (upper-case UUID)", !recased.ok && recased.error === "conflict");
  check("…still ONE order, stock untouched (9)", (await orderCount()) === 1 && (await stock()) === 9);

  // 3. A concurrent double-fire of the same key → exactly one order.
  const k2 = randomUUID();
  usedKeys.push(k2);
  const [a, b] = await Promise.all([quick(k2), quick(k2)]);
  check("concurrent double-submit (same key) → exactly ONE placed", [a, b].filter((r) => r.ok).length === 1);
  const loser = [a, b].find((r) => !r.ok);
  check("…the other is refused (conflict)", !!loser && !loser.ok && loser.error === "conflict");
  check("…two orders in total, stock decremented once more (8)", (await orderCount()) === 2 && (await stock()) === 8);

  // 4. A FAILED attempt disposes its cart → the retry with the same key works.
  const k3 = randomUUID();
  usedKeys.push(k3);
  const tooMany = await quick(k3, 50);
  check("over-stock attempt → refused", !tooMany.ok && tooMany.error !== "conflict");
  check("…its ephemeral cart is disposed (no `qb-<key>` row left)", (await cartFor(k3)) === null);
  check("…no order, stock untouched (8)", (await orderCount()) === 2 && (await stock()) === 8);
  const retry = await quick(k3, 1);
  check("retry with the SAME key after the refusal → placed", retry.ok);
  check("…three orders, stock 7", (await orderCount()) === 3 && (await stock()) === 7);

  // 5. An older client without a key keeps working (random ephemeral token).
  const legacy = await quick(undefined);
  check("key-less express submit → placed (legacy token)", legacy.ok && (await orderCount()) === 4);
}

async function main() {
  await cleanup();
  const saved = (
    await db.execute<{ value: string | null }>(sql`select value from site_settings where key = ${HOME_KEY}`)
  ).rows[0];
  try {
    await db.execute(
      sql`insert into site_settings (key, value, type, label) values (${HOME_KEY}, 'true', 'boolean', 'test')
          on conflict (key) do update set value = 'true'`,
    );
    pureMessages();
    await expressIdempotency();
  } finally {
    if (saved) {
      await db.execute(sql`update site_settings set value = ${saved.value} where key = ${HOME_KEY}`);
    } else {
      await db.execute(sql`delete from site_settings where key = ${HOME_KEY}`);
    }
    await cleanup();
  }

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
