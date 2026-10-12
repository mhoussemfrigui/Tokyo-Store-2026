/**
 * Tokyo Care store-wide setting KEYS — client-safe (no `server-only`, no DB). Kept
 * separate from {@link module:lib/care/config} so the admin "Réglages" form (a
 * `"use client"` component) can reference the exact keys for its checkbox `name`
 * attributes without pulling the server-only settings reader into the browser
 * bundle. `config.ts` re-exports this as the single source of truth.
 */
export const CARE_SETTING_KEYS = {
  /** Master switch. Gates the storefront care offer AND the server-side charge. Default OFF. */
  enabled: "care.enabled",
  /** Charge the plan price per UNIT (×qty, matching the legacy placeholder) vs once per cart line. */
  chargePerUnit: "care.charge_per_unit",
  /** Whether the care charge counts toward the free-shipping threshold (default: no — goods only). */
  countsTowardFreeShipping: "care.counts_toward_free_shipping",
} as const;
