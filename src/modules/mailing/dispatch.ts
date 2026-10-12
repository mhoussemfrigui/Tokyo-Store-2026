import "server-only";

import { sendEmail } from "@/lib/email/client";
import { canSendMarketingTo } from "@/lib/email/consent";
import { listUnsubscribeHeaders } from "@/lib/email/list-unsubscribe";
import { signUnsubToken } from "@/lib/crypto/sign";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { htmlToPlainText } from "@/lib/mailing/html-to-text";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { getEmailOverride } from "./queries";
import {
  getEmailTemplate,
  wrap,
  type EmailTemplateKey,
  type EmailTemplateCategory,
} from "./templates";
import { escapeHtml, renderTemplate } from "./render";
import { buildBrandVars, getEmailBrand, type EmailBrandVars } from "./brand";
import { emailLogService } from "./logs.service";

/** Trusted HTML unsubscribe footer for a marketing recipient (empty if no signing
 *  key). `origin` is the resolved public origin (seo.site_url override aware) so the
 *  link honours a runtime domain change — pass `await resolvePublicOrigin()`.
 *  `brandName` is the settings-driven brand (`getEmailBrand().name`, raw — escaped
 *  here); omitted → a brand-neutral « nos offres » (no hard-coded shop name). */
export function unsubFooterHtml(email: string, origin: string, brandName?: string): string {
  const token = signUnsubToken(email);
  if (!token) return "";
  const url = `${origin}/se-desabonner?token=${encodeURIComponent(token)}`;
  const offers = brandName?.trim() ? `aux offres ${escapeHtml(brandName.trim())}` : "à nos offres";
  return (
    `<div style="font-size:11px;color:#4b5563;line-height:1.7;margin-top:8px;">` +
    `Vous recevez cet email car vous êtes inscrit ${offers}. ` +
    `<a href="${url}" style="color:#4b5563;text-decoration:underline;">Se désabonner</a>.</div>`
  );
}

export type DispatchResult = { sent: boolean; skipped?: boolean; queued?: boolean; reason?: string };

export type DispatchEmailInput = {
  /** A registry template key, OR omit it and pass `composed` for an ad-hoc body. */
  key?: EmailTemplateKey;
  /**
   * Ad-hoc composed email (admin campaigns / promo blasts) — no template. The
   * `html` is wrapped in the shared brand layout (so it gets the header/footer +
   * unsubscribe slot). Defaults to the marketing category (consent-gated).
   */
  composed?: { subject: string; html: string; category?: EmailTemplateCategory };
  to: string | string[];
  /** Scalar variables — HTML-escaped before substitution into the body. */
  variables?: Record<string, string | number | null | undefined>;
  /** Pre-built, already-safe HTML fragments (e.g. items_html). NOT escaped. */
  htmlVariables?: Record<string, string>;
  replyTo?: string;
  /** Automation flow that triggered this send (recorded on the log row). */
  flowKey?: string;
  /** Campaign this send belongs to (recorded on the log row). */
  campaignId?: string;
  /**
   * Enqueue (status='queued') instead of sending inline — the mailing cron drains
   * it with throttle + retry. Used for campaigns + large automation fan-outs.
   * Bulk callers MUST pass a SINGLE recipient per call (the unsubscribe footer +
   * consent are per-recipient); the audience resolver fans out one row each.
   */
  bulk?: boolean;
};

/**
 * Templates whose rendered body carries single-use tokens / license keys. Their
 * body + variables are stored as "[redacted]"/null in the send log so a secret
 * never lands in the DB (and they can't be resent — the token is single-use).
 */
const REDACTED_KEYS = new Set<EmailTemplateKey>([
  "password_reset",
  "email_verification",
  // email_change carries a single-use confirmation token (verify_url) that
  // applies an account-security email change — same class as email_verification,
  // so its body+variables must not be persisted, and it must not be resendable.
  "email_change",
  "user_invitation",
  "purge_confirmation",
]);

function buildBodyVars(input: DispatchEmailInput): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.variables ?? {})) {
    vars[k] = escapeHtml(v == null ? "" : v); // escape untrusted scalars
  }
  for (const [k, v] of Object.entries(input.htmlVariables ?? {})) {
    vars[k] = v; // trusted, pre-built (cells already escaped when constructed)
  }
  return vars;
}

/**
 * Merge the resolved brand pieces into a body-var map. The logo/footer/socials
 * fragments are already-built TRUSTED html; brand_name/brand_tagline are scalar
 * tokens that may appear inside the HTML body (e.g. "compte {{ brand_name }}"),
 * so they're HTML-escaped here exactly like any other scalar.
 */
function mergeBrandVars(
  bodyVars: Record<string, string>,
  brand: EmailBrandVars,
): Record<string, string> {
  return {
    ...bodyVars,
    brand_logo: brand.brand_logo,
    brand_footer: brand.brand_footer,
    brand_socials: brand.brand_socials,
    brand_name: escapeHtml(brand.brand_name),
    brand_tagline: escapeHtml(brand.brand_tagline),
    // Validated hex (getEmailBrand) → inlined into CTA/eyebrow style attrs so
    // emails match the storefront theme accent/primary, not a hardcoded orange.
    brand_primary: brand.brand_primary,
    brand_accent: brand.brand_accent,
  };
}

/**
 * The single chokepoint every transactional email funnels through.
 *
 * Resolve template (DB override ?? code default) → gate on the per-TEMPLATE
 * enabled flag (Templates tab) → render (escaped scalars into the HTML, raw
 * scalars into the plain-text subject, trusted pre-built fragments passed
 * through) → send via the active provider. The per-FLOW toggle (Workflows tab,
 * `isFlowEnabled`) and the master `mail.marketing_enabled` switch are separate
 * gates — the flow check lives in each automation's sender; the marketing
 * kill-switch is enforced below. Best-effort: it never throws into a caller flow
 * (a failed welcome email must not block signup); it returns a result to log.
 */
export async function dispatchEmail(input: DispatchEmailInput): Promise<DispatchResult> {
  let category: EmailTemplateCategory;
  let subjectTpl: string;
  let bodyTpl: string;
  let templateKeyForLog: string | null;
  let redacted: boolean;

  if (input.composed) {
    // Ad-hoc composed email (campaign / promo blast): wrap the admin HTML in the
    // brand layout, default to the marketing category.
    category = input.composed.category ?? "marketing";
    subjectTpl = input.composed.subject;
    bodyTpl = wrap(input.composed.html);
    templateKeyForLog = null;
    redacted = false;
  } else {
    if (!input.key) return { sent: false, reason: "no_template" };
    const def = getEmailTemplate(input.key);
    if (!def) {
      console.warn("[mailing] unknown template key:", input.key);
      return { sent: false, reason: "unknown_template" };
    }
    const override = await getEmailOverride(input.key).catch(() => null);
    // An account-security (`critical`) template can never be disabled — the
    // toggle action refuses it, and as defence in depth a stored is_enabled=false
    // row (legacy / pre-guard) is ignored here too: skipping it would silently
    // block sign-up verification and password recovery.
    if (override && !override.is_enabled && !def.critical) {
      return { sent: false, skipped: true, reason: "disabled" };
    }
    category = def.category;
    subjectTpl = override?.subject?.trim() || def.subject;
    bodyTpl = override?.html?.trim() || def.html;
    templateKeyForLog = input.key;
    redacted = REDACTED_KEYS.has(input.key);
  }

  // MARKETING category is consent-gated + carries an unsubscribe footer;
  // account/commerce are transactional (never gated, no footer).
  const isMarketing = category === "marketing";

  // Master marketing kill-switch (mail.marketing_enabled): when OFF, NO marketing
  // email leaves — campaigns AND every automation (birthday/promo/price-drop/…).
  // Enforced here at the single chokepoint so it governs both the inline send and
  // the bulk enqueue paths below. getSettingsMap is request-cached, so the per-
  // recipient fan-out reads it once. Transactional (account/commerce) is unaffected.
  // FAILS CLOSED: an unreadable settings map can't prove the switch is ON, so the
  // marketing send is skipped rather than bypassing an operator-engaged OFF
  // (mirrors the external-API kill-switch). The consent backstop below stays
  // deliberately fail-open.
  if (isMarketing) {
    let settings: Record<string, string | null>;
    try {
      settings = await getSettingsMap();
    } catch {
      return { sent: false, skipped: true, reason: "settings_unavailable" };
    }
    if ((settings["mail.marketing_enabled"]?.trim() || "true") === "false") {
      return { sent: false, skipped: true, reason: "marketing_disabled" };
    }
  }

  // Consent backstop (marketing only): drop suppressed / opted-out recipients at
  // SEND time — so an opt-out between enqueue and the cron drain is still honoured.
  // On a transient check error, allow (the audience resolver already filtered).
  let recipients = Array.isArray(input.to) ? input.to : [input.to];
  if (isMarketing) {
    const allowed: string[] = [];
    for (const r of recipients) {
      if (await canSendMarketingTo(r).catch(() => true)) allowed.push(r);
    }
    if (allowed.length === 0) {
      return { sent: false, skipped: true, reason: "opted_out" };
    }
    recipients = allowed;
  }

  // Defense-in-depth: inline (non-bulk) marketing must be SINGLE-recipient — the
  // unsubscribe footer + List-Unsubscribe header below are built from
  // recipients[0], so a stray multi-recipient inline marketing send would hand
  // everyone the FIRST recipient's opt-out link. No caller does this today
  // (audiences fan out one row per address via bulk:true), but surface it loudly
  // if one ever does, so the convention can't silently rot into a real leak.
  if (isMarketing && !input.bulk && recipients.length > 1) {
    console.warn(
      `[mailing] inline marketing send to ${recipients.length} recipients for "${input.key}" — ` +
        "footer / List-Unsubscribe reflect only the first recipient; use bulk:true for multi-recipient.",
    );
  }

  // Resolve the settings-driven brand ONCE, then inject its rendered pieces as
  // TRUSTED vars (never admin-authored): brand_logo/footer/socials are html,
  // brand_name/brand_tagline are scalars (also used in the subject).
  const brandVars = buildBrandVars(await getEmailBrand());

  // Subject is a plain-text header — render with RAW scalar values so it never
  // shows HTML entities (e.g. "Tom & Jerry", not "Tom &amp; Jerry").
  const rawScalars: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.variables ?? {})) {
    rawScalars[k] = v == null ? "" : String(v);
  }
  rawScalars.brand_name = brandVars.brand_name;
  rawScalars.brand_tagline = brandVars.brand_tagline;

  const bodyVars = mergeBrandVars(buildBodyVars(input), brandVars);
  // {{ unsubscribe_footer }} (shared layout) — the per-recipient unsubscribe link
  // for marketing emails, empty for transactional. Marketing sends are
  // single-recipient (the audience resolver fans out one row per address).
  const origin = isMarketing ? await resolvePublicOrigin() : "";
  bodyVars.unsubscribe_footer = isMarketing
    ? unsubFooterHtml(recipients[0], origin, brandVars.brand_name)
    : "";

  const subject = renderTemplate(subjectTpl, rawScalars);
  const html = renderTemplate(bodyTpl, bodyVars);
  const text = htmlToPlainText(html);

  // Log every send (the mailing system is the source of truth). Sensitive
  // templates persist "[redacted]" so tokens/keys never hit the DB. Logging is
  // best-effort — a log-write failure must never break the send.
  const loggedBody = redacted ? "[redacted]" : html;
  const loggedVars: Record<string, unknown> | null = redacted
    ? null
    : (input.variables as Record<string, unknown> | undefined) ?? null;

  // Bulk path: enqueue a queued row per recipient (the cron drains it) instead of
  // sending inline. Bulk is marketing — store the real rendered body to send later.
  if (input.bulk) {
    await emailLogService
      .enqueue(
        recipients.map((to) => ({
          templateKey: templateKeyForLog,
          toEmail: to,
          subject,
          body: html,
          category,
          flowKey: input.flowKey ?? null,
          campaignId: input.campaignId ?? null,
          replyTo: input.replyTo ?? null,
          variables: loggedVars,
        })),
      )
      .catch((e) => console.error("[mailing] enqueue failed", e));
    return { sent: false, queued: true };
  }

  try {
    const res = await sendEmail({
      to: recipients,
      subject,
      html,
      text,
      replyTo: input.replyTo,
      // RFC 8058 one-click List-Unsubscribe for an inline marketing send (same
      // recipient + token as the footer). Queued (bulk) rows get theirs from the
      // drain at send time.
      headers: isMarketing ? listUnsubscribeHeaders(recipients[0], origin) : undefined,
    });
    for (const to of recipients) {
      void emailLogService
        .record({
          templateKey: templateKeyForLog,
          toEmail: to,
          fromEmail: res.from,
          subject,
          body: loggedBody,
          provider: res.provider,
          status: "sent",
          providerMessageId: res.id,
          category,
          flowKey: input.flowKey ?? null,
          campaignId: input.campaignId ?? null,
          variables: loggedVars,
        })
        .catch(() => {});
    }
    return { sent: true };
  } catch (err) {
    console.error("[mailing] send failed for", input.key, err);
    const message = err instanceof Error ? err.message : String(err);
    for (const to of recipients) {
      void emailLogService
        .record({
          templateKey: templateKeyForLog,
          toEmail: to,
          subject,
          body: loggedBody,
          status: "failed",
          errorMessage: message,
          category,
          flowKey: input.flowKey ?? null,
          campaignId: input.campaignId ?? null,
          variables: loggedVars,
        })
        .catch(() => {});
    }
    return { sent: false, reason: "send_error" };
  }
}

/**
 * Render a template to `{ subject, html }` WITHOUT sending — backs the admin
 * preview. Same resolution as dispatch (override ?? default), so what the
 * operator previews is exactly what ships.
 */
export async function renderEmailForPreview(
  key: string,
  variables: Record<string, string> = {},
  htmlVariables: Record<string, string> = {},
): Promise<{ subject: string; html: string } | null> {
  const def = getEmailTemplate(key);
  if (!def) return null;
  const override = await getEmailOverride(key).catch(() => null);
  const subjectTpl = override?.subject?.trim() || def.subject;
  const bodyTpl = override?.html?.trim() || def.html;

  // Same brand injection as dispatch → what the operator previews/tests is
  // exactly what ships (logo, footer, socials, name/tagline).
  const brandVars = buildBrandVars(await getEmailBrand());

  const bodyVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables)) bodyVars[k] = escapeHtml(v);
  for (const [k, v] of Object.entries(htmlVariables)) bodyVars[k] = v;

  const subjectScalars = { ...variables, brand_name: brandVars.brand_name, brand_tagline: brandVars.brand_tagline };
  return {
    subject: renderTemplate(subjectTpl, subjectScalars),
    html: renderTemplate(bodyTpl, mergeBrandVars(bodyVars, brandVars)),
  };
}
