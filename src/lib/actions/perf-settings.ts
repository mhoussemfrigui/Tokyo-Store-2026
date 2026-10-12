"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { resolvePerformanceConfig } from "@/lib/telemetry/perf-config";
import { __resetPerfRuntimeConfig } from "@/lib/telemetry/perf-runtime-config";

/**
 * Persist the performance/monitoring settings (`perf.*` site_settings) from the
 * "Infrastructure → Performance → Réglages" form. Mirrors saveAuditSettingsAction:
 * requirePermission(manage) → normalize through the SAME pure resolver the sampler
 * reads (resolvePerformanceConfig, so a hand-typed value is clamped) → upsert each
 * key (which emits setting.upserted, so the change is audited) → drop the runtime
 * cache so the sampler picks up the new cadence/thresholds within one tick →
 * revalidate.
 */
export async function savePerfSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_performance", "manage");

  const raw: Record<string, string | null> = {
    "perf.sampling_enabled": formData.get("perf.sampling_enabled") === "on" ? "true" : "false",
    "perf.sample_interval_sec": String(formData.get("perf.sample_interval_sec") ?? ""),
    "perf.history_size": String(formData.get("perf.history_size") ?? ""),
    "perf.heartbeat_interval_sec": String(formData.get("perf.heartbeat_interval_sec") ?? ""),
    "perf.ram_warn_pct": String(formData.get("perf.ram_warn_pct") ?? ""),
    "perf.cpu_warn_pct": String(formData.get("perf.cpu_warn_pct") ?? ""),
    "perf.event_loop_lag_warn_ms": String(formData.get("perf.event_loop_lag_warn_ms") ?? ""),
    "perf.db_latency_warn_ms": String(formData.get("perf.db_latency_warn_ms") ?? ""),
    "perf.alert_email_enabled": formData.get("perf.alert_email_enabled") === "on" ? "true" : "false",
    "perf.alert_cooldown_min": String(formData.get("perf.alert_cooldown_min") ?? ""),
    "perf.alert_breaches_required": String(formData.get("perf.alert_breaches_required") ?? ""),
    "perf.alert_recipients": String(formData.get("perf.alert_recipients") ?? ""),
  };
  const cfg = resolvePerformanceConfig(raw);

  const entries: Array<{ key: string; value: string; type: "text" | "boolean"; label: string }> = [
    { key: "perf.sampling_enabled", value: cfg.samplingEnabled ? "true" : "false", type: "boolean", label: "Performance — échantillonnage activé" },
    { key: "perf.sample_interval_sec", value: String(cfg.sampleIntervalSec), type: "text", label: "Performance — intervalle d'échantillonnage (s)" },
    { key: "perf.history_size", value: String(cfg.historySize), type: "text", label: "Performance — taille de l'historique" },
    { key: "perf.heartbeat_interval_sec", value: String(cfg.heartbeatIntervalSec), type: "text", label: "Performance — intervalle de heartbeat (s)" },
    { key: "perf.ram_warn_pct", value: String(cfg.ramWarnPct), type: "text", label: "Performance — seuil d'alerte RAM (%)" },
    { key: "perf.cpu_warn_pct", value: String(cfg.cpuWarnPct), type: "text", label: "Performance — seuil d'alerte CPU (%)" },
    { key: "perf.event_loop_lag_warn_ms", value: String(cfg.eventLoopLagWarnMs), type: "text", label: "Performance — seuil boucle d'évènements (ms)" },
    { key: "perf.db_latency_warn_ms", value: String(cfg.dbLatencyWarnMs), type: "text", label: "Performance — seuil latence DB (ms)" },
    { key: "perf.alert_email_enabled", value: cfg.alertEmailEnabled ? "true" : "false", type: "boolean", label: "Performance — envoi d'alertes par email" },
    { key: "perf.alert_cooldown_min", value: String(cfg.alertCooldownMin), type: "text", label: "Performance — délai anti-répétition (min)" },
    { key: "perf.alert_breaches_required", value: String(cfg.alertBreachesRequired), type: "text", label: "Performance — échantillons consécutifs requis" },
    // Persist the NORMALIZED recipient list (deduped/validated/lowercased) so a
    // bad paste is cleaned at save time, not just at read time.
    { key: "perf.alert_recipients", value: cfg.alertRecipients.join(", "), type: "text", label: "Performance — destinataires des alertes" },
  ];

  for (const e of entries) {
    const res = await workflows.cms.upsertSetting(
      {
        key: e.key,
        value: e.value,
        type: e.type as never,
        groupKey: "perf",
        label: e.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // Drop the in-process TTL cache so the sampler applies the new cadence +
  // thresholds on its next tick instead of lagging up to 15s.
  __resetPerfRuntimeConfig();
  revalidatePath("/admin/system/performance");
  return { ok: true, message: "Réglages de performance enregistrés." };
}
