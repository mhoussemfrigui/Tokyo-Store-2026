import "server-only";

import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { email_template_overrides, type EmailTemplateOverrideRow } from "./schema";

/** Override row for one template key, or null (⇒ use the code default). */
export async function getEmailOverride(
  key: string,
): Promise<EmailTemplateOverrideRow | null> {
  const [row] = await db
    .select()
    .from(email_template_overrides)
    .where(eq(email_template_overrides.template_key, key))
    .limit(1);
  return row ?? null;
}

/** All overrides (admin list), keyed by template_key for easy merge. */
export async function getEmailOverridesMap(): Promise<
  Map<string, EmailTemplateOverrideRow>
> {
  const rows = await db
    .select()
    .from(email_template_overrides)
    .orderBy(asc(email_template_overrides.template_key));
  return new Map(rows.map((r) => [r.template_key, r]));
}
