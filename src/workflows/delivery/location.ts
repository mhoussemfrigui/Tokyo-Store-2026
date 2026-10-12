import "server-only";

import { z } from "zod";

import { deliveryService } from "@/modules/delivery";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * Pickup-location workflows — CRUD on drive-by + in-store points
 * (`pickup_locations`). `kind` ("drive_by_pickup" | "in_store") matches the
 * `delivery_method` the location serves, and `feeCents` is a FLAT fee (no
 * free-threshold — that applies to home delivery only).
 *
 * Money is integer millimes: the admin enters dinars and the caller
 * (`@/lib/actions/delivery`) converts via `dinarsToMinor` before calling here.
 */

const pickupKindSchema = z.enum(["drive_by_pickup", "in_store"]);

// Field shapes WITHOUT defaults — defaults live only on the create schema below.
// zod 4 applies an inner `.default()` even under `.partial()`, so an update schema
// built from a defaulted create schema would silently RESET an omitted field on a
// partial patch (see agent.ts / zone.ts for the same guard).
const locationFields = {
  name: z.string().trim().min(1).max(120),
  kind: pickupKindSchema,
  // Flat pickup fee, millimes. 0 = free.
  feeCents: z.number().int().min(0),
  addressLine: z.string().trim().max(240).nullable(),
  city: z.string().trim().max(120).nullable(),
  region: z.string().trim().max(120).nullable(),
  phone: z.string().trim().max(40).nullable(),
  hoursLabel: z.string().trim().max(160).nullable(),
  enabled: z.boolean(),
  displayOrder: z.number().int().min(0),
};

const createLocationSchema = z.object({
  ...locationFields,
  feeCents: locationFields.feeCents.default(0),
  addressLine: locationFields.addressLine.default(null),
  city: locationFields.city.default(null),
  region: locationFields.region.default(null),
  phone: locationFields.phone.default(null),
  hoursLabel: locationFields.hoursLabel.default(null),
  enabled: locationFields.enabled.default(true),
  displayOrder: locationFields.displayOrder.default(0),
});

export const createPickupLocationWorkflow = workflow<
  [z.input<typeof createLocationSchema>, { actorUserId?: string | null }],
  { id: string }
>("delivery.location.create", async (input, { actorUserId } = {}) => {
  const parsed = createLocationSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const d = parsed.data;
  const row = await deliveryService.insertPickup({
    name: d.name,
    kind: d.kind,
    fee_cents: d.feeCents,
    address_line: d.addressLine,
    city: d.city,
    region: d.region,
    phone: d.phone,
    hours_label: d.hoursLabel,
    enabled: d.enabled,
    display_order: d.displayOrder,
  });
  await bus.emit("delivery.location.created", { locationId: row.id, name: d.name }, { actorUserId });
  return ok({ id: row.id });
});

const updateLocationSchema = z
  .object(locationFields)
  .partial()
  .extend({ id: z.string().uuid() });

export const updatePickupLocationWorkflow = workflow<
  [z.input<typeof updateLocationSchema>, { actorUserId?: string | null }],
  { id: string }
>("delivery.location.update", async (input, { actorUserId } = {}) => {
  const parsed = updateLocationSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const d = parsed.data;

  const patch: Parameters<typeof deliveryService.updatePickup>[1] = {};
  if (d.name !== undefined) patch.name = d.name;
  if (d.kind !== undefined) patch.kind = d.kind;
  if (d.feeCents !== undefined) patch.fee_cents = d.feeCents;
  if (d.addressLine !== undefined) patch.address_line = d.addressLine;
  if (d.city !== undefined) patch.city = d.city;
  if (d.region !== undefined) patch.region = d.region;
  if (d.phone !== undefined) patch.phone = d.phone;
  if (d.hoursLabel !== undefined) patch.hours_label = d.hoursLabel;
  if (d.enabled !== undefined) patch.enabled = d.enabled;
  if (d.displayOrder !== undefined) patch.display_order = d.displayOrder;

  if (Object.keys(patch).length === 0) return ok({ id: d.id });
  await deliveryService.updatePickup(d.id, patch);
  await bus.emit("delivery.location.updated", {
    locationId: d.id,
    changedFields: Object.keys(patch),
  }, { actorUserId });
  return ok({ id: d.id });
});

export const deletePickupLocationWorkflow = workflow<
  [{ id: string }, { actorUserId?: string | null }],
  { id: string }
>("delivery.location.delete", async ({ id }, { actorUserId } = {}) => {
  await deliveryService.deletePickup(id);
  await bus.emit("delivery.location.deleted", { locationId: id }, { actorUserId });
  return ok({ id });
});
