import "server-only";

import { getEmailOverride } from "@/modules/mailing";
import { getSettingsMap } from "@/modules/cms/setting/queries";

export type MarketingGateBlock = "marketing_disabled" | "template_disabled";

/**
 * The two GLOBAL gates `dispatchEmail` applies to a marketing template — the
 * master kill-switch (`mail.marketing_enabled`) and the per-template on/off
 * (Templates tab) — checked ONCE, up front, by a fan-out automation (birthday,
 * review request, promo announcement) BEFORE it claims any `mailing_sends` key.
 * Dispatch would skip every recipient anyway, and claiming first would burn each
 * natural key (the customer's birthday for the year, the order, the promo) so a
 * re-run after re-enabling sends nothing. `null` = clear to send; dispatch still
 * re-checks both (plus per-recipient consent) at send time.
 */
export async function marketingSendBlocked(templateKey: string): Promise<MarketingGateBlock | null> {
  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  if ((settings["mail.marketing_enabled"]?.trim() || "true") === "false") return "marketing_disabled";
  const override = await getEmailOverride(templateKey).catch(() => null);
  if (override && !override.is_enabled) return "template_disabled";
  return null;
}

/** French operator copy for a blocked run (job summaries / logs). */
export function marketingGateSummary(block: MarketingGateBlock, templateKey: string): string {
  return block === "marketing_disabled"
    ? "envoi marketing désactivé (interrupteur général mail.marketing_enabled)"
    : `modèle d'email « ${templateKey} » désactivé`;
}
