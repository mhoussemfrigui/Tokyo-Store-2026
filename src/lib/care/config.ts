import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { CARE_SETTING_KEYS } from "@/lib/care/keys";

/**
 * Tokyo Care feature configuration — the master switch plus the global charging
 * controls. Unlike most feature flags which default ON, Tokyo
 * Care CHARGES MONEY, so it FAILS CLOSED: `care.enabled` defaults to FALSE and
 * stays off until the operator explicitly turns it on (matches the money/marketing
 * kill-switch posture that settings-fail-closed.test.ts enforces). The per-plan
 * characteristics, pricing and eligibility all live on the `care_plans` rows
 * (admin-controlled from the Tokyo Care tab) — this config only carries the few
 * STORE-WIDE knobs.
 *
 * `getSettingsMap` is React-cache()'d, so reads here dedupe within a request.
 */
function asBool(v: string | null | undefined, fb: boolean): boolean {
  if (v == null) return fb;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return fb;
}

/** site_settings keys for the store-wide Tokyo Care controls (Catalogue → Tokyo Care → Réglages). */
export { CARE_SETTING_KEYS } from "@/lib/care/keys";

export type CareConfig = {
  enabled: boolean;
  chargePerUnit: boolean;
  countsTowardFreeShipping: boolean;
};

async function settings(): Promise<Record<string, string | null>> {
  try {
    return await getSettingsMap();
  } catch {
    // Settings unavailable → fail CLOSED (feature OFF) for this charging subsystem.
    return {};
  }
}

/** PURE builder (no DB) — fail-safe defaults live here so they can be unit tested. */
export function buildCareConfig(s: Record<string, string | null>): CareConfig {
  return {
    // Fail-closed: a money-charging add-on stays OFF until explicitly enabled.
    enabled: asBool(s[CARE_SETTING_KEYS.enabled], false),
    chargePerUnit: asBool(s[CARE_SETTING_KEYS.chargePerUnit], true),
    countsTowardFreeShipping: asBool(s[CARE_SETTING_KEYS.countsTowardFreeShipping], false),
  };
}

/** The full Tokyo Care config — used by the admin Réglages panel + the charge path. */
export async function resolveCareConfig(): Promise<CareConfig> {
  return buildCareConfig(await settings());
}
