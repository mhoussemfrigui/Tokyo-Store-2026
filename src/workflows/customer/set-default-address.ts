import "server-only";

import { z } from "zod";

import { customerService } from "@/modules/customer/service";
import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { fail, ok, workflow } from "../shared";

/**
 * Admin-side "set default" for a customer's address. The customer-side
 * version is bundled inside `updateAddress`, but the admin acts on someone
 * else's profile so we go through profileId rather than the linked user.
 */
export const setDefaultAddressSchema = z.object({
  customerProfileId: z.string().uuid(),
  addressId: z.string().uuid(),
  kind: z.enum(["billing", "shipping"]),
});

export const setDefaultAddressWorkflow = workflow<
  [z.input<typeof setDefaultAddressSchema>, { actorUserId: string }],
  { addressId: string }
>("customer.set_default_address", async (input, { actorUserId }) => {
  const parsed = setDefaultAddressSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Données invalides.");
  const { customerProfileId, addressId, kind } = parsed.data;

  const existing = await customerService.findAddressById(addressId);
  if (!existing || existing.customer_profile_id !== customerProfileId) {
    return fail("not_found", "Adresse introuvable.");
  }

  await db.transaction(async (tx) => {
    if (kind === "shipping") {
      await customerService.clearDefaultShipping(customerProfileId, addressId, tx);
      await customerService.updateAddress(addressId, { is_default_shipping: true }, tx);
    } else {
      await customerService.clearDefaultBilling(customerProfileId, addressId, tx);
      await customerService.updateAddress(addressId, { is_default_billing: true }, tx);
    }
  });

  await bus.emit(
    "address.updated",
    {
      customerProfileId,
      addressId,
      changedFields: [kind === "shipping" ? "is_default_shipping" : "is_default_billing"],
    },
    { actorUserId },
  );

  return ok({ addressId });
});
