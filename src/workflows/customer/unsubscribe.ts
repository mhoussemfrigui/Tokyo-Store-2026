import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { customer_profiles } from "@/modules/customer/schema";
import { customer_user_links } from "@/associations/customer-user";
import { newsletterService } from "@/modules/newsletter/service";
import { bus } from "@/events/bus";

/**
 * Unsubscribe an EMAIL from ALL marketing email. Flips any linked customer
 * profile's `marketing_opt_in=false` (emitting `customer.profile_updated` so the
 * existing `sync-marketing-optin` subscriber mirrors it) AND directly
 * unsubscribes any newsletter row (covers newsletter-only addresses with no
 * profile). This is the ONE sanctioned newsletter→profile reverse writer.
 *
 * Idempotent + best-effort; gives no signal whether the address existed
 * (anti-enumeration is enforced at the route).
 *
 * `opts.actorUserId` names the staff member when an operator does it from the
 * admin (newsletter « Désinscrire », customer archive) so the audit rows carry
 * them; omitted (null) for the recipient's own token-link opt-out.
 */
export async function unsubscribeEmailFromMarketing(
  email: string,
  opts: { actorUserId?: string | null } = {},
): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!e) return;
  const meta = { actorUserId: opts.actorUserId ?? null };

  // Newsletter row (also covers addresses with no customer account).
  const nl = await newsletterService.findByEmail(e).catch(() => null);
  if (nl && nl.is_active) {
    await newsletterService.unsubscribe(nl.id).catch(() => {});
    await bus
      .emit("newsletter.unsubscribed", { email: e, source: nl.source ?? null }, meta)
      .catch(() => {});
  }

  // Linked customer profile → marketing_opt_in=false (+ event for parity with
  // the account-page opt-out path).
  const [row] = await db
    .select({
      pid: customer_profiles.id,
      userId: users.id,
      optIn: customer_profiles.marketing_opt_in,
    })
    .from(users)
    .innerJoin(customer_user_links, eq(customer_user_links.user_id, users.id))
    .innerJoin(customer_profiles, eq(customer_profiles.id, customer_user_links.customer_profile_id))
    .where(sql`lower(${users.email}) = ${e}`)
    .limit(1);

  if (row && row.optIn) {
    await db
      .update(customer_profiles)
      .set({ marketing_opt_in: false, updated_at: sql`now()` })
      .where(eq(customer_profiles.id, row.pid));
    await bus
      .emit(
        "customer.profile_updated",
        { userId: row.userId, customerProfileId: row.pid, changedFields: ["marketing_opt_in"] },
        meta,
      )
      .catch(() => {});
  }
}
