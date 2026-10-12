"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { workflows } from "@/workflows";
import {
  createDeliveryZoneWorkflow,
  deleteDeliveryZoneWorkflow,
  updateDeliveryZoneWorkflow,
} from "@/workflows/delivery/zone";
import { DELIVERY_SETTING_KEYS } from "@/lib/checkout/delivery";
import {
  INVALID_MONEY_MESSAGE,
  parseTndFields,
  parseTndInput,
} from "@/lib/checkout/money-input";

/**
 * Delivery admin actions.
 *
 *   - saveDeliveryMethodsAction — the three method-enable toggles
 *     (home / drive-by / in-store). useActionState signature; upserts each
 *     `delivery.*_enabled` boolean into site settings.
 *   - create/update/delete{Agent,Location,Zone}Action — per-row CRUD. Every one
 *     is a `(prev, formData) => ActionState` action (useActionState on the add
 *     forms + each row card; the deletes run from a confirm modal) so a refused
 *     save / delete is SHOWN to the operator instead of the card silently
 *     snapping back to its old values. Zones go through `workflows/delivery/zone`
 *     (audited `delivery.zone.*` events; zone + courier rates in one tx).
 *
 * Admin enters fees + free-shipping thresholds in TND; the shared
 * `parseTndInput` (`@/lib/checkout/money-input`) converts to integer millimes
 * and REFUSES a negative / non-numeric amount with a field error — the same
 * rule Réglages commande applies to the same `checkout.delivery.*` keys.
 */

const ADMIN_PATH = "/admin/system/delivery";

// ──────────────────────────────────────────────────────── methods (toggles)
export async function saveDeliveryMethodsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "update");

  // Global home-delivery base fee + free-shipping threshold, validated BEFORE
  // any write so an invalid amount never half-applies the form (toggles saved,
  // fee not). Blank ⇒ null (the cart falls back to CHECKOUT_COPY_FALLBACKS).
  const money = parseTndFields(
    (name) => formData.get(name),
    ["global_default_fee_tnd", "global_free_threshold_tnd"] as const,
  );
  if (!money.ok) {
    return { ok: false, error: "validation", message: INVALID_MONEY_MESSAGE, fieldErrors: money.fieldErrors };
  }

  const upserts: Array<{ key: string; value: string; label: string }> = [
    {
      key: DELIVERY_SETTING_KEYS.homeEnabled,
      value: formData.get("home_enabled") === "on" ? "true" : "false",
      label: "Livraison à domicile activée",
    },
    {
      key: DELIVERY_SETTING_KEYS.driveByEnabled,
      value: formData.get("drive_by_enabled") === "on" ? "true" : "false",
      label: "Retrait drive activé",
    },
    {
      key: DELIVERY_SETTING_KEYS.inStoreEnabled,
      value: formData.get("in_store_enabled") === "on" ? "true" : "false",
      label: "Retrait en magasin activé",
    },
    {
      key: DELIVERY_SETTING_KEYS.zonePricingEnabled,
      value: formData.get("zone_pricing_enabled") === "on" ? "true" : "false",
      label: "Tarification par région (gouvernorat)",
    },
    {
      // Master switch for the global free-shipping threshold offer. OFF ⇒ the
      // resolvers (`previewShipping` + `getHomeBaseRate`) treat the threshold as
      // 0 so home delivery is always charged and the cart hides the nudge.
      key: "delivery.free_shipping_enabled",
      value: formData.get("free_shipping_enabled") === "on" ? "true" : "false",
      label: "Livraison offerte (seuil) activée",
    },
  ];

  for (const u of upserts) {
    const res = await workflows.cms.upsertSetting(
      {
        key: u.key,
        value: u.value,
        type: "boolean" as never,
        groupKey: "delivery",
        label: u.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // These are the SAME `checkout.delivery.*_cents` keys the Réglages-commande
  // page writes (millime storage, `checkout` group) — mirrored here so the
  // operator can set them next to the carriers/zones that inherit them, and so
  // the cart's "Plus que X pour la livraison offerte" reflects an edit made on
  // either page.
  const moneyUpserts: Array<{ key: string; cents: number | null; label: string }> = [
    {
      key: "checkout.delivery.default_fee_cents",
      cents: money.values.global_default_fee_tnd,
      label: "Frais de livraison (TND)",
    },
    {
      key: "checkout.delivery.free_threshold_cents",
      cents: money.values.global_free_threshold_tnd,
      label: "Seuil livraison offerte (TND)",
    },
  ];
  for (const m of moneyUpserts) {
    const res = await workflows.cms.upsertSetting(
      {
        key: m.key,
        value: m.cents == null ? null : String(m.cents),
        type: "number" as never,
        groupKey: "checkout",
        label: m.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // Storefront layout caches site settings — refresh so the checkout options
  // reflect the new method availability immediately.
  revalidatePath("/", "layout");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: "Méthodes de livraison enregistrées." };
}

// ──────────────────────────────────────────────────────────────── agents
export async function createDeliveryAgentAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "create");
  const name = str(formData.get("name"));
  // Operator feedback: a blank name used to `return` silently — React reset the
  // form and it LOOKED saved while nothing was created. Now it's a clear error.
  if (!name) return nameRequired("Le nom du transporteur est requis.");
  const money = parseTndFields((n) => formData.get(n), ["fee_tnd", "free_threshold_tnd"] as const);
  if (!money.ok) return invalidMoney(money.fieldErrors);
  const result = await workflows.delivery.createAgent(
    {
      name,
      feeCents: money.values.fee_tnd,
      freeThresholdCents: money.values.free_threshold_tnd,
      phone: nullableStr(formData.get("phone")),
      zoneLabel: nullableStr(formData.get("zone_label")),
      enabled: formData.get("enabled") === "on",
      displayOrder: intOr(formData.get("display_order"), 0),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return workflowFailure(result, "Transporteur non ajouté");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: `Transporteur « ${name} » ajouté.` };
}

export async function updateDeliveryAgentAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "update");
  const id = str(formData.get("agentId"));
  if (!id) return MISSING_ROW;
  const name = str(formData.get("name"));
  if (!name) return nameRequired("Le nom du transporteur est requis.");
  const money = parseTndFields((n) => formData.get(n), ["fee_tnd", "free_threshold_tnd"] as const);
  if (!money.ok) return invalidMoney(money.fieldErrors);
  const result = await workflows.delivery.updateAgent(
    {
      id,
      name,
      feeCents: money.values.fee_tnd,
      freeThresholdCents: money.values.free_threshold_tnd,
      phone: nullableStr(formData.get("phone")),
      zoneLabel: nullableStr(formData.get("zone_label")),
      enabled: formData.get("enabled") === "on",
      displayOrder: intOr(formData.get("display_order"), 0),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return workflowFailure(result, "Transporteur non enregistré");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: `Transporteur « ${name} » enregistré.` };
}

export async function deleteDeliveryAgentAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "delete");
  const id = str(formData.get("agentId"));
  if (!id) return MISSING_ROW;
  const result = await workflows.delivery.deleteAgent({ id }, { actorUserId: session.user.id });
  if (!result.ok) return workflowFailure(result, "Transporteur non supprimé");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: "Transporteur supprimé." };
}

// ──────────────────────────────────────────────────────── pickup locations
export async function createPickupLocationAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "create");
  const name = str(formData.get("name"));
  if (!name) return nameRequired("Le nom du point de retrait est requis.");
  const fee = parseTndInput(formData.get("fee_tnd"));
  if (!fee.ok) return invalidMoney({ fee_tnd: fee.error });
  const result = await workflows.delivery.createLocation(
    {
      name,
      kind: parseKind(formData.get("kind")),
      feeCents: fee.millimes ?? 0,
      addressLine: nullableStr(formData.get("address_line")),
      city: nullableStr(formData.get("city")),
      region: nullableStr(formData.get("region")),
      phone: nullableStr(formData.get("phone")),
      hoursLabel: nullableStr(formData.get("hours_label")),
      enabled: formData.get("enabled") === "on",
      displayOrder: intOr(formData.get("display_order"), 0),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return workflowFailure(result, "Point de retrait non ajouté");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: `Point « ${name} » ajouté.` };
}

export async function updatePickupLocationAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "update");
  const id = str(formData.get("locationId"));
  if (!id) return MISSING_ROW;
  const name = str(formData.get("name"));
  if (!name) return nameRequired("Le nom du point de retrait est requis.");
  const fee = parseTndInput(formData.get("fee_tnd"));
  if (!fee.ok) return invalidMoney({ fee_tnd: fee.error });
  const result = await workflows.delivery.updateLocation(
    {
      id,
      name,
      kind: parseKind(formData.get("kind")),
      feeCents: fee.millimes ?? 0,
      addressLine: nullableStr(formData.get("address_line")),
      city: nullableStr(formData.get("city")),
      region: nullableStr(formData.get("region")),
      phone: nullableStr(formData.get("phone")),
      hoursLabel: nullableStr(formData.get("hours_label")),
      enabled: formData.get("enabled") === "on",
      displayOrder: intOr(formData.get("display_order"), 0),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return workflowFailure(result, "Point de retrait non enregistré");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: `Point « ${name} » enregistré.` };
}

export async function deletePickupLocationAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "delete");
  const id = str(formData.get("locationId"));
  if (!id) return MISSING_ROW;
  const result = await workflows.delivery.deleteLocation({ id }, { actorUserId: session.user.id });
  if (!result.ok) return workflowFailure(result, "Point de retrait non supprimé");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: "Point de retrait supprimé." };
}

// ──────────────────────────────────────────────────── zones (region pricing)
export async function createDeliveryZoneAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "create");
  const name = str(formData.get("name"));
  if (!name) return nameRequired("Le nom de la zone est requis.");
  // The workflow canonicalizes the governorate list to the official names so
  // the zone matches what the storefront picker submits (accent/case/article
  // tolerant).
  const result = await createDeliveryZoneWorkflow(
    {
      name,
      governorates: str(formData.get("governorates")),
      enabled: formData.get("enabled") === "on",
      displayOrder: intOr(formData.get("display_order"), 0),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return workflowFailure(result, "Zone non créée");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: `Zone « ${name} » ajoutée.` };
}

export async function updateDeliveryZoneAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "update");
  const id = str(formData.get("zoneId"));
  if (!id) return MISSING_ROW;
  const name = str(formData.get("name"));
  if (!name) return nameRequired("Le nom de la zone est requis.");

  // Per-courier rates: the form posts rate_<agentId>_fee / rate_<agentId>_threshold.
  // An empty fee clears that courier's override for this zone. Every amount is
  // validated up front — the zone + all its rates are saved in ONE transaction
  // by the workflow, or nothing is.
  const rates: Array<{ agentId: string; feeCents: number | null; freeThresholdCents: number | null }> = [];
  const fieldErrors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const key of formData.keys()) {
    const m = key.match(/^rate_(.+)_fee$/);
    if (!m) continue;
    const agentId = m[1];
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    const feeField = `rate_${agentId}_fee`;
    const thresholdField = `rate_${agentId}_threshold`;
    const fee = parseTndInput(formData.get(feeField));
    const threshold = parseTndInput(formData.get(thresholdField));
    if (!fee.ok) fieldErrors[feeField] = fee.error;
    if (!threshold.ok) fieldErrors[thresholdField] = threshold.error;
    if (!fee.ok || !threshold.ok) continue;
    // A zone threshold only exists on a zone rate — without a fee the override
    // is cleared and the threshold would be silently dropped.
    if (fee.millimes == null && threshold.millimes != null) {
      fieldErrors[thresholdField] = "Renseignez aussi les frais pour appliquer ce seuil à la zone.";
      continue;
    }
    rates.push({ agentId, feeCents: fee.millimes, freeThresholdCents: threshold.millimes });
  }
  if (Object.keys(fieldErrors).length > 0) return invalidMoney(fieldErrors);

  const result = await updateDeliveryZoneWorkflow(
    {
      id,
      name,
      governorates: str(formData.get("governorates")),
      enabled: formData.get("enabled") === "on",
      displayOrder: intOr(formData.get("display_order"), 0),
      rates,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return workflowFailure(result, "Zone non enregistrée");
  revalidatePath(ADMIN_PATH);
  return {
    ok: true,
    message:
      result.data.changedFields.length > 0
        ? `Zone « ${name} » enregistrée.`
        : `Zone « ${name} » : aucune modification.`,
  };
}

export async function deleteDeliveryZoneAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_delivery", "delete");
  const id = str(formData.get("zoneId"));
  if (!id) return MISSING_ROW;
  const result = await deleteDeliveryZoneWorkflow({ id }, { actorUserId: session.user.id });
  if (!result.ok) return workflowFailure(result, "Zone non supprimée");
  revalidatePath(ADMIN_PATH);
  return { ok: true, message: "Zone supprimée." };
}

// ─────────────────────────────────────────────────────────────── helpers
const MISSING_ROW: ActionState = {
  ok: false,
  error: "validation",
  message: "Élément introuvable — rechargez la page.",
};

function nameRequired(message: string): ActionState {
  return { ok: false, error: "validation", message, fieldErrors: { name: "Saisissez un nom." } };
}

function invalidMoney(fieldErrors: Record<string, string>): ActionState {
  return { ok: false, error: "validation", message: INVALID_MONEY_MESSAGE, fieldErrors };
}

/**
 * Workflow schema key → the form input it came from + a French hint. The
 * workflows' zod messages are English and keyed by schema field (`zoneLabel`),
 * so a refused save is re-keyed to the form's input names (`zone_label`) for
 * the inline error and summarised in French for the banner.
 */
const FIELD_HINTS: Record<string, { field: string; message: string }> = {
  name: { field: "name", message: "Nom requis (120 caractères max)." },
  phone: { field: "phone", message: "Téléphone trop long (40 caractères max)." },
  zoneLabel: { field: "zone_label", message: "Zone trop longue (120 caractères max)." },
  addressLine: { field: "address_line", message: "Adresse trop longue (240 caractères max)." },
  city: { field: "city", message: "Ville trop longue (120 caractères max)." },
  region: { field: "region", message: "Région trop longue (120 caractères max)." },
  hoursLabel: { field: "hours_label", message: "Horaires trop longs (160 caractères max)." },
  governorates: { field: "governorates", message: "Liste de gouvernorats trop longue (2000 caractères max)." },
  displayOrder: { field: "display_order", message: "Ordre d'affichage invalide." },
  feeCents: { field: "fee_tnd", message: "Montant invalide." },
  freeThresholdCents: { field: "free_threshold_tnd", message: "Montant invalide." },
  kind: { field: "kind", message: "Type de point invalide." },
  rates: { field: "rates", message: "Tarif transporteur invalide — rechargez la page." },
  id: { field: "id", message: "Identifiant invalide — rechargez la page." },
};

function workflowFailure(
  result: { error: string; message: string; fieldErrors?: Record<string, string> },
  prefix: string,
): ActionState {
  const fieldErrors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(result.fieldErrors ?? {})) {
    const hint = FIELD_HINTS[key];
    fieldErrors[hint?.field ?? key] = hint?.message ?? raw;
  }
  const hints = Object.values(fieldErrors);
  return {
    ok: false,
    error: result.error,
    message: `${prefix} : ${hints.length > 0 ? hints.join(" ") : result.message}`,
    ...(hints.length > 0 ? { fieldErrors } : {}),
  };
}

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}

function nullableStr(v: FormDataEntryValue | null): string | null {
  const s = str(v);
  return s === "" ? null : s;
}

function intOr(v: FormDataEntryValue | null, fallback: number): number {
  const n = Math.trunc(Number(str(v)));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseKind(v: FormDataEntryValue | null): "drive_by_pickup" | "in_store" {
  return str(v) === "in_store" ? "in_store" : "drive_by_pickup";
}
