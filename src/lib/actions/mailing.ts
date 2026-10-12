"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { bus } from "@/events/bus";
import { workflows } from "@/workflows";
import { sendEmail } from "@/lib/email/client";
import { encryptSecret, isEncryptionConfigured } from "@/lib/crypto/secrets";
import { invalidateMailConfigCache, mailEnvDefaults } from "@/lib/email/config";
import { planMailSettingsWrites } from "@/lib/email/mail-settings";
import {
  mailingService,
  renderEmailForPreview,
  getEmailTemplate,
  emailFlowService,
  invalidateFlowCache,
  getEmailFlow,
  emailLogService,
  dispatchEmail,
} from "@/modules/mailing";
import { settingService } from "@/modules/cms/setting/service";
import { emailCampaignService, enqueueCampaign } from "@/modules/mailing";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import {
  AUDIENCE_CAP,
  resolveCampaignAudience,
  type AudienceKind,
} from "@/lib/mailing/audience";
import { isValidRuleTree } from "@/lib/promotions/rule-leaves";
import type { RuleNode } from "@/lib/promotions/rule-tree";
import { formatResetTime } from "@/lib/mailing/daily-limit";
import { filterMarketableEmails, isSuppressed } from "@/lib/email/consent";
import { stripUnsafeEmailHtml } from "@/modules/mailing/render";
import { isCriticalTemplate } from "@/modules/mailing/templates";
import { type ActionState } from "@/lib/actions/types";

const MAILING_PATH = "/admin/marketing/mailing";

function field(fd: FormData, key: string): string | undefined {
  const v = fd.get(key);
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

const envSet = (name: string): boolean => Boolean(process.env[name]?.trim());

/**
 * Super-admin (`*`) check for the OWNER-LEVEL parts of the mailing hub. The
 * mail transport (provider, SMTP relay, sendmail binary, provider secrets)
 * receives every email — password-reset / invitation / verification links
 * included — and the account-security (`critical`) templates carry those
 * single-use tokens. A delegated `system_mail:update` operator could otherwise
 * point the relay (or a template override) at themselves, fire the public
 * « mot de passe oublié » for a super-admin and take the account over.
 */
async function holdsWildcard(userId: string): Promise<boolean> {
  return (await resolveUserPermissions(userId)).has(WILDCARD);
}

const TRANSPORT_OWNER_ONLY: ActionState = {
  ok: false,
  error: "forbidden",
  message:
    "Seul un super-administrateur peut modifier le fournisseur d'envoi et ses identifiants.",
};
const SECURITY_TEMPLATE_OWNER_ONLY: ActionState = {
  ok: false,
  error: "forbidden",
  message:
    "Les emails de sécurité du compte (mot de passe, vérification, invitation…) ne sont modifiables que par un super-administrateur.",
};

/**
 * Provider selection + from/reply-to + SMTP transport + (encrypted) provider
 * secrets. An env var, when set, WINS (it's authoritative) so we skip persisting
 * the DB value for an env-locked field. Secrets (Resend key, SMTP password) are
 * AES-256-GCM encrypted at rest and only written when a new value is typed (an
 * empty submit keeps the existing ciphertext). Never round-trips a secret value.
 *
 * The TRANSPORT fields are super-admin only (see holdsWildcard); a delegated
 * operator's form carries only from/reply-to. Provider/from/reply-to equal to
 * the env/default fallback are stored as NULL so an unchanged save never pins
 * a value over EMAIL_PROVIDER / EMAIL_FROM / EMAIL_REPLY_TO. SMTP fields are
 * only persisted when SMTP is the submitted provider, the sendmail path only for
 * the internal mailer — a save with another provider leaves them intact.
 */
export async function saveMailSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission('system_mail', 'update');
  const actor = { actorUserId: session.user.id };

  // Pure plan first (no write yet): refuses transport fields for a non-owner,
  // stores NULL for values equal to the env/default fallback, only touches the
  // SUBMITTED provider's own fields, skips env-locked ones (lib/email/mail-settings).
  const plan = planMailSettingsWrites(formData, {
    canEditTransport: await holdsWildcard(session.user.id),
    defaults: mailEnvDefaults(),
    envLocked: envSet,
  });
  if (!plan.ok) {
    return plan.error === "forbidden"
      ? TRANSPORT_OWNER_ONLY
      : { ok: false, error: "validation", message: "Fournisseur email inconnu." };
  }

  // Secret intentions + encryption guard BEFORE any write, so a missing
  // encryption key rejects the whole save atomically (no partial plain-field
  // write). Secrets are transport fields — the plan already refused a non-owner.
  const resendKey = field(formData, "mail.resend_api_key");
  const smtpPass = field(formData, "mail.smtp_password");
  const wantsResend = Boolean(resendKey) && !envSet("RESEND_API_KEY");
  const wantsSmtpPass = Boolean(smtpPass) && !envSet("SMTP_PASSWORD");
  if ((wantsResend || wantsSmtpPass) && !isEncryptionConfigured()) {
    return {
      ok: false,
      error: "no_encryption_key",
      message: "Définissez d'abord PAYMENT_ENCRYPTION_KEY pour chiffrer les secrets email.",
    };
  }

  for (const f of plan.writes) {
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value: f.value,
        type: "text",
        groupKey: "mail",
        label: f.label,
      },
      actor,
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  if (wantsResend) {
    await workflows.cms.upsertSetting(
      {
        key: "mail.resend_api_key_enc",
        value: encryptSecret(resendKey!),
        type: "text",
        groupKey: "mail",
        label: "Resend — clé API (chiffrée)",
      },
      actor,
    );
  }
  if (wantsSmtpPass) {
    await workflows.cms.upsertSetting(
      {
        key: "mail.smtp_password_enc",
        value: encryptSecret(smtpPass!),
        type: "text",
        groupKey: "mail",
        label: "SMTP — mot de passe (chiffré)",
      },
      actor,
    );
  }

  invalidateMailConfigCache();
  revalidatePath("/", "layout"); // settings are read in the storefront layout
  revalidatePath(MAILING_PATH);
  return { ok: true, message: "Réglages email enregistrés." };
}

/**
 * Save a template override (subject + body). Body is lightly sanitised — which
 * does NOT stop an override from sending a `{{ reset_url }}`-style token to an
 * external URL, hence account-security (`critical`) templates are super-admin
 * only.
 */
export async function saveEmailTemplateAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission('system_mail', 'update');
  const key = field(formData, "key");
  if (!key || !getEmailTemplate(key)) {
    return { ok: false, error: "validation", message: "Modèle inconnu." };
  }
  if (isCriticalTemplate(key) && !(await holdsWildcard(session.user.id))) {
    return SECURITY_TEMPLATE_OWNER_ONLY;
  }
  const subject = field(formData, "subject") ?? null;
  const rawHtml = formData.get("html");
  const html = rawHtml ? stripUnsafeEmailHtml(String(rawHtml)) : null;
  await mailingService.upsertOverride(key, { subject, html });
  await bus.emit("mailing.template_updated", { templateKey: key }, { actorUserId: session.user.id });
  revalidatePath(MAILING_PATH);
  return { ok: true, message: "Modèle enregistré." };
}

/**
 * Enable/disable a template. Account-security (`critical`) templates can never
 * be DISABLED — dispatch would silently skip them, so no new account could be
 * verified and nobody could reset a password. (Re-enabling one that a legacy
 * row disabled stays allowed, for a super-admin.)
 */
export async function toggleEmailTemplateAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission('system_mail', 'update');
  const key = field(formData, "key");
  if (!key || !getEmailTemplate(key)) {
    return { ok: false, error: "validation", message: "Modèle inconnu." };
  }
  const enabled = formData.get("enabled") === "on";
  if (isCriticalTemplate(key)) {
    if (!enabled) {
      return {
        ok: false,
        error: "validation",
        message:
          "Cet email de sécurité du compte ne peut pas être désactivé (inscription, mot de passe oublié…).",
      };
    }
    if (!(await holdsWildcard(session.user.id))) return SECURITY_TEMPLATE_OWNER_ONLY;
  }
  await mailingService.setEnabled(key, enabled);
  await bus.emit("mailing.template_toggled", { templateKey: key, enabled }, { actorUserId: session.user.id });
  revalidatePath(MAILING_PATH);
  return { ok: true, message: enabled ? "Email activé." : "Email désactivé." };
}

/**
 * Drop the override → revert to the code default. Audited like a save (a
 * reverted security-template override must leave a trail too).
 */
export async function resetEmailTemplateAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission('system_mail', 'manage');
  const key = field(formData, "key");
  if (!key || !getEmailTemplate(key)) {
    return { ok: false, error: "validation", message: "Modèle inconnu." };
  }
  if (isCriticalTemplate(key) && !(await holdsWildcard(session.user.id))) {
    return SECURITY_TEMPLATE_OWNER_ONLY;
  }
  await mailingService.resetOverride(key);
  await bus.emit("mailing.template_updated", { templateKey: key }, { actorUserId: session.user.id });
  revalidatePath(MAILING_PATH);
  return { ok: true, message: "Modèle réinitialisé (valeur par défaut)." };
}

/**
 * Send a test of one template (rendered with its sample variables) to an
 * address. Uses `sendEmail` directly so a DISABLED template can still be
 * tested before going live.
 */
export async function sendTestEmailAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  await requirePermission('system_mail', 'manage');
  const key = field(formData, "key");
  const to = field(formData, "to");
  const def = key ? getEmailTemplate(key) : undefined;
  if (!def) return { ok: false, error: "validation", message: "Modèle inconnu." };
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: "validation", message: "Adresse email invalide." };
  }

  const scalars: Record<string, string> = {};
  const htmlVars: Record<string, string> = {};
  for (const v of def.variables) {
    if (v.isHtml) htmlVars[v.name] = v.sample;
    else scalars[v.name] = v.sample;
  }
  const rendered = await renderEmailForPreview(def.key, scalars, htmlVars);
  if (!rendered) return { ok: false, error: "internal", message: "Rendu impossible." };

  // The test path deliberately uses sendEmail directly (not dispatchEmail) so a
  // DISABLED template can still be tested — but it is still LOGGED, so the hub's
  // "centre of all mailing" invariant keeps ZERO silent bypass. Sample-rendered
  // (placeholder tokens), so storing the subject is safe; body is left out.
  const subject = `[TEST] ${rendered.subject}`;
  try {
    const sent = await sendEmail({ to, subject, html: rendered.html });
    await emailLogService
      .record({
        templateKey: def.key,
        toEmail: to,
        fromEmail: sent.from,
        subject,
        provider: sent.provider,
        providerMessageId: sent.id ?? null,
        status: "sent",
        category: "account",
        metadata: { test: true },
      })
      .catch(() => null);
  } catch {
    await emailLogService
      .record({
        templateKey: def.key,
        toEmail: to,
        subject,
        status: "failed",
        category: "account",
        errorMessage: "Échec de l'envoi (test)",
        metadata: { test: true },
      })
      .catch(() => null);
    return {
      ok: false,
      error: "send",
      message:
        "Échec de l'envoi — vérifiez le fournisseur et ses clés (variables d'environnement).",
    };
  }
  return { ok: true, message: `Test envoyé à ${to}.` };
}

/* ── Automation flows (Workflows tab) ─────────────────────────────────── */

/** Enable/disable an automation flow (email_flows override). */
export async function toggleEmailFlowAction(input: {
  flowKey: string;
  enabled: boolean;
}): Promise<ActionState> {
  const session = await requirePermission("system_mail", "update");
  if (!getEmailFlow(input.flowKey)) {
    return { ok: false, error: "validation", message: "Flux inconnu." };
  }
  await emailFlowService.upsert(input.flowKey, input.enabled);
  invalidateFlowCache();
  await bus.emit("mailing.flow_toggled", { flowKey: input.flowKey, enabled: input.enabled }, { actorUserId: session.user.id });
  revalidatePath(MAILING_PATH);
  return { ok: true, message: input.enabled ? "Automatisation activée." : "Automatisation désactivée." };
}

/* ── Global mailing toggles (Settings tab) ────────────────────────────── */

/**
 * Master + per-category kill-switches + throttle. Written through the settings
 * workflow like every other settings panel (validation, no-op skip, one
 * `setting.upserted` per REAL change, acting admin on each), and the summary
 * `mailing.global_settings_updated` lists only the keys whose stored value
 * actually changed — skipped entirely for an unchanged save, so the audit /
 * webhook trail no longer claims the marketing kill-switch and both promo codes
 * flipped on every click.
 */
export async function saveMailGlobalTogglesAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_mail", "update");
  const actor = { actorUserId: session.user.id };
  const bool = (k: string) => (formData.get(k) === "on" ? "true" : "false");
  const writes: Array<{
    key: string;
    value: string;
    type: "boolean" | "number" | "text";
    groupKey: string;
    label: string;
  }> = [
    {
      key: "mail.marketing_enabled",
      value: bool("mail.marketing_enabled"),
      type: "boolean",
      groupKey: "mail",
      label: "Emails marketing activés",
    },
  ];
  const throttle = field(formData, "mail.throttle_per_min");
  if (throttle && Number(throttle) > 0) {
    writes.push({
      key: "mail.throttle_per_min",
      value: String(Math.floor(Number(throttle))),
      type: "number",
      groupKey: "mail",
      label: "Débit d'envoi (par minute)",
    });
  }
  const reviewDelay = field(formData, "mail.review_delay_days");
  if (reviewDelay && Number(reviewDelay) > 0) {
    writes.push({
      key: "mail.review_delay_days",
      value: String(Math.max(1, Math.floor(Number(reviewDelay)))),
      type: "number",
      groupKey: "mail",
      label: "Délai demande d'avis (jours)",
    });
  }
  // Daily marketing-send cap (0 = unlimited) + its store-local reset time. Always
  // written (0 is a valid "unlimited", so no >0 guard); the reset time is
  // normalised to canonical HH:MM. The drain reads both to pause/resume marketing.
  writes.push(
    {
      key: "mail.daily_limit",
      value: String(Math.max(0, Math.floor(Number(field(formData, "mail.daily_limit")) || 0))),
      type: "number",
      groupKey: "mail",
      label: "Limite d'envoi marketing par jour (0 = illimité)",
    },
    {
      key: "mail.daily_reset_time",
      value: formatResetTime(field(formData, "mail.daily_reset_time")),
      type: "text",
      groupKey: "mail",
      label: "Heure de réinitialisation du quota quotidien",
    },
  );
  // Automation promo codes (the live promotion behind each automation).
  writes.push(
    {
      key: "mail.birthday_code",
      value: field(formData, "mail.birthday_code") ?? "",
      type: "text",
      groupKey: "mail",
      label: "Code promo anniversaire",
    },
    {
      key: "mail.wishlist_campaign_code",
      value: field(formData, "mail.wishlist_campaign_code") ?? "",
      type: "text",
      groupKey: "mail",
      label: "Code promo campagne liste d'envies",
    },
    {
      key: "mail.wishlist_campaign_segment_id",
      value: field(formData, "mail.wishlist_campaign_segment_id") ?? "",
      type: "text",
      groupKey: "mail",
      label: "Segment cible campagne liste d'envies",
    },
    {
      key: "newsletter.welcome_code",
      value: field(formData, "newsletter.welcome_code") ?? "",
      type: "text",
      groupKey: "newsletter",
      label: "Code promo de bienvenue (newsletter)",
    },
  );

  const changedFields: string[] = [];
  for (const w of writes) {
    // Read the stored value first: the workflow skips a no-op itself, but only
    // this comparison tells the summary event which keys REALLY changed.
    const before = await settingService.findByKey(w.key);
    const res = await workflows.cms.upsertSetting(w, actor);
    if (!res.ok) {
      if (changedFields.length > 0) invalidateMailConfigCache(); // earlier keys did land
      return { ok: false, error: res.error, message: res.message };
    }
    if (!before || before.value !== w.value) changedFields.push(w.key);
  }

  if (changedFields.length > 0) {
    invalidateMailConfigCache();
    await bus.emit("mailing.global_settings_updated", { changedFields }, actor);
  }
  revalidatePath(MAILING_PATH);
  return { ok: true, message: "Réglages enregistrés." };
}

/* ── Send-log management (Logs tab) ───────────────────────────────────── */

export async function pinEmailLogAction(input: { id: string; pinned: boolean }): Promise<ActionState> {
  await requirePermission("system_mail", "manage");
  await emailLogService.setPinned(input.id, input.pinned);
  revalidatePath(MAILING_PATH);
  return { ok: true, message: input.pinned ? "Épinglé." : "Désépinglé." };
}

export async function deleteEmailLogAction(input: { id: string }): Promise<ActionState> {
  await requirePermission("system_mail", "manage");
  await emailLogService.softDelete(input.id);
  revalidatePath(MAILING_PATH);
  return { ok: true, message: "Entrée supprimée." };
}

/** Re-queue a prior send (refuses redacted rows — token already stale). */
export async function resendEmailLogAction(input: { id: string }): Promise<ActionState> {
  await requirePermission("system_mail", "manage");
  const ok = await emailLogService.requeueFrom(input.id);
  if (!ok) {
    return { ok: false, error: "validation", message: "Renvoi impossible (email protégé ou incomplet)." };
  }
  revalidatePath(MAILING_PATH);
  return { ok: true, message: "Email remis en file d'envoi." };
}

/* ── Campaigns / manual send (Envoi tab) ──────────────────────────────── */

function audienceArgs(formData: FormData): {
  kind: AudienceKind;
  segmentId?: string;
  addresses?: string;
  ruleTree?: RuleNode;
} {
  const kind = (field(formData, "audienceKind") ?? "marketing_optin") as AudienceKind;
  // Inline rule (audience_kind='rule'): parse + validate the posted tree with the
  // same fail-closed validator the segment engine uses. An invalid/absent tree
  // resolves to nobody (the composer already disables send on an invalid rule).
  let ruleTree: RuleNode | undefined;
  if (kind === "rule") {
    const raw = field(formData, "ruleTree");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as RuleNode;
        if (isValidRuleTree(parsed)) ruleTree = parsed;
      } catch {
        /* invalid JSON → undefined → empty audience */
      }
    }
  }
  return {
    kind,
    segmentId: field(formData, "segmentId"),
    addresses: field(formData, "addresses"),
    ruleTree,
  };
}

/**
 * Resolve a campaign audience AND run the negative consent gate on it, for
 * EVERY kind (the resolver only filtered pasted lists). Suppressed / opted-out /
 * unsubscribed addresses are dropped up front, so the count the operator
 * confirms is what actually gets enqueued — they used to be enqueued and then
 * cut by the drain, surfacing as campaign « échecs ». The drain still re-checks
 * at send time (opt-out race). `capped` = the resolver hit AUDIENCE_CAP, i.e.
 * the audience was TRUNCATED and some eligible recipients will not get it.
 */
async function resolveSendableAudience(a: ReturnType<typeof audienceArgs>) {
  const { recipients: resolved, truncated: capped } = await resolveCampaignAudience(a.kind, {
    segmentId: a.segmentId,
    addresses: a.addresses,
    ruleTree: a.ruleTree,
  });
  if (resolved.length === 0) return { recipients: resolved, capped };
  const marketable = await filterMarketableEmails(resolved.map((r) => r.email));
  return { recipients: resolved.filter((r) => marketable.has(r.email)), capped };
}

/** Resolve the audience and return only its size — backs the count preview and
 *  the pre-send confirmation. `failed` = the audience/consent read errored: the
 *  count is then UNKNOWN (not 0), so the UI must not report an empty audience. */
export async function previewAudienceCountAction(
  formData: FormData,
): Promise<{ count: number; capped: boolean; cap: number; failed?: boolean }> {
  await requirePermission("system_mail", "create");
  try {
    const { recipients, capped } = await resolveSendableAudience(audienceArgs(formData));
    return { count: recipients.length, capped, cap: AUDIENCE_CAP };
  } catch (err) {
    console.error("[mailing] audience preview failed", err);
    return { count: 0, capped: false, cap: AUDIENCE_CAP, failed: true };
  }
}

/** Compose + send a bulk campaign: resolve audience → enqueue (cron drains). */
export async function createAndSendCampaignAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_mail", "create");

  const subject = field(formData, "subject");
  const body = field(formData, "body");
  if (!subject || !body) {
    return { ok: false, error: "validation", message: "Objet et corps requis." };
  }

  // Master marketing kill-switch — FAILS CLOSED: an unreadable settings map can't
  // prove the switch is ON, so the campaign is refused rather than queued.
  let settings: Record<string, string | null>;
  try {
    settings = await getSettingsMap();
  } catch {
    return {
      ok: false,
      error: "settings_unavailable",
      message:
        "Réglages indisponibles — impossible de vérifier que les emails marketing sont activés. Réessayez dans un instant.",
    };
  }
  if ((settings["mail.marketing_enabled"]?.trim() || "true") === "false") {
    return {
      ok: false,
      error: "disabled",
      message: "Les emails marketing sont désactivés (Réglages → Réglages globaux).",
    };
  }

  // No signing key ⇒ signUnsubToken returns "" and every campaign email would go
  // out WITHOUT its unsubscribe link (the only opt-out we offer). Refuse rather
  // than send non-compliant marketing mail; the hub shows the same warning.
  if (!isEncryptionConfigured()) {
    return {
      ok: false,
      error: "no_unsubscribe_key",
      message:
        "Envoi bloqué : aucune clé de signature (PAYMENT_ENCRYPTION_KEY) n'est configurée, les emails partiraient sans lien de désabonnement.",
    };
  }

  const a = audienceArgs(formData);
  const { recipients, capped } = await resolveSendableAudience(a);
  if (recipients.length === 0) {
    return { ok: false, error: "validation", message: "Aucun destinataire éligible pour cette audience." };
  }

  const safeBody = stripUnsafeEmailHtml(body);
  const campaign = await emailCampaignService.create({
    name: field(formData, "name") ?? null,
    subject,
    body: safeBody,
    audienceKind: a.kind,
    audienceRef: a.segmentId ?? null,
    audienceAddresses: a.kind === "addresses" ? (a.addresses ?? null) : null,
    audienceRuleTree: a.kind === "rule" ? (a.ruleTree ?? null) : null,
    totalRecipients: recipients.length,
    createdBy: session.user.id,
  });

  const enqueued = await enqueueCampaign({
    subject,
    html: safeBody,
    recipients,
    campaignId: campaign.id,
  });

  await bus.emit(
    "mailing.campaign_sent",
    { campaignId: campaign.id, audienceCount: enqueued, subject },
    { actorUserId: session.user.id },
  );

  revalidatePath(MAILING_PATH);
  return {
    ok: true,
    message:
      `Campagne mise en file pour ${enqueued} destinataire${enqueued === 1 ? "" : "s"} (envoi progressif).` +
      (capped ? ` Limite de ${AUDIENCE_CAP} atteinte : l'audience a été tronquée.` : ""),
  };
}

/**
 * Send a one-off email to a SINGLE address — « rédigez et envoyez ». A deliberate
 * manual 1:1 message (category "account"), so it is NOT marketing-consent gated
 * (it always delivers to the intended person) but it DOES refuse a HARD-suppressed
 * address (bounce / complaint) to protect sender reputation. Routed through the
 * central `dispatchEmail` chokepoint, so it is brand-wrapped and LOGGED like every
 * other send — no silent bypass. Gated on system_mail:create.
 */
export async function sendIndividualEmailAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  await requirePermission("system_mail", "create");
  const to = field(formData, "to");
  const subject = field(formData, "subject");
  const body = field(formData, "body");
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: "validation", message: "Adresse email invalide." };
  }
  if (!subject || !body) {
    return { ok: false, error: "validation", message: "Objet et corps requis." };
  }
  if (await isSuppressed(to)) {
    return {
      ok: false,
      error: "suppressed",
      message:
        "Cette adresse est sur la liste de suppression (rebond ou plainte) — envoi bloqué pour protéger la délivrabilité.",
    };
  }
  const res = await dispatchEmail({
    composed: { subject, html: stripUnsafeEmailHtml(body), category: "account" },
    to,
  });
  if (!res.sent) {
    return {
      ok: false,
      error: "send",
      message: "Échec de l'envoi — vérifiez le fournisseur email et ses clés.",
    };
  }
  revalidatePath(MAILING_PATH);
  return { ok: true, message: `Email envoyé à ${to}.` };
}
