import "server-only";

import { z } from "zod";

import { deliveryService } from "@/modules/delivery";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * Delivery-agent workflows — CRUD on home-delivery couriers
 * (`delivery_agents`). An agent optionally overrides the global home-delivery
 * base rate: `feeCents` / `freeThresholdCents` are NULLABLE and NULL means
 * "inherit the global checkout.delivery.* base" (the authoritative resolver in
 * `@/lib/checkout/delivery` applies that inheritance + the free-threshold).
 *
 * Money is integer millimes throughout — the admin enters dinars and the
 * caller (`@/lib/actions/delivery`) converts to millimes via `dinarsToMinor`
 * BEFORE calling these, so the workflow stays in canonical storage units.
 */

// Field shapes WITHOUT defaults. Defaults live only on the create schema below:
// zod 4 applies an inner `.default()` even under `.partial()`, so an update schema
// built from a defaulted create schema would silently RESET an omitted field
// (re-enable a disabled courier, blank its fee/phone/zone, reset order) on a partial
// patch. Mirrors the same guard in zone.ts.
const agentFields = {
  name: z.string().trim().min(1).max(120),
  // NULL = inherit the global base fee. >= 0 millimes otherwise.
  feeCents: z.number().int().min(0).nullable(),
  // NULL = inherit the global threshold; 0 = never free. >= 0 millimes.
  freeThresholdCents: z.number().int().min(0).nullable(),
  phone: z.string().trim().max(40).nullable(),
  zoneLabel: z.string().trim().max(120).nullable(),
  enabled: z.boolean(),
  displayOrder: z.number().int().min(0),
};

const createAgentSchema = z.object({
  ...agentFields,
  feeCents: agentFields.feeCents.default(null),
  freeThresholdCents: agentFields.freeThresholdCents.default(null),
  phone: agentFields.phone.default(null),
  zoneLabel: agentFields.zoneLabel.default(null),
  enabled: agentFields.enabled.default(true),
  displayOrder: agentFields.displayOrder.default(0),
});

export const createDeliveryAgentWorkflow = workflow<
  [z.input<typeof createAgentSchema>, { actorUserId?: string | null }],
  { id: string }
>("delivery.agent.create", async (input, { actorUserId } = {}) => {
  const parsed = createAgentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const d = parsed.data;
  const row = await deliveryService.insertAgent({
    name: d.name,
    fee_cents: d.feeCents,
    free_threshold_cents: d.freeThresholdCents,
    phone: d.phone,
    zone_label: d.zoneLabel,
    enabled: d.enabled,
    display_order: d.displayOrder,
  });
  await bus.emit("delivery.agent.created", { agentId: row.id, name: d.name }, { actorUserId });
  return ok({ id: row.id });
});

const updateAgentSchema = z
  .object(agentFields)
  .partial()
  .extend({ id: z.string().uuid() });

export const updateDeliveryAgentWorkflow = workflow<
  [z.input<typeof updateAgentSchema>, { actorUserId?: string | null }],
  { id: string }
>("delivery.agent.update", async (input, { actorUserId } = {}) => {
  const parsed = updateAgentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const d = parsed.data;

  const patch: Parameters<typeof deliveryService.updateAgent>[1] = {};
  if (d.name !== undefined) patch.name = d.name;
  if (d.feeCents !== undefined) patch.fee_cents = d.feeCents;
  if (d.freeThresholdCents !== undefined) patch.free_threshold_cents = d.freeThresholdCents;
  if (d.phone !== undefined) patch.phone = d.phone;
  if (d.zoneLabel !== undefined) patch.zone_label = d.zoneLabel;
  if (d.enabled !== undefined) patch.enabled = d.enabled;
  if (d.displayOrder !== undefined) patch.display_order = d.displayOrder;

  if (Object.keys(patch).length === 0) return ok({ id: d.id });
  await deliveryService.updateAgent(d.id, patch);
  await bus.emit("delivery.agent.updated", {
    agentId: d.id,
    changedFields: Object.keys(patch),
  }, { actorUserId });
  return ok({ id: d.id });
});

export const deleteDeliveryAgentWorkflow = workflow<
  [{ id: string }, { actorUserId?: string | null }],
  { id: string }
>("delivery.agent.delete", async ({ id }, { actorUserId } = {}) => {
  await deliveryService.deleteAgent(id);
  await bus.emit("delivery.agent.deleted", { agentId: id }, { actorUserId });
  return ok({ id });
});
