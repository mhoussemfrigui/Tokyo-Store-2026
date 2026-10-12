import "server-only";

import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { fail, ok, workflow } from "../shared";

export const verifyEmailSchema = z.object({
  token: z.string().min(8, "Lien invalide"),
});

/**
 * Verify an email from a raw token — the legacy `/verify-email?token=…` branch
 * of the storefront page. Emailed links are handled by Better Auth itself
 * (GET /api/auth/verify-email, then a redirect to the result page), so this
 * only serves an old-style link. `user.email_verified` is NOT emitted here: the
 * `auth.api.verifyEmail` call runs the `afterEmailVerification` hook
 * (lib/auth/server.ts), which emits it for every verification path — emitting
 * again would double the audit row / webhook.
 */
export const verifyEmailWorkflow = workflow<
  [z.input<typeof verifyEmailSchema>],
  { verified: true }
>("auth.verify_email", async (input) => {
  const parsed = verifyEmailSchema.safeParse(input);
  if (!parsed.success) {
    return fail("invalid_token", "Lien de vérification invalide.");
  }

  try {
    const auth = await getAuth();
    await auth.api.verifyEmail({
      query: { token: parsed.data.token },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/expired|invalid/i.test(message)) {
      return fail("expired_token", "Le lien de vérification est invalide ou expiré.");
    }
    throw err;
  }

  return ok({ verified: true as const });
});
