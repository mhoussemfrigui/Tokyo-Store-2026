import "server-only";

import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { AUTH_POLICY } from "@/lib/auth/policy";
import { authService } from "@/modules/auth/service";
import { assertActorOutranksTarget } from "@/lib/rbac/guards";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * Workflow — admin sets a user's password DIRECTLY (no email round-trip).
 *
 * Uses Better Auth's own scrypt hasher via the resolved auth context
 * (`$context.password.hash`) and its internal adapter — so this stays
 * byte-compatible with passwords set through the normal sign-up / reset flows
 * (no bespoke hashing). `internalAdapter.updatePassword` is an UPDATE only (it
 * silently touches zero rows when there is no credential account), so a
 * social-only user (Google/Facebook sign-up) gets a credential account CREATED
 * instead — the same branch Better Auth's own reset-password route takes. Note
 * that once a credential exists, linking a NEW social provider is gated by the
 * user's OAuth auto-link opt-in (an existing Google link keeps working). After the
 * change every active session is revoked: a password reset must invalidate
 * outstanding cookies (the user — and any attacker holding a live session —
 * re-authenticates with the new secret). The plaintext NEVER touches an event
 * payload or a log.
 */
export const setPasswordSchema = z.object({
  userId: z.string().min(1),
  newPassword: z
    .string()
    .min(AUTH_POLICY.minPasswordLength, `Mot de passe : ${AUTH_POLICY.minPasswordLength} caractères minimum`)
    .max(AUTH_POLICY.maxPasswordLength),
});
export type SetPasswordInput = z.input<typeof setPasswordSchema>;

export const setPasswordWorkflow = workflow<
  [SetPasswordInput, { actorUserId: string }],
  { userId: string }
>("auth.set_password", async (input, { actorUserId }) => {
  const parsed = setPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const { userId, newPassword } = parsed.data;

  const user = await authService.findById(userId);
  if (!user) return fail("not_found", "Utilisateur introuvable.");

  // A non-wildcard actor may not reset the password of a higher-privileged
  // target — otherwise a delegate could take over an existing super_admin.
  const outranked = await assertActorOutranksTarget(actorUserId, userId);
  if (outranked) return outranked;

  const ctx = await (await getAuth()).$context;
  const hash = await ctx.password.hash(newPassword);
  if (await authService.userHasCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    // accountId = userId mirrors how Better Auth keys credential accounts.
    await ctx.internalAdapter.createAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  }

  // Force re-authentication everywhere with the new secret.
  await authService.deleteSessionsForUser(userId);

  await bus.emit("user.password_set", { userId }, { actorUserId });
  return ok({ userId });
});
