import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { email_flows } from "./schema";

/**
 * Reads/writes the per-flow enable overrides (`email_flows`). Mirrors
 * `mailingService` for templates: a row OPTIONALLY overrides a flow's registry
 * `default_enabled`; no row ⇒ the code default.
 */
class EmailFlowService {
  async getOverridesMap(): Promise<Map<string, boolean>> {
    const rows = await db.select().from(email_flows);
    return new Map(rows.map((r) => [r.flow_key, r.is_enabled] as const));
  }

  async upsert(flowKey: string, enabled: boolean): Promise<void> {
    await db
      .insert(email_flows)
      .values({ flow_key: flowKey, is_enabled: enabled })
      .onConflictDoUpdate({
        target: email_flows.flow_key,
        set: { is_enabled: enabled, updated_at: sql`now()` },
      });
  }
}

export const emailFlowService = new EmailFlowService();
