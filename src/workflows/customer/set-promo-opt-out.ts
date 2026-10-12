import "server-only";

import { z } from "zod";

import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Admin sets whether a customer is EXCLUDED from public promotions
 * (`customer_profiles.promo_opt_out`). The eligibility engine suppresses public
 * promos for excluded customers (targeted promos still apply). Admin-only — no
 * customer self-service.
 *
 * Emits `customer.profile_updated` with the CUSTOMER's linked account as
 * `userId` (null for an unlinked profile) per the event contract; the admin
 * travels in the meta. `changedFields` never lists name fields (the name-sync
 * subscriber keys on those).
 */
export const setPromoOptOutSchema = z.object({
  profileId: z.string().uuid(),
  optOut: z.boolean(),
});

export const setCustomerPromoOptOutWorkflow = workflow<
  [z.input<typeof setPromoOptOutSchema>, { actorUserId: string }],
  { profileId: string; optOut: boolean }
>("customer.set_promo_opt_out", async (input, { actorUserId }) => {
  const parsed = setPromoOptOutSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "ID profil invalide.");
  const { profileId, optOut } = parsed.data;

  // Unknown / archived profile → not_found (never report or audit a no-op write).
  const existing = await customerService.findProfileById(profileId);
  if (!existing) return fail("not_found", "Profil introuvable.");

  await customerService.updateProfile(profileId, { promo_opt_out: optOut });

  const link = await customerUserLink.findByProfileId(profileId);
  await bus.emit(
    "customer.profile_updated",
    { userId: link?.user_id ?? null, customerProfileId: profileId, changedFields: ["promo_opt_out"] },
    { actorUserId },
  );

  return ok({ profileId, optOut });
});
