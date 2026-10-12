"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { dinarsToMinor } from "@/lib/price";
import { bpsFromPercent } from "@/lib/tax/shared";
import { CARE_SETTING_KEYS } from "@/lib/care/config";

/**
 * Server actions backing the Tokyo Care admin CRUD. Mirror the Collections
 * actions (requirePermission → Zod-validated workflow → revalidate). Money is
 * entered in DINARS / PERCENT in the form and converted to MILLIMES / basis
 * points HERE, at the edge, before the workflow (the single conversion point —
 * avoids /100 drift). The scope (products + categories) rides as repeated hidden
 * inputs; the workflow persists it inside its transaction.
 */

export async function createCarePlanAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("care", "create");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, error: "validation", message: "Le nom du plan est requis.", fieldErrors: { name: "Requis" } };
  }
  const result = await workflows.catalog.createCarePlan(buildInput(formData), {
    actorUserId: session.user.id,
  });
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  revalidatePath("/admin/catalog/care");
  return { ok: true, message: "Plan Tokyo Care créé.", id: result.data.planId };
}

export async function updateCarePlanAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("care", "update");
  const planId = optional(formData, "planId");
  if (!planId) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.catalog.updateCarePlan(
    { planId, ...buildInput(formData) },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  revalidatePath("/admin/catalog/care");
  revalidatePath(`/admin/catalog/care/${planId}`);
  return { ok: true, message: "Plan Tokyo Care mis à jour." };
}

export async function deleteCarePlanAction(planId: string): Promise<ActionState> {
  const session = await requirePermission("care", "delete");
  const result = await workflows.catalog.deleteCarePlan({ planId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/care");
  return { ok: true, message: "Plan Tokyo Care supprimé." };
}

/**
 * Store-wide Tokyo Care switches (Catalogue → Tokyo Care → Réglages). The master
 * `care.enabled` is the kill-switch that gates BOTH the storefront offer and the
 * server-side charge; it fails CLOSED (defaults OFF) so a save is the only way to
 * turn the money path on. The two charging knobs ride alongside it.
 */
const CARE_SETTINGS_FIELDS: { key: string; label: string }[] = [
  { key: CARE_SETTING_KEYS.enabled, label: "Tokyo Care — activé" },
  { key: CARE_SETTING_KEYS.chargePerUnit, label: "Facturer par unité (×quantité)" },
  { key: CARE_SETTING_KEYS.countsTowardFreeShipping, label: "Compter dans le seuil de livraison gratuite" },
];

export async function saveCareSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("care", "update");
  const errors: string[] = [];
  for (const f of CARE_SETTINGS_FIELDS) {
    const r = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value: formData.get(f.key) === "on" ? "true" : "false",
        type: "boolean",
        groupKey: "care",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!r.ok) errors.push(`${f.label}: ${r.message}`);
  }
  revalidatePath("/admin/catalog/care");
  revalidatePath("/", "layout"); // storefront reads the care config
  if (errors.length > 0) return { ok: false, error: "partial", message: `Erreurs : ${errors.join(" · ")}` };
  return { ok: true, message: "Réglages Tokyo Care enregistrés." };
}

/** FormData → the workflow input (shared by create + update; money converted here). */
function buildInput(formData: FormData) {
  const pricingMode = (optional(formData, "pricingMode") as "flat" | "percent" | undefined) ?? "percent";
  return {
    name: String(formData.get("name") ?? ""),
    slug: optional(formData, "slug"),
    externalRef: nullable(formData, "externalRef"),
    description: nullable(formData, "description"),
    durationMonths: optionalInt(formData, "durationMonths") ?? 12,
    pricingMode,
    // Flat price is entered in DINARS → millimes; percent is entered as a % → bps.
    priceCents: pricingMode === "flat" ? dinarField(formData, "priceFlat") : 0,
    priceBps: pricingMode === "percent" ? percentField(formData, "pricePercent") : 0,
    priceRoundToCents: dinarField(formData, "priceRoundTo"),
    minChargeCents: dinarField(formData, "minCharge"),
    minProductPriceCents: dinarField(formData, "minProductPrice"),
    requireWarranty: formData.get("requireWarranty") === "on",
    applicableConditions: pickAll(formData, "applicableConditions") as
      | ("new" | "used" | "refurbished")[],
    // Coverage bullets: one per line in a textarea.
    perks: String(formData.get("perksText") ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .slice(0, 20),
    icon: nullable(formData, "icon"),
    isActive: formData.get("isActive") === "on",
    displayPriority: optionalInt(formData, "displayPriority") ?? 0,
    scopeCategoryIds: pickAllUuid(formData, "scopeCategoryIds"),
    scopeIncludeDescendants: formData.get("scopeIncludeDescendants") === "on",
  };
}

// ─── local FormData coercers (mirror the collection/catalog action helpers) ───
function optional(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}
function nullable(form: FormData, key: string): string | null | undefined {
  if (!form.has(key)) return undefined;
  const v = String(form.get(key) ?? "").trim();
  return v === "" ? null : v;
}
function optionalInt(form: FormData, key: string): number | undefined {
  const v = optional(form, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
/** A DINAR amount field → integer MILLIMES (blank/invalid → 0). */
function dinarField(form: FormData, key: string): number {
  const v = optional(form, key);
  if (v === undefined) return 0;
  const n = Number.parseFloat(v.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? dinarsToMinor(n) : 0;
}
/** A PERCENT field (e.g. "7" or "7.5") → basis points (blank/invalid → 0). */
function percentField(form: FormData, key: string): number {
  const v = optional(form, key);
  if (v === undefined) return 0;
  const n = Number.parseFloat(v.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? bpsFromPercent(n) : 0;
}
function pickAll(form: FormData, key: string): string[] {
  return form
    .getAll(key)
    .map((v) => String(v).trim())
    .filter((v) => v !== "");
}
function pickAllUuid(form: FormData, key: string): string[] {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return pickAll(form, key).filter((v) => re.test(v));
}
