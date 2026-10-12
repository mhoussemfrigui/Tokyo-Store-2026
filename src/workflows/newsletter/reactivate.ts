import "server-only";

import { z } from "zod";

import { newsletterService } from "@/modules/newsletter/service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Admin-initiated reactivation of a previously-unsubscribed entry. Mirrors
 * what `subscribeWorkflow` does when it hits an inactive row, but here it's
 * an explicit operator action against an `id` rather than an email submit.
 */
export const reactivateSubscriberSchema = z.object({
  subscriberId: z.string().uuid(),
});

export const reactivateSubscriberWorkflow = workflow<
  [z.input<typeof reactivateSubscriberSchema>, { actorUserId: string }],
  { subscriberId: string }
>("newsletter.reactivate", async (input, { actorUserId }) => {
  const parsed = reactivateSubscriberSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "ID invalide.");

  const row = await newsletterService.reactivate(parsed.data.subscriberId);
  if (!row) return fail("not_found", "Abonné introuvable.");
  // Emit with the REAL email so `sync-newsletter-to-profile` can flip a linked
  // customer's `marketing_opt_in` back on — otherwise the newsletter row reads
  // "Actif" while the profile stays opted out and the address is un-mailable.
  // That staff override is honoured ONLY for `source: "admin"` + an actor
  // holding `newsletter:manage` (the admin UI confirms the consent implication
  // first); an anonymous footer subscribe can't do it. `reactivated: true`
  // still suppresses the welcome-coupon resend.
  await bus.emit(
    "newsletter.subscribed",
    {
      email: row.email,
      source: "admin",
      reactivated: true,
    },
    { actorUserId },
  );
  return ok({ subscriberId: parsed.data.subscriberId });
});
