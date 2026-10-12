"use server";

import { verifyUnsubToken } from "@/lib/crypto/sign";
import { unsubscribeEmailFromMarketing } from "@/workflows/customer/unsubscribe";

/**
 * Public one-click unsubscribe (POST-confirm so email scanners / link prefetch
 * can't unsubscribe on a GET). Verifies the HMAC token → unsubscribes the email
 * → ALWAYS redirects to the same success page (anti-enumeration: a bad/forged
 * token is indistinguishable from a real one).
 */
export async function unsubscribeByTokenAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const email = verifyUnsubToken(token);
  if (email) {
    await unsubscribeEmailFromMarketing(email).catch(() => {});
  }
  // Lazy import so this server module doesn't eagerly load next/navigation
  // (client app-router-context) at import time — keeps react-server test imports working.
  const { redirect } = await import("next/navigation");
  redirect("/se-desabonner?done=1");
}
