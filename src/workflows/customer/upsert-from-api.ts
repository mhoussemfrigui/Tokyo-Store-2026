import "server-only";

import { z } from "zod";

import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";
import type { CustomerProfileRow } from "@/modules/customer/schema";

/**
 * ERP CUSTOMER upsert — create/link/update a customer PROFILE from the external
 * API. The ERP addresses a customer by its `externalRef` (the two-way link, set
 * on first push) or the uuid `id`. Email is NOT settable here: it lives on the
 * linked Better-Auth account, and creating auth accounts is a separate flow — an
 * ERP-pushed profile stays a standalone profile (a later storefront signup
 * creates its own profile; nothing merges the two automatically).
 *
 * LINKING an existing storefront customer: `{ id, externalRef }` stamps the ref
 * on that profile when it has none (the ERP's initial match: GET ?email= → id →
 * PUT {id, externalRef}). Re-sending the same ref is an idempotent no-op; a
 * DIFFERENT ref on an already-linked profile is refused (409 `conflict`,
 * fieldErrors.externalRef = "already_linked"), and a ref owned by ANOTHER
 * profile trips `customer_profiles_external_ref_uniq` → the mapped 409.
 *
 * Reuses `customerService.insert/updateProfile` (which keep phone_normalized in
 * lock-step). On update it emits `customer.profile_updated` so the name-sync +
 * audit subscribers fire, exactly like the admin profile edit.
 */

/** A REAL calendar date 'YYYY-MM-DD' (UTC round-trip rejects 2025-02-30 / 2025-13-01,
 *  which the regex alone accepts and Postgres then refuses with 22008 → 500). */
const birthdaySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "birthday attend 'YYYY-MM-DD'.")
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "birthday : date inexistante.");

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  externalRef: z.string().trim().min(1).max(200).optional(),
  firstName: z.string().trim().min(1).max(200).optional(),
  lastName: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(60).nullish(),
  marketingOptIn: z.boolean().optional(),
  birthday: birthdaySchema.nullish(),
});

export const upsertCustomerFromApiWorkflow = workflow<
  [z.input<typeof upsertSchema>, { actorUserId: string; mustExist: boolean }],
  { customerId: string; externalRef: string | null; created: boolean }
>("customer.upsert_from_api", async (input, { actorUserId, mustExist }) => {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", parsed.error.issues[0]?.message ?? "Client invalide.", flattenZodError(parsed.error));
  }
  const d = parsed.data;

  // Resolve the target: by id (authoritative) then FALL BACK to externalRef. A PUT
  // carrying a stale/unknown id AND a live externalRef must UPDATE the profile that
  // owns the ref — not fall through to create a second one (which would trip
  // customer_profiles_external_ref_uniq → a confusing "valeur déjà utilisée" 409).
  let existing: CustomerProfileRow | null = null;
  if (d.id) existing = await customerService.findProfileById(d.id);
  if (!existing && d.externalRef) existing = await customerService.findByExternalRef(d.externalRef);

  // Map the provided API fields → column patch (only what was sent).
  const patch: Record<string, unknown> = {};
  if (d.firstName !== undefined) patch.first_name = d.firstName;
  if (d.lastName !== undefined) patch.last_name = d.lastName;
  if (d.phone !== undefined) patch.phone = d.phone;
  if (d.marketingOptIn !== undefined) patch.marketing_opt_in = d.marketingOptIn;
  if (d.birthday !== undefined) patch.birthday = d.birthday;
  if (d.externalRef !== undefined) {
    // Link semantics (mirrors the order status route): a profile already linked
    // to a DIFFERENT ref is never silently re-linked; an unlinked one is stamped.
    if (existing?.external_ref && existing.external_ref !== d.externalRef) {
      return fail("conflict", "Ce client est déjà lié à un autre externalRef.", { externalRef: "already_linked" });
    }
    if (!existing || existing.external_ref !== d.externalRef) patch.external_ref = d.externalRef;
  }

  if (existing) {
    // Nothing to change (e.g. an idempotent re-link) → no write, no event: an
    // empty update would still bump updated_at, re-surface the customer in the
    // ERP's own sync feed and fire a webhook back at it for a non-change.
    if (Object.keys(patch).length === 0) {
      return ok({ customerId: existing.id, externalRef: existing.external_ref ?? null, created: false });
    }
    const updated = await customerService.updateProfile(existing.id, patch);
    if (!updated) return fail("not_found", "Client introuvable.");
    // The ERP can update ANY profile — including a linked storefront customer's.
    // Carry the linked account id (null only for a standalone profile) so the
    // name-sync (users.name) and marketing-sync (newsletter row) subscribers act
    // on it, exactly like the admin profile edit; with a hard-coded null both
    // silently skipped and an ERP rename / opt-out never reached the account.
    const link = await customerUserLink.findByProfileId(existing.id);
    await bus.emit(
      "customer.profile_updated",
      { userId: link?.user_id ?? null, customerProfileId: existing.id, changedFields: Object.keys(patch) },
      { actorUserId },
    );
    return ok({ customerId: existing.id, externalRef: updated.external_ref ?? null, created: false });
  }

  if (mustExist) return fail("not_found", "Client introuvable.");

  // Create — first/last name are required for a new profile.
  if (!d.firstName || !d.lastName) {
    return fail("validation", "firstName et lastName sont requis pour créer un client.");
  }
  const created = await customerService.insertProfile({
    first_name: d.firstName,
    last_name: d.lastName,
    phone: d.phone ?? null,
    marketing_opt_in: d.marketingOptIn ?? false,
    birthday: d.birthday ?? null,
    external_ref: d.externalRef ?? null,
  } as never);
  await bus.emit(
    "customer.profile_updated",
    { userId: null, customerProfileId: created.id, changedFields: ["created"] },
    { actorUserId },
  );
  return ok({ customerId: created.id, externalRef: created.external_ref ?? null, created: true });
});
