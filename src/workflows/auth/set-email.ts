import "server-only";

import { z } from "zod";

import { authService } from "@/modules/auth/service";
import { assertActorOutranksTarget } from "@/lib/rbac/guards";
import { maskEmail } from "@/lib/email/util";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * Workflow — admin sets a user's LOGIN email DIRECTLY.
 *
 * The self-service change flow (`auth.api.changeEmail`) needs the user's OWN
 * session + a confirmation click, which an admin doesn't have — so this is the
 * staff path (e.g. an employee typo'd their address at sign-up and is locked
 * out). Because the email IS the login identity, this is deliberately careful:
 *   - RANK-GUARD the target (a delegate can't rewrite a super_admin's identity).
 *   - Enforce UNIQUENESS (no two accounts on one address).
 *   - Mark the new address UNVERIFIED — an admin swap doesn't prove mailbox
 *     ownership, so the user still has to verify (mirrors setEmailVerified's
 *     account-takeover caution).
 *   - REVOKE every session — the identity changed, so outstanding cookies must
 *     re-authenticate.
 *   - AUDIT with both addresses MASKED (never the full address in the event),
 *     matching the self-service `user.email_changed` emit in auth/server.ts.
 */
export const setEmailSchema = z.object({
  userId: z.string().min(1),
  newEmail: z.string().trim().toLowerCase().email("Email invalide").max(254),
});
export type SetEmailInput = z.input<typeof setEmailSchema>;

export const setEmailWorkflow = workflow<
  [SetEmailInput, { actorUserId: string }],
  { userId: string }
>("auth.set_email", async (input, { actorUserId }) => {
  const parsed = setEmailSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  const { userId, newEmail } = parsed.data;

  const user = await authService.findById(userId);
  if (!user) return fail("not_found", "Utilisateur introuvable.");

  const outranked = await assertActorOutranksTarget(actorUserId, userId);
  if (outranked) return outranked;

  const oldEmail = user.email;
  if (oldEmail.toLowerCase() === newEmail) return ok({ userId }); // no-op, no write/emit

  // Uniqueness — another account must not already hold this address.
  const clash = await authService.findByEmail(newEmail);
  if (clash && clash.id !== userId) {
    return fail("conflict", "Cet email est déjà utilisé par un autre compte.", { newEmail: "Déjà utilisé" });
  }

  await authService.update(userId, { email: newEmail, emailVerified: false });
  await authService.deleteSessionsForUser(userId); // identity changed → force re-auth

  await bus.emit(
    "user.email_changed",
    { userId, oldEmailMasked: maskEmail(oldEmail), newEmailMasked: maskEmail(newEmail) },
    { actorUserId },
  );
  return ok({ userId });
});
