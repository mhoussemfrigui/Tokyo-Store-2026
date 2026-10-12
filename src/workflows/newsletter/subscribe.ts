import "server-only";

import { z } from "zod";

import { newsletterService } from "@/modules/newsletter/service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Newsletter subscribe.
 *
 * Idempotent on email — re-subscribing a previously-unsubscribed address
 * reactivates the existing row rather than inserting a duplicate. Submitting
 * an already-active email is a soft no-op (200 + a polite message) so the
 * form never leaks "this address is in our list" to scrapers.
 *
 * Emits `newsletter.subscribed` so subscribers (the welcome-coupon emailer,
 * structured logs) react without touching this workflow.
 *
 * `ctx.actorUserId` is the SIGNED-IN visitor (null when anonymous). It rides on
 * the event meta so `sync-newsletter-to-profile` only turns a customer
 * account's marketing consent back on when that account's owner subscribed —
 * the public form is unauthenticated, so a bare email proves nothing.
 */

export const subscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  source: z.string().trim().max(60).default("footer"),
  ipAddress: z.string().trim().max(60).nullable().optional(),
  userAgent: z.string().trim().max(500).nullable().optional(),
});

export const subscribeWorkflow = workflow<
  [z.input<typeof subscribeSchema>, { actorUserId?: string | null }?],
  { status: "created" | "reactivated" | "already_active" }
>("newsletter.subscribe", async (input, ctx = {}) => {
  const parsed = subscribeSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Adresse email invalide.");

  const meta = {
    actorUserId: ctx.actorUserId ?? null,
    actorIp: parsed.data.ipAddress ?? null,
  };

  const existing = await newsletterService.findByEmail(parsed.data.email);
  if (existing) {
    if (existing.is_active) {
      return ok({ status: "already_active" });
    }
    await newsletterService.reactivate(existing.id);
    await bus.emit(
      "newsletter.subscribed",
      {
        email: parsed.data.email,
        source: parsed.data.source,
        reactivated: true,
      },
      meta,
    );
    return ok({ status: "reactivated" });
  }

  const row = await newsletterService.insert({
    email: parsed.data.email,
    source: parsed.data.source,
    ip_address: parsed.data.ipAddress ?? null,
    user_agent: parsed.data.userAgent ?? null,
    confirmed_at: new Date(), // single-opt-in for now
  });
  await bus.emit(
    "newsletter.subscribed",
    {
      email: row.email,
      source: row.source,
      reactivated: false,
    },
    meta,
  );
  return ok({ status: "created" });
});
