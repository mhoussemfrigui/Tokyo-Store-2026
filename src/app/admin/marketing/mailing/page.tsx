import type { Metadata } from "next";
import { AlertTriangle } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { mailEnvDefaults, resolveMailProviderConfig } from "@/lib/email/config";
import { isEncryptionConfigured } from "@/lib/crypto/secrets";
import { AdminPageHeader } from "@/components/admin/page-header";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import {
  EMAIL_TEMPLATES,
  EMAIL_FLOWS,
  emailFlowService,
  emailLogService,
  emailCampaignService,
  buildBrandVars,
  getEmailBrand,
  getEmailOverridesMap,
} from "@/modules/mailing";
import { isCriticalTemplate } from "@/modules/mailing/templates";
import { segmentService } from "@/modules/customer/segment.service";
import { formatResetTime } from "@/lib/mailing/daily-limit";

import { MailingTabs } from "./mailing-tabs";
import { LOG_PAGE_SIZE, parseLogParams } from "./logs-params";

export const metadata: Metadata = { title: "Mailing" };

/**
 * The mailing hub — a single multi-tab surface: Campagnes (audience blasts with
 * promotions-parity targeting), Envoi direct (1:1 write & send), Workflows
 * (automations), Modèles (templates), Journaux (send log), and Réglages
 * (provider + global toggles incl. the daily send cap). Everything funnels
 * through the central dispatch chokepoint, so this is the source of truth for
 * all email on the site.
 */
export default async function MailingHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("system_mail", "view");
  const sp = await searchParams;
  // Journaux tab: status / recipient search / page come from the URL and are
  // applied in SQL over the whole log. One extra row = "a next page exists".
  const logFilters = parseLogParams((k) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  });

  const [
    settings,
    overrides,
    flowOverrides,
    brand,
    logs,
    logCounts,
    segments,
    campaigns,
    perms,
    resolvedMail,
  ] = await Promise.all([
    // No `.catch`: the transport + global toggles forms are pre-filled from this.
    // A swallowed read shows marketing ON and the promo codes blank, which a
    // normal save would persist (re-enabling marketing against the operator's
    // choice). A failure reaches the admin error boundary (retry).
    getSettingsMap(),
    getEmailOverridesMap().catch(() => new Map()),
    emailFlowService.getOverridesMap().catch(() => new Map<string, boolean>()),
    getEmailBrand(),
    emailLogService
      .list({
        status: logFilters.status || undefined,
        email: logFilters.q || undefined,
        limit: LOG_PAGE_SIZE + 1,
        offset: (logFilters.page - 1) * LOG_PAGE_SIZE,
      })
      .catch(() => []),
    emailLogService.statusCounts().catch(() => ({}) as Record<string, number>),
    segmentService.list().catch(() => []),
    emailCampaignService.list(10).catch(() => []),
    resolveUserPermissions(session.user.id),
    resolveMailProviderConfig().catch(() => null),
  ]);

  const brandVars = buildBrandVars(brand);
  const envSet = (name: string) => Boolean(process.env[name]?.trim());
  // Owner-level surfaces (mail transport + account-security templates) are
  // editable by a super-admin only — the actions enforce it, the UI mirrors it.
  const isOwner = perms.has(WILDCARD);
  // Capability flags so the UI hides/disables controls a view-only delegate
  // (system_mail:view without update/manage/create) can't actually use — the
  // server actions enforce these regardless, this just removes dead-end buttons.
  const canUpdate = permissionSetAllows(perms, "system_mail", "update"); // toggles, templates, workflows
  const canManage = permissionSetAllows(perms, "system_mail", "manage"); // log pin/delete/resend
  const canCreate = permissionSetAllows(perms, "system_mail", "create"); // send campaigns
  const envDefaults = mailEnvDefaults();

  const templates = EMAIL_TEMPLATES.map((t) => {
    const o = overrides.get(t.key);
    const critical = t.critical === true;
    return {
      key: t.key,
      name: t.name,
      category: t.category,
      description: t.description,
      defaultSubject: t.subject,
      defaultHtml: t.html,
      variables: t.variables,
      subject: o?.subject ?? null,
      html: o?.html ?? null,
      isEnabled: o?.is_enabled ?? true,
      isOverridden: Boolean(o?.subject || o?.html),
      critical,
      // Locked (read-only) for a non-owner critical template OR any delegate
      // without system_mail:update — the save action would refuse either way.
      locked: (critical && !isOwner) || !canUpdate,
    };
  });

  const flows = EMAIL_FLOWS.map((f) => ({
    key: f.key,
    label: f.label,
    description: f.description,
    trigger: f.trigger,
    category: f.category,
    enabled: flowOverrides.has(f.key) ? Boolean(flowOverrides.get(f.key)) : f.default_enabled,
  }));

  // Both kinds are selectable as a campaign audience: resolveCampaignAudience resolves
  // a DYNAMIC segment through the shared SQL compiler (opt-in-gated), just like a manual
  // roster. Dynamic ones are labelled so the operator knows the audience is rule-resolved
  // at send time. (segmentService.list() already returns enabled, non-deleted segments.)
  const campaignSegments = segments.map((s) => ({
    id: s.id,
    name: s.kind === "dynamic" ? `${s.name} (dynamique)` : s.name,
  }));

  // Live per-campaign progress (sent/failed/pending) is DERIVED from the linked
  // email_logs rows — there are no static counters on email_campaigns.
  const campaignProgress = await emailLogService
    .progressByCampaign(campaigns.map((c) => c.id))
    .catch(() => new Map<string, { sent: number; failed: number; pending: number }>());

  const campaignRows = campaigns.map((c) => {
    const p = campaignProgress.get(c.id);
    return {
      id: c.id,
      name: c.name,
      subject: c.subject,
      audienceKind: c.audience_kind,
      status: c.status,
      total: c.total_recipients,
      sent: p?.sent ?? 0,
      failed: p?.failed ?? 0,
      pending: p?.pending ?? 0,
      createdAt: (c.created_at as Date).toISOString(),
    };
  });

  const logRows = logs.map((l) => ({
    id: l.id,
    toEmail: l.to_email,
    subject: l.subject,
    status: l.status,
    category: l.category,
    flowKey: l.flow_key,
    templateKey: l.template_key,
    provider: l.provider,
    error: l.error_message,
    pinned: Boolean(l.pinned_at),
    // Account-security templates are exactly the ones dispatch stores REDACTED
    // (single-use tokens) — the resend action refuses them, so hide the button.
    redacted: l.template_key ? isCriticalTemplate(l.template_key) : false,
    createdAt: (l.created_at as Date).toISOString(),
  }));

  // Unsubscribe links are HMAC-signed with PAYMENT_ENCRYPTION_KEY; without it
  // marketing email would carry no opt-out link, so campaign sends are refused.
  const unsubKeyMissing = !isEncryptionConfigured();

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Mailing"
        description="Centre d'envoi des emails : fournisseur, modèles, automatisations et journaux. Tout passe par ce hub (mots de passe oubliés, bienvenue, commandes, promotions, anniversaires…)."
      />
      {unsubKeyMissing && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-[22px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3 text-xs text-[#b45309]"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Aucune clé de signature n&apos;est configurée (variable PAYMENT_ENCRYPTION_KEY) : les
            emails marketing partiraient sans lien de désabonnement. L&apos;envoi de campagnes est
            bloqué tant qu&apos;elle n&apos;est pas définie (elle est normalement générée
            automatiquement au démarrage du conteneur).
          </span>
        </p>
      )}
      <MailingTabs
        settings={{
          // The EFFECTIVE values (DB pin, else EMAIL_PROVIDER / EMAIL_FROM /
          // EMAIL_REPLY_TO, else the default) — never a hard-coded "console",
          // which an unchanged save used to pin over the env provider.
          provider:
            resolvedMail?.providerName ??
            (settings["mail.provider"]?.trim() || envDefaults.providerName),
          from: resolvedMail?.from ?? (settings["mail.from"]?.trim() || envDefaults.from),
          replyTo:
            resolvedMail?.replyTo ?? (settings["mail.reply_to"]?.trim() || envDefaults.replyTo || ""),
          transport: {
            editable: isOwner,
            envProvider: envDefaults.providerFromEnv ? envDefaults.providerName : null,
            providerPinned: Boolean(settings["mail.provider"]?.trim()),
            fromPinned: Boolean(settings["mail.from"]?.trim()),
            replyToPinned: Boolean(settings["mail.reply_to"]?.trim()),
          },
          smtp: {
            host: settings["mail.smtp_host"]?.trim() || "",
            port: settings["mail.smtp_port"]?.trim() || "587",
            user: settings["mail.smtp_user"]?.trim() || "",
            secure: (settings["mail.smtp_secure"]?.trim() || "false") === "true",
          },
          sendmailPath: settings["mail.sendmail_path"]?.trim() || "/usr/sbin/sendmail",
          marketingEnabled: (settings["mail.marketing_enabled"]?.trim() || "true") !== "false",
          throttlePerMin: settings["mail.throttle_per_min"]?.trim() || "300",
          dailyLimit: settings["mail.daily_limit"]?.trim() || "0",
          dailyResetTime: formatResetTime(settings["mail.daily_reset_time"]),
          reviewDelayDays: settings["mail.review_delay_days"]?.trim() || "4",
          birthdayCode: settings["mail.birthday_code"]?.trim() || "",
          wishlistCampaignCode: settings["mail.wishlist_campaign_code"]?.trim() || "",
          wishlistCampaignSegmentId: settings["mail.wishlist_campaign_segment_id"]?.trim() || "",
          welcomeCode: settings["newsletter.welcome_code"]?.trim() || "",
          locks: {
            from: false,
            replyTo: false,
            smtpHost: envSet("SMTP_HOST"),
            smtpPort: envSet("SMTP_PORT"),
            smtpUser: envSet("SMTP_USER"),
            smtpSecure: envSet("SMTP_SECURE"),
            resendKey: envSet("RESEND_API_KEY"),
            smtpPass: envSet("SMTP_PASSWORD"),
            sendmailPath: envSet("SENDMAIL_PATH"),
          },
          hasValue: {
            resendKey: envSet("RESEND_API_KEY") || Boolean(settings["mail.resend_api_key_enc"]),
            smtpPass: envSet("SMTP_PASSWORD") || Boolean(settings["mail.smtp_password_enc"]),
          },
        }}
        templates={templates}
        brandVars={brandVars}
        flows={flows}
        logs={logRows}
        logCounts={logCounts}
        segments={campaignSegments}
        campaigns={campaignRows}
        canUpdate={canUpdate}
        canManage={canManage}
        canCreate={canCreate}
      />
    </div>
  );
}
