import "server-only";

import { z } from "zod";

import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Admin-side update of `admin_notes` on a customer profile. Notes are
 * never sent to the customer and only ever read by admin views, so the
 * input is the raw textarea contents — we trim and collapse empty to null
 * so the column reflects "no notes" rather than carrying whitespace.
 */
export const updateCustomerNotesSchema = z.object({
  profileId: z.string().uuid(),
  notes: z.string().max(8000),
});

export const updateCustomerNotesWorkflow = workflow<
  [z.input<typeof updateCustomerNotesSchema>, { actorUserId: string }],
  { profileId: string }
>("customer.update_notes", async (input, { actorUserId }) => {
  const parsed = updateCustomerNotesSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  // Unknown / archived profile → not_found (updateProfile alone would match an
  // archived row, or silently no-op on an unknown id and still emit + report ok).
  const existing = await customerService.findProfileById(parsed.data.profileId);
  if (!existing) return fail("not_found", "Profil introuvable.");

  const trimmed = parsed.data.notes.trim();
  await customerService.updateProfile(parsed.data.profileId, {
    admin_notes: trimmed.length ? trimmed : null,
  });

  const link = await customerUserLink.findByProfileId(parsed.data.profileId);

  await bus.emit(
    "customer.profile_updated",
    {
      // The customer's linked account (null for an unlinked profile) per the
      // event contract — the admin travels in the meta (`actorUserId`).
      userId: link?.user_id ?? null,
      customerProfileId: parsed.data.profileId,
      changedFields: ["admin_notes"],
    },
    { actorUserId },
  );

  return ok({ profileId: parsed.data.profileId });
});
