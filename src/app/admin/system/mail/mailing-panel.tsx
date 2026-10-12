"use client";

import { useActionState, useMemo, useState } from "react";
import { Eye, EyeOff, Loader2, RotateCcw, Save, Send } from "lucide-react";

import {
  resetEmailTemplateAction,
  saveEmailTemplateAction,
  saveMailSettingsAction,
  sendTestEmailAction,
  toggleEmailTemplateAction,
} from "@/lib/actions/mailing";
import { type ActionState } from "@/lib/actions/types";
import { SelectField } from "@/components/ui/select-field";
import {
  FieldSection,
  NumberField,
  SecretField,
  TextField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";

export type SmtpView = { host: string; port: string; user: string; secure: boolean };
export type MailLocks = {
  from: boolean;
  replyTo: boolean;
  smtpHost: boolean;
  smtpPort: boolean;
  smtpUser: boolean;
  smtpSecure: boolean;
  resendKey: boolean;
  smtpPass: boolean;
  sendmailPath: boolean;
};
export type MailHasValue = { resendKey: boolean; smtpPass: boolean };
/**
 * Who may edit the transport + where provider/from/reply-to come from. The
 * transport (provider, SMTP, sendmail, secrets) receives every email incl.
 * password-reset links, so it's super-admin only (`editable`). Provider/from/
 * reply-to follow the env until a DB row pins them (`*Pinned`).
 */
export type MailTransportView = {
  editable: boolean;
  /** EMAIL_PROVIDER when explicitly set in the environment, else null. */
  envProvider: string | null;
  providerPinned: boolean;
  fromPinned: boolean;
  replyToPinned: boolean;
};

type Variable = { name: string; sample: string; description?: string; isHtml?: boolean };
/**
 * Resolved, settings-driven brand pieces (logo/footer/socials are pre-built
 * HTML; name/tagline are scalars). Injected server-side at dispatch + preview;
 * the panel substitutes the SAME tokens into the client iframe preview so the
 * admin sees the real branding, not empty placeholders.
 */
export type BrandVars = {
  brand_name: string;
  brand_tagline: string;
  brand_logo: string;
  brand_footer: string;
  brand_socials: string;
  /** Theme primary/accent hex — so the preview's CTA/eyebrow match a real send. */
  brand_primary: string;
  brand_accent: string;
};
export type TemplateView = {
  key: string;
  name: string;
  category: "account" | "commerce" | "marketing";
  description: string;
  defaultSubject: string;
  defaultHtml: string;
  variables: Variable[];
  subject: string | null;
  html: string | null;
  isEnabled: boolean;
  isOverridden: boolean;
  /** Account-security template: can never be disabled. */
  critical: boolean;
  /** Critical AND the viewer isn't a super-admin → read-only. */
  locked: boolean;
};

const CATEGORY_LABEL: Record<TemplateView["category"], string> = {
  account: "Compte",
  commerce: "Commerce",
  marketing: "Marketing",
};

const PROVIDER_OPTIONS = [
  { value: "console", label: "Console (test / journaux)" },
  { value: "resend", label: "Resend" },
  { value: "smtp", label: "SMTP (Node)" },
  { value: "internal", label: "Mailer interne (sendmail local)" },
];

/** How the SELECTED provider relates to EMAIL_PROVIDER, when the env sets one. */
function providerHelper(transport: MailTransportView, selected: string): string | undefined {
  if (!transport.editable) return "Réservé à un super-administrateur.";
  const envProvider = transport.envProvider;
  if (!envProvider) return undefined;
  if (selected === envProvider) {
    return transport.providerPinned
      ? `Enregistrer rétablit la valeur de l'environnement (EMAIL_PROVIDER=${envProvider}).`
      : `Défini par l'environnement (EMAIL_PROVIDER=${envProvider}). En choisir un autre ici le remplace.`;
  }
  const label = PROVIDER_OPTIONS.find((o) => o.value === envProvider)?.label ?? envProvider;
  return `Remplace EMAIL_PROVIDER=${envProvider} (environnement). Re-sélectionnez « ${label} » pour revenir à la valeur de l'environnement.`;
}

/** From / Reply-To follow the env (or its default) until an admin value pins them. */
function envFieldHelper(pinned: boolean, envVar: string): string {
  return pinned
    ? `Videz le champ pour revenir à la valeur par défaut (variable ${envVar}).`
    : `Valeur par défaut (variable ${envVar}) — modifiez-la pour la remplacer.`;
}

export function ProviderSettings({
  provider,
  from,
  replyTo,
  smtp,
  sendmailPath,
  locks,
  hasValue,
  transport,
}: {
  provider: string;
  from: string;
  replyTo: string;
  smtp: SmtpView;
  sendmailPath: string;
  locks: MailLocks;
  hasValue: MailHasValue;
  transport: MailTransportView;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    saveMailSettingsAction,
    null,
  );
  const [selected, setSelected] = useState(provider);
  const canEditTransport = transport.editable;

  return (
    <form action={action} className="space-y-5 rounded-3xl border border-border bg-card p-5 sm:p-6">
      <div>
        <h2 className="text-[14.5px] text-foreground">Fournisseur d&apos;envoi</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Choisissez le fournisseur et renseignez ses identifiants. Un identifiant SMTP ou un secret
          défini par variable d&apos;environnement est prioritaire (le champ est alors verrouillé) ;
          le fournisseur, l&apos;expéditeur et le Reply-To suivent l&apos;environnement tant
          qu&apos;ils ne sont pas modifiés ici. Les secrets (clé Resend, mot de passe SMTP) sont
          chiffrés au repos et ne sont jamais réaffichés.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          // No `name` for a non-super-admin: the (disabled) select still shows
          // the provider but posts nothing — the action refuses transport fields.
          name={canEditTransport ? "mail.provider" : undefined}
          label="Fournisseur"
          defaultValue={provider}
          onChange={(v) => setSelected(v)}
          disabled={!canEditTransport}
          helper={providerHelper(transport, selected)}
          options={PROVIDER_OPTIONS}
        />
        <TextField
          name="mail.from"
          label="Expéditeur (From)"
          defaultValue={from}
          placeholder="Tokyo Store <noreply@tokyostore.tn>"
          disabled={locks.from}
          locked={locks.from}
          helper={envFieldHelper(transport.fromPinned, "EMAIL_FROM")}
        />
        <TextField
          name="mail.reply_to"
          label="Répondre à (Reply-To)"
          defaultValue={replyTo}
          placeholder="support@tokyostore.tn"
          disabled={locks.replyTo}
          locked={locks.replyTo}
          helper={envFieldHelper(transport.replyToPinned, "EMAIL_REPLY_TO")}
        />
      </div>

      {!canEditTransport && (
        <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
          Le fournisseur d&apos;envoi et ses identifiants (clé Resend, serveur SMTP, sendmail) ne
          sont modifiables que par un super-administrateur : ils reçoivent tous les emails, y compris
          les liens de réinitialisation de mot de passe. Vous pouvez modifier l&apos;expéditeur et le
          Reply-To.
        </p>
      )}

      {canEditTransport && selected === "resend" && (
        <FieldSection title="Resend" description="Clé API de votre compte Resend (resend.com).">
          <SecretField
            name="mail.resend_api_key"
            label="Clé API Resend"
            hasValue={hasValue.resendKey}
            locked={locks.resendKey}
            helper="Commence par « re_ ». Laissez vide pour conserver la clé existante."
          />
        </FieldSection>
      )}

      {canEditTransport && selected === "smtp" && (
        <FieldSection title="SMTP" description="Serveur SMTP sortant (ex. Mailgun, Brevo, OVH).">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="mail.smtp_host"
              label="Hôte"
              defaultValue={smtp.host}
              placeholder="smtp.example.com"
              disabled={locks.smtpHost}
              locked={locks.smtpHost}
            />
            <NumberField name="mail.smtp_port" label="Port" defaultValue={smtp.port} min={1} disabled={locks.smtpPort} locked={locks.smtpPort} />
            <TextField
              name="mail.smtp_user"
              label="Utilisateur"
              defaultValue={smtp.user}
              disabled={locks.smtpUser}
              locked={locks.smtpUser}
            />
            <SecretField
              name="mail.smtp_password"
              label="Mot de passe"
              hasValue={hasValue.smtpPass}
              locked={locks.smtpPass}
            />
          </div>
          <ToggleField
            name="mail.smtp_secure"
            label="TLS implicite (port 465)"
            description="Activez pour SMTPS (465). Laissez désactivé pour STARTTLS (587)."
            defaultChecked={smtp.secure}
            disabled={locks.smtpSecure}
            locked={locks.smtpSecure}
          />
        </FieldSection>
      )}

      {canEditTransport && selected === "internal" && (
        <FieldSection
          title="Mailer interne"
          description="Envoie via le système de mail LOCAL de l'hôte (sendmail/Postfix), sans relais externe. Nécessite un binaire sendmail installé sur le serveur — sinon préférez SMTP ou Resend."
        >
          <TextField
            name="mail.sendmail_path"
            label="Chemin du binaire sendmail"
            defaultValue={sendmailPath}
            placeholder="/usr/sbin/sendmail"
            disabled={locks.sendmailPath}
            locked={locks.sendmailPath}
          />
        </FieldSection>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Enregistrer
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

/** Minimal HTML escape — mirrors the server's escapeHtml for scalar brand vars. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function TemplateCard({ t, brandVars }: { t: TemplateView; brandVars: BrandVars }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [subject, setSubject] = useState(t.subject ?? t.defaultSubject);
  const [html, setHtml] = useState(t.html ?? t.defaultHtml);

  const [saveState, saveAction, saving] = useActionState<ActionState | null, FormData>(
    saveEmailTemplateAction,
    null,
  );
  // Capture the toggle state so a failure ("Modèle inconnu.") surfaces instead
  // of the click silently doing nothing (success flips via revalidate).
  const [toggleState, toggleAction] = useActionState<ActionState | null, FormData>(
    toggleEmailTemplateAction,
    null,
  );
  // Reset goes through a confirm modal (it discards the custom subject + HTML);
  // a failure renders inside the modal, the success notice below the editor.
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetState, setResetState] = useState<ActionState | null>(null);
  const [testState, testAction, testing] = useActionState<ActionState | null, FormData>(
    sendTestEmailAction,
    null,
  );

  // After a toggle the action revalidates the page, so `t.isEnabled` arrives
  // fresh as a prop — no optimistic local state needed.
  const enabled = t.isEnabled;

  // Client preview — substitute each {{var}} with its sample, PLUS the
  // server-resolved brand tokens (logo/footer/socials/name/tagline). The brand
  // values mirror what dispatch + renderEmailForPreview inject, so the iframe
  // preview reflects real branding and stays identical to sent mail. Rendered
  // inside a sandboxed iframe so any markup (or stray script in unsaved edits)
  // can't execute in the admin context while styles still render faithfully.
  const previewDoc = useMemo(() => {
    let out = html;
    for (const v of t.variables) {
      out = out.replace(new RegExp(`\\{\\{\\s*${v.name}\\s*\\}\\}`, "g"), v.sample);
    }
    // brand_logo/footer/socials are trusted HTML; name/tagline are scalars
    // (escaped to match the server's HTML-body substitution).
    const brandSubs: Record<string, string> = {
      brand_logo: brandVars.brand_logo,
      brand_footer: brandVars.brand_footer,
      brand_socials: brandVars.brand_socials,
      brand_name: escapeHtml(brandVars.brand_name),
      brand_tagline: escapeHtml(brandVars.brand_tagline),
      brand_primary: brandVars.brand_primary,
      brand_accent: brandVars.brand_accent,
    };
    for (const [name, value] of Object.entries(brandSubs)) {
      out = out.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "g"), () => value);
    }
    return out;
  }, [html, t.variables, brandVars]);

  return (
    <div className="rounded-3xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">{t.name}</p>
            <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABEL[t.category]}
            </span>
            {t.isOverridden && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                Personnalisé
              </span>
            )}
            {t.critical && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                Sécurité du compte
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Enable/disable — an account-security email can't be turned off
              (it would silently block verification / password recovery); the
              toggle only reappears to RE-enable one a legacy row disabled. */}
          {t.critical && (enabled || t.locked) ? (
            <span
              title="Email de sécurité du compte : il ne peut pas être désactivé."
              className={`inline-flex h-8 items-center rounded-full px-3 text-[11px] font-semibold ${
                enabled
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-surface text-muted-foreground"
              }`}
            >
              {enabled ? "Toujours actif" : "Désactivé"}
            </span>
          ) : (
            <form action={toggleAction} className="flex items-center gap-1.5">
              <input type="hidden" name="key" value={t.key} />
              <input type="hidden" name="enabled" value={enabled ? "" : "on"} />
              <button
                type="submit"
                className={`inline-flex h-8 items-center rounded-full px-3 text-[11px] font-semibold ${
                  enabled
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "bg-surface text-muted-foreground"
                }`}
              >
                {enabled ? "Activé" : "Désactivé"}
              </button>
              {toggleState && !toggleState.ok && (
                <span role="alert" className="text-[10px] font-medium text-destructive">
                  {toggleState.message}
                </span>
              )}
            </form>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-8 items-center rounded-full border border-border px-3 text-[11px] font-medium hover:bg-surface"
          >
            {open ? "Fermer" : t.locked ? "Consulter" : "Modifier"}
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-4 border-t border-border p-4 sm:p-5">
          {t.locked && (
            <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
              Email de sécurité du compte : il transporte un lien ou un code à usage unique, seul un
              super-administrateur peut le modifier. Aperçu et envoi de test restent disponibles.
            </p>
          )}
          {/* Editor form */}
          <form action={saveAction} className="space-y-3">
            <input type="hidden" name="key" value={t.key} />
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Objet
              </span>
              <input
                name="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                readOnly={t.locked}
                className="mt-1 h-10 w-full rounded-2xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20 read-only:opacity-70"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Corps (HTML)
              </span>
              <textarea
                name="html"
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                readOnly={t.locked}
                rows={12}
                spellCheck={false}
                className="mt-1 w-full rounded-2xl border border-border bg-background p-3 font-mono text-[12px] leading-relaxed focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20 read-only:opacity-70"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {!t.locked && (
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Enregistrer
                </button>
              )}
              <button
                type="button"
                onClick={() => setPreview((v) => !v)}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-border px-4 text-xs font-medium hover:bg-surface"
              >
                {preview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {preview ? "Masquer l'aperçu" : "Aperçu"}
              </button>
              <Feedback state={saveState} />
            </div>
          </form>

          {/* Reset to default */}
          {t.isOverridden && !t.locked && (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[11px] font-medium text-muted-foreground hover:bg-surface"
            >
              <RotateCcw className="h-3 w-3" /> Réinitialiser au modèle par défaut
            </button>
          )}
          {/* Rendered outside the isOverridden branch: the reset flips it to
              false (revalidate), which unmounts the button above. Hidden again
              once a new customisation is saved. */}
          {resetState?.ok && !t.isOverridden && (
            <p role="status" className="text-[11px] font-medium text-emerald-600">
              {resetState.message}
            </p>
          )}
          {confirmReset && (
            <ConfirmDeleteModal
              variant="neutral"
              icon={RotateCcw}
              title="Réinitialiser ce modèle ?"
              description="L'objet et le corps HTML personnalisés seront supprimés : le modèle par défaut sera de nouveau envoyé. Cette action est irréversible."
              confirmLabel="Réinitialiser"
              preview={
                <div className="rounded-2xl border border-border bg-surface/40 p-2 text-xs">
                  <p className="font-medium">{t.name}</p>
                  <p className="text-[11px] text-muted-foreground">{t.key}</p>
                </div>
              }
              onCancel={() => setConfirmReset(false)}
              onConfirm={async () => {
                const fd = new FormData();
                fd.set("key", t.key);
                const res = await resetEmailTemplateAction(null, fd);
                if (!res.ok) return res.message ?? "Erreur";
                // Re-seed the controlled editor with the defaults: the card stays
                // mounted (keyed by template key), so without this the textarea
                // + preview kept the deleted custom HTML and the next « Enregistrer »
                // silently re-created the override the operator just reset.
                setSubject(t.defaultSubject);
                setHtml(t.defaultHtml);
                setResetState(res);
                return null;
              }}
            />
          )}

          {/* Variables reference */}
          <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-3">
            <p className="text-[11px] font-semibold text-muted-foreground">Variables disponibles</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {t.variables.map((v) => (
                <code
                  key={v.name}
                  className="rounded bg-card px-1.5 py-0.5 text-[11px] text-foreground"
                  title={`Exemple : ${v.sample}`}
                >
                  {`{{ ${v.name} }}`}
                </code>
              ))}
            </div>
          </div>

          {/* Preview */}
          {preview && (
            <iframe
              // Sandboxed: no scripts, no same-origin — a safe render of the
              // (possibly unsaved) HTML with sample data substituted.
              sandbox=""
              srcDoc={previewDoc}
              title={`Aperçu ${t.name}`}
              className="h-[420px] w-full rounded-2xl border border-border bg-white"
            />
          )}

          {/* Test send */}
          <form action={testAction} className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <input type="hidden" name="key" value={t.key} />
            <input
              name="to"
              type="email"
              placeholder="adresse@test.tn"
              className="h-9 flex-1 min-w-[180px] rounded-2xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="submit"
              disabled={testing}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-xs font-semibold text-background disabled:opacity-60"
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Envoyer un test
            </button>
            <Feedback state={testState} />
          </form>
        </div>
      )}
    </div>
  );
}

export function Feedback({ state }: { state: ActionState | null }) {
  if (!state) return null;
  return (
    <span
      className={`text-[11px] font-medium ${state.ok ? "text-emerald-600" : "text-destructive"}`}
    >
      {state.message}
    </span>
  );
}
