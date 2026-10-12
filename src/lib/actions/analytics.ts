"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { type ActionState } from "@/lib/actions/types";
import { EVENT_GROUPS } from "@/lib/tracking/event-groups";
import { CONSENT_SIGNALS } from "@/lib/tracking/consent-mode";
import { TRACKING_SCRIPT_KEYS, ownerOnlyTrackingViolation } from "@/lib/tracking/script-keys";
import { normalizeTrackingId, type TrackingIdKind } from "@/lib/tracking/parse-config";

/**
 * Persist the Tracking & Analytics configuration (`tracking.*` site_settings).
 * Mirrors saveSeoSettingsAction / saveCookieSettingsAction: requirePermission →
 * one upsertSetting per key → revalidate the admin page AND the storefront
 * layout so the tag loader + funnel pick up the new config.
 *
 * The 3 tag IDs used to live under `consent.*` (Cookies & RGPD); the config
 * loader still falls back to those legacy keys, so existing installs keep
 * working until the owner re-saves here.
 *
 * OWNER-ONLY keys: the two raw-HTML snippets (injected, their <script>s
 * re-executed) and the GTM container id (an attacker-owned container ships
 * Custom-HTML tags) each run ARBITRARY JavaScript on every storefront page.
 * The admin shares the storefront origin + session cookie, so such a script
 * runs with the session of any staff member who browses the shop — writing
 * these keys through the delegable `system_analytics:update` grant would be a
 * privilege escalation to full admin. They therefore require the `*` wildcard
 * (TRACKING_SCRIPT_KEYS / ownerOnlyTrackingViolation in
 * src/lib/tracking/script-keys.ts); GA4 / Meta Pixel ids (no code injection)
 * and the toggles stay delegable — but only in their exact FORMAT
 * (`TRACKING_ID_FORMATS`): the GA4 field is loaded as `gtag/js?id=<id>`, which
 * serves a full GTM container for a `GTM-` id, so an unchecked value there
 * would reopen the owner-only rule. A non-matching id is refused up front
 * (nothing is written) and ignored by the storefront loader anyway.
 */

/** Tag-id keys → their format kind + the French hint shown when refused. */
const ID_KEYS = new Map<string, { kind: TrackingIdKind; hint: string }>([
  ["tracking.gtm_id", { kind: "gtm", hint: "ID Google Tag Manager invalide (format GTM-XXXXXXX)." }],
  ["tracking.ga4_id", { kind: "ga4", hint: "ID Google Analytics 4 invalide (format G-XXXXXXXXXX)." }],
  ["tracking.meta_pixel_id", { kind: "metaPixel", hint: "ID Meta Pixel invalide (5 à 20 chiffres)." }],
]);
const RAW_HTML_KEYS = new Set(["tracking.custom_head", "tracking.custom_body"]);

const TEXT_FIELDS: Array<{ key: string; label: string }> = [
  { key: "tracking.gtm_id", label: "Suivi — Google Tag Manager (ID)" },
  { key: "tracking.ga4_id", label: "Suivi — Google Analytics 4 (ID)" },
  { key: "tracking.meta_pixel_id", label: "Suivi — Meta Pixel (ID)" },
  { key: "tracking.custom_head", label: "Suivi — code personnalisé (head)" },
  { key: "tracking.custom_body", label: "Suivi — code personnalisé (body)" },
];

/**
 * Sanitize per key: tag ids → normalized + format-checked (`null` = present but
 * NOT a valid id for that field; "" = cleared); custom HTML → kept raw (trusted
 * admin input).
 */
function sanitizeValue(key: string, raw: string): string | null {
  const id = ID_KEYS.get(key);
  if (id) return raw === "" ? "" : normalizeTrackingId(id.kind, raw);
  if (RAW_HTML_KEYS.has(key)) return raw; // owner-only (`*`, see TRACKING_SCRIPT_KEYS); never exposed via public API
  return raw;
}

export async function saveAnalyticsSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_analytics", "update");
  const ctx = { actorUserId: session.user.id };
  const isOwner = (await resolveUserPermissions(session.user.id)).has(WILDCARD);

  // A non-owner can't touch the script-capable keys. The panel renders them
  // disabled (so they aren't posted and the stored value is left as is); a
  // request that still carries one is refused outright rather than silently
  // half-applied.
  if (ownerOnlyTrackingViolation(isOwner, (key) => formData.has(key))) {
    return {
      ok: false,
      error: "forbidden",
      message:
        "Le conteneur Google Tag Manager et le code personnalisé sont réservés au super-administrateur (ils peuvent exécuter du code sur la boutique).",
    };
  }

  // Validate every writable text field BEFORE any write, so a bad tag id never
  // leaves the form half-applied.
  const values = new Map<string, string>();
  const fieldErrors: Record<string, string> = {};
  for (const f of TEXT_FIELDS) {
    if (!isOwner && TRACKING_SCRIPT_KEYS.has(f.key)) continue; // owner-only — keep the stored value
    const value = sanitizeValue(f.key, String(formData.get(f.key) ?? "").trim());
    if (value === null) fieldErrors[f.key] = ID_KEYS.get(f.key)?.hint ?? "Valeur invalide.";
    else values.set(f.key, value);
  }
  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      error: "validation",
      message: Object.values(fieldErrors).join(" "),
      fieldErrors,
    };
  }

  for (const f of TEXT_FIELDS) {
    const value = values.get(f.key);
    if (value === undefined) continue; // owner-only key skipped for a delegate
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value,
        type: "text" as never,
        groupKey: "tracking",
        label: f.label,
      },
      ctx,
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // Consent Mode strategy (select) — normalized to a known enum value.
  const modeRaw = String(formData.get("tracking.consent_mode") ?? "").trim().toLowerCase();
  const mode = modeRaw === "off" ? "off" : modeRaw === "basic" ? "basic" : "advanced";
  const modeRes = await workflows.cms.upsertSetting(
    {
      key: "tracking.consent_mode",
      value: mode,
      type: "text" as never,
      groupKey: "tracking",
      label: "Suivi — mode de consentement",
    },
    ctx,
  );
  if (!modeRes.ok) return { ok: false, error: modeRes.error, message: modeRes.message };

  // wait_for_update (ms) — clamped to [0, 5000].
  const rawWait = Number.parseInt(String(formData.get("tracking.cm_wait_for_update") ?? "500"), 10);
  const wait = String(Number.isFinite(rawWait) ? Math.max(0, Math.min(rawWait, 5000)) : 500);
  const waitRes = await workflows.cms.upsertSetting(
    {
      key: "tracking.cm_wait_for_update",
      value: wait,
      type: "number" as never,
      groupKey: "tracking",
      label: "Suivi — Consent Mode wait_for_update (ms)",
    },
    ctx,
  );
  if (!waitRes.ok) return { ok: false, error: waitRes.error, message: waitRes.message };

  // Per-signal pre-consent defaults (the per-signal editor). security_storage is
  // consent-exempt (always granted) and has no form control, so it's skipped.
  // A checked toggle (submitted "on") means "granted by default".
  for (const sig of CONSENT_SIGNALS) {
    if (sig === "security_storage") continue;
    const granted = formData.get(`tracking.cm_default_${sig}`) === "on";
    const res = await workflows.cms.upsertSetting(
      {
        key: `tracking.cm_default_${sig}`,
        value: granted ? "granted" : "denied",
        type: "text" as never,
        groupKey: "tracking",
        label: `Suivi — Consent Mode défaut : ${sig}`,
      },
      ctx,
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // Boolean toggles — checkboxes submit "on" when checked, absent otherwise.
  const BOOL_FIELDS: Array<{ key: string; label: string }> = [
    { key: "tracking.enabled", label: "Suivi — activé" },
    { key: "tracking.bypass_consent", label: "Suivi — bypass du consentement (tout suivre)" },
    { key: "tracking.region_eea_only", label: "Suivi — consentement requis (UE/TN) uniquement" },
    { key: "tracking.cm_ads_data_redaction", label: "Suivi — ads_data_redaction" },
    { key: "tracking.cm_url_passthrough", label: "Suivi — url_passthrough" },
    ...EVENT_GROUPS.map((g) => ({
      key: `tracking.evt.${g.key}`,
      label: `Suivi — événements : ${g.label}`,
    })),
  ];
  for (const f of BOOL_FIELDS) {
    const checked = formData.get(f.key) === "on";
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value: checked ? "true" : "false",
        type: "boolean" as never,
        groupKey: "tracking",
        label: f.label,
      },
      ctx,
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  revalidatePath("/admin/system/analytics");
  revalidatePath("/", "layout");
  return { ok: true, message: "Réglages de suivi enregistrés." };
}
