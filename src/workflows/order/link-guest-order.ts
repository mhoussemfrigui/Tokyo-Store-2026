import "server-only";

import { z } from "zod";

import { orderService } from "@/modules/order/service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Admin-side "link a guest order to a customer account".
 *
 * A guest order is `user_id IS NULL` with `contact_email` / `contact_phone`
 * carrying the only identity we have. This workflow attaches such an order to
 * an existing auth user so it joins that customer's history (and shows up in
 * their account / points view going forward).
 *
 * Guarded path:
 *   - the order must exist
 *   - it must STILL be a guest order (`user_id IS NULL`). We re-check inside
 *     the workflow rather than trusting the page that rendered the control, so
 *     a stale tab can't re-assign an order that was already linked (or
 *     self-claimed at sign-up via `claimGuestOrders`) to a different account.
 *
 * The candidate-account resolution (matching on contact_email / contact_phone)
 * happens in the action/page layer — by the time we get here the operator has
 * picked a concrete `userId`, so `orderService.linkOrderToUser` sets it
 * unconditionally.
 *
 * Auditing: emits the typed `order.linked_to_user` event after a successful
 * link. The wildcard audit subscriber records it (which actor linked which order
 * to which account), so a privileged guest→account reassignment leaves a
 * first-class audit-trail entry rather than only an `updated_at` bump.
 */
const linkGuestOrderSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().min(1),
});

export const linkGuestOrderWorkflow = workflow<
  [z.input<typeof linkGuestOrderSchema>, { actorUserId: string }],
  { orderId: string; userId: string }
>("order.link_guest", async (input, { actorUserId }) => {
  const parsed = linkGuestOrderSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const existing = await orderService.findById(parsed.data.orderId);
  if (!existing) return fail("not_found", "Commande introuvable.");

  // Guard: only guest orders can be linked. If the order already belongs to an
  // account, refuse rather than silently reassign it.
  if (existing.user_id) {
    return fail(
      "already_linked",
      "Cette commande est déjà rattachée à un compte client.",
    );
  }

  const updated = await orderService.linkOrderToUser(
    parsed.data.orderId,
    parsed.data.userId,
  );
  if (!updated) return fail("not_found", "Commande introuvable.");

  await bus.emit(
    "order.linked_to_user",
    {
      orderId: updated.id,
      orderNumber: existing.order_number,
      userId: parsed.data.userId,
    },
    { actorUserId },
  );

  return ok({ orderId: updated.id, userId: parsed.data.userId });
});
