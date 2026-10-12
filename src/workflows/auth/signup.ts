import "server-only";

import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

export const signupSchema = z.object({
  firstName: z.string().trim().min(1, "Prénom requis").max(80),
  lastName: z.string().trim().min(1, "Nom requis").max(80),
  email: z.string().trim().toLowerCase().email("Email invalide"),
  // Optional — stored on the customer profile at signup. Guest orders are claimed
  // (and their points retro-credited) ONLY AFTER email verification, from the auth
  // layer's afterEmailVerification hook → claimGuestOrdersAfterVerification, which
  // reads this phone back off the profile. Never claimed at signup (the email is
  // still unverified attacker input there) — see the NOTE further down.
  phone: z.string().trim().max(40).optional(),
  // Min 12 to match Better Auth's `minPasswordLength` (auth/server.ts). Keeping
  // them in lockstep means the user sees the clear zod field error instead of
  // Better Auth's generic rejection on an 8–11 char password.
  password: z.string().min(12, "Minimum 12 caractères").max(128),
  marketingOptIn: z.boolean().optional().default(false),
  // Use a plain boolean + refine instead of z.literal(true) so the calling
  // action can pass the raw checkbox value without a misleading type cast.
  terms: z
    .boolean()
    .refine((v) => v === true, "Vous devez accepter les conditions"),
});

export type SignupInput = z.input<typeof signupSchema>;

/**
 * Workflow — sign a new customer up.
 *
 * Steps (with rollback contract):
 *   1. Validate input.
 *   2. Better Auth creates the user row + sends verification email. An
 *      already-registered email yields the same generic success and NOTHING
 *      below runs (no profile, no link, no event).
 *   3. We create a customer_profile.
 *   4. We link user ↔ customer_profile via customer_user_links.
 *   5. Emit `user.created` (welcome email, audit).
 *
 * If the link step fails we soft-delete the freshly-created profile so we
 * don't leave orphans. The user row stays — Better Auth manages its
 * lifecycle and a partial signup can be completed by visiting verify-email
 * again.
 */
export const signupWorkflow = workflow<
  [SignupInput, { ip?: string | null }],
  { userId: string; emailVerificationRequired: true; alreadyRegistered?: boolean }
>("auth.signup", async (input, meta) => {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString() ?? "form";
      fieldErrors[key] = issue.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }
  const data = parsed.data;

  // 1. Better Auth handles user + account row + verification email.
  let signUpResult;
  try {
    const auth = await getAuth();
    signUpResult = await auth.api.signUpEmail({
      body: {
        email: data.email,
        password: data.password,
        name: `${data.firstName} ${data.lastName}`,
      },
      asResponse: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Defence in depth only: with our config (autoSignIn:false) Better Auth does
    // NOT throw on an existing email — see the synthetic-user check below. Kept
    // in case a library upgrade restores the USER_ALREADY_EXISTS throw.
    if (/exists|in use|already/i.test(message)) {
      return ok({ userId: "", emailVerificationRequired: true as const, alreadyRegistered: true });
    }
    throw err;
  }

  const userId = signUpResult?.user?.id;
  if (!userId) {
    return fail("internal", "Création du compte impossible.");
  }

  // ANTI-ENUMERATION (OWASP A07) + no side effects for an existing email.
  // Better Auth 1.6 (autoSignIn:false / requireEmailVerification) answers a
  // duplicate signup with a SYNTHETIC user — a freshly generated id that was
  // never inserted — instead of throwing (it hashes the password either way so
  // both paths take similar time; checking AFTER the call keeps that). Using that
  // id would create an orphan profile + link and fire `user.created`, i.e. a
  // "welcome" email to the REAL owner with an attacker-chosen name. So: an id
  // with no users row ⇒ return the SAME generic success the happy path returns,
  // create nothing, emit nothing (and never email the existing owner — signup
  // must not become a victim-inbox spam vector). (Residual: this path skips the
  // profile insert + link + emits, so it returns marginally faster — bounded by
  // the per-IP + per-email rate limits in signupAction; the response SHAPE is
  // identical.)
  const created = await authService.findById(userId);
  if (!created) {
    return ok({ userId: "", emailVerificationRequired: true as const, alreadyRegistered: true });
  }

  // 2. Customer profile.
  let profile;
  try {
    profile = await customerService.insertProfile({
      first_name: data.firstName,
      last_name: data.lastName,
      phone: data.phone || null,
      marketing_opt_in: data.marketingOptIn,
    });
  } catch (err) {
    console.error("[workflow:auth.signup] profile insert failed", err);
    return fail("internal", "Impossible de créer le profil client.");
  }

  // 3. Link.
  try {
    await customerUserLink.create({
      user_id: userId,
      customer_profile_id: profile.id,
    });
  } catch (err) {
    console.error("[workflow:auth.signup] link creation failed; rolling back profile", err);
    await customerService.softDeleteProfile(profile.id);
    return fail("internal", "Impossible de lier le profil au compte.");
  }

  // NOTE: guest-order claiming is NOT done here. At signup the email is still
  // unverified attacker-supplied input, so reassigning guest orders by the typed
  // email+phone would let a stranger orphan a guest-only customer's history. The
  // claim now runs from the auth layer's `afterEmailVerification` hook (see
  // lib/auth/server.ts → claimGuestOrdersAfterVerification), once mailbox
  // ownership is proven. Admin create/invite paths still claim inline (the
  // operator vouches for the email).

  // 4. Side effects.
  await bus.emit(
    "user.created",
    { userId, email: data.email, name: `${data.firstName} ${data.lastName}`, ip: meta.ip ?? null },
    { actorIp: meta.ip ?? null },
  );

  // Mirror the marketing opt-in into the newsletter table. The sync
  // subscriber listens to `customer.profile_updated` (not `user.created`),
  // so emit it here — only when opted in — to reuse the one-way
  // profile → newsletter sync.
  if (data.marketingOptIn) {
    await bus.emit(
      "customer.profile_updated",
      { userId, customerProfileId: profile.id, changedFields: ["marketing_opt_in"] },
      { actorUserId: userId, actorIp: meta.ip ?? null },
    );
  }

  return ok({ userId, emailVerificationRequired: true as const });
});
