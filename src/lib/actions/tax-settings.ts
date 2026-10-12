"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import {
  TAX_SETTING_KEYS,
  CARE_TAX_SETTING_KEYS,
  bpsFromPercent,
} from "@/lib/tax";

/**
 * Saves the GLOBAL tax (TVA) config — the base of the cascade
 * (produit → filtre → marque → catégorie → global). All keys post together from
 * the tax-settings panel; this action upserts each into `site_settings` under
 * the `tax` group, exactly like `saveCheckoutSettingsAction`.
 *
 * Storage conventions (the resolver in `@/lib/tax` parses these back):
 *   • `tax.mode`            — "disabled" | "ttc" | "ht" (verbatim string).
 *   • `tax.default_rate_bps` — basis points. The admin enters a PERCENT; we
 *                              convert with `bpsFromPercent` (19 → "1900").
 *   • `tax.label`           — display label, e.g. "TVA".
 *   • `tax.on_shipping`     — "true" | "false".
 */

type Field = {
  key: string;
  label: string;
  description?: string;
  type?: "text" | "boolean" | "number" | "media";
};

const TAX_FIELDS: Field[] = [
  { key: TAX_SETTING_KEYS.mode, label: "Mode de taxation", type: "text" },
  // Stored as bps but typed "text" — the value we write is already the bps
  // string, not a raw percent, so a "number" type would mislead the settings
  // panel into showing 1900 as the editable value. The label drops the "(bps)"
  // suffix to match the tax panel UI, which collects/shows a PERCENT; the raw
  // persisted value remains basis points (see the doc-comment above).
  { key: TAX_SETTING_KEYS.defaultRateBps, label: "Taux par défaut", type: "text" },
  { key: TAX_SETTING_KEYS.label, label: "Libellé taxe", type: "text" },
  { key: TAX_SETTING_KEYS.onShipping, label: "Taxe sur la livraison", type: "boolean" },
];

function parseMode(raw: string): "disabled" | "ttc" | "ht" {
  return raw === "ttc" || raw === "ht" ? raw : "disabled";
}

export async function saveTaxSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_tax", "update");

  // Global default rate: the admin enters a PERCENT; we store integer basis
  // points. Accept "," or "." as the decimal separator. Blank → null, which
  // makes the resolver fall back to the built-in 19 % (1900 bps). Anything
  // outside 0–100 % (or non-numeric) is REJECTED before any setting is written
  // — it used to be stored as-is (150 → a 150 % surcharge in HT mode) or
  // silently reset to 19 %.
  const rawRate = formData.get(TAX_SETTING_KEYS.defaultRateBps);
  const trimmedRate = rawRate === null ? "" : String(rawRate).trim().replace(",", ".");
  let rateBps: string | null = null;
  if (trimmedRate) {
    const pct = Number(trimmedRate);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return {
        ok: false,
        error: "validation",
        message: "Taux par défaut invalide : saisissez un pourcentage entre 0 et 100.",
        fieldErrors: { [TAX_SETTING_KEYS.defaultRateBps]: "Entre 0 et 100 %" },
      };
    }
    rateBps = String(bpsFromPercent(pct));
  }

  // Tokyo Care service TVA rate — same percent→bps rule + 0–100 guard. Validated
  // here (before any write) so an invalid value never half-commits the panel.
  const rawCareRate = formData.get(CARE_TAX_SETTING_KEYS.rateBps);
  const trimmedCareRate = rawCareRate === null ? "" : String(rawCareRate).trim().replace(",", ".");
  let careRateBps: string | null = null;
  if (trimmedCareRate) {
    const pct = Number(trimmedCareRate);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return {
        ok: false,
        error: "validation",
        message: "Taux TVA Tokyo Care invalide : saisissez un pourcentage entre 0 et 100.",
        fieldErrors: { [CARE_TAX_SETTING_KEYS.rateBps]: "Entre 0 et 100 %" },
      };
    }
    careRateBps = String(bpsFromPercent(pct));
  }

  const errors: string[] = [];
  for (const field of TAX_FIELDS) {
    let value: string | null;

    if (field.key === TAX_SETTING_KEYS.mode) {
      value = parseMode(String(formData.get(field.key) ?? "").trim());
    } else if (field.key === TAX_SETTING_KEYS.defaultRateBps) {
      value = rateBps;
    } else if (field.type === "boolean") {
      value = formData.get(field.key) === "on" ? "true" : "false";
    } else {
      const raw = formData.get(field.key);
      value = raw === null ? null : String(raw).trim() || null;
    }

    const result = await workflows.cms.upsertSetting(
      {
        key: field.key,
        value,
        // Settings rows store everything as strings; `type` is just metadata for
        // the generic settings panel. We always persist "text" as never to match
        // the codebase convention for non-trivially-typed values (bps/mode).
        type: (field.type ?? "text") as never,
        groupKey: "tax",
        label: field.label,
        description: field.description,
      },
      { actorUserId: session.user.id },
    );
    if (!result.ok) errors.push(`${field.label}: ${result.message}`);
  }

  // Tokyo Care service TVA (taxable toggle + rate + label), persisted alongside
  // the global config under the same `tax` group.
  const careFields: Array<{ key: string; label: string; value: string | null; type: "boolean" | "text" }> = [
    {
      key: CARE_TAX_SETTING_KEYS.taxable,
      label: "Taxer Tokyo Care",
      value: formData.get(CARE_TAX_SETTING_KEYS.taxable) === "on" ? "true" : "false",
      type: "boolean",
    },
    { key: CARE_TAX_SETTING_KEYS.rateBps, label: "Taux TVA Tokyo Care", value: careRateBps, type: "text" },
    {
      key: CARE_TAX_SETTING_KEYS.label,
      label: "Libellé TVA Tokyo Care",
      value: ((): string | null => {
        const raw = formData.get(CARE_TAX_SETTING_KEYS.label);
        return raw === null ? null : String(raw).trim() || null;
      })(),
      type: "text",
    },
  ];
  for (const field of careFields) {
    const result = await workflows.cms.upsertSetting(
      { key: field.key, value: field.value, type: field.type as never, groupKey: "tax", label: field.label },
      { actorUserId: session.user.id },
    );
    if (!result.ok) errors.push(`${field.label}: ${result.message}`);
  }

  // The storefront layout caches site settings (getTaxConfig is React-cached
  // per request but reads getSettingsMap) — refresh so changes propagate.
  revalidatePath("/", "layout");
  revalidatePath("/admin/system/tax");

  if (errors.length > 0) {
    return {
      ok: false,
      error: "partial",
      message: `Certains réglages n'ont pas été enregistrés : ${errors.join(" · ")}`,
    };
  }
  return { ok: true, message: "Réglages de taxe enregistrés." };
}
