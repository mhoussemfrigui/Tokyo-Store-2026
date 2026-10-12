"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { checkConsentRevision } from "@/lib/consent/revision";
import { settingService } from "@/modules/cms/setting/service";
import { type ActionState } from "@/lib/actions/types";

/**
 * Persist the GDPR cookie-consent configuration (`consent.*` site_settings).
 * Mirrors saveSeoSettingsAction: requirePermission("system_cookies", "update") →
 * one upsertSetting per key (with the actor) →
 * revalidate the admin page AND the storefront layout so the banner picks up the
 * new config. The visitor's actual decision is NOT stored here (it's a cookie).
 */

const TEXT_FIELDS: Array<{ key: string; label: string }> = [
  { key: "consent.title", label: "Cookies — titre de la bannière" },
  { key: "consent.description", label: "Cookies — texte de la bannière" },
  { key: "consent.policy_url", label: "Cookies — URL politique cookies" },
  { key: "consent.privacy_url", label: "Cookies — URL confidentialité" },
];

const BOOL_FIELDS: Array<{ key: string; label: string }> = [
  { key: "consent.enabled", label: "Cookies — bannière activée" },
  { key: "consent.functional_enabled", label: "Cookies — catégorie fonctionnels" },
  { key: "consent.analytics_enabled", label: "Cookies — catégorie mesure d'audience" },
  { key: "consent.marketing_enabled", label: "Cookies — catégorie marketing" },
];

/** Accept only a same-origin path ("/…") or an http(s) URL; reject javascript:/data:/etc. */
function safePathOrUrl(value: string, fallback: string): string {
  const t = value.trim();
  if (!t) return fallback;
  if (t.startsWith("/")) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return fallback;
}

/** Server-side normalization mirroring the render-time guards. */
function sanitizeValue(key: string, raw: string): string {
  if (key === "consent.policy_url") return safePathOrUrl(raw, "/cookies");
  if (key === "consent.privacy_url") return safePathOrUrl(raw, "/confidentialite");
  return raw;
}

export async function saveCookieSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission('system_cookies', 'update');

  // Consent revision — bump to invalidate every stored decision and re-prompt
  // (e.g. after enabling a new tracker). Checked BEFORE any write: it may only go
  // UP. The storefront keeps a decision while `record.v >= revision`, so a lowered
  // revision (typo, or a form built from a failed read showing « 1 ») would make
  // a later bump re-prompt nobody. Blank keeps the stored value.
  let storedRevision: string | null;
  try {
    storedRevision = (await settingService.findByKey("consent.revision"))?.value ?? null;
  } catch {
    return {
      ok: false,
      error: "settings_unavailable",
      message: "Réglages indisponibles — rechargez la page puis réessayez.",
    };
  }
  const revisionCheck = checkConsentRevision(formData.get("consent.revision"), storedRevision);
  if (!revisionCheck.ok) {
    const message = `La révision ne peut pas être inférieure à la valeur actuelle (${revisionCheck.current}). Augmentez-la pour redemander le consentement, ou laissez-la inchangée.`;
    return {
      ok: false,
      error: "validation",
      message,
      fieldErrors: { "consent.revision": message },
    };
  }

  for (const f of TEXT_FIELDS) {
    const value = sanitizeValue(f.key, String(formData.get(f.key) ?? "").trim());
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value,
        type: "text" as never,
        groupKey: "consent",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  for (const f of BOOL_FIELDS) {
    const value = formData.get(f.key) === "on" ? "true" : "false";
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value,
        type: "boolean" as never,
        groupKey: "consent",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  const rev = await workflows.cms.upsertSetting(
    {
      key: "consent.revision",
      value: String(revisionCheck.revision),
      type: "number" as never,
      groupKey: "consent",
      label: "Cookies — révision du consentement",
    },
    { actorUserId: session.user.id },
  );
  if (!rev.ok) return { ok: false, error: rev.error, message: rev.message };

  revalidatePath("/admin/system/cookies");
  revalidatePath("/", "layout");
  return { ok: true, message: "Réglages cookies enregistrés." };
}
