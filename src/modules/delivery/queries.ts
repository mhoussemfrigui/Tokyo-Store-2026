import "server-only";

import { deliveryService, type PickupKind } from "./service";
import type { DeliveryAgentRow, PickupLocationRow } from "./schema";

/**
 * Read-side helpers for the storefront / checkout. Thin wrappers over the
 * service's enabled-only reads so callers import `deliveryQueries` (the public
 * read surface) instead of reaching into the CRUD service. The authoritative
 * price + order snapshot lives in `@/lib/checkout/delivery`.
 */

/** Enabled home-delivery agents in display order. */
export async function listEnabledAgents(): Promise<DeliveryAgentRow[]> {
  return deliveryService.listEnabledAgents();
}

/** Enabled pickup locations in display order, optionally filtered to one kind. */
export async function listEnabledPickups(kind?: PickupKind): Promise<PickupLocationRow[]> {
  return deliveryService.listEnabledPickups(kind);
}

export const deliveryQueries = {
  listEnabledAgents,
  listEnabledPickups,
};
