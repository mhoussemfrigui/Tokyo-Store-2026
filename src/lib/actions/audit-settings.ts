"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { resolveAuditConfig } from "@/lib/audit/parse-config";
import { __resetAuditRuntimeConfig } from "@/lib/audit/runtime-config";

/**
 * Persist the audit/debug capture settings (`audit.*` / `debug.*` site_settings)
 * from the "Journal d'audit → Réglages" form. Mirrors saveSearchSettingsAction:
 * requirePermission(manage) → normalize through the SAME pure resolver the
 * subscribers read (resolveAuditConfig, so a hand-typed value is clamped) →
 * upsert each key (which itself emits setting.upserted, so the change is audited)
 * → revalidate.
 */
export async function saveAuditSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_audit", "manage");

  const raw: Record<string, string | null> = {
    "audit.enabled": formData.get("audit.enabled") === "on" ? "true" : "false",
    "audit.log_level": String(formData.get("audit.log_level") ?? ""),
    "audit.persist_low_signal":
      formData.get("audit.persist_low_signal") === "on" ? "true" : "false",
    "audit.retention_months": String(formData.get("audit.retention_months") ?? ""),
    "debug.enabled": formData.get("debug.enabled") === "on" ? "true" : "false",
    "debug.capture_payloads":
      formData.get("debug.capture_payloads") === "on" ? "true" : "false",
    "debug.sample_rate": String(formData.get("debug.sample_rate") ?? ""),
  };
  const cfg = resolveAuditConfig(raw);

  const entries: Array<{ key: string; value: string; type: "text" | "boolean"; label: string }> = [
    { key: "audit.enabled", value: cfg.enabled ? "true" : "false", type: "boolean", label: "Audit — capture activée" },
    { key: "audit.log_level", value: cfg.logLevel, type: "text", label: "Audit — niveau de journalisation console" },
    { key: "audit.persist_low_signal", value: cfg.persistLowSignal ? "true" : "false", type: "boolean", label: "Audit — conserver les événements à faible signal" },
    { key: "audit.retention_months", value: String(cfg.retentionMonths), type: "text", label: "Audit — conservation du journal (mois)" },
    { key: "debug.enabled", value: cfg.debugEnabled ? "true" : "false", type: "boolean", label: "Débogage — capture détaillée" },
    { key: "debug.capture_payloads", value: cfg.debugCapturePayloads ? "true" : "false", type: "boolean", label: "Débogage — inclure les payloads dans les logs" },
    { key: "debug.sample_rate", value: String(cfg.debugSampleRate), type: "text", label: "Débogage — taux d'échantillonnage (%)" },
  ];

  for (const e of entries) {
    const res = await workflows.cms.upsertSetting(
      {
        key: e.key,
        value: e.value,
        type: e.type as never,
        groupKey: e.key.startsWith("debug.") ? "debug" : "audit",
        label: e.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // Drop the in-process TTL cache so the new capture/level/kill-switch takes
  // effect on the very next emit instead of lagging up to 15s.
  __resetAuditRuntimeConfig();
  revalidatePath("/admin/system/audit");
  return { ok: true, message: "Réglages du journal d'audit enregistrés." };
}
