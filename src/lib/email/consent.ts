import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { customer_profiles } from "@/modules/customer/schema";
import { customer_user_links } from "@/associations/customer-user";
import { newsletter_subscriptions } from "@/modules/newsletter/schema";
import { email_suppressions } from "@/modules/mailing/schema";

/**
 * NEGATIVE consent backstop for MARKETING / automation email. Returns false ONLY
 * for an address that is suppressed (hard bounce / complaint) or has EXPLICITLY
 * opted out — a linked customer with marketing_opt_in=false, or an unsubscribed
 * newsletter row. UNKNOWN addresses pass: positive audience selection happens
 * upstream (the audience resolver), and a pasted campaign list is the operator's
 * explicit choice. Evaluated at SEND time inside dispatch, so an opt-out between
 * enqueue and send is still honoured. Transactional emails never call this.
 *
 * An explicit opt-out is honoured WHATEVER the profile's archive state: the
 * profile join has NO `deleted_at` filter. Archiving a customer (« Supprimer le
 * client ») must narrow consent, never widen it — with a live-profile filter an
 * archived profile's `marketing_opt_in=false` stopped vetoing, so a newsletter
 * row re-activated by an anonymous footer subscribe (which deliberately leaves
 * the profile opt-out winning — sync-newsletter-to-profile) made the address
 * mailable again. POSITIVE opt-in selection (the audiences) keeps requiring a
 * live profile.
 */
/**
 * SET-WISE marketing-consent filter — the batched sibling of
 * {@link canSendMarketingTo}. Given N addresses, returns the subset still
 * marketable using exactly THREE queries (suppressions, profile opt-out,
 * newsletter unsubscribe) via `lower(col) IN (…)`, instead of N×3 serial
 * round-trips. Same NEGATIVE-consent semantics: an address is dropped ONLY if
 * suppressed / explicitly opted out / unsubscribed; unknown addresses pass.
 * Fail-OPEN per dimension: a read error on one query never blocks anyone
 * (mirrors canSendMarketingTo's `.catch(() => true)` callers).
 */
export async function filterMarketableEmails(emails: string[]): Promise<Set<string>> {
  const lowered = Array.from(
    new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  );
  const allowed = new Set(lowered);
  if (lowered.length === 0) return allowed;

  // 1) suppressions (hard bounce / complaint)
  try {
    const rows = await db
      .select({ e: sql<string>`lower(${email_suppressions.email})` })
      .from(email_suppressions)
      .where(inArray(sql`lower(${email_suppressions.email})`, lowered));
    for (const r of rows) allowed.delete(r.e);
  } catch {
    /* fail-open: a read error must not block the blast */
  }

  // 2) explicit profile opt-out (marketing_opt_in = false) — live OR archived
  //    profile: an opt-out survives the archive (see canSendMarketingTo).
  try {
    const rows = await db
      .select({ e: sql<string>`lower(${users.email})` })
      .from(users)
      .innerJoin(customer_user_links, eq(customer_user_links.user_id, users.id))
      .innerJoin(customer_profiles, eq(customer_profiles.id, customer_user_links.customer_profile_id))
      .where(
        and(
          eq(customer_profiles.marketing_opt_in, false),
          inArray(sql`lower(${users.email})`, lowered),
        ),
      );
    for (const r of rows) allowed.delete(r.e);
  } catch {
    /* fail-open */
  }

  // 3) newsletter unsubscribed
  try {
    const rows = await db
      .select({ e: sql<string>`lower(${newsletter_subscriptions.email})` })
      .from(newsletter_subscriptions)
      .where(
        and(
          eq(newsletter_subscriptions.is_active, false),
          inArray(sql`lower(${newsletter_subscriptions.email})`, lowered),
        ),
      );
    for (const r of rows) allowed.delete(r.e);
  } catch {
    /* fail-open */
  }

  return allowed;
}

/**
 * Hard-suppression check (bounce / complaint list ONLY) for a deliberate 1:1
 * manual send. Unlike {@link canSendMarketingTo} it does NOT consider marketing
 * opt-out or newsletter unsubscribe — an operator writing a direct message to one
 * person is transactional, not a marketing blast — but it still refuses an address
 * the provider flagged as a hard bounce / complaint, to protect sender reputation.
 * Case-insensitive; fail-OPEN (a read error never blocks the send).
 */
export async function isSuppressed(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  try {
    const [row] = await db
      .select({ id: email_suppressions.id })
      .from(email_suppressions)
      .where(sql`lower(${email_suppressions.email}) = ${e}`)
      .limit(1);
    return Boolean(row);
  } catch {
    return false; // fail-open: a suppression-read hiccup must not block a 1:1 send
  }
}

export async function canSendMarketingTo(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;

  // Case-insensitive: a suppression/newsletter row may have been written with a
  // different case than the address we're about to email (e.g. a provider bounce
  // webhook posting the original-cased address).
  const [supp] = await db
    .select({ id: email_suppressions.id })
    .from(email_suppressions)
    .where(sql`lower(${email_suppressions.email}) = ${e}`)
    .limit(1);
  if (supp) return false;

  // Explicit profile opt-out — live OR archived profile (no deleted_at filter:
  // archiving must never re-open a closed address).
  const [prof] = await db
    .select({ optIn: customer_profiles.marketing_opt_in })
    .from(users)
    .innerJoin(customer_user_links, eq(customer_user_links.user_id, users.id))
    .innerJoin(customer_profiles, eq(customer_profiles.id, customer_user_links.customer_profile_id))
    .where(sql`lower(${users.email}) = ${e}`)
    .limit(1);
  if (prof && prof.optIn === false) return false;

  const [nl] = await db
    .select({ active: newsletter_subscriptions.is_active })
    .from(newsletter_subscriptions)
    .where(sql`lower(${newsletter_subscriptions.email}) = ${e}`)
    .limit(1);
  if (nl && nl.active === false) return false;

  return true;
}
