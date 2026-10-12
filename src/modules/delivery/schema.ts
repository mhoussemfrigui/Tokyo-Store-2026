import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Delivery module.
 *
 *   delivery_agents   — home-delivery couriers; each has its own fee + optional
 *                       free-shipping threshold (NULL = inherit the global
 *                       checkout.delivery.* base rate).
 *   pickup_locations  — drive-by + in-store points; each has a flat fee.
 *   delivery_zones    — named governorate groupings (e.g. Grand Tunis vs Intérieur)
 *                       used by OPTIONAL region pricing (delivery.zone_pricing_enabled).
 *   delivery_agent_zone_rates — per-courier × zone fee override; only consulted
 *                       when region pricing is ON, else couriers use their flat fee.
 *
 * The chosen agent/location id + a name/address snapshot are recorded on the
 * order (orders.delivery_* columns) so history survives row edits/deletes.
 */
export const delivery_agents = pgTable(
  "delivery_agents",
  {
    id: id(),
    name: text("name").notNull(),
    /** Flat home-delivery fee (millimes). NULL = inherit the global default fee. */
    fee_cents: integer("fee_cents"),
    /** Free above this subtotal (millimes). NULL = inherit global; 0 = never free. */
    free_threshold_cents: integer("free_threshold_cents"),
    phone: text("phone"),
    zone_label: text("zone_label"),
    enabled: boolean("enabled").notNull().default(true),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => ({
    enabledIdx: index("delivery_agents_enabled_idx").on(t.enabled, t.display_order),
  }),
);

export const pickup_locations = pgTable(
  "pickup_locations",
  {
    id: id(),
    name: text("name").notNull(),
    /** 'drive_by_pickup' | 'in_store' — matches the delivery_method it serves. */
    kind: text("kind").notNull(),
    /** Flat pickup fee (millimes); 0 = free. */
    fee_cents: integer("fee_cents").notNull().default(0),
    address_line: text("address_line"),
    city: text("city"),
    region: text("region"),
    phone: text("phone"),
    hours_label: text("hours_label"),
    enabled: boolean("enabled").notNull().default(true),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => ({
    enabledIdx: index("pickup_locations_enabled_idx").on(t.enabled, t.display_order),
  }),
);

/**
 * A named zone = a group of governorates that share a delivery rate (e.g.
 * "Grand Tunis", "Intérieur"). `governorates` is a comma-separated list of
 * gouvernorat names matched case-insensitively against the order's ship_region.
 * Only consulted when `delivery.zone_pricing_enabled` is true.
 */
export const delivery_zones = pgTable(
  "delivery_zones",
  {
    id: id(),
    name: text("name").notNull(),
    /** Comma-separated gouvernorats covered by this zone. */
    governorates: text("governorates").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => ({
    enabledIdx: index("delivery_zones_enabled_idx").on(t.enabled, t.display_order),
  }),
);

/** Per-courier × zone rate. Absent ⇒ the courier's flat fee applies even with
 *  zone pricing on. `free_threshold_cents` NULL inherits the courier/global. */
export const delivery_agent_zone_rates = pgTable(
  "delivery_agent_zone_rates",
  {
    id: id(),
    agent_id: uuid("agent_id").notNull(),
    zone_id: uuid("zone_id").notNull(),
    fee_cents: integer("fee_cents").notNull(),
    free_threshold_cents: integer("free_threshold_cents"),
    ...timestamps(),
  },
  (t) => ({
    uniq: uniqueIndex("delivery_agent_zone_rates_uniq").on(t.agent_id, t.zone_id),
    zoneIdx: index("delivery_agent_zone_rates_zone_idx").on(t.zone_id),
  }),
);

export type DeliveryAgentRow = typeof delivery_agents.$inferSelect;
export type NewDeliveryAgentRow = typeof delivery_agents.$inferInsert;
export type PickupLocationRow = typeof pickup_locations.$inferSelect;
export type NewPickupLocationRow = typeof pickup_locations.$inferInsert;
export type DeliveryZoneRow = typeof delivery_zones.$inferSelect;
export type NewDeliveryZoneRow = typeof delivery_zones.$inferInsert;
export type DeliveryAgentZoneRateRow = typeof delivery_agent_zone_rates.$inferSelect;
export type NewDeliveryAgentZoneRateRow = typeof delivery_agent_zone_rates.$inferInsert;
