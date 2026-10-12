import "server-only";

/**
 * Invite-context flag — lets the admin "invite user" flow reuse Better Auth's
 * password-reset machinery while sending a DIFFERENT email template.
 *
 * The admin action calls {@link markPendingInvite} just before triggering
 * `auth.api.forgetPassword`; when Better Auth then calls `sendResetPassword`
 * (src/lib/auth/server.ts), {@link consumePendingInvite} returns true exactly
 * once and the "user_invitation" template is dispatched instead of
 * "password_reset".
 *
 * Storage is a module-level in-process Map — same single-process deploy
 * assumption as the in-memory rate limit in auth/server.ts (one Coolify
 * container). If the app ever scales to multiple pods, the mark and the
 * consume could land on different processes; the failure mode is graceful —
 * the user simply receives the plain password-reset email, which still
 * carries a working link.
 */

const TTL_MS = 15 * 60 * 1000; // 15 minutes

/** lowercased email → expiry timestamp (ms epoch). */
const pending = new Map<string, number>();

/**
 * lowercased email → { the captured set-password URL, expiry }. Lets the invite
 * workflow read back the link Better Auth generated inside `sendResetPassword`
 * (which otherwise only emails it) so an admin can be SHOWN the link to relay
 * manually when the invitation email doesn't arrive. One-shot read.
 */
const capturedUrls = new Map<string, { url: string; expiresAt: number }>();

/** Drop every expired entry. Called on each access so the map never grows. */
function prune(now: number): void {
  for (const [email, expiresAt] of pending) {
    if (expiresAt <= now) pending.delete(email);
  }
  for (const [email, v] of capturedUrls) {
    if (v.expiresAt <= now) capturedUrls.delete(email);
  }
}

/** Stash the set-password URL for an in-flight invite (called from
 *  `sendResetPassword` when the address is a pending invite). */
export function captureInviteUrl(email: string, url: string): void {
  const now = Date.now();
  prune(now);
  capturedUrls.set(email.trim().toLowerCase(), { url, expiresAt: now + TTL_MS });
}

/** Read + clear the captured set-password URL for `email` (null when none). */
export function takeInviteUrl(email: string): string | null {
  const now = Date.now();
  prune(now);
  const key = email.trim().toLowerCase();
  const v = capturedUrls.get(key);
  if (!v) return null;
  capturedUrls.delete(key);
  return v.url;
}

/** Flag `email` so the NEXT reset email it receives is the invitation template. */
export function markPendingInvite(email: string): void {
  const now = Date.now();
  prune(now);
  pending.set(email.trim().toLowerCase(), now + TTL_MS);
}

/**
 * Non-consuming peek — true when `email` is currently marked as an invite.
 * Used by `sendVerificationEmail` to SUPPRESS the signup verification email
 * for invitees (the invite link proves mailbox ownership; two emails with
 * contradictory instructions would confuse them), and by `sendResetPassword`
 * to pick the invitation template before deciding whether to consume.
 */
export function hasPendingInvite(email: string): boolean {
  const now = Date.now();
  prune(now);
  return pending.has(email.trim().toLowerCase());
}

/**
 * Returns true (and clears the flag) when `email` was marked within the TTL.
 * One-shot: a second call returns false, so a user-initiated reset right
 * after an invite still gets the regular password-reset email. Callers should
 * consume only AFTER the invitation email actually went out — on a failed
 * dispatch the marker survives (15-min TTL), so a retry via « Envoyer un lien
 * de réinitialisation » re-sends the INVITATION wording, not the reset one.
 */
export function consumePendingInvite(email: string): boolean {
  const now = Date.now();
  prune(now);
  return pending.delete(email.trim().toLowerCase());
}
