import "server-only";

import { z } from "zod";

import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { fail, ok, workflow } from "../shared";

export const addAddressSchema = z.object({
  label: z.string().trim().max(40).optional(),
  fullName: z.string().trim().min(1, "Nom requis").max(120),
  company: z.string().trim().max(120).optional(),
  streetLine1: z.string().trim().min(1, "Adresse requise").max(200),
  streetLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1, "Ville requise").max(80),
  region: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().length(2).default("TN"),
  phone: z.string().trim().max(40).optional(),
  setAsDefaultShipping: z.boolean().optional().default(false),
  setAsDefaultBilling: z.boolean().optional().default(false),
});

export type AddAddressInput = z.input<typeof addAddressSchema>;

export const addAddressWorkflow = workflow<
  [AddAddressInput, { actorUserId: string }],
  { addressId: string }
>("customer.add_address", async (input, { actorUserId }) => {
  const parsed = addAddressSchema.safeParse(input);
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

  // Run the insert + default flag fix-ups inside a transaction so the
  // "only one default" invariant never has a window of inconsistency.
  const newId = await db.transaction(async (tx) => {
    // Insert as non-default first, then clear siblings and flip the flag on.
    // Inserting with the default flag already set would collide with the
    // existing default on the `addresses_one_default_*` partial unique index
    // (two `true` rows for the same profile) BEFORE the clear could run.
    const address = await customerService.insertAddress({
      customer_profile_id: link.customer_profile_id,
      label: d.label ?? null,
      full_name: d.fullName,
      company: d.company ?? null,
      street_line1: d.streetLine1,
      street_line2: d.streetLine2 ?? null,
      city: d.city,
      region: d.region ?? null,
      postal_code: d.postalCode ?? null,
      country: d.country,
      phone: d.phone ?? null,
      is_default_shipping: false,
      is_default_billing: false,
    }, tx);

    if (d.setAsDefaultShipping) {
      await customerService.clearDefaultShipping(link.customer_profile_id, address.id, tx);
      await customerService.updateAddress(address.id, { is_default_shipping: true }, tx);
    }
    if (d.setAsDefaultBilling) {
      await customerService.clearDefaultBilling(link.customer_profile_id, address.id, tx);
      await customerService.updateAddress(address.id, { is_default_billing: true }, tx);
    }

    return address.id;
  });

  await bus.emit(
    "address.created",
    { customerProfileId: link.customer_profile_id, addressId: newId },
    { actorUserId },
  );

  return ok({ addressId: newId });
});
