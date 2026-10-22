/**
 * Multi-location inventory config — PURE module (no server-only deps), so the
 * client settings panel can import the keys and a server page can resolve the
 * values from a settings map. Defaults keep the store SINGLE-POOL (the existing
 * behaviour) until the operator opts into per-location mode.
 */

/** `shared` = one stock pool (locations are organisational only, current
 *  behaviour); `per_location` = each location tracks its own stock. */
export type LocationMode = "shared" | "per_location";

export const INVENTORY_LOCATION_MODE_KEY = "inventory.location_mode";
export const INVENTORY_CARRIER_LINK_KEY = "inventory.carrier_link_enabled";
export const INVENTORY_TRANSFERS_KEY = "inventory.transfers_enabled";
export const INVENTORY_TRANSFER_AUTO_KEY = "inventory.transfer_auto_request";
export const INVENTORY_TRANSFER_SOURCING_KEY = "inventory.transfer_sourcing_strategy";
export const INVENTORY_WEB_STOCK_SOURCE_KEY = "inventory.web_stock_source";

/**
 * Where the WEBSITE fulfils from (operator-switchable), given per_location mode:
 *   - `central` (default) — the Centrale (the default location) is the online
 *     DEPOT: online orders ship from it, and when it runs short a store→Centrale
 *     auto-transfer tops it up ("prefer Centrale, auto-pull"). The 3 stores back
 *     the website through the Centrale. Matches the historical behaviour.
 *   - `combined` — flat aggregate: the locations are peers, the website isn't tied
 *     to a single depot, so there's no depot ship-decrement and no auto-pull.
 * Availability is the SAME in both — the sellable TOTAL (`stock_qty`) is the
 * authoritative count the storefront sells against (no oversell), and the website
 * never hides store stock; the mode only changes fulfilment + replenish.
 *
 * NOTE on the per-location invariant: `central` keeps total = Σ(active levels)
 * continuously because every fulfilment step that drops the total also drops a
 * location level (placement → total, ship/pickup → depot level, return → depot
 * level credit). `combined` has NO depot, so the order flow moves ONLY the total;
 * the per-location levels are the operator/ERP-maintained physical counts
 * (adjustLocationLevel via PATCH /api/stock, or the Stock matrix). The invariant
 * therefore holds only AT REST — after a sale the total can sit BELOW Σ(active
 * levels) until the operator/ERP reconciles the levels. This is by design, not a
 * bug: the total, not Σ-levels, is what gates sellability.
 */
export type WebStockSource = "combined" | "central";

/**
 * How the (later) order-driven auto-request picks WHICH store to pull from when
 * the selling depot can't fill an order:
 *   - `priority`   — the active locations in their display order (operator-ranked);
 *   - `most_stock` — the active location holding the most of the item first.
 */
export type TransferSourcingStrategy = "priority" | "most_stock";

export type InventoryConfig = {
  locationMode: LocationMode;
  /** Allow linking a location to a Livraison carrier / pickup point. */
  carrierLinkEnabled: boolean;
  /** Allow stock transfers between locations (gates the Transferts tab + auto-request). */
  transfersEnabled: boolean;
  /** Auto-create a store→depot transfer when an online order can't be filled from
   *  the depot — applied on `order.created` (lib/inventory/auto-transfer.ts).
   *  Off = the operator requests transfers manually. */
  transferAutoRequest: boolean;
  /** Which store the auto-request pulls from first. */
  transferSourcing: TransferSourcingStrategy;
  /** Website fulfilment model: `central` (Centrale is the online depot — ship from
   *  it + auto-pull) or `combined` (flat aggregate, no depot). Default `central`. */
  webStockSource: WebStockSource;
};

/** Resolve the inventory config from a settings map, with safe defaults. */
export function resolveInventoryConfig(
  settings: Record<string, string | null>,
): InventoryConfig {
  return {
    locationMode:
      settings[INVENTORY_LOCATION_MODE_KEY] === "per_location" ? "per_location" : "shared",
    carrierLinkEnabled: settings[INVENTORY_CARRIER_LINK_KEY] === "true",
    transfersEnabled: settings[INVENTORY_TRANSFERS_KEY] === "true",
    transferAutoRequest: settings[INVENTORY_TRANSFER_AUTO_KEY] === "true",
    transferSourcing:
      settings[INVENTORY_TRANSFER_SOURCING_KEY] === "most_stock" ? "most_stock" : "priority",
    // Default `central` preserves the historical depot-centric fulfilment; only an
    // explicit `combined` opts into the flat-aggregate model.
    webStockSource: settings[INVENTORY_WEB_STOCK_SOURCE_KEY] === "combined" ? "combined" : "central",
  };
}
