import "server-only";

import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { fail, ok, workflow } from "../shared";

export const resetPasswordSchema = z.object({
  token: z.string().min(8, "Lien invalide"),
  // Min 12 to match Better Auth's `minPasswordLength` (auth/server.ts) and the
  // signup schema — so an 8–11 char reset surfaces this clear field error
  // rather than Better Auth's generic rejection.
  newPassword: z.string().min(12, "Minimum 12 caractères").max(128),
});

export type ResetPasswordInput = z.input<typeof resetPasswordSchema>;

export const resetPasswordWorkflow = workflow<
  [ResetPasswordInput],
  { reset: true }
>("auth.reset_password", async (input) => {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString() ?? "form";
      fieldErrors[key] = issue.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }

  try {
    const auth = await getAuth();
    await auth.api.resetPassword({
      body: {
        token: parsed.data.token,
        newPassword: parsed.data.newPassword,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/expired|invalid|not found/i.test(message)) {
      return fail("expired_token", "Le lien de réinitialisation est invalide ou expiré.");
    }
    throw err;
  }

  // The `onPasswordReset` hook in auth/server.ts emits the audit event.
  return ok({ reset: true as const });
});
