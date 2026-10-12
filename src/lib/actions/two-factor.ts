"use server";

import { revalidatePath } from "next/cache";
import QRCode from "qrcode";

import { requirePermission, requireSession } from "@/lib/auth/session";
import { assertActorOutranksTarget } from "@/lib/rbac/guards";
import { authService } from "@/modules/auth/service";
import { bus } from "@/events/bus";
import { type ActionState } from "@/lib/actions/types";

/**
 * Render an `otpauth://` TOTP URI (returned by `twoFactor.enable`; the HTTP
 * `get-totp-uri` endpoint is disabled — see AUTH_HTTP_DISABLED_PATHS) to a QR
 * data URL, server-side, so the `qrcode` lib stays out of the client
 * bundle. Requires a session — a user only ever encodes their OWN enrolment URI
 * (already in their browser); this just avoids shipping the encoder client-side.
 */
export async function twoFactorQrAction(uri: string): Promise<string | null> {
  await requireSession();
  if (!uri || !uri.startsWith("otpauth://")) return null;
  try {
    return await QRCode.toDataURL(uri, { width: 200, margin: 1 });
  } catch {
    return null;
  }
}

/**
 * Admin 2FA lockout-recovery: clear a user's 2FA enrolment so they can sign in
 * (and re-enrol). Gated on `users:manage` + the escalation guard (a delegate
 * can't act on a higher-privileged account). The admin only CLEARS — they can
 * never read the secret/backup codes. Audited.
 */
export async function disableUserTwoFactorAction(userId: string): Promise<ActionState> {
  const session = await requirePermission("users", "manage");
  const outranked = await assertActorOutranksTarget(session.user.id, userId);
  if (outranked) return { ok: false, error: outranked.error, message: outranked.message };

  const existing = await authService.findById(userId);
  if (!existing) return { ok: false, error: "not_found", message: "Utilisateur introuvable." };

  const had = await authService.clearTwoFactor(userId);
  // Revoke sessions so a 2FA bypass can't ride an existing cookie.
  await authService.deleteSessionsForUser(userId);
  await bus.emit(
    "user.two_factor_disabled_by_admin",
    { userId, actorUserId: session.user.id },
    { actorUserId: session.user.id },
  );

  revalidatePath(`/admin/users/${userId}`);
  return {
    ok: true,
    message: had ? "2FA réinitialisée pour cet utilisateur." : "Aucune 2FA active sur ce compte.",
  };
}
