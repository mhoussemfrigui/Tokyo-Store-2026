import "server-only";

/**
 * Delivery region-pricing resolver test. Verifies resolveDelivery's zone branch:
 * OFF ⇒ courier flat fee (region ignored); ON ⇒ the courier's per-zone rate when
 * the gouvernorat maps to a zone with a rate, else the flat fee; plus the
 * per-zone free-shipping threshold. Also pins the NEVER-RE-ROUTED contract: a
 * disabled method or a stale / invalid pickup point is refused with a typed
 * `DeliveryUnavailable` (never silently turned into a home delivery), and a
 * pickup method with NO point (caisse counter sale) keeps its method at fee 0.
 * Self-cleaning (`__dztest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/delivery-zone.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { deliveryService } from "@/modules/delivery";
import {
  resolveDelivery,
  listDeliveryOptions,
  buildRegionAgentFeeIndex,
  type DeliveryResolution,
} from "@/lib/checkout/delivery";
import { zoneHomeAgentFee } from "@/lib/checkout/delivery-fee";
import { previewShipping } from "@/lib/checkout/shipping";

/** The charged fee of a SUCCESSFUL resolution (NaN when refused ⇒ any fee check fails). */
function fee(r: DeliveryResolution): number {
  return r.ok ? r.shippingCents : Number.NaN;
}

/** The courier agent option's DISPLAYED fee from the checkout selector. */
async function displayedAgentFee(
  agentId: string,
  region: string,
  subtotalCents: number,
): Promise<number | undefined> {
  const opts = await listDeliveryOptions(subtotalCents, region);
  return opts.home.find((o) => o.id === agentId)?.feeCents;
}

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

async function setBoolSetting(key: string, on: boolean) {
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values (${key}, ${on ? "true" : "false"}, 'boolean', 'test')
        on conflict (key) do update set value = ${on ? "true" : "false"}`,
  );
}

async function setZonePricing(on: boolean) {
  await setBoolSetting("delivery.zone_pricing_enabled", on);
}

const METHOD_KEYS = ["delivery.home_enabled", "delivery.drive_by_enabled", "delivery.in_store_enabled"];

async function cleanup() {
  await db.execute(sql`delete from delivery_agent_zone_rates where agent_id in (select id from delivery_agents where name like '__dztest%')`);
  await db.execute(sql`delete from delivery_zones where name like '__dztest%'`);
  await db.execute(sql`delete from delivery_agents where name like '__dztest%'`);
  await db.execute(sql`delete from pickup_locations where name like '__dztest%'`);
  await db.execute(sql`delete from site_settings where key = 'delivery.zone_pricing_enabled'`);
}

/** Snapshot of the three method toggles, restored after the contract checks so a
 *  dev DB's real delivery config is never left altered. */
async function readMethodSettings(): Promise<Map<string, string | null>> {
  const rows = await db.execute<{ key: string; value: string | null }>(
    sql`select key, value from site_settings where key in ('delivery.home_enabled', 'delivery.drive_by_enabled', 'delivery.in_store_enabled')`,
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}

async function restoreMethodSettings(saved: Map<string, string | null>) {
  for (const key of METHOD_KEYS) {
    if (saved.has(key)) {
      await db.execute(sql`update site_settings set value = ${saved.get(key) ?? null} where key = ${key}`);
    } else {
      await db.execute(sql`delete from site_settings where key = ${key}`);
    }
  }
}

async function main() {
  await cleanup();

  const agent = await deliveryService.insertAgent({
    name: "__dztest-courier",
    fee_cents: 7000, // flat fee
    free_threshold_cents: null,
    enabled: true,
  } as never);
  const zone = await deliveryService.insertZone({
    name: "__dztest-sud",
    governorates: "Sfax, Gabes",
    enabled: true,
  } as never);
  await deliveryService.setAgentZoneRate(agent.id, zone.id, 5000, null); // zone rate 5 TND

  const baseInput = { method: "home_delivery", agentId: agent.id, subtotalCents: 100000 };

  // 1) Pricing OFF → flat fee, region ignored.
  await setZonePricing(false);
  const off = await resolveDelivery({ ...baseInput, region: "Sfax" });
  check("pricing OFF → flat courier fee", fee(off) === 7000);

  // 2) Pricing ON + region in zone + rate → zone rate.
  await setZonePricing(true);
  const on = await resolveDelivery({ ...baseInput, region: "Sfax" });
  check("pricing ON + zone rate → zone fee", fee(on) === 5000);

  // 2b) DISPLAY == CHARGE: the checkout selector must SHOW exactly what
  // resolveDelivery will CHARGE for the same (agent, region, subtotal). This is
  // the mismatch this fix closed — the selector used to show the flat 7000.
  const shown = await displayedAgentFee(agent.id, "Sfax", 100000);
  check("listDeliveryOptions shows the zone fee (matches charge)", shown === fee(on));
  // The client index + pure helper must agree (case-insensitive region).
  const index = await buildRegionAgentFeeIndex();
  const viaIndex = zoneHomeAgentFee(index, "SFAX", agent.id, 100000);
  check("zoneHomeAgentFee (client) matches charge, case-insensitive", viaIndex?.feeCents === fee(on));

  // 3) Pricing ON + region NOT in any zone → flat fee.
  const noZone = await resolveDelivery({ ...baseInput, region: "Bizerte" });
  check("pricing ON + region with no zone → flat fee", fee(noZone) === 7000);

  // 4) Pricing ON + zone exists but agent has NO rate → flat fee.
  const otherZone = await deliveryService.insertZone({ name: "__dztest-nord", governorates: "Bizerte", enabled: true } as never);
  void otherZone;
  const zoneNoRate = await resolveDelivery({ ...baseInput, region: "Bizerte" });
  check("pricing ON + zone without this courier's rate → flat fee", fee(zoneNoRate) === 7000);

  // 5) Per-zone free-shipping threshold zeros the fee.
  await deliveryService.setAgentZoneRate(agent.id, zone.id, 5000, 50000); // free ≥ 50 TND
  const free = await resolveDelivery({ ...baseInput, region: "Sfax" }); // subtotal 100 TND ≥ 50
  check("zone free-threshold reached → 0", fee(free) === 0);
  check(
    "display matches charge at free-threshold (0)",
    (await displayedAgentFee(agent.id, "Sfax", 100000)) === fee(free),
  );
  const below = await resolveDelivery({ method: "home_delivery", agentId: agent.id, subtotalCents: 30000, region: "Sfax" });
  check("below zone free-threshold → zone fee", fee(below) === 5000);
  check(
    "display matches charge below free-threshold (zone fee)",
    (await displayedAgentFee(agent.id, "Sfax", 30000)) === fee(below),
  );
  // No-zone region: both display and charge fall back to the flat courier fee.
  check(
    "display matches charge for a no-zone region (flat fallback)",
    (await displayedAgentFee(agent.id, "Bizerte", 30000)) ===
      fee(await resolveDelivery({ method: "home_delivery", agentId: agent.id, subtotalCents: 30000, region: "Bizerte" })),
  );

  // 6) ACCENT-insensitive matching: a zone configured with the UNACCENTED name
  // "Beja" must be hit by the accented canonical region "Béja" that the
  // storefront governorate picker submits (and vice-versa).
  const accentZone = await deliveryService.insertZone({ name: "__dztest-nord-ouest", governorates: "Beja, Jendouba", enabled: true } as never);
  await deliveryService.setAgentZoneRate(agent.id, accentZone.id, 8000, null);
  const accented = await resolveDelivery({ method: "home_delivery", agentId: agent.id, subtotalCents: 30000, region: "Béja" });
  check("accented region 'Béja' matches zone configured 'Beja'", fee(accented) === 8000);
  check(
    "display matches charge for the accented region",
    (await displayedAgentFee(agent.id, "Béja", 30000)) === fee(accented),
  );

  // 7) NEVER-RE-ROUTED contract (a disabled method / stale pickup is refused, a
  // point-less pickup keeps its method even with the method toggle off). All
  // three methods ON to start.
  const savedMethods = await readMethodSettings();
  try {
    for (const key of METHOD_KEYS) await setBoolSetting(key, true);
    const store = await deliveryService.insertPickup({
      name: "__dztest-boutique",
      kind: "in_store",
      fee_cents: 2000,
      address_line: "1 rue du Lac",
      city: "Tunis",
      enabled: true,
    } as never);
    const disabledStore = await deliveryService.insertPickup({
      name: "__dztest-boutique-off",
      kind: "in_store",
      fee_cents: 0,
      enabled: false,
    } as never);

    // Valid pickup → its flat fee + snapshot, method kept.
    const pick = await resolveDelivery({ method: "in_store", pickupLocationId: store.id, subtotalCents: 30000 });
    check(
      "valid in-store point → in_store + its fee + name snapshot",
      pick.ok && pick.deliveryMethod === "in_store" && pick.shippingCents === 2000 &&
        pick.pickupLocationId === store.id && pick.pickupLocationName === "__dztest-boutique",
    );

    // Pickup with NO point (caisse counter sale) → method kept, fee 0, no snapshot.
    const counter = await resolveDelivery({ method: "in_store", subtotalCents: 30000 });
    check(
      "in_store without a point → in_store, fee 0, no location (not home_delivery)",
      counter.ok && counter.deliveryMethod === "in_store" && counter.shippingCents === 0 &&
        counter.pickupLocationId === null && counter.pickupLocationName === null,
    );

    // Disabled / unknown / wrong-kind point → REFUSED, never re-routed to home.
    const off1 = await resolveDelivery({ method: "in_store", pickupLocationId: disabledStore.id, subtotalCents: 30000 });
    check("disabled pickup point → refused (pickup_unavailable)", !off1.ok && off1.reason === "pickup_unavailable");
    const wrongKind = await resolveDelivery({ method: "drive_by_pickup", pickupLocationId: store.id, subtotalCents: 30000 });
    check("in-store point used as drive-by → refused (pickup_unavailable)", !wrongKind.ok && wrongKind.reason === "pickup_unavailable");
    const ghost = await resolveDelivery({
      method: "in_store",
      pickupLocationId: "00000000-0000-4000-8000-000000000000",
      subtotalCents: 30000,
    });
    check("unknown pickup point → refused with a French message", !ghost.ok && /retrait/i.test(ghost.message));

    // Unknown method string → refused.
    const junk = await resolveDelivery({ method: "teleport", subtotalCents: 30000 });
    check("unknown method → refused (unknown_method)", !junk.ok && junk.reason === "unknown_method");

    // Home enabled: base path is exactly previewShipping; an unknown courier
    // falls back to the base (same method) — never refused.
    const expectedBase = (await previewShipping(30000)).shippingCents;
    const homeBase = await resolveDelivery({ method: "home_delivery", subtotalCents: 30000 });
    check(
      "home, no agent → exactly previewShipping",
      homeBase.ok && homeBase.deliveryMethod === "home_delivery" && homeBase.shippingCents === expectedBase,
    );
    const absent = await resolveDelivery({ subtotalCents: 30000 });
    check("absent method → home delivery base", absent.ok && absent.deliveryMethod === "home_delivery");
    const ghostAgent = await resolveDelivery({
      method: "home_delivery",
      agentId: "00000000-0000-4000-8000-000000000000",
      subtotalCents: 30000,
    });
    check(
      "unknown courier → home base (method kept)",
      ghostAgent.ok && ghostAgent.deliveryAgentId === null && ghostAgent.shippingCents === expectedBase,
    );

    // Home DISABLED → home refused; a stale pickup is refused too (never home).
    await setBoolSetting("delivery.home_enabled", false);
    const homeOff = await resolveDelivery({ method: "home_delivery", subtotalCents: 30000 });
    check("home disabled + home_delivery → refused (method_disabled)", !homeOff.ok && homeOff.reason === "method_disabled");
    const homeOffAgent = await resolveDelivery({ method: "home_delivery", agentId: agent.id, subtotalCents: 30000 });
    check("home disabled + courier → refused", !homeOffAgent.ok);
    const homeOffStale = await resolveDelivery({ method: "in_store", pickupLocationId: disabledStore.id, subtotalCents: 30000 });
    check("home disabled + stale pickup → refused, not home", !homeOffStale.ok && homeOffStale.reason === "pickup_unavailable");
    const homeOffPickup = await resolveDelivery({ method: "in_store", pickupLocationId: store.id, subtotalCents: 30000 });
    check("home disabled + valid pickup → still honoured", homeOffPickup.ok && homeOffPickup.deliveryMethod === "in_store");

    // Pickup method DISABLED (the storefront « Retrait en magasin » toggle):
    // a point-less counter sale (the caisse) still goes through — the till has
    // no picker and must not be blocked — but a pickup AT a point is refused.
    await setBoolSetting("delivery.in_store_enabled", false);
    const inStoreOff = await resolveDelivery({ method: "in_store", subtotalCents: 30000 });
    check(
      "in_store disabled + no point (counter sale) → in_store, fee 0",
      inStoreOff.ok && inStoreOff.deliveryMethod === "in_store" && inStoreOff.shippingCents === 0,
    );
    const inStoreOffPoint = await resolveDelivery({ method: "in_store", pickupLocationId: store.id, subtotalCents: 30000 });
    check(
      "in_store disabled + a point → refused (method_disabled)",
      !inStoreOffPoint.ok && inStoreOffPoint.reason === "method_disabled",
    );
  } finally {
    await restoreMethodSettings(savedMethods);
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
