import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import type { RuleNode } from "@/lib/promotions/rule-tree";
import { emailLogService } from "./logs.service";
import { email_campaigns, type EmailCampaignRow, type NewEmailCampaignRow } from "./schema";

/** CRUD for admin bulk campaigns (`email_campaigns`). Per-recipient sends live in
 *  `email_logs` linked by campaign_id; progress is read there. */
class EmailCampaignService {
  async create(input: {
    name?: string | null;
    subject: string;
    body: string;
    templateKey?: string | null;
    audienceKind: string;
    audienceRef?: string | null;
    audienceAddresses?: string | null;
    audienceRuleTree?: RuleNode | null;
    totalRecipients: number;
    createdBy?: string | null;
  }): Promise<EmailCampaignRow> {
    const [row] = await db
      .insert(email_campaigns)
      .values({
        name: input.name ?? null,
        subject: input.subject,
        body: input.body,
        template_key: input.templateKey ?? null,
        audience_kind: input.audienceKind,
        audience_ref: input.audienceRef ?? null,
        audience_addresses: input.audienceAddresses ?? null,
        audience_rule_tree: input.audienceRuleTree ?? null,
        status: "queued",
        total_recipients: input.totalRecipients,
        created_by: input.createdBy ?? null,
        started_at: new Date(),
      } as NewEmailCampaignRow)
      .returning();
    return row;
  }

  async list(limit = 20): Promise<EmailCampaignRow[]> {
    return db
      .select()
      .from(email_campaigns)
      .where(isNull(email_campaigns.deleted_at))
      .orderBy(desc(email_campaigns.created_at))
      .limit(limit);
  }

  /**
   * Advance a campaign's status once its queue is fully drained (called by the
   * mailing drain for each campaign it touched). No-op while rows remain; marks
   * `sent` if anything delivered, else `failed`. The status-guarded WHERE makes
   * concurrent drain ticks idempotent (only a still-queued/sending campaign flips).
   */
  async tallyAndMaybeFinish(campaignId: string): Promise<void> {
    const { remaining, sent, failed } = await emailLogService.campaignTally(campaignId);
    if (remaining > 0 || sent + failed === 0) return; // still draining / nothing finalized
    await db
      .update(email_campaigns)
      .set({
        status: sent > 0 ? "sent" : "failed",
        finished_at: new Date(),
        updated_at: sql`now()`,
      })
      .where(and(eq(email_campaigns.id, campaignId), inArray(email_campaigns.status, ["queued", "sending"])));
  }
}

export const emailCampaignService = new EmailCampaignService();
