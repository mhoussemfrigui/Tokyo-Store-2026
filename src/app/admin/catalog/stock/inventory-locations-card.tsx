"use client";

import { MapPin } from "lucide-react";

import { type InventoryConfig } from "@/lib/inventory/locations-config";
import {
  LocationsPanel,
  type CarrierOption,
  type LocationView,
} from "@/app/admin/catalog/locations/locations-panel";

/**
 * "Emplacements & multi-stock" — the inventory LOCATIONS settings + CRUD, shown
 * as the "Emplacements" sub-tab of the Stock page (locations are a stock
 * parameter, so they live beside the stock table rather than on a separate
 * top-level page). The tab is the show/hide affordance, so the card itself is
 * always open with a static header.
 */
export function InventoryLocationsCard({
  canManage,
  config,
  carrierOptions,
  locations,
}: {
  canManage: boolean;
  config: InventoryConfig;
  carrierOptions: CarrierOption[];
  locations: LocationView[];
}) {
  const perLocation = config.locationMode === "per_location";
  const activeCount = locations.filter((l) => l.isActive).length;
  const summary = perLocation
    ? `par emplacement · ${activeCount} actif${activeCount > 1 ? "s" : ""}`
    : "pool partagé";

  return (
    <section className="rounded-[28px] border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-6 py-5">
        <MapPin className="h-5 w-5 shrink-0 text-primary" />
        <span className="text-[18px] font-black text-foreground">Emplacements &amp; multi-stock</span>
        <span className="truncate text-[12px] text-muted-foreground">· {summary}</span>
      </div>
      <div className="p-6">
        <LocationsPanel
          canManage={canManage}
          config={config}
          carrierOptions={carrierOptions}
          locations={locations}
        />
      </div>
    </section>
  );
}
