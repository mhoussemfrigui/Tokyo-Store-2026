import "server-only";

import { z } from "zod";

import { db } from "@/lib/db/client";
import { deliveryService } from "@/modules/delivery";
import { canonicalizeGovernorateList } from "@/lib/checkout/delivery-fee";
import { MAX_MONEY_MILLIMES } from "@/lib/checkout/money-input";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * Delivery-zone workflows — CRUD on the region-pricing zones
 * (`delivery_zones`, governorate groups) and their per-courier rates
 * (`delivery_agent_zone_rates`). Zone rates decide what a customer is charged
 * when « Tarification par région » is on, so every write here is
 * money-affecting config: it emits `delivery.zone.*` (actor in the emit meta →
 * audit trail + outbound webhooks) exactly like the agent / location workflows.
 *
 * An update saves the zone row AND its courier rates in ONE transaction, so a
 * failed save can never leave the zone renamed with only some rates applied.
 *
 * Money is integer millimes: the admin enters dinars and the caller
 * (`@/lib/actions/delivery`) converts + validates via `parseTndInput` first.
 */

const zoneFields = {
  name: z.string().trim().min(1).max(120),
  // Free-text, comma-separated gouvernorats — canonicalized below so the zone
  // matches the exact names the storefront governorate picker submits.
  governorates: z.string().max(2000),
  enabled: z.boolean(),
  displayOrder: z.number().int().min(0),
};

// Defaults ONLY on create: zod 4 applies an inner `.default()` even under
// `.partial()`, so an update schema built from these would silently reset an
// omitted governorate list / enabled flag / order on a partial update.
const createZoneSchema = z.object({
  ...zoneFields,
  governorates: zoneFields.governorates.default(""),
  enabled: zoneFields.enabled.default(true),
  displayOrder: zoneFields.displayOrder.default(0),
});

export const createDeliveryZoneWorkflow = workflow<
  [z.input<typeof createZoneSchema>, { actorUserId?: string | null }],
  { id: string }
>("delivery.zone.create", async (input, { actorUserId } = {}) => {
  const parsed = createZoneSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const d = parsed.data;
  const row = await deliveryService.insertZone({
    name: d.name,
    governorates: canonicalizeGovernorateList(d.governorates),
    enabled: d.enabled,
    display_order: d.displayOrder,
  });
  await bus.emit("delivery.zone.created", { zoneId: row.id, name: row.name }, { actorUserId });
  return ok({ id: row.id });
});

/** One courier × zone rate. `feeCents: null` clears the override (flat fee applies). */
const zoneRateSchema = z.object({
  agentId: z.string().uuid(),
  // Bounded by the `integer` fee columns (an overflow is a clean validation
  // error, not a Postgres out-of-range failure).
  feeCents: z.number().int().min(0).max(MAX_MONEY_MILLIMES).nullable(),
  // NULL = inherit the courier / global free threshold.
  freeThresholdCents: z.number().int().min(0).max(MAX_MONEY_MILLIMES).nullable(),
});

const updateZoneSchema = z
  .object(zoneFields)
  .partial()
  .extend({
    id: z.string().uuid(),
    rates: z.array(zoneRateSchema).max(500).optional(),
  });

export const updateDeliveryZoneWorkflow = workflow<
  [z.input<typeof updateZoneSchema>, { actorUserId?: string | null }],
  { id: string; changedFields: string[] }
>("delivery.zone.update", async (input, { actorUserId } = {}) => {
  const parsed = updateZoneSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const d = parsed.data;

  const existing = await deliveryService.getZone(d.id);
  if (!existing) return fail("not_found", "Zone introuvable (elle a peut-être été supprimée).");

  // Diff against the stored row so the audit row names what really changed and
  // an unchanged save writes nothing (no audit noise).
  const patch: Parameters<typeof deliveryService.updateZone>[1] = {};
  if (d.name !== undefined && d.name !== existing.name) patch.name = d.name;
  if (d.governorates !== undefined) {
    const governorates = canonicalizeGovernorateList(d.governorates);
    if (governorates !== existing.governorates) patch.governorates = governorates;
  }
  if (d.enabled !== undefined && d.enabled !== existing.enabled) patch.enabled = d.enabled;
  if (d.displayOrder !== undefined && d.displayOrder !== existing.display_order) {
    patch.display_order = d.displayOrder;
  }

  // Only the rates that actually differ from what's stored for this zone.
  const storedRates = new Map(
    (await deliveryService.listRates())
      .filter((r) => r.zone_id === d.id)
      .map((r) => [r.agent_id, r]),
  );
  const seen = new Set<string>();
  const rateWrites = (d.rates ?? []).filter((r) => {
    if (seen.has(r.agentId)) return false;
    seen.add(r.agentId);
    const stored = storedRates.get(r.agentId);
    if (r.feeCents == null) return Boolean(stored); // clear an existing override
    return (
      !stored ||
      stored.fee_cents !== r.feeCents ||
      (stored.free_threshold_cents ?? null) !== r.freeThresholdCents
    );
  });

  const changedFields = [
    ...Object.keys(patch),
    ...(rateWrites.length > 0 ? ["rates"] : []),
  ];
  if (changedFields.length === 0) return ok({ id: d.id, changedFields });

  const row = await db.transaction(async (tx) => {
    const updated =
      Object.keys(patch).length > 0 ? await deliveryService.updateZone(d.id, patch, tx) : existing;
    if (!updated) return null; // deleted concurrently — write no orphan rates
    for (const r of rateWrites) {
      await deliveryService.setAgentZoneRate(r.agentId, d.id, r.feeCents, r.freeThresholdCents, tx);
    }
    return updated;
  });
  if (!row) return fail("not_found", "Zone introuvable (elle a peut-être été supprimée).");

  await bus.emit(
    "delivery.zone.updated",
    { zoneId: d.id, name: row.name, changedFields },
    { actorUserId },
  );
  return ok({ id: d.id, changedFields });
});

export const deleteDeliveryZoneWorkflow = workflow<
  [{ id: string }, { actorUserId?: string | null }],
  { id: string }
>("delivery.zone.delete", async ({ id }, { actorUserId } = {}) => {
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation", "Identifiant de zone invalide.");
  }
  const existing = await deliveryService.getZone(id);
  if (!existing) return fail("not_found", "Zone introuvable (elle a peut-être déjà été supprimée).");
  // Rates + zone row in one transaction (the service deletes rates first).
  await db.transaction(async (tx) => {
    await deliveryService.deleteZone(id, tx);
  });
  await bus.emit("delivery.zone.deleted", { zoneId: id, name: existing.name }, { actorUserId });
  return ok({ id });
});
