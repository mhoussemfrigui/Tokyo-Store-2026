import "server-only";

import { z } from "zod";

import { orderService } from "@/modules/order/service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Flag / unflag an order as SPAM (triage). A pure classification toggle — it moves
 * no money and changes no status, only `flagged_spam_at` (+ the actor). A flagged
 * order drops out of the default Commandes list AND the « À traiter » queue
 * (actionableOrderSql excludes it), staying reachable via the « Spam » filter for
 * review / bulk cancellation.
 *
 * Emits `order.edited{changedFields:["flagged_spam"]}` (audited + webhooked) so the
 * ERP can mirror the classification. Idempotent: re-flagging just re-stamps.
 */
const setSpamSchema = z.object({ orderId: z.string().uuid(), spam: z.boolean() });

export const setOrderSpamWorkflow = workflow<
  [z.input<typeof setSpamSchema>, { actorUserId?: string | null }],
  { orderId: string; spam: boolean }
>("order.set_spam", async (input, { actorUserId }) => {
  const parsed = setSpamSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const updated = await orderService.setSpam(
    parsed.data.orderId,
    parsed.data.spam,
    actorUserId ?? null,
  );
  if (!updated) return fail("not_found", "Commande introuvable.");

  await bus.emit(
    "order.edited",
    {
      orderId: updated.id,
      orderNumber: updated.order_number,
      changedFields: ["flagged_spam"],
      actorUserId: actorUserId ?? null,
    },
    { actorUserId: actorUserId ?? null },
  );

  return ok({ orderId: updated.id, spam: parsed.data.spam });
});
