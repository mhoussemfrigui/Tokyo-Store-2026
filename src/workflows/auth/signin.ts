import "server-only";

import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { authService } from "@/modules/auth/service";
import { bus } from "@/events/bus";
import { maskEmail } from "@/lib/email/util";
import { fail, ok, workflow } from "../shared";

/**
 * Sign-in. ONE account per email; an account's capabilities (customer / admin /
 * business member) are orthogonal to which login PAGE it used — "a user is a
 * user". There is deliberately NO login-portal audience gate: the staff login +
 * secret admin URL exist only for obscurity, and the real authorization boundary
 * is the RBAC gate on `/admin` (resolveAdminShellAccess), which 404s any
 * non-admin regardless of how they authenticated. A disabled account is still
 * refused here (and its just-minted session revoked).
 */

export const signinSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email invalide"),
  password: z.string().min(1, "Mot de passe requis"),
  rememberMe: z.boolean().optional(),
});

export type SigninInput = z.input<typeof signinSchema>;

export const signinWorkflow = workflow<
  [SigninInput, { ip?: string | null }],
  { userId: string | null; twoFactorRequired: boolean }
>("auth.signin", async (input, meta) => {
  const parsed = signinSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString() ?? "form";
      fieldErrors[key] = issue.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }
  const data = parsed.data;

  let result;
  try {
    const auth = await getAuth();
    result = await auth.api.signInEmail({
      body: {
        email: data.email,
        password: data.password,
        rememberMe: data.rememberMe ?? true,
      },
      asResponse: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Record the failure for the security trail (masked email, never the
    // password; the user-facing message stays neutral). Best-effort — a logging
    // hiccup must never change the auth outcome. The reason classifies the cause
    // for the Sécurité view without being an oracle to the caller.
    const reason: "invalid_credentials" | "email_not_verified" | "account_disabled" =
      /ACCOUNT_DISABLED/i.test(message)
        ? "account_disabled"
        : /verify|verification/i.test(message)
          ? "email_not_verified"
          : "invalid_credentials";
    await bus
      .emit(
        "user.sign_in_failed",
        { emailMasked: maskEmail(data.email), reason, ip: meta.ip ?? null },
        { actorIp: meta.ip ?? null },
      )
      .catch(() => {});

    // The session.create.before hook (auth/server.ts) refuses to mint a
    // session for a soft-disabled account — surface the real reason instead
    // of the generic credentials error.
    if (reason === "account_disabled") {
      return fail("account_disabled", "Ce compte a été désactivé. Contactez le support.");
    }

    if (reason === "email_not_verified") {
      return fail(
        "email_not_verified",
        "Confirmez votre email avant de vous connecter.",
      );
    }

    // Generic — don't reveal which field is wrong.
    return fail("invalid_credentials", "Email ou mot de passe incorrect.");
  }

  // 2FA enabled → credentials were correct but NO session was minted yet; the
  // body carries `twoFactorRedirect`. The caller routes to /login/2fa to verify
  // the second factor (which then mints the session — and the disabledAt ban
  // hook still runs at that point). Must be checked BEFORE the `!userId` guard,
  // since a 2FA response legitimately has no `user`.
  if (result && (result as { twoFactorRedirect?: boolean }).twoFactorRedirect) {
    return ok({ userId: null, twoFactorRequired: true });
  }

  const userId = result?.user?.id;
  if (!userId) {
    return fail("invalid_credentials", "Email ou mot de passe incorrect.");
  }

  // A soft-disabled account must not obtain a fresh session. Better Auth has
  // no knowledge of our `disabledAt`, so enforce it here and revoke the
  // session it just created.
  const account = await authService.findById(userId);
  if (!account || account.disabledAt) {
    await authService.deleteSessionsForUser(userId).catch(() => {});
    return fail("account_disabled", "Ce compte a été désactivé. Contactez le support.");
  }

  await bus.emit(
    "user.signed_in",
    { userId, email: data.email, ip: meta.ip ?? null },
    { actorUserId: userId, actorIp: meta.ip ?? null },
  );

  return ok({ userId, twoFactorRequired: false });
});
