"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { setBrandTaxRatesWorkflow } from "@/workflows/catalog/create-brand";
import { setCategoryTaxRatesWorkflow } from "@/workflows/catalog/create-category";
import { bus } from "@/events/bus";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { bpsFromPercent } from "@/lib/tax";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Blank → null (inherit); a finite PERCENT in 0–100 → bps; anything else → NaN. */
function parsePercentBps(raw: FormDataEntryValue | null): number | null {
  const trimmed = String(raw ?? "").trim().replace(",", ".");
  if (trimmed === "") return null;
  const pct = Number(trimmed);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? bpsFromPercent(pct) : NaN;
}

/**
 * Parse the bulk per-MARQUE / per-CATÉGORIE form: each row posts `rate_<id>` as a
 * PERCENT (empty = clear the override → inherit; a number, incl. 0, = explicit
 * rate) plus `prev_<id>`, the value the page was loaded with. EVERY row is
 * validated (0–100 %) before anything is written — one bad row returns per-row
 * `fieldErrors` and saves nothing (it used to store 150 % for a brand, or crash
 * mid-loop on the categories CHECK after earlier rows had committed). Rows the
 * operator left untouched (rate === prev) are dropped, so a stale page never
 * reverts a rate changed elsewhere since it was loaded. Brand sits between
 * filter and category in the cascade; category between brand and global.
 */
function parseEntityTaxRates(
  formData: FormData,
): { ok: true; rates: { id: string; bps: number | null }[] } | { ok: false; state: ActionState } {
  const rates: { id: string; bps: number | null }[] = [];
  const fieldErrors: Record<string, string> = {};
  for (const key of formData.keys()) {
    const m = key.match(/^rate_(.+)$/);
    if (!m || !UUID_RE.test(m[1])) continue;
    const bps = parsePercentBps(formData.get(key));
    if (bps !== null && Number.isNaN(bps)) {
      fieldErrors[key] = "Entre 0 et 100 %";
      continue;
    }
    const prevRaw = formData.get(`prev_${m[1]}`);
    if (prevRaw !== null && parsePercentBps(prevRaw) === bps) continue;
    rates.push({ id: m[1], bps });
  }
  const invalid = Object.keys(fieldErrors).length;
  if (invalid > 0) {
    return {
      ok: false,
      state: {
        ok: false,
        error: "validation",
        message: `${invalid} taux invalide${invalid > 1 ? "s" : ""} : saisissez un pourcentage entre 0 et 100 (aucun taux enregistré).`,
        fieldErrors,
      },
    };
  }
  return { ok: true, rates };
}

async function afterEntityTaxSave(
  entityType: "brand" | "category",
  changed: number,
  actorUserId: string,
): Promise<ActionState> {
  if (changed === 0) return { ok: true, message: "Aucun taux modifié." };
  revalidatePath("/admin/system/tax");
  revalidatePath("/", "layout"); // storefront tax preview reads these rates
  await bus.emit("tax.entity_rate_updated", { entityType, count: changed }, { actorUserId });
  return { ok: true, message: `${changed} taux enregistré${changed > 1 ? "s" : ""}.` };
}

export async function saveBrandTaxRatesAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_tax", "update");
  const parsed = parseEntityTaxRates(formData);
  if (!parsed.ok) return parsed.state;
  if (parsed.rates.length === 0) return { ok: true, message: "Aucun taux modifié." };
  // One transaction + a brand.updated per changed brand (see the workflow).
  const result = await setBrandTaxRatesWorkflow(
    { rates: parsed.rates.map((r) => ({ brandId: r.id, taxRateBps: r.bps })) },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  return afterEntityTaxSave("brand", result.data.changedIds.length, session.user.id);
}

export async function saveCategoryTaxRatesAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_tax", "update");
  const parsed = parseEntityTaxRates(formData);
  if (!parsed.ok) return parsed.state;
  if (parsed.rates.length === 0) return { ok: true, message: "Aucun taux modifié." };
  // One transaction + a category.updated per changed category (see the workflow).
  const result = await setCategoryTaxRatesWorkflow(
    { rates: parsed.rates.map((r) => ({ categoryId: r.id, taxRateBps: r.bps })) },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  return afterEntityTaxSave("category", result.data.changedIds.length, session.user.id);
}

/**
 * Save one per-filter tax rule (the FILTER tier of the cascade). The admin
 * enters a PERCENT against an attribute value; we convert to basis points and
 * upsert. An empty / blank / zero rate means "no rule" → we DELETE so the
 * value falls back to the category/global tier (a 0 % rule would be
 * indistinguishable from no tax and just clutter the cascade).
 *
 * Called once per row from the "Règles par filtre" panel.
 */
export async function saveTaxRuleAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_tax", "update");

  const attributeValueId = String(formData.get("attributeValueId") ?? "").trim();
  if (!UUID_RE.test(attributeValueId)) {
    return { ok: false, error: "validation", message: "Valeur de filtre invalide." };
  }

  const raw = formData.get("ratePercent");
  const trimmed = raw === null ? "" : String(raw).trim().replace(",", ".");
  const pct = trimmed === "" ? NaN : Number(trimmed);

  // Empty or non-positive → clear the rule.
  if (!Number.isFinite(pct) || pct <= 0) {
    const result = await workflows.tax.deleteRule(
      { attributeValueId },
      { actorUserId: session.user.id },
    );
    if (!result.ok) return { ok: false, error: result.error, message: result.message };
    revalidatePath("/admin/system/tax");
    revalidatePath("/", "layout");
    return { ok: true, message: "Règle supprimée." };
  }

  const result = await workflows.tax.upsertRule(
    { attributeValueId, rateBps: bpsFromPercent(pct) },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  revalidatePath("/admin/system/tax");
  revalidatePath("/", "layout");
  return { ok: true, message: "Règle enregistrée." };
}
