import "server-only";

import { wrap } from "./templates";
import { renderTemplate, escapeHtml } from "./render";
import { buildBrandVars, getEmailBrand } from "./brand";
import { emailLogService } from "./logs.service";
import { unsubFooterHtml } from "./dispatch";
import { resolvePublicOrigin } from "@/lib/url/public-origin";

/** Placeholder spliced with each recipient's unsubscribe footer (no re-render). */
const SENTINEL = "%%TK_UNSUB_FOOTER%%";

/**
 * Enqueue a composed campaign to a (pre-resolved, consent-filtered) audience.
 * Renders the brand-wrapped body ONCE with a sentinel where the per-recipient
 * unsubscribe footer goes, then bulk-inserts one queued row per recipient with
 * the footer spliced — O(1) renders + O(N) string ops + one insert, so a large
 * blast doesn't fan out thousands of renders. The cron drain re-checks consent
 * at send time and paces delivery. Returns the number enqueued.
 */
export async function enqueueCampaign(opts: {
  subject: string;
  /** Admin-composed inner HTML (already sanitised by the caller). */
  html: string;
  recipients: { email: string }[];
  campaignId: string;
}): Promise<number> {
  if (opts.recipients.length === 0) return 0;
  const brand = buildBrandVars(await getEmailBrand());
  const base = renderTemplate(wrap(opts.html), {
    brand_logo: brand.brand_logo,
    // The shared shell's accent bars/rules use {{ brand_primary }} — without it a
    // campaign rendered with empty tokens (no crimson). Pass it like dispatch.ts does.
    brand_primary: brand.brand_primary,
    brand_footer: brand.brand_footer,
    brand_socials: brand.brand_socials,
    brand_name: escapeHtml(brand.brand_name),
    brand_tagline: escapeHtml(brand.brand_tagline),
    unsubscribe_footer: SENTINEL,
  });
  const origin = await resolvePublicOrigin();
  const rows = opts.recipients.map((r) => ({
    toEmail: r.email,
    subject: opts.subject,
    body: base.replace(SENTINEL, unsubFooterHtml(r.email, origin)),
    category: "marketing" as const,
    campaignId: opts.campaignId,
  }));
  return emailLogService.enqueue(rows);
}
