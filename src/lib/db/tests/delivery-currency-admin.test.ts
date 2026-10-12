import "server-only";

/**
 * Delivery / payment admin write-path test (Commandes › Livraison, Réglages
 * commande, Paiement, Système › IA).
 *
 *   1. The shared admin money parser (`@/lib/checkout/money-input`) — the ONE
 *      rule both writers of the `checkout.delivery.*` fee/threshold keys apply:
 *      blank ⇒ null (inherit), "7,500" ⇒ 7500 millimes, negative / non-numeric /
 *      over-int4 ⇒ a French field error (never a silent null or a stored "-7").
 *   2. The delivery-zone workflows (`@/workflows/delivery/zone`): every write
 *      emits `delivery.zone.*` (audit + webhooks), an update saves the zone AND
 *      its courier rates in ONE transaction (a failing rate rolls the rename
 *      back), an unchanged save writes nothing and emits nothing.
 *   3. The payment / AI provider-settings workflows diff against the stored row:
 *      no warn « identifiants mis à jour » audit row for a save that changes
 *      nothing, test_mode listed only when it really flips.
 *
 * Self-cleaning (`__dcatest…` rows; the provider rows it touches are restored).
 * Run against an ISOLATED DB:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/delivery-currency-admin.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { deliveryService } from "@/modules/delivery";
import { currencyService } from "@/modules/currency/service";
import { currencies } from "@/modules/currency/schema";
import { payment_provider_settings } from "@/modules/payment/schema";
import { ai_provider_settings } from "@/modules/ai/schema";
import { AI_PROVIDER_IDS } from "@/lib/ai/providers";
import {
  INVALID_MONEY_MESSAGE,
  MAX_MONEY_MILLIMES,
  parseTndFields,
  parseTndInput,
} from "@/lib/checkout/money-input";
import {
  createDeliveryZoneWorkflow,
  deleteDeliveryZoneWorkflow,
  updateDeliveryZoneWorkflow,
} from "@/workflows/delivery/zone";
import { createDeliveryAgentWorkflow, updateDeliveryAgentWorkflow } from "@/workflows/delivery/agent";
import { createPickupLocationWorkflow, updatePickupLocationWorkflow } from "@/workflows/delivery/location";
import { upsertPaymentProviderSettingsWorkflow } from "@/workflows/payment/upsert-provider-settings";
import { upsertAiProviderSettingsWorkflow } from "@/workflows/ai/upsert-provider-settings";

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

/** Every event emitted during the test, in order (name + payload + actor). */
const emitted: Array<{ name: string; payload: Record<string, unknown>; actorUserId: string | null }> = [];
bus.onAny((env) => {
  emitted.push({
    name: env.name,
    payload: env.payload as Record<string, unknown>,
    actorUserId: env.actorUserId ?? null,
  });
});
const countOf = (name: string) => emitted.filter((e) => e.name === name).length;

async function cleanup() {
  await db.execute(
    sql`delete from delivery_agent_zone_rates where zone_id in (select id from delivery_zones where name like '__dcatest%')`,
  );
  await db.execute(sql`delete from delivery_zones where name like '__dcatest%'`);
  await db.execute(sql`delete from delivery_agents where name like '__dcatest%'`);
  await db.execute(sql`delete from pickup_locations where name like '__dcatest%'`);
  await db.execute(sql`delete from currencies where code like 'ZZC%'`);
}

// ── currencyService.setActive TOCTOU rollback (never zero active currency) ──
async function currencyActive() {
  // setActive deactivates every OTHER currency — capture the pre-existing active
  // one (if any) so we restore it after and don't disturb the shared test DB.
  const [prevActive] = await db.select({ id: currencies.id }).from(currencies).where(eq(currencies.is_active, true));
  const a = await currencyService.create({ code: "ZZCA", name: "ZZ A", symbol: "A", symbol_position: "after", decimals: 3 } as never);
  const b = await currencyService.create({ code: "ZZCB", name: "ZZ B", symbol: "B", symbol_position: "after", decimals: 3 } as never);
  const okA = await currencyService.setActive(a.id);
  check("currency setActive(A) returns true", okA === true);
  const activeAfterA = await db.select({ id: currencies.id, on: currencies.is_active }).from(currencies).where(eq(currencies.id, a.id));
  check("currency A is active", activeAfterA[0]?.on === true);
  // Activate a NON-EXISTENT id: the deactivate-all must roll back, leaving A active.
  const okGhost = await currencyService.setActive("00000000-0000-0000-0000-0000000000ff");
  check("currency setActive(ghost) returns false", okGhost === false);
  const stillA = await db.select({ on: currencies.is_active }).from(currencies).where(eq(currencies.id, a.id));
  check("A STILL active after failed setActive (rollback — never zero active)", stillA[0]?.on === true);
  const activeCount = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from currencies where is_active = true and code like 'ZZC%'`,
  );
  check("exactly one ZZ currency active (invariant held)", Number(activeCount.rows[0]?.n) === 1);
  void b;
  // Restore the DB's original active currency (setActive deactivated it).
  if (prevActive?.id) await currencyService.setActive(prevActive.id).catch(() => {});
}

// ── 1. money parser (pure) ──────────────────────────────────────────────────
function moneyInput() {
  const blank = parseTndInput("  ");
  check("money: blank ⇒ null (unset / inherit)", blank.ok && blank.millimes === null);
  const missing = parseTndInput(null);
  check("money: absent field ⇒ null", missing.ok && missing.millimes === null);
  const seven = parseTndInput("7");
  check("money: '7' ⇒ 7000 millimes", seven.ok && seven.millimes === 7000);
  const comma = parseTndInput("7,500");
  check("money: '7,500' (comma decimal) ⇒ 7500 millimes", comma.ok && comma.millimes === 7500);
  const zero = parseTndInput("0");
  check("money: '0' ⇒ 0 (free), not null", zero.ok && zero.millimes === 0);
  const negative = parseTndInput("-7");
  check("money: '-7' ⇒ refused with a French error", !negative.ok && /négatif/.test(negative.error));
  const junk = parseTndInput("abc");
  check("money: 'abc' ⇒ refused", !junk.ok);
  const huge = parseTndInput(String(MAX_MONEY_MILLIMES)); // dinars ⇒ ×1000 overflows int4
  check("money: an amount over the int4 column ceiling ⇒ refused", !huge.ok);

  const fields = parseTndFields(
    (n) => ({ fee: "5", threshold: "-1" })[n],
    ["fee", "threshold"] as const,
  );
  check(
    "money: parseTndFields keys the error by the form field name (whole save refused)",
    !fields.ok && Object.keys(fields.fieldErrors).join(",") === "threshold",
  );
  const allOk = parseTndFields((n) => ({ fee: "5", threshold: "" })[n], ["fee", "threshold"] as const);
  check(
    "money: parseTndFields returns millimes per field when all valid",
    allOk.ok && allOk.values.fee === 5000 && allOk.values.threshold === null,
  );
  check("money: the refusal banner is French", /montants/i.test(INVALID_MONEY_MESSAGE));
}

// ── 2. delivery-zone workflows (DB) ─────────────────────────────────────────
async function zones() {
  await cleanup();
  const actor = { actorUserId: null };
  const agent = await deliveryService.insertAgent({
    name: "__dcatest-courier",
    fee_cents: 7000,
    free_threshold_cents: null,
    enabled: true,
  } as never);

  // create → canonical governorates + delivery.zone.created
  const created = await createDeliveryZoneWorkflow(
    { name: "__dcatest-zone", governorates: "tunis, ARIANA, manouba", enabled: true, displayOrder: 0 },
    actor,
  );
  check("zone create → ok", created.ok);
  if (!created.ok) return;
  const zoneId = created.data.id;
  const row = await deliveryService.getZone(zoneId);
  check(
    "zone create canonicalizes the governorate list to the official names",
    row?.governorates === "Tunis, Ariana, La Manouba",
  );
  check(
    "zone create emits delivery.zone.created { zoneId, name }",
    emitted.some((e) => e.name === "delivery.zone.created" && e.payload.zoneId === zoneId && e.payload.name === "__dcatest-zone"),
  );

  // update rename + one courier rate → both saved + delivery.zone.updated
  const before = countOf("delivery.zone.updated");
  const updated = await updateDeliveryZoneWorkflow(
    {
      id: zoneId,
      name: "__dcatest-zone-grand-tunis",
      governorates: "Tunis, Ariana, La Manouba",
      enabled: true,
      displayOrder: 0,
      rates: [{ agentId: agent.id, feeCents: 5000, freeThresholdCents: 80000 }],
    },
    actor,
  );
  check(
    "zone update (rename + rate) → ok, changedFields = [name, rates]",
    updated.ok && updated.data.changedFields.join(",") === "name,rates",
  );
  const rate = await deliveryService.getAgentZoneRate(agent.id, zoneId);
  check("zone update stored the courier rate (5 TND, free ≥ 80 TND)", rate?.fee_cents === 5000 && rate.free_threshold_cents === 80000);
  const updEvent = emitted.filter((e) => e.name === "delivery.zone.updated").at(-1);
  check(
    "zone update emits delivery.zone.updated with the changed fields",
    countOf("delivery.zone.updated") === before + 1 &&
      updEvent?.payload.zoneId === zoneId &&
      JSON.stringify(updEvent.payload.changedFields) === JSON.stringify(["name", "rates"]),
  );

  // unchanged save → no write, no event
  const noop = await updateDeliveryZoneWorkflow(
    {
      id: zoneId,
      name: "__dcatest-zone-grand-tunis",
      governorates: "tunis, ariana, manouba", // canonicalizes to the stored value
      enabled: true,
      displayOrder: 0,
      rates: [{ agentId: agent.id, feeCents: 5000, freeThresholdCents: 80000 }],
    },
    actor,
  );
  check(
    "zone update with nothing changed → ok, changedFields [] and NO event",
    noop.ok && noop.data.changedFields.length === 0 && countOf("delivery.zone.updated") === before + 1,
  );

  // An amount over the integer column → clean validation, not a PG error.
  const overflow = await updateDeliveryZoneWorkflow(
    { id: zoneId, rates: [{ agentId: agent.id, feeCents: 3_000_000_000, freeThresholdCents: null }] },
    actor,
  );
  check("zone rate over the int4 ceiling → validation (never reaches Postgres)", !overflow.ok && overflow.error === "validation");

  // ATOMIC: a rename + a first rate written, then the SECOND rate write fails
  // (simulated outage) → the whole save rolls back.
  const secondAgent = await deliveryService.insertAgent({
    name: "__dcatest-courier-2",
    fee_cents: 6000,
    free_threshold_cents: null,
    enabled: true,
  } as never);
  const realSetRate = deliveryService.setAgentZoneRate.bind(deliveryService);
  let rateWrites = 0;
  deliveryService.setAgentZoneRate = async (...args: Parameters<typeof realSetRate>) => {
    rateWrites++;
    if (rateWrites === 2) throw new Error("simulated rate-write failure");
    return realSetRate(...args);
  };
  let atomic;
  try {
    atomic = await updateDeliveryZoneWorkflow(
      {
        id: zoneId,
        name: "__dcatest-zone-SHOULD-ROLL-BACK",
        rates: [
          { agentId: agent.id, feeCents: 9000, freeThresholdCents: null },
          { agentId: secondAgent.id, feeCents: 4000, freeThresholdCents: null },
        ],
      },
      actor,
    );
  } finally {
    deliveryService.setAgentZoneRate = realSetRate;
  }
  const afterFail = await deliveryService.getZone(zoneId);
  const rateAfterFail = await deliveryService.getAgentZoneRate(agent.id, zoneId);
  check("zone update whose 2nd rate write fails → refused (not ok)", rateWrites === 2 && !atomic.ok);
  check(
    "…and rolled back: zone NOT renamed, first rate NOT applied (one transaction)",
    afterFail?.name === "__dcatest-zone-grand-tunis" && rateAfterFail?.fee_cents === 5000,
  );
  check("…and no delivery.zone.updated emitted for the failed save", countOf("delivery.zone.updated") === before + 1);

  // PARTIAL update (rates only): the omitted fields are KEPT — zod 4 applies an
  // inner `.default()` under `.partial()`, which used to reset them.
  const cleared = await updateDeliveryZoneWorkflow(
    { id: zoneId, rates: [{ agentId: agent.id, feeCents: null, freeThresholdCents: null }] },
    actor,
  );
  const afterPartial = await deliveryService.getZone(zoneId);
  check(
    "zone update with fee null clears the courier override (changedFields [rates])",
    cleared.ok && cleared.data.changedFields.join(",") === "rates" &&
      (await deliveryService.getAgentZoneRate(agent.id, zoneId)) === null,
  );
  check(
    "…a rates-only update keeps the governorates / enabled / order untouched",
    afterPartial?.governorates === "Tunis, Ariana, La Manouba" && afterPartial.enabled === true &&
      afterPartial.name === "__dcatest-zone-grand-tunis",
  );

  // unknown zone / bad id
  const ghost = await updateDeliveryZoneWorkflow({ id: randomUUID(), name: "x" }, actor);
  check("update of an unknown zone → not_found", !ghost.ok && ghost.error === "not_found");
  const badId = await deleteDeliveryZoneWorkflow({ id: "not-a-uuid" }, actor);
  check("delete with a malformed id → validation (no PG error)", !badId.ok && badId.error === "validation");

  // ── AGENT partial-update safety (the zod-4 .partial()+default trap) ─────────
  // A name-only update must NOT reset the omitted fee/threshold/phone/zone/enabled/order.
  const agentCreated = await createDeliveryAgentWorkflow(
    {
      name: "__dcatest-agent-partial",
      feeCents: 7000,
      freeThresholdCents: 200000,
      phone: "20123456",
      zoneLabel: "Grand Tunis",
      enabled: false,
      displayOrder: 5,
    },
    actor,
  );
  check("agent create ok", agentCreated.ok);
  if (agentCreated.ok) {
    const aid = agentCreated.data.id;
    const upd = await updateDeliveryAgentWorkflow({ id: aid, name: "__dcatest-agent-partial-2" }, actor);
    const a = await deliveryService.getAgent(aid);
    check(
      "agent name-only update KEEPS fee/threshold/phone/zone/enabled/order (no partial-default reset)",
      upd.ok &&
        a?.name === "__dcatest-agent-partial-2" &&
        a?.fee_cents === 7000 &&
        a?.free_threshold_cents === 200000 &&
        a?.phone === "20123456" &&
        a?.zone_label === "Grand Tunis" &&
        a?.enabled === false &&
        a?.display_order === 5,
    );
  }

  // ── PICKUP LOCATION partial-update safety (same trap) ──────────────────────
  const locCreated = await createPickupLocationWorkflow(
    {
      name: "__dcatest-loc-partial",
      kind: "in_store",
      feeCents: 3000,
      addressLine: "12 Av. Habib Bourguiba",
      city: "Tunis",
      phone: "71000000",
      hoursLabel: "9h–18h",
      enabled: false,
      displayOrder: 4,
    },
    actor,
  );
  check("pickup create ok", locCreated.ok);
  if (locCreated.ok) {
    const lid = locCreated.data.id;
    const upd = await updatePickupLocationWorkflow({ id: lid, name: "__dcatest-loc-partial-2" }, actor);
    const l = await deliveryService.getPickup(lid);
    check(
      "pickup name-only update KEEPS fee/address/city/phone/hours/enabled/order (no partial-default reset)",
      upd.ok &&
        l?.name === "__dcatest-loc-partial-2" &&
        l?.fee_cents === 3000 &&
        l?.address_line === "12 Av. Habib Bourguiba" &&
        l?.city === "Tunis" &&
        l?.phone === "71000000" &&
        l?.hours_label === "9h–18h" &&
        l?.enabled === false &&
        l?.display_order === 4,
    );
  }

  // delete → rates + zone gone + delivery.zone.deleted
  await deliveryService.setAgentZoneRate(agent.id, zoneId, 4000, null);
  const deleted = await deleteDeliveryZoneWorkflow({ id: zoneId }, actor);
  check("zone delete → ok", deleted.ok);
  check(
    "zone delete removed the zone AND its courier rates",
    (await deliveryService.getZone(zoneId)) === null &&
      (await deliveryService.getAgentZoneRate(agent.id, zoneId)) === null,
  );
  check(
    "zone delete emits delivery.zone.deleted { zoneId, name }",
    emitted.some(
      (e) => e.name === "delivery.zone.deleted" && e.payload.zoneId === zoneId && e.payload.name === "__dcatest-zone-grand-tunis",
    ),
  );
  const again = await deleteDeliveryZoneWorkflow({ id: zoneId }, actor);
  check("deleting it again → not_found (no silent success)", !again.ok && again.error === "not_found");

  await cleanup();
}

// ── 3. provider-settings workflows diff (DB) ────────────────────────────────
async function providerSettings(actorUserId: string) {
  // Payment (ClicToPay): snapshot, run from "no row", restore.
  const [savedPay] = await db
    .select()
    .from(payment_provider_settings)
    .where(eq(payment_provider_settings.provider, "clictopay"));
  await db.delete(payment_provider_settings).where(eq(payment_provider_settings.provider, "clictopay"));
  try {
    const n0 = countOf("payment.provider_settings_updated");
    const same = await upsertPaymentProviderSettingsWorkflow(
      { provider: "clictopay", testMode: true, secrets: {} },
      { actorUserId },
    );
    const [noRow] = await db
      .select()
      .from(payment_provider_settings)
      .where(eq(payment_provider_settings.provider, "clictopay"));
    check(
      "payment: sandbox ON (= the default) + no secret → no write, no audit event",
      same.ok && same.data.changedFields.length === 0 && !noRow &&
        countOf("payment.provider_settings_updated") === n0,
    );

    const flip = await upsertPaymentProviderSettingsWorkflow(
      { provider: "clictopay", testMode: false, secrets: { username: "   " } },
      { actorUserId },
    );
    const [prodRow] = await db
      .select()
      .from(payment_provider_settings)
      .where(eq(payment_provider_settings.provider, "clictopay"));
    const flipEvent = emitted.filter((e) => e.name === "payment.provider_settings_updated").at(-1);
    check(
      "payment: sandbox → production is written and audited as [test_mode] only (blank secret ignored)",
      flip.ok && prodRow?.test_mode === false &&
        countOf("payment.provider_settings_updated") === n0 + 1 &&
        JSON.stringify(flipEvent?.payload.changedFields) === JSON.stringify(["test_mode"]) &&
        flipEvent?.actorUserId === actorUserId,
    );

    const again = await upsertPaymentProviderSettingsWorkflow(
      { provider: "clictopay", testMode: false, secrets: {} },
      { actorUserId },
    );
    const untouched = await upsertPaymentProviderSettingsWorkflow(
      { provider: "clictopay", testMode: undefined, secrets: {} },
      { actorUserId },
    );
    check(
      "payment: re-saving the same sandbox value (or none) → no event (no audit noise)",
      again.ok && untouched.ok && countOf("payment.provider_settings_updated") === n0 + 1,
    );
  } finally {
    await db.delete(payment_provider_settings).where(eq(payment_provider_settings.provider, "clictopay"));
    if (savedPay) await db.insert(payment_provider_settings).values(savedPay);
  }

  // AI: snapshot one provider, run, restore.
  const aiProvider = AI_PROVIDER_IDS[0];
  const [savedAi] = await db
    .select()
    .from(ai_provider_settings)
    .where(eq(ai_provider_settings.provider, aiProvider));
  await db.delete(ai_provider_settings).where(eq(ai_provider_settings.provider, aiProvider));
  try {
    const a0 = countOf("ai.provider_settings_updated");
    const first = await upsertAiProviderSettingsWorkflow(
      { provider: aiProvider, baseUrl: "", defaultModel: "", enabled: false },
      { actorUserId },
    );
    const [firstRow] = await db
      .select()
      .from(ai_provider_settings)
      .where(eq(ai_provider_settings.provider, aiProvider));
    check(
      "ai: with NO row the first save still writes it (enabled:false can override an env key)",
      first.ok && firstRow?.enabled === false,
    );
    const a1 = countOf("ai.provider_settings_updated");
    const unchanged = await upsertAiProviderSettingsWorkflow(
      { provider: aiProvider, baseUrl: "", defaultModel: "", enabled: false },
      { actorUserId },
    );
    check(
      "ai: an unchanged save of an existing row → no event (was one warn row per provider per save)",
      unchanged.ok && unchanged.data.changedFields.length === 0 && countOf("ai.provider_settings_updated") === a1,
    );
    const model = await upsertAiProviderSettingsWorkflow(
      { provider: aiProvider, baseUrl: "", defaultModel: "__dcatest-model", enabled: false },
      { actorUserId },
    );
    const modelEvent = emitted.filter((e) => e.name === "ai.provider_settings_updated").at(-1);
    check(
      "ai: a real change is written + audited with exactly that field",
      model.ok && countOf("ai.provider_settings_updated") === a1 + 1 &&
        JSON.stringify(modelEvent?.payload.changedFields) === JSON.stringify(["default_model"]) &&
        a1 >= a0,
    );
  } finally {
    await db.delete(ai_provider_settings).where(eq(ai_provider_settings.provider, aiProvider));
    if (savedAi) await db.insert(ai_provider_settings).values(savedAi);
  }
}

async function main() {
  moneyInput();
  await zones();
  // The actor only rides in the emit meta here (no audit subscriber is loaded).
  const actorUserId = `__dcatest-actor-${randomUUID()}`;
  await providerSettings(actorUserId);
  await currencyActive();

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
