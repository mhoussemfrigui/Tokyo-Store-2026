import "server-only";

import { z } from "zod";

import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

export const deleteAddressSchema = z.object({
  addressId: z.string().uuid(),
});

export const deleteAddressWorkflow = workflow<
  [z.input<typeof deleteAddressSchema>, { actorUserId: string }],
  { addressId: string }
>("customer.delete_address", async (input, { actorUserId }) => {
  const parsed = deleteAddressSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Adresse invalide.");

  const link = await customerUserLink.findByUserId(actorUserId);
  if (!link) return fail("not_found", "Profil introuvable.");

  const existing = await customerService.findAddressById(parsed.data.addressId);
  if (!existing || existing.customer_profile_id !== link.customer_profile_id) {
    return fail("not_found", "Adresse introuvable.");
  }

  await customerService.softDeleteAddress(parsed.data.addressId);

  await bus.emit(
    "address.deleted",
    {
      customerProfileId: link.customer_profile_id,
      addressId: parsed.data.addressId,
    },
    { actorUserId },
  );

  return ok({ addressId: parsed.data.addressId });
});
