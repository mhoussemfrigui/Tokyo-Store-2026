import "server-only";

import { z } from "zod";

import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { fail, ok, workflow } from "../shared";

export const updateAddressSchema = z.object({
  addressId: z.string().uuid("Adresse invalide"),
  label: z.string().trim().max(40).optional().nullable(),
  fullName: z.string().trim().min(1).max(120).optional(),
  company: z.string().trim().max(120).optional().nullable(),
  streetLine1: z.string().trim().min(1).max(200).optional(),
  streetLine2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(1).max(80).optional(),
  region: z.string().trim().max(80).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().length(2).optional(),
  phone: z.string().trim().max(40).optional().nullable(),
  setAsDefaultShipping: z.boolean().optional(),
  setAsDefaultBilling: z.boolean().optional(),
});

export type UpdateAddressInput = z.input<typeof updateAddressSchema>;

export const updateAddressWorkflow = workflow<
  [UpdateAddressInput, { actorUserId: string }],
  { addressId: string }
>("customer.update_address", async (input, { actorUserId }) => {
  const parsed = updateAddressSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path[0]?.toString() ?? "form"] = issue.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }
  const d = parsed.data;

  const link = await customerUserLink.findByUserId(actorUserId);
  if (!link) return fail("not_found", "Profil introuvable.");

  const existing = await customerService.findAddressById(d.addressId);
  if (!existing || existing.customer_profile_id !== link.customer_profile_id) {
    return fail("not_found", "Adresse introuvable.");
  }

  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  const map: Record<string, string> = {
    label: "label",
    fullName: "full_name",
    company: "company",
    streetLine1: "street_line1",
    streetLine2: "street_line2",
    city: "city",
    region: "region",
    postalCode: "postal_code",
    country: "country",
    phone: "phone",
  };
  for (const [k, dbKey] of Object.entries(map)) {
    const v = (d as Record<string, unknown>)[k];
    if (v !== undefined) {
      patch[dbKey] = v;
      changed.push(dbKey);
    }
  }
  if (d.setAsDefaultShipping !== undefined) {
    patch.is_default_shipping = d.setAsDefaultShipping;
    changed.push("is_default_shipping");
  }
  if (d.setAsDefaultBilling !== undefined) {
    patch.is_default_billing = d.setAsDefaultBilling;
    changed.push("is_default_billing");
  }

  if (Object.keys(patch).length === 0) {
    return ok({ addressId: d.addressId });
  }

  await db.transaction(async (tx) => {
    // Clear the sibling defaults BEFORE writing this address as the default,
    // so we never hold two `true` rows at once (which would trip the
    // `addresses_one_default_*` partial unique index). `clearDefault*` excludes
    // this address, then the patch flips its flag on.
    if (d.setAsDefaultShipping === true) {
      await customerService.clearDefaultShipping(link.customer_profile_id, d.addressId, tx);
    }
    if (d.setAsDefaultBilling === true) {
      await customerService.clearDefaultBilling(link.customer_profile_id, d.addressId, tx);
    }
    await customerService.updateAddress(d.addressId, patch, tx);
  });

  await bus.emit(
    "address.updated",
    { customerProfileId: link.customer_profile_id, addressId: d.addressId, changedFields: changed },
    { actorUserId },
  );

  return ok({ addressId: d.addressId });
});
