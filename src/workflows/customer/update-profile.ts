import "server-only";

import { z } from "zod";

import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Birthday — an optional pure date 'YYYY-MM-DD'. `null` clears it, `undefined`
 * leaves it unchanged. Validates the format, that it is a REAL calendar date
 * (rejects 2025-02-30 / 2025-13-01 via UTC round-trip), and bounds it to a
 * sane range (>= 1900-01-01, not in the future). Shared by both the
 * self-service and admin profile-update variants.
 */
const birthdayField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Format de date invalide (AAAA-MM-JJ).")
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "Date invalide.")
  .refine((s) => s >= "1900-01-01", "Date de naissance trop ancienne.")
  .refine(
    (s) => s <= new Date().toISOString().slice(0, 10),
    "La date de naissance ne peut pas être dans le futur.",
  )
  .nullable()
  .optional();

/** Gender — the closed set ('female' | 'male' | 'other'), `null` clears it,
 *  `undefined` leaves it unchanged. Shared by the self-service + admin variants. */
const genderField = z.enum(["female", "male", "other"]).nullable().optional();

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(40).optional().nullable(),
  marketingOptIn: z.boolean().optional(),
  birthday: birthdayField,
  gender: genderField,
});

export type UpdateProfileInput = z.input<typeof updateProfileSchema>;

export const updateProfileWorkflow = workflow<
  [UpdateProfileInput, { actorUserId: string }],
  { customerProfileId: string }
>("customer.update_profile", async (input, { actorUserId }) => {
  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path[0]?.toString() ?? "form"] = issue.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }

  const link = await customerUserLink.findByUserId(actorUserId);
  if (!link) return fail("not_found", "Profil introuvable.");

  const patch: Parameters<typeof customerService.updateProfile>[1] = {};
  const changed: string[] = [];
  if (parsed.data.firstName !== undefined) {
    patch.first_name = parsed.data.firstName;
    changed.push("first_name");
  }
  if (parsed.data.lastName !== undefined) {
    patch.last_name = parsed.data.lastName;
    changed.push("last_name");
  }
  if (parsed.data.phone !== undefined) {
    patch.phone = parsed.data.phone;
    changed.push("phone");
  }
  if (parsed.data.marketingOptIn !== undefined) {
    patch.marketing_opt_in = parsed.data.marketingOptIn;
    changed.push("marketing_opt_in");
  }
  if (parsed.data.birthday !== undefined) {
    patch.birthday = parsed.data.birthday;
    changed.push("birthday");
  }
  if (parsed.data.gender !== undefined) {
    patch.gender = parsed.data.gender;
    changed.push("gender");
  }

  if (Object.keys(patch).length === 0) {
    return ok({ customerProfileId: link.customer_profile_id });
  }

  await customerService.updateProfile(link.customer_profile_id, patch);

  await bus.emit(
    "customer.profile_updated",
    {
      userId: actorUserId,
      customerProfileId: link.customer_profile_id,
      changedFields: changed,
    },
    { actorUserId },
  );

  return ok({ customerProfileId: link.customer_profile_id });
});

/**
 * Admin variant — edits a customer profile by its ID (not the actor's own).
 * Same field set + phone_normalized maintenance (via customerService), but
 * targeted by profileId so an admin can correct a client's contact details
 * (notably the phone, which powers guest↔client matching). Audited.
 */
export const adminUpdateProfileSchema = z.object({
  profileId: z.string().uuid(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(40).optional().nullable(),
  marketingOptIn: z.boolean().optional(),
  birthday: birthdayField,
  gender: genderField,
});

export type AdminUpdateProfileInput = z.input<typeof adminUpdateProfileSchema>;

export const adminUpdateProfileWorkflow = workflow<
  [AdminUpdateProfileInput, { actorUserId: string }],
  { customerProfileId: string }
>("customer.admin_update_profile", async (input, { actorUserId }) => {
  const parsed = adminUpdateProfileSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path[0]?.toString() ?? "form"] = issue.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }

  const profile = await customerService.findProfileById(parsed.data.profileId);
  if (!profile) return fail("not_found", "Profil introuvable.");

  const patch: Parameters<typeof customerService.updateProfile>[1] = {};
  const changed: string[] = [];
  if (parsed.data.firstName !== undefined) {
    patch.first_name = parsed.data.firstName;
    changed.push("first_name");
  }
  if (parsed.data.lastName !== undefined) {
    patch.last_name = parsed.data.lastName;
    changed.push("last_name");
  }
  if (parsed.data.phone !== undefined) {
    patch.phone = parsed.data.phone;
    changed.push("phone");
  }
  if (parsed.data.marketingOptIn !== undefined) {
    patch.marketing_opt_in = parsed.data.marketingOptIn;
    changed.push("marketing_opt_in");
  }
  if (parsed.data.birthday !== undefined) {
    patch.birthday = parsed.data.birthday;
    changed.push("birthday");
  }
  if (parsed.data.gender !== undefined) {
    patch.gender = parsed.data.gender;
    changed.push("gender");
  }

  if (Object.keys(patch).length === 0) {
    return ok({ customerProfileId: profile.id });
  }

  await customerService.updateProfile(profile.id, patch);

  const link = await customerUserLink.findByProfileId(profile.id);
  await bus.emit(
    "customer.profile_updated",
    // null (not "") for an unlinked/guest profile — the honest contract the
    // name-sync + marketing-sync subscribers gate on.
    { userId: link?.user_id ?? null, customerProfileId: profile.id, changedFields: changed },
    { actorUserId },
  );

  return ok({ customerProfileId: profile.id });
});
