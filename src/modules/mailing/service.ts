import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { email_template_overrides } from "./schema";

class MailingService {
  /**
   * Upsert a template override. Only the keys present in `patch` are written,
   * so toggling `is_enabled` never clobbers a saved subject/html and vice
   * versa. A new row inherits sensible defaults (null overrides ⇒ code
   * default, enabled).
   */
  async upsertOverride(
    key: string,
    patch: { subject?: string | null; html?: string | null; is_enabled?: boolean },
  ): Promise<void> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    if (patch.subject !== undefined) set.subject = patch.subject;
    if (patch.html !== undefined) set.html = patch.html;
    if (patch.is_enabled !== undefined) set.is_enabled = patch.is_enabled;

    await db
      .insert(email_template_overrides)
      .values({
        template_key: key,
        subject: patch.subject ?? null,
        html: patch.html ?? null,
        is_enabled: patch.is_enabled ?? true,
      })
      .onConflictDoUpdate({ target: email_template_overrides.template_key, set });
  }

  /** Enable/disable an email without touching its copy. */
  async setEnabled(key: string, enabled: boolean): Promise<void> {
    await this.upsertOverride(key, { is_enabled: enabled });
  }

  /** Drop the override row → the template reverts to its code default. */
  async resetOverride(key: string): Promise<void> {
    await db
      .delete(email_template_overrides)
      .where(eq(email_template_overrides.template_key, key));
  }
}

export const mailingService = new MailingService();
