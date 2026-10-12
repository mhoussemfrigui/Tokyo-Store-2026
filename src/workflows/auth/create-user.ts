import "server-only";

import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { markPendingInvite } from "@/lib/auth/invite-context";
import { AUTH_POLICY } from "@/lib/auth/policy";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { assertActorMayAssignRoles, assertActorMayGrantRole } from "@/lib/rbac/guards";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { claimGuestOrdersForUser } from "@/lib/order/claim-guest-orders";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * Workflow — admin creates a user DIRECTLY with a chosen email + password
 * (no invite round-trip). Differs from inviteUser: the admin sets the password
 * and the account is usable immediately; no email is sent.
 *
 * Steps mirror inviteUser where they overlap:
 *   0. markPendingInvite(email) BEFORE signUpEmail purely to SUPPRESS the
 *      signup verification email (sendVerificationEmail skips marked addresses).
 *      We never call requestPasswordReset, so no invitation email goes out
 *      either — the admin hands over the credentials. The marker self-expires.
 *   1. signUpEmail with the admin-chosen password (Better Auth hashes it).
 *   2. Force emailVerified — the admin vouches for the account.
 *   3. No roles → a plain customer: profile + link (+ guest-order claim when the
 *      actor may vouch for the email — staff, never a B2B partner). With roles it
 *      is an internal account (no customer profile).
 *   4. Assign any selected RBAC roles.
 *   5. Emit user.created_by_admin (audit).
 */
export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email invalide"),
  firstName: z.string().trim().min(1, "Prénom requis").max(80),
  lastName: z.string().trim().min(1, "Nom requis").max(80),
  password: z
    .string()
    .min(AUTH_POLICY.minPasswordLength, `Mot de passe : ${AUTH_POLICY.minPasswordLength} caractères minimum`)
    .max(AUTH_POLICY.maxPasswordLength),
  phone: z.string().trim().max(40).optional(),
  // Internal vs customer is derived from whether any RBAC role is assigned — there is
  // no account-type enum anymore (access is role-only).
  roleIds: z.array(z.string().uuid()).max(50).default([]),
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const createUserWorkflow = workflow<
  [CreateUserInput, { actorUserId: string }],
  { userId: string }
>("auth.create_user", async (input, { actorUserId }) => {
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const data = parsed.data;

  if (await authService.findByEmail(data.email)) {
    return fail("email_taken", "Cette adresse a déjà un compte.", {
      email: "Adresse déjà utilisée",
    });
  }

  // ESCALATION GUARDS (nothing created yet). Attaching ANY role is the grant power
  // (users:roles) — a users:create-only operator can mint a plain account but not
  // give it access. Then each requested role must be one the actor could itself
  // wield (assertActorMayGrantRole: no system role / nothing above its own grants).
  if (data.roleIds.length > 0) {
    const mayAssign = await assertActorMayAssignRoles(actorUserId);
    if (mayAssign) return mayAssign;
  }
  for (const roleId of data.roleIds) {
    const role = await rbacService.findRoleById(roleId);
    if (!role) return fail("not_found", "Rôle sélectionné introuvable.");
    const denied = await assertActorMayGrantRole(actorUserId, role);
    if (denied) return denied;
  }

  // 0. Suppress the signup verification email (admin sets the password).
  markPendingInvite(data.email);

  // 1. Create the credential account with the admin-chosen password.
  let signUpResult;
  const auth = await getAuth();
  try {
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
    if (/exists|in use|already/i.test(message)) {
      return fail("email_taken", "Cette adresse a déjà un compte.", {
        email: "Adresse déjà utilisée",
      });
    }
    throw err;
  }

  const userId = signUpResult?.user?.id;
  if (!userId) return fail("internal", "Création du compte impossible.");

  // Better Auth 1.6 (autoSignIn:false) answers a DUPLICATE email with a
  // SYNTHETIC user — a freshly generated, never-inserted id — instead of
  // throwing, so a concurrent create of the same address that slipped past the
  // pre-check would otherwise "succeed" on a phantom id (orphan role / profile /
  // user_roles rows, a bogus audit event). Trust the id only once its row
  // exists (mirrors signup.ts).
  if (!(await authService.findById(userId))) {
    return fail("email_taken", "Cette adresse a déjà un compte.", {
      email: "Adresse déjà utilisée",
    });
  }

  // 2. Admin vouches — mark verified so first sign-in isn't gated.
  await authService.update(userId, { emailVerified: true });

  // 3. Profile — an INTERNAL account (one carrying RBAC roles) gets no customer
  // profile (its fiche is /admin/users/<id>); a plain customer (no roles) gets a
  // profile + link + guest-order retro-claim.
  if (data.roleIds.length === 0) {
    let profile;
    try {
      profile = await customerService.insertProfile({
        first_name: data.firstName,
        last_name: data.lastName,
        phone: data.phone || null,
        marketing_opt_in: false,
      });
    } catch (err) {
      console.error("[workflow:auth.create_user] profile insert failed", err);
      return fail("internal", "Impossible de créer le profil client.");
    }
    try {
      await customerUserLink.create({ user_id: userId, customer_profile_id: profile.id });
    } catch (err) {
      console.error("[workflow:auth.create_user] link creation failed; rolling back profile", err);
      await customerService.softDeleteProfile(profile.id);
      return fail("internal", "Impossible de lier le profil au compte.");
    }
    // Retro-link guest orders placed with this email — the email is the match,
    // the phone plays no part. The claim REASSIGNS orders.user_id, so it is gated
    // on the ACTOR holding `users:create`: claimGuestOrdersForUser enforces that
    // from `actorUserId` and no-ops for a non-staff actor (defense in depth — the
    // server action is already gated, but the workflow must not claim for an actor
    // that reaches it directly). Best-effort — must never fail the create.
    try {
      await claimGuestOrdersForUser({ userId, email: data.email, actorUserId });
    } catch (err) {
      console.error("[workflow:auth.create_user] guest-order claim failed", err);
    }
  }

  // 4. Assign selected RBAC roles (idempotent).
  for (const roleId of data.roleIds) {
    await rbacService.assignRoleToUser(userId, roleId);
  }

  // 5. Audit.
  await bus.emit(
    "user.created_by_admin",
    { userId, email: data.email, internal: data.roleIds.length > 0 },
    { actorUserId },
  );
  if (data.roleIds.length > 0) {
    await bus.emit("user.roles_changed", { userId, roleIds: data.roleIds }, { actorUserId });
  }

  return ok({ userId });
});
