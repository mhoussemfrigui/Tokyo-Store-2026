"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { resolveLowStockConfig } from "@/lib/inventory/low-stock";
import {
  ERP_MODE_KEY,
  ERP_MODES,
  ERP_PULL_STOCK_KEY,
  ERP_PUSH_STOCK_KEY,
  ERP_PUSH_TRANSFERS_KEY,
  ERP_PUSH_WARRANTY_KEY,
  ERP_PULL_WARRANTY_KEY,
  type ErpMode,
} from "@/lib/inventory/erp-config";

/**
 * Persist the low-stock OPERATOR-ALERT settings (`stock.*` site_settings) from
 * the "Catalogue → Stock → Alertes de stock" card (L10). Mirrors
 * savePerfSettingsAction: requirePermission → normalize through the SAME pure
 * resolver place-order + the subscriber read (`resolveLowStockConfig`, so a
 * hand-typed threshold is clamped and the recipient list is cleaned at save
 * time) → upsert each key (emits setting.upserted, so the change is audited) →
 * revalidate the stock page.
 */
export async function saveStockAlertSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("stock", "update");

  const cfg = resolveLowStockConfig({
    "stock.alert_enabled": formData.get("stock.alert_enabled") === "on" ? "true" : "false",
    "stock.low_threshold_qty": String(formData.get("stock.low_threshold_qty") ?? ""),
    "stock.alert_recipients": String(formData.get("stock.alert_recipients") ?? ""),
  });

  const entries: Array<{ key: string; value: string; type: "text" | "boolean"; label: string }> = [
    { key: "stock.alert_enabled", value: cfg.enabled ? "true" : "false", type: "boolean", label: "Stock — alertes opérateur activées" },
    { key: "stock.low_threshold_qty", value: String(cfg.threshold), type: "text", label: "Stock — seuil de stock faible" },
    // Persist the NORMALIZED recipient list (deduped/validated/lowercased).
    { key: "stock.alert_recipients", value: cfg.recipients.join(", "), type: "text", label: "Stock — destinataires des alertes" },
  ];

  for (const e of entries) {
    const res = await workflows.cms.upsertSetting(
      {
        key: e.key,
        value: e.value,
        type: e.type as never,
        groupKey: "stock",
        label: e.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  revalidatePath("/admin/catalog/stock");
  return { ok: true, message: "Alertes de stock enregistrées." };
}

/**
 * Persist the ERP linkage settings (`erp.*`) from the Stock → ERP tab: the sync
 * MODE (off / platform / erp / mixed) plus the per-axis push/pull toggles that
 * only apply in `mixed` (harmless to store in the presets — the resolver ignores
 * them). Mirrors saveStockAlertSettingsAction: guard → upsert each key (audited)
 * → revalidate. Enforcement of the authority lives in the sync paths (Phase 2).
 */
export async function saveErpSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("stock", "update");

  const rawMode = String(formData.get(ERP_MODE_KEY) ?? "off");
  const mode: ErpMode = (ERP_MODES as readonly string[]).includes(rawMode) ? (rawMode as ErpMode) : "off";
  const bool = (k: string) => formData.get(k) === "on";

  const entries: Array<{ key: string; value: string; type: "text" | "boolean"; label: string }> = [
    { key: ERP_MODE_KEY, value: mode, type: "text", label: "ERP — mode de synchronisation" },
    { key: ERP_PUSH_STOCK_KEY, value: bool(ERP_PUSH_STOCK_KEY) ? "true" : "false", type: "boolean", label: "ERP — pousser le stock (mixte)" },
    { key: ERP_PULL_STOCK_KEY, value: bool(ERP_PULL_STOCK_KEY) ? "true" : "false", type: "boolean", label: "ERP — recevoir le stock (mixte)" },
    { key: ERP_PUSH_TRANSFERS_KEY, value: bool(ERP_PUSH_TRANSFERS_KEY) ? "true" : "false", type: "boolean", label: "ERP — notifier les transferts" },
    { key: ERP_PUSH_WARRANTY_KEY, value: bool(ERP_PUSH_WARRANTY_KEY) ? "true" : "false", type: "boolean", label: "ERP — pousser les garanties (réclamations)" },
    { key: ERP_PULL_WARRANTY_KEY, value: bool(ERP_PULL_WARRANTY_KEY) ? "true" : "false", type: "boolean", label: "ERP — recevoir les garanties (réclamations)" },
  ];

  for (const e of entries) {
    const res = await workflows.cms.upsertSetting(
      { key: e.key, value: e.value, type: e.type as never, groupKey: "erp", label: e.label },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  revalidatePath("/admin/catalog/stock");
  return { ok: true, message: "Réglages ERP enregistrés." };
}
