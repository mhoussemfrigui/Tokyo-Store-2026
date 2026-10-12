import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { normalizeGovernorate } from "@/lib/checkout/delivery-fee";
import {
  delivery_agents,
  pickup_locations,
  delivery_zones,
  delivery_agent_zone_rates,
  type DeliveryAgentRow,
  type NewDeliveryAgentRow,
  type NewPickupLocationRow,
  type PickupLocationRow,
  type DeliveryZoneRow,
  type NewDeliveryZoneRow,
  type DeliveryAgentZoneRateRow,
} from "./schema";

/** Pickup-location kinds — mirror the matching `delivery_method` enum values. */
export type PickupKind = "drive_by_pickup" | "in_store";

/**
 * Delivery service — pure CRUD on this module's own tables (home-delivery
 * agents + drive-by / in-store pickup locations).
 *
 * Admin panels insert/update/delete + list (incl. disabled rows); the
 * storefront reads only the enabled rows in display order via
 * `listEnabledAgents` / `listEnabledPickups`. The authoritative price + order
 * snapshot is computed in `@/lib/checkout/delivery` (which calls these reads);
 * this service never touches money math.
 */
class DeliveryService {
  // ──────────────────────────────────────────────────────── agents
  /** Agents in display order. Enabled-only by default (admin passes includeDisabled). */
  async listAgents(opts: { includeDisabled?: boolean } = {}): Promise<DeliveryAgentRow[]> {
    const rows = await db
      .select()
      .from(delivery_agents)
      .orderBy(asc(delivery_agents.display_order), asc(delivery_agents.name));
    return opts.includeDisabled ? rows : rows.filter((r) => r.enabled);
  }

  /** Enabled home-delivery agents in display order (storefront). */
  async listEnabledAgents(): Promise<DeliveryAgentRow[]> {
    return this.listAgents();
  }

  async getAgent(id: string): Promise<DeliveryAgentRow | null> {
    const [row] = await db
      .select()
      .from(delivery_agents)
      .where(eq(delivery_agents.id, id))
      .limit(1);
    return row ?? null;
  }

  async insertAgent(input: NewDeliveryAgentRow): Promise<DeliveryAgentRow> {
    const [row] = await db.insert(delivery_agents).values(input).returning();
    return row;
  }

  async updateAgent(
    id: string,
    patch: Partial<Omit<DeliveryAgentRow, "id" | "created_at">>,
  ): Promise<DeliveryAgentRow | null> {
    const [row] = await db
      .update(delivery_agents)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(delivery_agents.id, id))
      .returning();
    return row ?? null;
  }

  async deleteAgent(id: string): Promise<void> {
    await db.delete(delivery_agents).where(eq(delivery_agents.id, id));
  }

  // ──────────────────────────────────────────────────── pickup locations
  /** Pickup locations in display order. Optionally filter by kind / include disabled. */
  async listPickups(
    opts: { includeDisabled?: boolean; kind?: PickupKind } = {},
  ): Promise<PickupLocationRow[]> {
    const rows = await db
      .select()
      .from(pickup_locations)
      .orderBy(asc(pickup_locations.display_order), asc(pickup_locations.name));
    return rows.filter(
      (r) =>
        (opts.includeDisabled ? true : r.enabled) &&
        (opts.kind ? r.kind === opts.kind : true),
    );
  }

  /** Enabled pickup locations in display order, optionally for one kind (storefront). */
  async listEnabledPickups(kind?: PickupKind): Promise<PickupLocationRow[]> {
    return this.listPickups({ kind });
  }

  async getPickup(id: string): Promise<PickupLocationRow | null> {
    const [row] = await db
      .select()
      .from(pickup_locations)
      .where(eq(pickup_locations.id, id))
      .limit(1);
    return row ?? null;
  }

  async insertPickup(input: NewPickupLocationRow): Promise<PickupLocationRow> {
    const [row] = await db.insert(pickup_locations).values(input).returning();
    return row;
  }

  async updatePickup(
    id: string,
    patch: Partial<Omit<PickupLocationRow, "id" | "created_at">>,
  ): Promise<PickupLocationRow | null> {
    const [row] = await db
      .update(pickup_locations)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(pickup_locations.id, id))
      .returning();
    return row ?? null;
  }

  async deletePickup(id: string): Promise<void> {
    await db.delete(pickup_locations).where(eq(pickup_locations.id, id));
  }

  // ──────────────────────────────────────────────────── zones (region pricing)
  async listZones(opts: { includeDisabled?: boolean } = {}): Promise<DeliveryZoneRow[]> {
    const rows = await db
      .select()
      .from(delivery_zones)
      .orderBy(asc(delivery_zones.display_order), asc(delivery_zones.name));
    return opts.includeDisabled ? rows : rows.filter((r) => r.enabled);
  }

  async getZone(id: string, txOrDb: DbOrTx = db): Promise<DeliveryZoneRow | null> {
    const [row] = await txOrDb.select().from(delivery_zones).where(eq(delivery_zones.id, id)).limit(1);
    return row ?? null;
  }

  // The zone writes accept an optional transaction so the zone workflows
  // (`@/workflows/delivery/zone`) can save a zone + its courier rates atomically.
  async insertZone(input: NewDeliveryZoneRow, txOrDb: DbOrTx = db): Promise<DeliveryZoneRow> {
    const [row] = await txOrDb.insert(delivery_zones).values(input).returning();
    return row;
  }

  async updateZone(
    id: string,
    patch: Partial<Omit<DeliveryZoneRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ): Promise<DeliveryZoneRow | null> {
    const [row] = await txOrDb
      .update(delivery_zones)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(delivery_zones.id, id))
      .returning();
    return row ?? null;
  }

  async deleteZone(id: string, txOrDb: DbOrTx = db): Promise<void> {
    await txOrDb.delete(delivery_agent_zone_rates).where(eq(delivery_agent_zone_rates.zone_id, id));
    await txOrDb.delete(delivery_zones).where(eq(delivery_zones.id, id));
  }

  /**
   * The first ENABLED zone whose governorate list contains `region`
   * (case-insensitive, comma-split). Used by the authoritative delivery resolver
   * when region pricing is on. Returns null when no zone covers the region.
   */
  async resolveZoneForRegion(region: string | null | undefined): Promise<DeliveryZoneRow | null> {
    // Accent- + case-insensitive: the storefront submits the accented canonical
    // name ("Béja") but the admin zone list is free text ("beja"), so both sides
    // are folded the same way (see normalizeGovernorate).
    const r = normalizeGovernorate(region);
    if (!r) return null;
    const zones = await this.listZones();
    for (const z of zones) {
      const govs = z.governorates
        .split(",")
        .map((g) => normalizeGovernorate(g))
        .filter(Boolean);
      if (govs.includes(r)) return z;
    }
    return null;
  }

  // ─────────────────────────────────────────── agent × zone rates
  async listRates(): Promise<DeliveryAgentZoneRateRow[]> {
    return db.select().from(delivery_agent_zone_rates);
  }

  async getAgentZoneRate(agentId: string, zoneId: string): Promise<DeliveryAgentZoneRateRow | null> {
    const [row] = await db
      .select()
      .from(delivery_agent_zone_rates)
      .where(
        sql`${delivery_agent_zone_rates.agent_id} = ${agentId} and ${delivery_agent_zone_rates.zone_id} = ${zoneId}`,
      )
      .limit(1);
    return row ?? null;
  }

  /** Upsert one courier×zone rate (delete when fee is null = "no override"). */
  async setAgentZoneRate(
    agentId: string,
    zoneId: string,
    feeCents: number | null,
    freeThresholdCents: number | null,
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    if (feeCents == null) {
      await txOrDb
        .delete(delivery_agent_zone_rates)
        .where(
          sql`${delivery_agent_zone_rates.agent_id} = ${agentId} and ${delivery_agent_zone_rates.zone_id} = ${zoneId}`,
        );
      return;
    }
    await txOrDb
      .insert(delivery_agent_zone_rates)
      .values({ agent_id: agentId, zone_id: zoneId, fee_cents: feeCents, free_threshold_cents: freeThresholdCents })
      .onConflictDoUpdate({
        target: [delivery_agent_zone_rates.agent_id, delivery_agent_zone_rates.zone_id],
        set: { fee_cents: feeCents, free_threshold_cents: freeThresholdCents, updated_at: sql`now()` },
      });
  }
}

export const deliveryService = new DeliveryService();
export type { DeliveryService };
