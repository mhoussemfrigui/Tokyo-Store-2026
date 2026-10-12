/**
 * PURE delivery rules — no I/O, no `server-only`, so BOTH the authoritative
 * server resolver (`./delivery` `resolveDelivery` / `listDeliveryOptions`) and
 * the client checkout form import the SAME functions. This is the guard against
 * the class of bug where the fee SHOWN to the customer drifts from the fee
 * CHARGED: there is one free-threshold rule, one governorate normalization, and
 * one zone-lookup, used on both sides. Money is integer millimes throughout
 * (see `@/lib/price`).
 */

import { TUNISIA_GOVERNORATES } from "@/lib/geo/tunisia";

/**
 * Canonical key for a gouvernorat name so matching is tolerant of CASE and
 * ACCENTS. The storefront region pickers submit the accented canonical name
 * (e.g. "Béja", "Gabès"), but the admin delivery-zone `governorates` list is
 * free text — an operator may type "beja" or "Gabes". Without folding accents
 * those silently fail to match and the customer is charged the flat fee instead
 * of the zone rate. `normalize("NFD")` splits letters from their diacritics, then
 * we drop the combining marks (é→e, è→e, à→a). Pure + client-safe, and used by
 * BOTH the server (`resolveZoneForRegion`, `buildRegionAgentFeeIndex`) and the
 * client (`zoneHomeAgentFee`) so all three agree.
 */
export function normalizeGovernorate(s: string | null | undefined): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip combining diacritics
}

/**
 * Map a free-text, comma-separated gouvernorat list (the admin delivery-zone
 * field) to the OFFICIAL canonical names, so a saved zone matches the exact
 * values the storefront governorate picker submits. Each entry is matched
 * accent-/case-insensitively, tolerating a dropped "La"/"Le" article ("manouba"
 * → "La Manouba", "kef" → "Le Kef"). An unmatched entry is kept (trimmed) so an
 * operator can still enter a custom value. Run on save so stored data is clean.
 */
export function canonicalizeGovernorateList(input: string | null | undefined): string {
  const canon = TUNISIA_GOVERNORATES.map((g) => ({ name: g, key: normalizeGovernorate(g) }));
  return (input ?? "")
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const k = normalizeGovernorate(raw);
      const exact = canon.find((c) => c.key === k);
      if (exact) return exact.name;
      const articled = canon.find((c) => c.key.endsWith(` ${k}`));
      return articled ? articled.name : raw;
    })
    .join(", ");
}

/**
 * Region (gouvernorat, lower-cased) → courier agent id → the courier's resolved
 * zone fee for that region. `thresholdCents` is the FULLY-RESOLVED free-shipping
 * threshold for that zone rate (`rate ?? agent ?? global base`), so the client
 * needs nothing else to mirror the server's free-shipping decision. Only regions
 * that actually map to a zone with a per-courier rate appear; everything else
 * falls back to the courier's flat fee (exactly like `resolveDelivery`).
 */
export type RegionAgentFeeIndex = Record<
  string,
  Record<string, { feeCents: number; thresholdCents: number }>
>;

/**
 * The one free-shipping rule. A threshold of 0 means "never free" (the admin
 * sentinel — to make delivery always free you set the FEE to 0, not the
 * threshold). Mirrors the inline checks in `delivery.ts` that this replaces.
 */
export function applyFreeThreshold(
  feeCents: number,
  thresholdCents: number,
  subtotalCents: number,
): { feeCents: number; freeApplied: boolean } {
  const freeApplied = thresholdCents > 0 && subtotalCents >= thresholdCents;
  return { feeCents: freeApplied ? 0 : feeCents, freeApplied };
}

/**
 * Zone-priced fee for a chosen home-delivery AGENT in a given region, or `null`
 * when no zone rate applies (the caller then uses the agent's flat option fee —
 * the same fallback `resolveDelivery` makes server-side). Pure map lookup +
 * `applyFreeThreshold`, so the client recomputes the displayed fee the instant
 * the gouvernorat select changes, with no round-trip, and it always equals what
 * `resolveDelivery` will charge for that (agent, region, subtotal).
 */
export function zoneHomeAgentFee(
  index: RegionAgentFeeIndex | null | undefined,
  region: string | null | undefined,
  agentId: string | null | undefined,
  subtotalCents: number,
): { feeCents: number; freeApplied: boolean } | null {
  if (!index || !agentId) return null;
  const r = normalizeGovernorate(region);
  if (!r) return null;
  const entry = index[r]?.[agentId];
  if (!entry) return null;
  return applyFreeThreshold(entry.feeCents, entry.thresholdCents, subtotalCents);
}
