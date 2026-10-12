/**
 * PURE low-stock alert config + crossing detection — NO "server-only", NO DB,
 * so it can be unit-tested directly and imported from anywhere (place-order
 * capture, the subscriber, the admin form preview). Mirrors the pure-config
 * pattern of perf-config / search parse-config.
 *
 * The feature alerts operators when a SALE takes a TRACKED product/variant's
 * stock down to (or below) a configured threshold — fired ONLY on the crossing
 * edge so a cart that buys the last 3 of a 4-stock item raises one alert, not
 * one per subsequent sale at 0.
 */

import { parseEmailRecipients } from "@/lib/format/email-recipients";

export type LowStockConfig = {
  /** Master switch — when false, no crossing is evaluated and nothing is emitted. */
  enabled: boolean;
  /** A sale that lands stock at or below this (and was above it) raises `stock_low`.
   *  0 disables the "low" warning while keeping the out-of-stock (`depleted`) alert. */
  threshold: number;
  /** Operator recipients (resolved emails). Empty ⇒ the subscriber falls back to
   *  every active admin. */
  recipients: string[];
};

export const LOW_STOCK_DEFAULTS: LowStockConfig = {
  enabled: false,
  threshold: 5,
  recipients: [],
};

const MAX_THRESHOLD = 100_000;

function toBool(v: string | null | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "on") return true;
  if (s === "false" || s === "0" || s === "off") return false;
  return fallback;
}

/** Split a CSV/whitespace recipient list into validated, de-duplicated,
 *  lower-cased emails (capped) — the SHARED parser, so this matches the perf
 *  alert's validation + fan-out cap instead of diverging. */
export function parseRecipients(raw: string | null | undefined): string[] {
  return parseEmailRecipients(raw);
}

/**
 * Resolve the low-stock config from the raw `site_settings` map. Clamps the
 * threshold into [0, MAX_THRESHOLD]; a blank/NaN threshold falls back to the
 * default. Pure — the caller supplies the already-read settings map.
 */
export function resolveLowStockConfig(
  map: Record<string, string | null>,
): LowStockConfig {
  const rawThreshold = map["stock.low_threshold_qty"];
  const parsed = rawThreshold == null || rawThreshold.trim() === "" ? NaN : Number(rawThreshold);
  const threshold = Number.isFinite(parsed)
    ? Math.min(MAX_THRESHOLD, Math.max(0, Math.trunc(parsed)))
    : LOW_STOCK_DEFAULTS.threshold;
  return {
    enabled: toBool(map["stock.alert_enabled"], LOW_STOCK_DEFAULTS.enabled),
    threshold,
    recipients: parseRecipients(map["stock.alert_recipients"]),
  };
}

export type StockCrossing = "depleted" | "low" | null;

/**
 * Classify a stock change as a low-stock CROSSING. Returns:
 *   - "depleted" when the change took stock to 0 (or below) from a positive level;
 *   - "low" when it landed in (0, threshold] from above the threshold;
 *   - null otherwise (no crossing — already low, restock, or threshold disabled).
 *
 * Only the crossing EDGE fires, so repeated sales at/below the line don't spam.
 * `threshold <= 0` disables the "low" tier (depleted still fires).
 */
export function classifyStockCrossing(
  prevQty: number,
  newQty: number,
  threshold: number,
): StockCrossing {
  // Only a genuine decrease can cross downward.
  if (newQty >= prevQty) return null;
  if (newQty <= 0 && prevQty > 0) return "depleted";
  if (threshold > 0 && newQty <= threshold && prevQty > threshold) return "low";
  return null;
}
