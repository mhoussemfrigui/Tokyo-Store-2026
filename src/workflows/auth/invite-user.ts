import "server-only";

import { randomBytes } from "node:crypto";
import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { markPendingInvite, takeInviteUrl } from "@/lib/auth/invite-context";
import { assertActorMayAssignRoles, assertActorMayGrantRole } from "@/lib/rbac/guards";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { claimGuestOrdersForUser } from "@/lib/order/claim-guest-orders";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email invalide"),
  firstName: z.string().trim().min(1, "Prénom requis").max(80),
  lastName: z.string().trim().min(1, "Nom requis").max(80),
  phone: z.string().trim().max(40).optional(),
  // Assigning ≥1 RBAC role makes the invitee an internal account; none = a customer.
  roleIds: z.array(z.string().uuid()).max(50).default([]),
});

export type InviteUserInput = z.input<typeof inviteUserSchema>;

/**
 * Workflow — admin invites a user (a plain customer, or an internal account when
 * ≥1 RBAC role is selected).
 *
 * Steps:
 *   0. `markPendingInvite(email)` FIRST — the marker must be set before
 *      `signUpEmail` runs, because Better Auth dispatches the signup
 *      verification email inline during that call; the marked address makes
 *      `sendVerificationEmail` (auth/server.ts) skip it, so the invitee's
 *      ONLY emails are the invitation (and nothing auto-signs them in).
 *   1. Better Auth creates the user via `signUpEmail` with a cryptographically
 *      random throwaway password the invitee never learns — they choose their
 *      own through the invite link.
 *   2. Mark the email verified immediately: the invite link itself proves
 *      mailbox ownership, and a verified flag means the invitee isn't blocked
 *      by `requireEmailVerification` after setting their password.
 *   3. Role handling — an invitee with ≥1 selected RBAC role is internal (no
 *      customer profile); none gets a customer_profile + link exactly like
 *      signup (with profile rollback if the link fails) plus a best-effort claim
 *      of the guest orders placed with the email. Any selected roles are assigned
 *      in step 3c.
 *   4. Trigger the standard `requestPasswordReset` flow — `sendResetPassword`
 *      sees the marked address and sends the INVITATION template (consuming
 *      the marker only on a successful send, so a failed dispatch can be
 *      retried with the right wording via « Envoyer un lien de
 *      réinitialisation » within 15 minutes).
 *   5. Emit `user.invited` (audit).
 */
export const inviteUserWorkflow = workflow<
  [InviteUserInput, { actorUserId: string }],
  { userId: string; inviteUrl: string | null }
>("auth.invite_user", async (input, { actorUserId }) => {
  const parsed = inviteUserSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const data = parsed.data;

  // Explicit pre-check — an invite to an existing address is an operator
  // mistake worth a clear field error (no enumeration concern: admin-only).
  if (await authService.findByEmail(data.email)) {
    return fail("email_taken", "Cette adresse a déjà un compte.", {
      email: "Adresse déjà utilisée",
    });
  }

  // ESCALATION GUARDS (nothing created yet). Attaching ANY role is the grant power
  // (users:roles) — a users:create-only operator can invite a plain account but not
  // give it access. Then each requested role must be one the actor could itself
  // wield (assertActorMayGrantRole: no system role / nothing above its own grants),
  // so a delegate can't invite a super-admin to an address it controls and seize it.
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

  // 0. Flag the address BEFORE creating the account — signUpEmail dispatches
  // the signup verification email inline, and the marker is what makes
  // sendVerificationEmail (auth/server.ts) suppress it for invitees.
  markPendingInvite(data.email);

  // 1. Better Auth creates the user + credential rows. The throwaway password
  // never leaves this scope and is never communicated to anyone.
  const throwawayPassword = randomBytes(24).toString("base64url");
  let signUpResult;
  const auth = await getAuth();
  try {
    signUpResult = await auth.api.signUpEmail({
      body: {
        email: data.email,
        password: throwawayPassword,
        name: `${data.firstName} ${data.lastName}`,
      },
      asResponse: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Race with a concurrent signup — same outcome as the pre-check.
    if (/exists|in use|already/i.test(message)) {
      return fail("email_taken", "Cette adresse a déjà un compte.", {
        email: "Adresse déjà utilisée",
      });
    }
    throw err;
  }

  const userId = signUpResult?.user?.id;
  if (!userId) {
    return fail("internal", "Création du compte impossible.");
  }

  // Better Auth 1.6 (autoSignIn:false) answers a DUPLICATE email with a
  // SYNTHETIC user — a freshly generated, never-inserted id — instead of
  // throwing, so the concurrent-signup race above usually does NOT throw. Trust
  // the id only once its row exists (mirrors signup.ts); otherwise it is the
  // same outcome as the pre-check (and no invitation goes out).
  if (!(await authService.findById(userId))) {
    return fail("email_taken", "Cette adresse a déjà un compte.", {
      email: "Adresse déjà utilisée",
    });
  }

  // 2. Mark verified — the invite link proves mailbox ownership, so the
  // signup-triggered verification round-trip is redundant for invitees.
  await authService.update(userId, { emailVerified: true });

  // 3. Profile — an invitee carrying RBAC roles is an internal account (fiche =
  // /admin/users/<id>, no customer profile); none = a plain customer (profile + link
  // + guest-order retro-claim), mirroring signup.
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
      console.error("[workflow:auth.invite_user] profile insert failed", err);
      return fail("internal", "Impossible de créer le profil client.");
    }

    try {
      await customerUserLink.create({
        user_id: userId,
        customer_profile_id: profile.id,
      });
    } catch (err) {
      console.error(
        "[workflow:auth.invite_user] link creation failed; rolling back profile",
        err,
      );
      await customerService.softDeleteProfile(profile.id);
      return fail("internal", "Impossible de lier le profil au compte.");
    }

    // Retro-link guest orders placed with this email. The email is the match —
    // the phone plays no part, so it no longer gates the claim (an invite without
    // a phone used to skip it). The invited account is force-verified, so the
    // verification hook that claims for self-service signups never runs for it:
    // the claim happens here, vouched for by the inviting staff. The vouch is
    // ENFORCED — claimGuestOrdersForUser gates on `actorUserId` holding
    // `users:create` (the same grant inviteUserAction requires) and no-ops for a
    // non-staff actor. Best-effort — must never fail the invite.
    try {
      await claimGuestOrdersForUser({ userId, email: data.email, actorUserId });
    } catch (err) {
      console.error("[workflow:auth.invite_user] guest-order claim failed", err);
    }
  }

  // 3c. Assign any selected RBAC roles (idempotent). A freshly created user can't be
  // the last admin, so no last-admin floor is needed here.
  for (const roleId of data.roleIds) await rbacService.assignRoleToUser(userId, roleId);

  // 4. Send the invite link. The pending-invite flag (set in step 0, 15-min
  // TTL) makes Better Auth's reset email go out as the invitation template
  // instead of the standard password-reset one; it is consumed only on a
  // successful send. Failure is logged but doesn't fail the invite — the
  // admin can re-send via « Envoyer un lien de réinitialisation », which
  // keeps the invitation wording while the marker lives.
  try {
    await auth.api.requestPasswordReset({
      body: {
        email: data.email,
        redirectTo: "/reset-password",
      },
    });
  } catch (err) {
    console.error("[workflow:auth.invite_user] invite link send failed", err);
  }

  // Read back the set-password link captured during the reset call (above) so
  // the caller can reveal it to the admin for manual relay. Null when the send
  // path didn't run (e.g. a multi-pod deploy where the capture landed on
  // another process) — the admin can still re-send the link from the UI.
  const inviteUrl = takeInviteUrl(data.email);

  // 5. Side effects.
  await bus.emit(
    "user.invited",
    { userId, email: data.email, internal: data.roleIds.length > 0 },
    { actorUserId },
  );
  if (data.roleIds.length > 0) {
    await bus.emit("user.roles_changed", { userId, roleIds: data.roleIds }, { actorUserId });
  }

  return ok({ userId, inviteUrl });
});
