import "server-only";

import { z } from "zod";

import { findSubscriberById } from "@/modules/newsletter/queries";
import { unsubscribeEmailFromMarketing } from "@/workflows/customer/unsubscribe";
import { fail, ok, workflow } from "../shared";

/**
 * Admin-initiated opt-out of a newsletter subscriber (« Désinscrire ») — how
 * staff honour a "please remove me" / erasure request received by email or
 * phone, without asking the person to click a footer link.
 *
 * Delegates to `unsubscribeEmailFromMarketing` (the one sanctioned opt-out
 * writer), so it withdraws consent EVERYWHERE the address is marketable: the
 * newsletter row goes inactive (emitting `newsletter.unsubscribed` — audit +
 * outbound webhooks) AND a linked customer account's `marketing_opt_in` is
 * turned off. The row is deliberately KEPT (not deleted): the marketing
 * consent gate is negative-only, so the unsubscribed row IS the suppression
 * record — deleting it would make the address mailable again (e.g. from a
 * pasted campaign list).
 *
 * Idempotent: an already-unsubscribed row is a successful no-op. Unlike the
 * token path, success is VERIFIED (the row is re-read) — a swallowed write
 * failure surfaces as an error instead of a false confirmation.
 */
export const unsubscribeSubscriberSchema = z.object({
  subscriberId: z.string().uuid(),
});

export const unsubscribeSubscriberWorkflow = workflow<
  [z.input<typeof unsubscribeSubscriberSchema>, { actorUserId: string }],
  { subscriberId: string; alreadyInactive: boolean }
>("newsletter.unsubscribe", async (input, { actorUserId }) => {
  const parsed = unsubscribeSubscriberSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "ID invalide.");

  const row = await findSubscriberById(parsed.data.subscriberId);
  if (!row) return fail("not_found", "Abonné introuvable.");

  await unsubscribeEmailFromMarketing(row.email, { actorUserId });
  // The delegate is best-effort (it swallows its own DB errors — right for the
  // anti-enumeration token link, wrong here): an operator honouring a removal /
  // erasure request must never read « désinscrite » for an address that is
  // still mailable. Verify the row actually went inactive.
  if (row.is_active) {
    const after = await findSubscriberById(row.id);
    if (after?.is_active) {
      return fail("internal", "La désinscription n'a pas pu être enregistrée. Réessayez.");
    }
  }
  return ok({ subscriberId: row.id, alreadyInactive: !row.is_active });
});
