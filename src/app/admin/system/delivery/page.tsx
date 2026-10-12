import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { AdminPageHeader } from "@/components/admin/page-header";
import { getDeliveryConfig } from "@/lib/checkout/delivery";
import { getCheckoutCopy } from "@/lib/checkout/copy";
import {
  deliveryService,
  type DeliveryAgentRow,
  type PickupLocationRow,
  type DeliveryZoneRow,
} from "@/modules/delivery";
import { minorToDinars } from "@/lib/price";

import {
  DeliveryPanel,
  type AgentView,
  type LocationView,
  type MethodsView,
  type ZoneView,
} from "./delivery-panel";

export const metadata: Metadata = { title: "Livraison" };
// Config + agents + locations are admin-live; never statically cache.
export const dynamic = "force-dynamic";

/** Millimes → editable TND string; NULL (inherit) → "" so the input shows empty. */
function feeToTnd(cents: number | null): string {
  return cents != null ? String(minorToDinars(cents)) : "";
}

function agentView(a: DeliveryAgentRow): AgentView {
  return {
    id: a.id,
    name: a.name,
    feeTnd: feeToTnd(a.fee_cents),
    freeThresholdTnd: feeToTnd(a.free_threshold_cents),
    phone: a.phone ?? "",
    zoneLabel: a.zone_label ?? "",
    enabled: a.enabled,
    displayOrder: a.display_order,
  };
}

function locationView(l: PickupLocationRow): LocationView {
  return {
    id: l.id,
    name: l.name,
    kind: l.kind === "in_store" ? "in_store" : "drive_by_pickup",
    feeTnd: feeToTnd(l.fee_cents),
    addressLine: l.address_line ?? "",
    city: l.city ?? "",
    region: l.region ?? "",
    phone: l.phone ?? "",
    hoursLabel: l.hours_label ?? "",
    enabled: l.enabled,
    displayOrder: l.display_order,
  };
}

/**
 * Livraison — the delivery control surface: the methods offered storewide
 * (3 toggles), the home-delivery transporteurs (agents), and the drive/in-store
 * points de retrait (pickup locations).
 *
 * Loads in parallel the method config (settings) and the FULL agent + location
 * lists (admin sees disabled rows too — `includeDisabled`). The authoritative
 * checkout price + order snapshot is computed elsewhere (`@/lib/checkout/delivery`).
 */
export default async function DeliverySettingsPage() {
  const session = await requirePermission("system_delivery", "view");
  // A view-only role sees read-only cards (no save / delete / add controls that
  // would only answer with a refusal); the actions re-check server-side.
  const perms = await resolveUserPermissions(session.user.id);
  const can = {
    canCreate: permissionSetAllows(perms, "system_delivery", "create"),
    canUpdate: permissionSetAllows(perms, "system_delivery", "update"),
    canDelete: permissionSetAllows(perms, "system_delivery", "delete"),
  };
  const [config, copy, agents, locations, zones, rates] = await Promise.all([
    getDeliveryConfig(),
    // Global home-delivery base fee + free-shipping threshold (same
    // `checkout.delivery.*_cents` keys as Réglages commande) so they can be
    // edited here too; "" when unset → the field shows empty (cart falls back).
    getCheckoutCopy(),
    deliveryService.listAgents({ includeDisabled: true }),
    deliveryService.listPickups({ includeDisabled: true }),
    deliveryService.listZones({ includeDisabled: true }),
    deliveryService.listRates(),
  ]);

  const methods: MethodsView = {
    homeEnabled: config.homeEnabled,
    driveByEnabled: config.driveByEnabled,
    inStoreEnabled: config.inStoreEnabled,
    zonePricingEnabled: config.zonePricingEnabled,
    freeShippingEnabled: copy.freeShippingEnabled,
    defaultFeeTnd: feeToTnd(copy.defaultFeeCents),
    freeThresholdTnd: feeToTnd(copy.freeThresholdCents),
  };

  const agentViews = agents.map(agentView);
  const ratesByZoneAgent = new Map<string, { feeTnd: string; thresholdTnd: string }>();
  for (const r of rates) {
    ratesByZoneAgent.set(`${r.zone_id}:${r.agent_id}`, {
      feeTnd: feeToTnd(r.fee_cents),
      thresholdTnd: feeToTnd(r.free_threshold_cents),
    });
  }
  const zoneViews: ZoneView[] = zones.map((z: DeliveryZoneRow) => ({
    id: z.id,
    name: z.name,
    governorates: z.governorates,
    enabled: z.enabled,
    displayOrder: z.display_order,
    rates: agentViews.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      feeTnd: ratesByZoneAgent.get(`${z.id}:${a.id}`)?.feeTnd ?? "",
      thresholdTnd: ratesByZoneAgent.get(`${z.id}:${a.id}`)?.thresholdTnd ?? "",
    })),
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour au Système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="Livraison"
            description="Méthodes de livraison, transporteurs et points de retrait. Les frais sont en TND ; le seuil de gratuité s'applique à la livraison à domicile uniquement."
          />
        </div>
      </div>

      <DeliveryPanel
        methods={methods}
        agents={agentViews}
        locations={locations.map(locationView)}
        zones={zoneViews}
        perms={can}
      />
    </div>
  );
}
