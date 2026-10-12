import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import {
  newsletter_subscriptions,
  type NewNewsletterSubscriptionRow,
  type NewsletterSubscriptionRow,
} from "./schema";

class NewsletterService {
  async findByEmail(email: string): Promise<NewsletterSubscriptionRow | null> {
    const [row] = await db
      .select()
      .from(newsletter_subscriptions)
      .where(eq(newsletter_subscriptions.email, email.toLowerCase()))
      .limit(1);
    return row ?? null;
  }

  async insert(input: NewNewsletterSubscriptionRow): Promise<NewsletterSubscriptionRow> {
    // Always lowercase on insert: the Drizzle unique index is case-sensitive,
    // so normalising here (the ONLY insert path) is what makes the
    // case-insensitive `newsletter_email_lower_unique` (baseline raw tail) and
    // the lowercasing `findByEmail` consistent — no mixed-case dup can slip in.
    const [row] = await db
      .insert(newsletter_subscriptions)
      .values({ ...input, email: input.email.toLowerCase() })
      .returning();
    return row;
  }

  async reactivate(id: string): Promise<NewsletterSubscriptionRow | null> {
    // RETURNING the row so callers can emit `newsletter.subscribed` with the
    // real email — the profile-opt-in sync subscriber keys off the address.
    const [row] = await db
      .update(newsletter_subscriptions)
      .set({
        is_active: true,
        unsubscribed_at: null,
        updated_at: sql`now()`,
      })
      .where(eq(newsletter_subscriptions.id, id))
      .returning();
    return row ?? null;
  }

  async unsubscribe(id: string): Promise<void> {
    await db
      .update(newsletter_subscriptions)
      .set({
        is_active: false,
        unsubscribed_at: new Date(),
        updated_at: sql`now()`,
      })
      .where(eq(newsletter_subscriptions.id, id));
  }

  /**
   * Follow an account's sign-in EMAIL CHANGE. Rows are keyed by address (no
   * user link), so without this the subscription stayed on the OLD mailbox: the
   * profile opt-out (sync-marketing-optin, which resolves the user's CURRENT
   * email) then found nothing to switch off and the old address kept getting
   * campaigns. The old row is re-keyed to the new address — consent (and its
   * active / unsubscribed state) follows the customer. When the new address
   * already has its own row, that row wins and the old one is only switched off.
   */
  async followEmailChange(oldEmail: string, newEmail: string): Promise<"none" | "moved" | "deactivated"> {
    const from = oldEmail.trim().toLowerCase();
    const to = newEmail.trim().toLowerCase();
    if (!from || !to || from === to) return "none";
    const old = await this.findByEmail(from);
    if (!old) return "none";
    if (!(await this.findByEmail(to))) {
      try {
        await db
          .update(newsletter_subscriptions)
          .set({ email: to, updated_at: sql`now()` })
          .where(eq(newsletter_subscriptions.id, old.id));
        return "moved";
      } catch (err) {
        // A row for the new address appeared concurrently (case-insensitive
        // unique index) — fall through and just switch the old one off.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    if (!old.is_active) return "none";
    await this.unsubscribe(old.id);
    return "deactivated";
  }

  async list(): Promise<NewsletterSubscriptionRow[]> {
    return db.select().from(newsletter_subscriptions).orderBy(sql`created_at DESC`);
  }
}

export const newsletterService = new NewsletterService();
