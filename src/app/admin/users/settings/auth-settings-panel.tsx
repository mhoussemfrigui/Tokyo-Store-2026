"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Save, Trash2, TriangleAlert } from "lucide-react";

import { clearOAuthCredentialsAction, saveAuthSettingsAction } from "@/lib/actions/auth-settings";
import { EMAIL_VERIFICATION_REQUIRED_KEY } from "@/lib/auth/policy";
import { type ActionState } from "@/lib/actions/types";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { FormTabs, FormTab, type FormTabDef } from "@/components/admin/_components/form-tabs";
import {
  FieldSection,
  SecretField,
  TextField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { AUTH_PAGE_DEFAULTS, AUTH_PERKS_AS_TEXT } from "@/lib/auth/pages-defaults";
import { PerksEditor } from "./perks-editor";

const truthy = (v: string | null | undefined): boolean => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

/**
 * Built-in defaults — the SINGLE SOURCE OF TRUTH `AUTH_PAGE_DEFAULTS`
 * (src/lib/auth/pages-defaults.ts), shared verbatim with `getAuthPagesConfig` and
 * `AUTH_PAGES_FALLBACK` so the panel pre-fill can never drift from what the
 * storefront actually renders (a no-op save writes back the identical default).
 * Pre-filled into the fields so the panel never looks empty; clearing a field
 * still restores the default.
 */
const DEFAULTS = {
  loginTitle: AUTH_PAGE_DEFAULTS.login.title,
  loginSubtitle: AUTH_PAGE_DEFAULTS.login.subtitle,
  loginPanelTitle: AUTH_PAGE_DEFAULTS.login.panelTitle,
  loginPanelSubtitle: AUTH_PAGE_DEFAULTS.login.panelSubtitle,
  loginPerks: AUTH_PERKS_AS_TEXT.login,
  registerTitle: AUTH_PAGE_DEFAULTS.register.title,
  registerPanelBadge: AUTH_PAGE_DEFAULTS.register.panelBadge,
  registerPanelTitle: AUTH_PAGE_DEFAULTS.register.panelTitle,
  registerPerks: AUTH_PERKS_AS_TEXT.register,
  registerFootnote: AUTH_PAGE_DEFAULTS.register.footnote,
  forgotTitle: AUTH_PAGE_DEFAULTS.forgotPassword.title,
  forgotSubtitle: AUTH_PAGE_DEFAULTS.forgotPassword.subtitle,
  resetTitle: AUTH_PAGE_DEFAULTS.resetPassword.title,
  resetSubtitle: AUTH_PAGE_DEFAULTS.resetPassword.subtitle,
  resetInvalidTitle: AUTH_PAGE_DEFAULTS.resetPassword.invalidTitle,
  resetInvalidBody: AUTH_PAGE_DEFAULTS.resetPassword.invalidBody,
  verifyIncompleteTitle: AUTH_PAGE_DEFAULTS.verifyEmail.incompleteTitle,
  verifyIncompleteBody: AUTH_PAGE_DEFAULTS.verifyEmail.incompleteBody,
  verifyInvalidTitle: AUTH_PAGE_DEFAULTS.verifyEmail.invalidTitle,
  verifyInvalidBody: AUTH_PAGE_DEFAULTS.verifyEmail.invalidBody,
} as const;

/** One OAuth credential input's status, computed server-side (page.tsx). */
export type ProviderCredField = {
  name: string;
  label: string;
  /** A value is resolvable (env or DB) — shows the "défini" badge. */
  hasValue: boolean;
  /** Force-locked by a set env var — the input is disabled. */
  locked: boolean;
  envVar: string;
};

export type ProviderCredData = {
  provider: "google" | "facebook";
  label: string;
  /** Both id + secret resolvable — the provider can actually be used. */
  ready: boolean;
  callbackUrl: string;
  idField: ProviderCredField;
  secretField: ProviderCredField;
};

type SettingsTabId = "pages" | "social" | "security";

const SETTINGS_TABS: ReadonlyArray<FormTabDef<SettingsTabId>> = [
  { id: "pages", label: "Pages connexion & inscription" },
  { id: "social", label: "Connexion sociale" },
  { id: "security", label: "Sécurité" },
];

/**
 * One form, three tabs — login/register page copy, social login (toggles +
 * OAuth credentials), and account security (email-verification policy). All tabs
 * submit together in a single `saveAuthSettingsAction` call (`FormTabs` keeps
 * hidden panels mounted).
 * Copy fields are pre-filled with their default so the panel isn't empty;
 * clearing a field restores the default text.
 */
export function AuthSettingsPanel({
  settings,
  providers,
  encryptionReady,
  authOriginDiffers = false,
}: {
  settings: Record<string, string | null>;
  providers: ProviderCredData[];
  /** PAYMENT_ENCRYPTION_KEY is available — required to store new credentials. */
  encryptionReady: boolean;
  /** BETTER_AUTH_URL and NEXT_PUBLIC_SITE_URL resolve to different origins — the
   *  OAuth redirect_uri uses the former, so surface a note next to the callback URL. */
  authOriginDiffers?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveAuthSettingsAction,
    null,
  );

  // Pre-fill a copy field with its stored value, falling back to the default
  // text (so the panel shows real content rather than an empty box).
  const copy = (key: string, fallback: string) => settings[key]?.trim() || fallback;

  return (
    <form action={formAction} className="space-y-6">
      <FormTabs tabs={SETTINGS_TABS} defaultTab="pages">
        {(active) => (
          <>
            {/* ─── Pages connexion & inscription ─────────────────────────── */}
            <FormTab id="pages" active={active}>
              <FieldSection
                title="Page de connexion"
                description="Textes affichés sur /login. Videz un champ pour revenir au texte par défaut."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="auth.login.title"
                    label="Titre du formulaire"
                    defaultValue={copy("auth.login.title", DEFAULTS.loginTitle)}
                    placeholder={DEFAULTS.loginTitle}
                    helper="Vide = texte par défaut."
                  />
                  <TextField
                    name="auth.login.subtitle"
                    label="Sous-titre du formulaire"
                    defaultValue={copy("auth.login.subtitle", DEFAULTS.loginSubtitle)}
                    placeholder={DEFAULTS.loginSubtitle}
                    helper="Vide = texte par défaut."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="auth.login.panel_title"
                    label="Panneau latéral — titre"
                    defaultValue={copy("auth.login.panel_title", DEFAULTS.loginPanelTitle)}
                    placeholder={DEFAULTS.loginPanelTitle}
                    helper="Vide = texte par défaut."
                  />
                  <TextField
                    name="auth.login.panel_subtitle"
                    label="Panneau latéral — sous-titre"
                    defaultValue={copy("auth.login.panel_subtitle", DEFAULTS.loginPanelSubtitle)}
                    placeholder={DEFAULTS.loginPanelSubtitle}
                    helper="Vide = texte par défaut."
                  />
                </div>
                <PerksEditor
                  name="auth.login.perks"
                  label="Avantages du panneau latéral"
                  defaultValue={copy("auth.login.perks", DEFAULTS.loginPerks)}
                  helper="Puces du panneau latéral — ajoutez, retirez, réordonnez. Restez vague (pas de promesses chiffrées). Liste vide = liste par défaut."
                />
              </FieldSection>

              <FieldSection
                title="Page d'inscription"
                description="Textes affichés sur /register. Videz un champ pour revenir au texte par défaut."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="auth.register.title"
                    label="Titre du formulaire"
                    defaultValue={copy("auth.register.title", DEFAULTS.registerTitle)}
                    placeholder={DEFAULTS.registerTitle}
                    helper="Vide = texte par défaut."
                  />
                  <TextField
                    name="auth.register.panel_badge"
                    label="Panneau latéral — badge"
                    defaultValue={copy("auth.register.panel_badge", DEFAULTS.registerPanelBadge)}
                    placeholder={DEFAULTS.registerPanelBadge}
                    helper="Vide = texte par défaut."
                  />
                </div>
                <TextField
                  name="auth.register.panel_title"
                  label="Panneau latéral — titre"
                  defaultValue={copy("auth.register.panel_title", DEFAULTS.registerPanelTitle)}
                  placeholder={DEFAULTS.registerPanelTitle}
                  helper="Vide = texte par défaut."
                />
                <PerksEditor
                  name="auth.register.perks"
                  label="Avantages du panneau latéral"
                  defaultValue={copy("auth.register.perks", DEFAULTS.registerPerks)}
                  helper="Puces du panneau latéral — ajoutez, retirez, réordonnez. Restez vague (pas de promesses chiffrées). Liste vide = liste par défaut."
                />
                <TextField
                  name="auth.register.footnote"
                  label="Note de bas de page"
                  defaultValue={copy("auth.register.footnote", DEFAULTS.registerFootnote)}
                  placeholder={DEFAULTS.registerFootnote}
                  helper="Vide = texte par défaut."
                />
              </FieldSection>

              <FieldSection
                title="Mot de passe oublié"
                description="Textes affichés sur /forgot-password. Videz un champ pour revenir au texte par défaut."
              >
                <TextField
                  name="auth.forgot.title"
                  label="Titre"
                  defaultValue={copy("auth.forgot.title", DEFAULTS.forgotTitle)}
                  placeholder={DEFAULTS.forgotTitle}
                  helper="Vide = texte par défaut."
                />
                <TextField
                  name="auth.forgot.subtitle"
                  label="Sous-titre"
                  defaultValue={copy("auth.forgot.subtitle", DEFAULTS.forgotSubtitle)}
                  placeholder={DEFAULTS.forgotSubtitle}
                  helper="Vide = texte par défaut."
                />
              </FieldSection>

              <FieldSection
                title="Réinitialisation du mot de passe"
                description="Textes affichés sur /reset-password (formulaire et écran « lien invalide »). Videz un champ pour revenir au texte par défaut."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="auth.reset.title"
                    label="Titre"
                    defaultValue={copy("auth.reset.title", DEFAULTS.resetTitle)}
                    placeholder={DEFAULTS.resetTitle}
                    helper="Vide = texte par défaut."
                  />
                  <TextField
                    name="auth.reset.subtitle"
                    label="Sous-titre"
                    defaultValue={copy("auth.reset.subtitle", DEFAULTS.resetSubtitle)}
                    placeholder={DEFAULTS.resetSubtitle}
                    helper="Vide = texte par défaut."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="auth.reset.invalid_title"
                    label="Lien invalide — titre"
                    defaultValue={copy("auth.reset.invalid_title", DEFAULTS.resetInvalidTitle)}
                    placeholder={DEFAULTS.resetInvalidTitle}
                    helper="Vide = texte par défaut."
                  />
                  <TextField
                    name="auth.reset.invalid_body"
                    label="Lien invalide — texte"
                    defaultValue={copy("auth.reset.invalid_body", DEFAULTS.resetInvalidBody)}
                    placeholder={DEFAULTS.resetInvalidBody}
                    helper="Vide = texte par défaut."
                  />
                </div>
              </FieldSection>

              <FieldSection
                title="Vérification de l'email"
                description="Textes affichés sur /verify-email quand le lien est incomplet ou invalide. Videz un champ pour revenir au texte par défaut."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="auth.verify.incomplete_title"
                    label="Lien incomplet — titre"
                    defaultValue={copy("auth.verify.incomplete_title", DEFAULTS.verifyIncompleteTitle)}
                    placeholder={DEFAULTS.verifyIncompleteTitle}
                    helper="Vide = texte par défaut."
                  />
                  <TextField
                    name="auth.verify.incomplete_body"
                    label="Lien incomplet — texte"
                    defaultValue={copy("auth.verify.incomplete_body", DEFAULTS.verifyIncompleteBody)}
                    placeholder={DEFAULTS.verifyIncompleteBody}
                    helper="Vide = texte par défaut."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="auth.verify.invalid_title"
                    label="Lien invalide — titre"
                    defaultValue={copy("auth.verify.invalid_title", DEFAULTS.verifyInvalidTitle)}
                    placeholder={DEFAULTS.verifyInvalidTitle}
                    helper="Vide = texte par défaut."
                  />
                  <TextField
                    name="auth.verify.invalid_body"
                    label="Lien invalide — texte"
                    defaultValue={copy("auth.verify.invalid_body", DEFAULTS.verifyInvalidBody)}
                    placeholder={DEFAULTS.verifyInvalidBody}
                    helper="Vide = texte par défaut."
                  />
                </div>
              </FieldSection>
            </FormTab>

            {/* ─── Connexion sociale ─────────────────────────────────────── */}
            <FormTab id="social" active={active}>
              <FieldSection
                title="Connexion sociale (Google / Facebook)"
                description="Saisissez les identifiants OAuth ici (chiffrés au repos), puis activez l'interrupteur pour activer la connexion et afficher le bouton sur /login et /register. Interrupteur coupé, le fournisseur est désactivé. Une variable d'environnement (GOOGLE_* / FACEBOOK_*) reste prioritaire et verrouille le champ correspondant."
              >
                {!encryptionReady && (
                  <AdminCallout tone="warning" icon={TriangleAlert}>
                    <code>PAYMENT_ENCRYPTION_KEY</code> n&apos;est pas définie — impossible
                    d&apos;enregistrer de nouveaux identifiants OAuth tant qu&apos;elle est
                    absente (elle est normalement provisionnée automatiquement au démarrage).
                  </AdminCallout>
                )}
                {authOriginDiffers && (
                  <AdminCallout tone="warning" icon={TriangleAlert}>
                    <code>BETTER_AUTH_URL</code> et <code>NEXT_PUBLIC_SITE_URL</code> pointent
                    vers des origines différentes. L&apos;URL de redirection ci-dessous utilise
                    <code>BETTER_AUTH_URL</code> (l&apos;origine que la connexion OAuth emploie
                    réellement) — c&apos;est bien cette valeur exacte qu&apos;il faut autoriser
                    dans la console du fournisseur.
                  </AdminCallout>
                )}
                {providers.map((p) => (
                  <ProviderCard
                    key={p.provider}
                    data={p}
                    toggleChecked={truthy(settings[`auth.social.${p.provider}_enabled`])}
                  />
                ))}
              </FieldSection>
            </FormTab>

            {/* ─── Sécurité — politique de comptes ───────────────────────── */}
            <FormTab id="security" active={active}>
              <FieldSection
                title="Vérification de l'e-mail"
                description="Quand cette option est activée (par défaut), un nouvel utilisateur inscrit par e-mail/mot de passe doit confirmer son adresse avant de pouvoir se connecter. Désactivez-la pour autoriser la connexion sans confirmation — l'e-mail de vérification est tout de même envoyé pour permettre une confirmation ultérieure. (Google est vérifié par le fournisseur ; Facebook peut renvoyer une adresse non vérifiée, qui reçoit alors un e-mail de vérification.)"
              >
                <ToggleField
                  name={EMAIL_VERIFICATION_REQUIRED_KEY}
                  label="Vérification e-mail obligatoire"
                  description="Bloque la connexion tant que l'e-mail n'est pas confirmé. Désactivé = la connexion est autorisée immédiatement."
                  // Default ON: only the literal "false" turns it off.
                  defaultChecked={settings[EMAIL_VERIFICATION_REQUIRED_KEY] !== "false"}
                />
              </FieldSection>
            </FormTab>
          </>
        )}
      </FormTabs>

      {/* Feedback + submit */}
      {state && !state.ok && (
        <div className="rounded-[14px] border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {state.message}
        </div>
      )}
      {state?.ok && (
        <div className="rounded-[14px] border border-[#cdebd6] bg-[#eaf7ee] p-3 text-xs text-[#15803d]">
          {state.message}
        </div>
      )}

      <div className="sticky bottom-4 z-10 flex items-center justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {pending ? "Enregistrement…" : "Enregistrer tous les réglages"}
        </button>
      </div>
    </form>
  );
}

/**
 * One social provider: the storefront-button toggle, the two write-only
 * credential fields (env-locked fields are disabled), an overall readiness
 * badge, and the callback URL to paste into the provider console.
 */
function ProviderCard({
  data,
  toggleChecked,
}: {
  data: ProviderCredData;
  toggleChecked: boolean;
}) {
  // Admin-saved (DB) credentials exist — an env-locked field is not stored here.
  const hasStored =
    (data.idField.hasValue && !data.idField.locked) ||
    (data.secretField.hasValue && !data.secretField.locked);
  const [clearState, setClearState] = useState<ActionState | null>(null);
  const [clearing, startClearing] = useTransition();
  const router = useRouter();

  const clearCredentials = () => {
    if (
      !window.confirm(
        `Supprimer les identifiants ${data.label} enregistrés ? La connexion ${data.label} sera désactivée tant que de nouveaux identifiants ne sont pas saisis.`,
      )
    ) {
      return;
    }
    startClearing(async () => {
      try {
        const res = await clearOAuthCredentialsAction(data.provider);
        setClearState(res);
        if (res.ok) router.refresh();
      } catch {
        setClearState({
          ok: false,
          error: "internal",
          message: "Suppression impossible. Réessayez.",
        });
      }
    });
  };

  return (
    <div className="space-y-3 rounded-[22px] border border-border bg-[#fbf9f8] p-4">
      <div className="flex items-center justify-between gap-3">
        <ToggleField
          name={`auth.social.${data.provider}_enabled`}
          label={`Connexion ${data.label}`}
          description={`Active la connexion ${data.label} et affiche le bouton « Continuer avec ${data.label} » sur les pages de connexion et d'inscription (uniquement si les identifiants sont présents). Désactivée, la connexion ${data.label} est refusée, même par un appel direct.`}
          defaultChecked={toggleChecked}
        />
      </div>

      {data.ready ? (
        <p className="inline-flex items-center gap-1.5 rounded-full border border-[#cdebd6] bg-[#eaf7ee] px-3 py-1 text-[11px] font-bold text-[#15803d]">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Identifiants configurés
        </p>
      ) : (
        <AdminCallout tone="warning" icon={TriangleAlert}>
          Identifiants incomplets — saisissez le Client ID et le Client secret ci-dessous
          (le bouton ne s&apos;affiche pas tant qu&apos;ils sont absents).
        </AdminCallout>
      )}

      <SecretField
        name={data.idField.name}
        label={data.idField.label}
        hasValue={data.idField.hasValue}
        locked={data.idField.locked}
        helper={`Variable d'environnement (prioritaire) : ${data.idField.envVar}`}
      />
      <SecretField
        name={data.secretField.name}
        label={data.secretField.label}
        hasValue={data.secretField.hasValue}
        locked={data.secretField.locked}
        helper={`Variable d'environnement (prioritaire) : ${data.secretField.envVar}`}
      />

      {hasStored && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={clearCredentials}
            disabled={clearing}
            className="inline-flex h-9 items-center gap-2 rounded-full border-[1.5px] border-[#f3c6d1] bg-card px-4 text-[13px] font-bold text-[#d40530] transition hover:bg-[#fdecef] disabled:opacity-60"
          >
            {clearing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {clearing ? "Suppression…" : "Supprimer les identifiants"}
          </button>
          <span className="text-[11px] text-muted-foreground">
            Efface le Client ID et le Client secret enregistrés ici.
          </span>
        </div>
      )}
      {clearState && (
        <p
          className={
            clearState.ok
              ? "rounded-[12px] border border-[#cdebd6] bg-[#eaf7ee] px-3 py-2 text-[11px] text-[#15803d]"
              : "rounded-[12px] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive"
          }
        >
          {clearState.message}
        </p>
      )}

      <div>
        <p className="text-[13px] font-bold text-foreground">
          URL de redirection à autoriser dans la console {data.label}
        </p>
        <code className="mt-1.5 block w-full select-all overflow-x-auto rounded-[12px] border border-input bg-[#fbf9f8] px-3 py-2 font-mono text-[11px] text-foreground">
          {data.callbackUrl}
        </code>
      </div>
    </div>
  );
}

