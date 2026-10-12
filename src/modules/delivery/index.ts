/**
 * Delivery module — public surface.
 *
 *   import {
 *     deliveryService,
 *     deliveryQueries,
 *     type DeliveryAgentRow,
 *     type PickupKind,
 *   } from "@/modules/delivery";
 *
 * CRUD lives in `service` (admin panels); enabled-only storefront reads in
 * `queries`. Money math (fees, free-threshold, order snapshot) is owned by
 * `@/lib/checkout/delivery`, not this module.
 */

export { deliveryService, type DeliveryService, type PickupKind } from "./service";
export {
  deliveryQueries,
  listEnabledAgents,
  listEnabledPickups,
} from "./queries";
export {
  delivery_agents,
  pickup_locations,
  delivery_zones,
  delivery_agent_zone_rates,
  type DeliveryAgentRow,
  type NewDeliveryAgentRow,
  type PickupLocationRow,
  type NewPickupLocationRow,
  type DeliveryZoneRow,
  type NewDeliveryZoneRow,
  type DeliveryAgentZoneRateRow,
} from "./schema";
