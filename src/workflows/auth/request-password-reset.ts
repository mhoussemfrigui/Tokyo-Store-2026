import "server-only";

import { z } from "zod";

import { getAuth } from "@/lib/auth/server";
import { ok, workflow } from "../shared";

export const requestPasswordResetSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email invalide"),
});

export type RequestPasswordResetInput = z.input<typeof requestPasswordResetSchema>;

/**
 * Always returns `ok({ delivered: true })` regardless of whether the email
 * exists — prevents account enumeration. The actual email-sending +
 * audit-emit happens inside Better Auth's `sendResetPassword` hook (see
 * `lib/auth/server.ts`), so a missing email simply means no email goes out.
 */
export const requestPasswordResetWorkflow = workflow<
  [RequestPasswordResetInput, { ip?: string | null }],
  { delivered: true }
>("auth.request_password_reset", async (input) => {
  const parsed = requestPasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    // Even malformed emails get the standard response, to avoid leaking info.
    return ok({ delivered: true as const });
  }

  try {
    const auth = await getAuth();
    await auth.api.requestPasswordReset({
      body: {
        email: parsed.data.email,
        redirectTo: "/reset-password",
      },
    });
  } catch (err) {
    // Quietly log — never reveal whether the email matched.
    console.warn("[workflow:auth.request_password_reset] silent failure", err);
  }

  return ok({ delivered: true as const });
});
