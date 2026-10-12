/**
 * Stock-location form parsing — PURE (no server-only deps), so the create/edit
 * actions (lib/actions/stock-locations.ts, a "use server" module that can only
 * export async functions) share it and it's unit-testable in isolation.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** A carrier / pickup-point soft link: a uuid, else null ("— Aucun —"). */
export function cleanCarrierRef(raw: FormDataEntryValue | null): string | null {
  const v = String(raw ?? "").trim();
  return UUID_RE.test(v) ? v : null;
}

/**
 * The "Emplacement actif" checkbox. A native checkbox posts "on" when ticked
 * and NOTHING when unticked, so the key's presence is the signal — the old
 * `!== "off"` test was always true and a location could never be deactivated.
 * The default location stays active (its form doesn't render the box at all,
 * so the missing key must not deactivate it).
 */
export function parseLocationActive(formData: FormData, isDefault: boolean): boolean {
  return isDefault ? true : formData.get("is_active") === "on";
}

/**
 * The `carrier_ref` patch for an EDIT. The carrier select is only rendered while
 * « Lier les emplacements à la livraison » is on, so a missing key means "field
 * not shown" — keep the stored link (was: nulled, silently erasing it on any
 * rename made while the feature was off). A present key is cleaned (a blank
 * « — Aucun — » clears it).
 */
export function carrierRefPatch(formData: FormData): { carrier_ref?: string | null } {
  return formData.has("carrier_ref") ? { carrier_ref: cleanCarrierRef(formData.get("carrier_ref")) } : {};
}
