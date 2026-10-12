import type { Metadata } from "next";

import { productService } from "@/modules/catalog/product/service";
import { productQueries } from "@/modules/catalog/product";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveLowStockConfig } from "@/lib/inventory/low-stock";
import { resolveInventoryConfig } from "@/lib/inventory/locations-config";
import { resolveErpConfig } from "@/lib/inventory/erp-config";
import { stockLocationService } from "@/modules/stock-location";
import { stockTransferService, TRANSFERS_PAGE_SIZE } from "@/modules/stock-transfer";
import type { TransferStatus } from "@/modules/stock-transfer/schema";
import { deliveryQueries } from "@/modules/delivery/queries";

import { StockPanel } from "./stock-panel";
import { StockTabs } from "./stock-tabs";
import { InventoryLocationsCard } from "./inventory-locations-card";
import { TransfersPanel } from "./transfers-panel";
import { ErpPanel } from "./erp-panel";
import { ReglagesPanel } from "./reglages-panel";
import { type CarrierOption } from "@/app/admin/catalog/locations/locations-panel";

export const metadata: Metadata = { title: "Stock — Catalogue" };

/**
 * Global inventory page — every (non-deleted) product on one screen with
 * inline-editable `in_stock` + `stock_qty`. The page itself stays a thin
 * Server Component that:
 *   - reads filters from `searchParams`
 *   - issues ONE service.list call (no per-row work — the table is
 *     intentionally not joining brand/category to keep it fast and to
 *     reflect what an upstream inventory API would push)
 *   - hands the rows to the client panel that owns the dirty-state UI
 *     and posts to `bulkUpdateStockAction` (shared pool) or
 *     `setLocationLevelsAction` (per-location).
 *
 * Layout: five sub-tabs (StockTabs) — INVENTAIRE (the editable table, default),
 * EMPLACEMENTS (locations / multi-stock), TRANSFERTS (inter-location moves), ERP
 * (linkage posture) and RÉGLAGES (every stock setting: variant mode, low-stock
 * alerts, multi-stock + transfer settings). These are all stock parameters, so
 * they live here as tabs rather than separate top-level pages. The product
 * Référence externe (ERP) is shown read-only per row.
 *
 * ERP/inventory sync: an external system reconciles stock through the keyed
 * `/api/stock` endpoint (GET/PATCH by productId | externalRef | sku | gtin),
 * which writes the cached TOTAL via the same `applyStockSet`/`applyStockDelta`
 * helpers the admin uses — so admin + API + order paths stay consistent.
 */
export default async function StockAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("stock", "view");
  // "update" gates every editing surface — the inventory table, the alert
  // settings and the locations card render read-only without it (each action
  // re-checks server-side).
  const canManageStock = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "stock",
    "update",
  );
  // No `.catch`: the alert settings + locations card are pre-filled from this. A
  // swallowed read resolves locationMode « shared », so saving ANY locations
  // toggle would silently switch per_location back to shared (the confirm dialog
  // compares against the same degraded config). A failure reaches the admin
  // error boundary (retry) instead.
  const settings = await getSettingsMap();
  const lowStockCfg = resolveLowStockConfig(settings);
  const inventoryCfg = resolveInventoryConfig(settings);
  const multiLocation = inventoryCfg.locationMode === "per_location";
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() || undefined : undefined;
  const filter = typeof sp.filter === "string" ? sp.filter : undefined;
  const page = typeof sp.page === "string" ? Math.max(1, parseInt(sp.page, 10) || 1) : 1;
  // `?tab=emplacements` (the old /admin/catalog/locations redirect) opens that
  // sub-tab; StockTabs validates the value.
  const initialTab = typeof sp.tab === "string" ? sp.tab : undefined;

  // Filter + paginate at the DB with a TRUE total count, so "Rupture" surfaces
  // across the WHOLE catalog (not just a fetched window) and the count is honest.
  // « Bas » uses the operator's configured threshold (the alert emails' line),
  // not a hardcoded 5 — the table badges get the same value below.
  const [result, sharedStockDefault] = await Promise.all([
    productService.listStockPaged({
      search: q,
      filter,
      lowThreshold: lowStockCfg.threshold,
      page,
      pageSize: 50,
    }),
    getSharedStockDefault(),
  ]);

  // For VARIABLE products on this page, load their variants so a product in
  // "par variante" mode can be expanded to edit per-variant stock. Shared-mode
  // (and simple) products keep editing the single product-level pool as before.
  const variableIds = result.items
    .filter((p) => p.product_type === "variable")
    .map((p) => p.id);
  const variantsByProduct = variableIds.length
    ? await productQueries.listVariantsForProducts(variableIds).catch(() => new Map())
    : new Map();

  // Locations feed the inline "Emplacements" card (the settings + CRUD, folded
  // into this page instead of a separate tab). One listAll() serves BOTH the
  // card and the table's active-location columns. The per-location unit counts
  // (an unbounded GROUP BY over stock_levels) are only worth computing once
  // there's MORE than one location — in the default single-location store the
  // sole location simply holds the product totals.
  const allLocations = await stockLocationService.listAll().catch(() => []);
  const unitsByLocation =
    allLocations.length > 1
      ? await stockLocationService.unitsByLocation().catch(() => new Map<string, number>())
      : new Map<string, number>();
  const activeLocations = allLocations.filter((l) => l.is_active);
  const locationViews = allLocations.map((l) => ({
    id: l.id,
    name: l.name,
    code: l.code,
    carrierRef: l.carrier_ref,
    isDefault: l.is_default,
    isActive: l.is_active,
    units: unitsByLocation.get(l.id) ?? 0,
  }));

  // Carrier/pickup link targets — only when the link feature is on.
  let carrierOptions: CarrierOption[] = [];
  if (inventoryCfg.carrierLinkEnabled) {
    const [agents, pickups] = await Promise.all([
      deliveryQueries.listEnabledAgents().catch(() => []),
      deliveryQueries.listEnabledPickups().catch(() => []),
    ]);
    carrierOptions = [
      ...agents.map((a) => ({ id: a.id, label: a.name, kind: "Transporteur" as const })),
      ...pickups.map((p) => ({ id: p.id, label: p.name, kind: "Point de retrait" as const })),
    ];
  }

  // Multi-location mode: the table renders a quantity cell per ACTIVE location.
  // Load the per-location levels for exactly the products on this page.
  const levelsMap =
    multiLocation && result.items.length
      ? await stockLocationService
          .listLevelsForProducts(result.items.map((p) => p.id))
          .catch(() => new Map<string, Map<string, number>>())
      : new Map<string, Map<string, number>>();
  // Map<key, Map<locationId, qty>> → Record<key, Record<locationId, qty>>.
  const levels: Record<string, Record<string, number>> = {};
  for (const [key, perLoc] of levelsMap) {
    levels[key] = Object.fromEntries(perLoc);
  }

  // INCOMING (in-transit) units per destination location, keyed
  // `${productId}:${variantId ?? ""}:${locationId}` — so the matrix shows what is
  // arriving on top of the on-hand. Only when per-location + transfers are on.
  const incomingMap =
    multiLocation && inventoryCfg.transfersEnabled && result.items.length
      ? await stockTransferService
          .incomingByLocationForProducts(result.items.map((p) => p.id))
          .catch(() => new Map<string, number>())
      : new Map<string, number>();
  const incoming: Record<string, number> = Object.fromEntries(incomingMap);

  const activeLocationCount = activeLocations.length;

  // Transfers — first page + per-status counts (server-side paginated; the panel
  // pages/filters via listTransfersAction). Only queried when the feature is on.
  const emptyCounts = { requested: 0, accepted: 0, in_transit: 0, completed: 0, cancelled: 0 } as const;
  const [transfersList, transferCounts] = inventoryCfg.transfersEnabled
    ? await Promise.all([
        stockTransferService
          .list({ pageSize: TRANSFERS_PAGE_SIZE })
          .catch(() => ({ items: [], total: 0, page: 1, pageSize: TRANSFERS_PAGE_SIZE })),
        stockTransferService.countsByStatus().catch(() => ({ ...emptyCounts })),
      ])
    : [{ items: [], total: 0, page: 1, pageSize: TRANSFERS_PAGE_SIZE }, { ...emptyCounts }];
  const transferRows = transfersList.items.map((t) => ({
    id: t.id,
    ref: t.ref,
    status: t.status as TransferStatus,
    fromName: t.fromName,
    toName: t.toName,
    itemCount: t.itemCount,
    totalQty: t.totalQty,
    createdAt: t.created_at.toISOString(),
    orderId: t.order_id,
    note: t.note,
  }));
  const pendingTransfers = transferCounts.requested + transferCounts.accepted + transferCounts.in_transit;
  const transferHint = !inventoryCfg.transfersEnabled
    ? "désactivés"
    : pendingTransfers > 0
      ? `${pendingTransfers} en cours`
      : "";

  // ERP linkage posture (off / platform / erp / mixed).
  const erpConfig = resolveErpConfig(settings);
  const erpHint =
    erpConfig.mode === "off"
      ? ""
      : erpConfig.mode === "erp"
        ? "ERP maître"
        : erpConfig.mode === "platform"
          ? "Plateforme"
          : "Mixte";

  return (
    <StockTabs
      initialTab={initialTab}
      locationHint={
        multiLocation
          ? `${activeLocationCount} actif${activeLocationCount > 1 ? "s" : ""}`
          : "partagé"
      }
      transferHint={transferHint}
      transfers={
        <TransfersPanel
          canManage={canManageStock}
          enabled={inventoryCfg.transfersEnabled}
          locations={activeLocations.map((l) => ({ id: l.id, name: l.name }))}
          transfers={transferRows}
          total={transfersList.total}
          pageSize={transfersList.pageSize}
          counts={transferCounts}
        />
      }
      erpHint={erpHint}
      erp={<ErpPanel config={erpConfig} canManage={canManageStock} />}
      reglages={
        <ReglagesPanel
          canManage={canManageStock}
          sharedStockDefault={sharedStockDefault}
          lowStock={lowStockCfg}
          inventory={inventoryCfg}
        />
      }
      locations={
        <InventoryLocationsCard
          canManage={canManageStock}
          config={inventoryCfg}
          carrierOptions={carrierOptions}
          locations={locationViews}
        />
      }
      inventory={
        <StockPanel
      canManage={canManageStock}
      lowThreshold={lowStockCfg.threshold}
      multiLocation={multiLocation}
      erpAuthoritative={erpConfig.pullStock}
      locations={activeLocations.map((l) => ({ id: l.id, name: l.name, code: l.code, isDefault: l.is_default }))}
      levels={levels}
      incoming={incoming}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      rows={result.items.map((p) => {
        // Per-variant editing applies only to a VARIABLE product NOT in shared
        // mode (where each variant tracks its own stock_qty).
        const variantShared =
          p.product_type === "variable" &&
          isSharedStock(p.shared_variant_stock, sharedStockDefault);
        const variants =
          p.product_type === "variable" && !variantShared
            ? (
                (variantsByProduct.get(p.id) ?? []) as Array<{
                  id: string;
                  label: string;
                  sku: string | null;
                  stock_qty: number | null;
                  in_stock: boolean;
                }>
              ).map((v) => ({
                id: v.id,
                label: v.label,
                sku: v.sku,
                stockQty: v.stock_qty,
                inStock: v.in_stock,
              }))
            : [];
        return {
          id: p.id,
          slug: p.slug,
          name: p.name,
          sku: p.sku,
          // Référence externe (ERP) — the stable code that links this product to
          // an external ERP/PIM. Surfaced read-only in the table so stock can be
          // reconciled against the ERP. Edited on the product's Identité tab.
          externalRef: p.external_ref,
          priceCents: p.price_cents,
          currency: p.currency,
          inStock: p.in_stock,
          stockQty: p.stock_qty,
          isPublished: p.is_published,
          productType: p.product_type,
          variantShared,
          variants,
        };
      })}
      currentQuery={q ?? ""}
      currentFilter={filter ?? "all"}
        />
      }
    />
  );
}
