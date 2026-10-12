import "server-only";

import { orderService } from "@/modules/order/service";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";

/**
 * Merge a new account's matching GUEST orders into it — link every guest order
 * (`user_id IS NULL`) whose `contact_email` equals `email` to `userId`, so the
 * buyer's pre-account history shows up under their account going forward.
 *
 * The caller MUST have established that the account owns this mailbox:
 *   - {@link claimGuestOrdersAfterVerification} — the email-verification hook,
 *     where clicking the emailed link proves ownership (self-service signup +
 *     the new address of a completed email change);
 *   - {@link claimGuestOrdersForUser} — an admin create/invite, where a staff
 *     operator (holding `users:create`) vouches for the email. That variant
 *     ENFORCES the grant itself (see below) rather than trusting the caller.
 *
 * Best-effort: callers wrap this so a failure never breaks signup/verification.
 */
async function claimGuestOrders(opts: { userId: string; email: string }): Promise<void> {
  await orderService.claimGuestOrders(opts);
}

/** Self-service path: run from the post-verification hook (mailbox proven). */
export async function claimGuestOrdersAfterVerification(opts: {
  userId: string;
  email: string;
}): Promise<void> {
  await claimGuestOrders(opts);
}

/**
 * Admin create/invite path: the operator vouches for the email — and that vouch
 * is ENFORCED here, not assumed. The claim REASSIGNS orders.user_id (it would
 * seize EVERY guest order placed under this email), so it runs ONLY when the
 * acting `actorUserId` actually holds `users:create` — the exact grant the
 * create/invite server actions require. A non-staff actor that reaches this
 * directly (e.g. a workflow invoked outside its gated action) claims NOTHING.
 * A missing/insufficient grant is a silent no-op, not a throw, so callers keep
 * their best-effort contract (the account create/invite still succeeds).
 */
export async function claimGuestOrdersForUser(opts: {
  userId: string;
  email: string;
  /** The staff operator performing the create/invite; must hold `users:create`. */
  actorUserId: string;
}): Promise<void> {
  const perms = await resolveUserPermissions(opts.actorUserId);
  if (!permissionSetAllows(perms, "users", "create")) return;
  await claimGuestOrders({ userId: opts.userId, email: opts.email });
}
