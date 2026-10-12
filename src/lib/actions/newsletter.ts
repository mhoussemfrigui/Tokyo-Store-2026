"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { unsubscribeSubscriberWorkflow } from "@/workflows/newsletter/unsubscribe";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { getSession, requirePermission } from "@/lib/auth/session";

export type NewsletterState =
  | { ok: true; message: string }
  | { ok: false; message: string };

export type AdminNewsletterState =
  | { ok: true; message?: string }
  | { ok: false; error: string; message: string };

export async function reactivateNewsletterSubscriberAction(
  subscriberId: string,
): Promise<AdminNewsletterState> {
  const session = await requirePermission('newsletter', 'manage');
  const result = await workflows.newsletter.reactivate(
    { subscriberId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/newsletter");
  return { ok: true, message: "Inscrit·e réactivé·e." };
}

/**
 * Staff opt-out (« Désinscrire ») — honours a removal / erasure request made
 * outside the footer link. Withdraws marketing consent everywhere the address
 * is mailable (newsletter row + linked customer account); the row is kept as
 * the suppression record.
 */
export async function unsubscribeNewsletterSubscriberAction(
  subscriberId: string,
): Promise<AdminNewsletterState> {
  const session = await requirePermission("newsletter", "manage");
  const result = await unsubscribeSubscriberWorkflow(
    { subscriberId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/newsletter");
  return {
    ok: true,
    message: result.data.alreadyInactive ? "Adresse déjà désinscrite." : "Adresse désinscrite.",
  };
}

/**
 * Subscribe a visitor to the newsletter. Public, unauthenticated. Always
 * returns a polite message — never leaks whether an email is already in the
 * list (which would be an information disclosure issue for scrapers).
 */
export async function subscribeNewsletterAction(
  _prev: NewsletterState | null,
  formData: FormData,
): Promise<NewsletterState> {
  const email = String(formData.get("email") ?? "").trim();
  const source = String(formData.get("source") ?? "footer");

  if (!email) {
    return { ok: false, message: "Email requis." };
  }

  const h = await headers();
  const ip =
    getClientIp(h) ||
    null;
  const userAgent = h.get("user-agent") || null;

  // One generic success message for EVERY accepted/rate-limited/already-present
  // outcome (see SUBSCRIBE_OK below). Distinct per-status copy
  // ("déjà inscrit·e" vs "inscrit·e") would let a scraper enumerate which
  // addresses are already in the list — exactly what this endpoint must not
  // reveal. Rate-limited returns the same shape so the throttle is invisible too.
  const ipBucket = `newsletter:ip:${ip ?? "anon"}`;
  const rl = await checkRateLimit({ bucket: ipBucket, max: 5, windowSeconds: 60 });
  if (!rl.ok) {
    return SUBSCRIBE_OK;
  }

  // Optional auth: the form is public, but a SIGNED-IN visitor subscribing
  // their own address is the only signal strong enough to re-enable their
  // account's marketing consent (see sync-newsletter-to-profile). Anonymous →
  // null, so typing someone else's email can't re-opt them in.
  const session = await getSession().catch(() => null);

  const result = await workflows.newsletter.subscribe(
    {
      email,
      source,
      ipAddress: ip,
      userAgent,
    },
    { actorUserId: session?.user?.id ?? null },
  );

  if (!result.ok) {
    if (result.error === "validation") {
      return { ok: false, message: "Adresse email invalide." };
    }
    return { ok: false, message: result.message };
  }

  // created / reactivated / already_active all collapse to the same response.
  return SUBSCRIBE_OK;
}

/** Neutral, status-agnostic success response — accurate for a single-opt-in
 *  list (no confirmation email is promised) and identical across every state
 *  so subscription status can't be probed. */
const SUBSCRIBE_OK = {
  ok: true,
  message: "Merci ! Votre inscription est bien prise en compte.",
} as const;
