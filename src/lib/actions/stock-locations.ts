"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { bus } from "@/events/bus";
import { bustCacheTag } from "@/lib/cache/revalidate";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { emitProductStockCacheBust } from "@/lib/catalog/product-cache-bust";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { productService } from "@/modules/catalog/product/service";
import {
  EvacuatePartialError,
  stockLocationService,
  type LevelTarget,
  type StockLocationRow,
} from "@/modules/stock-location";
import { stockTransferService } from "@/modules/stock-transfer";
import {
  INVENTORY_CARRIER_LINK_KEY,
  INVENTORY_LOCATION_MODE_KEY,
  INVENTORY_TRANSFERS_KEY,
  INVENTORY_TRANSFER_AUTO_KEY,
  INVENTORY_TRANSFER_SOURCING_KEY,
  INVENTORY_WEB_STOCK_SOURCE_KEY,
  resolveInventoryConfig,
} from "@/lib/inventory/locations-config";
import { carrierRefPatch, cleanCarrierRef, parseLocationActive } from "@/lib/inventory/location-form";

const UUID_RE = /^[0-9a-f-]{36}$/i;

function cleanName(raw: FormDataEntryValue | null): string {
  return String(raw ?? "").trim().slice(0, 120);
}
function cleanCode(raw: FormDataEntryValue | null): string | null {
  const v = String(raw ?? "").trim().slice(0, 40);
  return v === "" ? null : v;
}

/**
 * Persist the multi-location inventory settings (`inventory.*`) from the
 * "Emplacements" page. Mirrors saveStockAlertSettingsAction: requirePermission →
 * normalise → upsert each key (audited via setting.upserted) → revalidate.
 *
 * `location_mode` shared|per_location is the master switch the Stock table reads
 * to decide whether to render per-location columns. carrier_link / transfers are
 * downstream feature flags (carrier dropdown on a location; transfer scenarios in
 * order processing — the latter wired in a later phase).
 */
export async function saveInventorySettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("stock", "update");

  const mode = formData.get(INVENTORY_LOCATION_MODE_KEY) === "per_location" ? "per_location" : "shared";
  const carrierLink = formData.get(INVENTORY_CARRIER_LINK_KEY) === "on";
  const transfers = formData.get(INVENTORY_TRANSFERS_KEY) === "on";
  const transferAuto = formData.get(INVENTORY_TRANSFER_AUTO_KEY) === "on";
  const sourcing =
    formData.get(INVENTORY_TRANSFER_SOURCING_KEY) === "most_stock" ? "most_stock" : "priority";
  const webStockSource =
    formData.get(INVENTORY_WEB_STOCK_SOURCE_KEY) === "combined" ? "combined" : "central";

  // Detect a shared → per_location transition so we can reconcile the default
  // location's levels to the cached totals BEFORE the matrix is shown (shared
  // mode drifts stock_levels from stock_qty).
  const prevMode = resolveInventoryConfig(
    await getSettingsMap().catch(() => ({}) as Record<string, string | null>),
  ).locationMode;

  const entries: Array<{ key: string; value: string; type: "text" | "boolean"; label: string }> = [
    { key: INVENTORY_LOCATION_MODE_KEY, value: mode, type: "text", label: "Stock — mode multi-emplacements" },
    { key: INVENTORY_CARRIER_LINK_KEY, value: carrierLink ? "true" : "false", type: "boolean", label: "Stock — lier les emplacements aux transporteurs" },
    { key: INVENTORY_TRANSFERS_KEY, value: transfers ? "true" : "false", type: "boolean", label: "Stock — transferts entre emplacements" },
    { key: INVENTORY_TRANSFER_AUTO_KEY, value: transferAuto ? "true" : "false", type: "boolean", label: "Stock — demande de transfert automatique" },
    { key: INVENTORY_TRANSFER_SOURCING_KEY, value: sourcing, type: "text", label: "Stock — stratégie de source des transferts" },
    { key: INVENTORY_WEB_STOCK_SOURCE_KEY, value: webStockSource, type: "text", label: "Stock — source du stock vendu en ligne" },
  ];

  for (const e of entries) {
    const res = await workflows.cms.upsertSetting(
      {
        key: e.key,
        value: e.value,
        type: e.type as never,
        groupKey: "inventory",
        label: e.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // First switch into per-location: align stock_levels with the live totals.
  // `overwrite` reseeds any stale leftover default levels — safe here because the
  // totals ARE the baseline at the moment of the switch (no unshipped-order
  // divergence exists in shared mode).
  if (mode === "per_location" && prevMode !== "per_location") {
    await stockLocationService.reconcileDefaultLevels({ overwrite: true }).catch(() => {});
  }

  revalidatePath("/admin/catalog/stock");
  return { ok: true, message: "Paramètres d'emplacements enregistrés." };
}

/**
 * Bulk-set per-location stock LEVELS from the multi-location Stock table (only
 * reached when `inventory.location_mode` = per_location). Each update sets ONE
 * (target, location) quantity through stockLocationService.setLocationLevel,
 * which maintains the cached product/variant total + ledgers the move. Mirrors
 * bulkUpdateStockAction's per-row, fail-soft error model.
 */
export async function setLocationLevelsAction(
  updates: Array<{
    productId: string;
    variantId: string | null;
    locationId: string;
    qty: number;
    /** The level the operator saw at page load — optimistic compare-and-set so a
     *  stale cell can't clobber a level a transfer/edit moved since (conflict =
     *  per-cell failure the operator must reload to resolve). */
    expectedQty?: number | null;
  }>,
): Promise<
  ActionState & {
    /** Per-cell failures so the client keeps only the failed cells dirty. */
    failures?: Array<{ productId: string; variantId: string | null; locationId: string; message: string }>;
    /** Cells that committed, so the client clears exactly those drafts. */
    saved?: Array<{ productId: string; variantId: string | null; locationId: string }>;
  }
> {
  const session = await requirePermission("stock", "update");

  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, error: "validation", message: "Aucune modification reçue." };
  }
  if (updates.length > 1000) {
    return { ok: false, error: "too_many", message: "Trop de lignes à enregistrer en une fois (max 1000)." };
  }

  // Backfill any MISSING default-location level rows before the matrix edits apply.
  // A target stocked by a total-only writer (product editor / import / a new or
  // duplicated product) AFTER per-location mode was enabled carries a stock_qty with
  // NO stock_levels row, so the matrix showed its default level from the total but
  // setting that same value re-added the whole quantity — DOUBLING the total (e.g.
  // 10 → 20). Reconciling here gives every such target a real default level =
  // stock_qty − Σ(other active) first, so the operator's write composes as a delta.
  // Idempotent and a cheap no-op once everything is level-tracked. (ISSUE-31.)
  await stockLocationService.reconcileDefaultLevels().catch(() => {});

  type RowUpdate = (typeof updates)[number];
  const processRow = async (u: RowUpdate) => {
    const cell = { productId: u.productId, variantId: u.variantId, locationId: u.locationId };
    const fail = (message: string) => ({ ok: false as const, ...cell, message });
    if (!UUID_RE.test(u.productId) || !UUID_RE.test(u.locationId)) return fail("ID invalide.");
    if (u.variantId != null && !UUID_RE.test(u.variantId)) return fail("ID de variante invalide.");
    if (!Number.isInteger(u.qty) || u.qty < 0) return fail("Quantité invalide (entier ≥ 0).");
    if (u.expectedQty != null && (!Number.isInteger(u.expectedQty) || u.expectedQty < 0)) {
      return fail("Quantité attendue invalide.");
    }
    try {
      const target: LevelTarget = { productId: u.productId, variantId: u.variantId };
      const res = await stockLocationService.setLocationLevel(target, u.locationId, u.qty, {
        actorUserId: session.user.id,
        expectedLevel: u.expectedQty ?? null,
      });
      return { ok: true as const, ...cell, becameAvailable: res.becameAvailable };
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Erreur inattendue.");
    }
  };

  // Sequential in small chunks — setLocationLevel takes row locks, so flooding
  // the pool with a wide fan-out risks lock contention on the same totals.
  const results: Array<Awaited<ReturnType<typeof processRow>>> = [];
  const CHUNK = 8;
  for (let i = 0; i < updates.length; i += CHUNK) {
    results.push(...(await Promise.all(updates.slice(i, i + CHUNK).map(processRow))));
  }

  const failed = results.filter((r) => !r.ok);
  const ok = results.filter(
    (
      r,
    ): r is {
      ok: true;
      productId: string;
      variantId: string | null;
      locationId: string;
      becameAvailable: boolean;
    } => r.ok,
  );

  // Mirror bulkUpdateStockAction's event emission so per-location edits ALSO bust
  // the catalog cache (product.updated → invalidate-catalog-cache) and fire the
  // back-in-stock email to wishlist watchers (product.restocked). setLocationLevel
  // only touches the DB; without this the storefront would show stale availability.
  // Best-effort — a bus/slug hiccup must not fail an otherwise-successful save.
  try {
    const changedIds = [...new Set(ok.map((r) => r.productId))];
    const restockedIds = new Set(ok.filter((r) => r.becameAvailable).map((r) => r.productId));
    if (changedIds.length > 0) {
      const rows = await productService.listByIds(changedIds);
      const rowById = new Map(rows.map((p) => [p.id, p]));
      for (const id of changedIds) {
        const row = rowById.get(id);
        await bus.emit(
          "product.updated",
          {
            productId: id,
            slug: row?.slug ?? "",
            changedFields: ["stock_qty", "in_stock"],
            // Full rows already loaded — carry the ERP identifiers on the event.
            sku: row?.sku ?? null,
            gtin: row?.gtin ?? null,
            externalRef: row?.external_ref ?? null,
          },
          { actorUserId: session.user.id },
        );
        if (restockedIds.has(id)) {
          await bus.emit("product.restocked", { productId: id }, { actorUserId: session.user.id });
        }
      }
    }
  } catch {
    // swallow — the levels are saved; only the cache/notify side-effects missed.
  }

  revalidatePath("/admin/catalog/stock");
  revalidatePath("/admin/catalog/products");

  const saved = ok.map((r) => ({ productId: r.productId, variantId: r.variantId, locationId: r.locationId }));
  if (failed.length === 0) {
    return { ok: true, message: `${updates.length} niveau(x) de stock mis à jour.`, saved };
  }
  return {
    ok: false,
    error: "partial_failure",
    message: `${failed.length} ligne(s) en erreur sur ${updates.length}. La première : ${failed[0]?.message ?? "inconnue"}.`,
    failures: failed.map((f) => ({
      productId: f.productId,
      variantId: f.variantId,
      locationId: f.locationId,
      message: f.message,
    })),
    saved,
  };
}

/** Create a stock location (never default — use setDefault). Name required. */
export async function createLocationAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("stock", "update");

  const name = cleanName(formData.get("name"));
  if (!name) return { ok: false, error: "validation", message: "Le nom de l'emplacement est requis." };
  const code = cleanCode(formData.get("code"));
  const carrierRef = cleanCarrierRef(formData.get("carrier_ref"));
  // A brand-new location holds no levels, so its initial state moves no totals.
  const isActive = parseLocationActive(formData, false);

  let created: StockLocationRow;
  try {
    const display_order = await stockLocationService.nextDisplayOrder();
    created = await stockLocationService.create({
      name,
      code,
      carrier_ref: carrierRef,
      is_active: isActive,
      is_default: false,
      display_order,
    });
  } catch (err) {
    // The most likely failure is the partial-unique on `code`.
    const msg = err instanceof Error && /code_unique/.test(err.message)
      ? "Ce code d'emplacement est déjà utilisé."
      : "Impossible de créer l'emplacement.";
    return { ok: false, error: "db", message: msg };
  }

  // Post-commit, best-effort: audit trail (who created it) + outbound webhooks.
  await bus
    .emit(
      "stock_location.created",
      { locationId: created.id, name: created.name, isActive: created.is_active },
      { actorUserId: session.user.id },
    )
    .catch(() => {});

  revalidatePath("/admin/catalog/stock");
  return { ok: true, message: "Emplacement créé." };
}

/** Update an existing location's editable fields. */
export async function updateLocationAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("stock", "update");

  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return { ok: false, error: "validation", message: "ID d'emplacement invalide." };
  const name = cleanName(formData.get("name"));
  if (!name) return { ok: false, error: "validation", message: "Le nom de l'emplacement est requis." };

  const loc = await stockLocationService.findById(id);
  if (!loc) return { ok: false, error: "not_found", message: "Emplacement introuvable." };

  // The default location stays active; everyone else can be toggled.
  const isActive = parseLocationActive(formData, loc.is_default);
  const code = cleanCode(formData.get("code"));
  const carrier = carrierRefPatch(formData);

  // The fields this save actually changes (audit `changedFields`).
  const changedFields: string[] = [];
  if (name !== loc.name) changedFields.push("name");
  if (code !== loc.code) changedFields.push("code");
  if ("carrier_ref" in carrier && carrier.carrier_ref !== loc.carrier_ref) changedFields.push("carrier_ref");
  // Post-commit, best-effort `stock_location.updated` (audit trail + webhooks).
  // `isActive` rides along only on a real (de)activation — the audit summary
  // reads it as « activé » / « désactivé ».
  const emitUpdated = async (withActive: boolean) => {
    if (changedFields.length === 0) return;
    await bus
      .emit(
        "stock_location.updated",
        { locationId: id, name, ...(withActive ? { isActive } : {}), changedFields },
        { actorUserId: session.user.id },
      )
      .catch(() => {});
  };

  try {
    // is_active is NOT part of this patch — it flips through setLocationActive
    // below, which moves the totals with it (a plain column write would change
    // which stock is sellable without touching the totals).
    await stockLocationService.update(id, { name, code, ...carrier });
  } catch (err) {
    const msg = err instanceof Error && /code_unique/.test(err.message)
      ? "Ce code d'emplacement est déjà utilisé."
      : "Impossible de mettre à jour l'emplacement.";
    return { ok: false, error: "db", message: msg };
  }

  // (De)activating a location takes its units out of / back into the sellable
  // totals — by DELTA, ledgered, atomically with the flag (never a Σ(levels)
  // recompute, which would resurrect units sold since the last matrix edit).
  let activeFlipped = false;
  if (isActive !== loc.is_active) {
    // Deactivating a location that still has pending (non-terminal) transfers
    // would STRAND them — a completion moves stock through an ACTIVE location, so
    // réception would then throw "inactif" and the transfer could only be
    // cancelled. Refuse with a clear message (the name/code patch above already
    // committed — audit that much), mirroring the delete-with-stock guard.
    if (!isActive) {
      const pending = await stockTransferService.countPendingForLocation(id).catch(() => 0);
      if (pending > 0) {
        await emitUpdated(false);
        revalidatePath("/admin/catalog/stock");
        return {
          ok: false,
          error: "has_transfers",
          message: `Informations enregistrées, mais l'emplacement a ${pending} transfert(s) en cours : finalisez-les ou annulez-les avant de le désactiver.`,
        };
      }
    }
    let flip: Awaited<ReturnType<typeof stockLocationService.setLocationActive>>;
    try {
      flip = await stockLocationService.setLocationActive(id, isActive, { actorUserId: session.user.id });
    } catch {
      // The name/code/carrier patch above did commit — audit that much.
      await emitUpdated(false);
      revalidatePath("/admin/catalog/stock");
      return {
        ok: false,
        error: "db",
        message: isActive
          ? "Informations enregistrées, mais la réactivation de l'emplacement a échoué. Réessayez."
          : "Informations enregistrées, mais la désactivation de l'emplacement a échoué. Réessayez.",
      };
    }
    if (flip.changed) {
      activeFlipped = true;
      changedFields.push("is_active");
    }
    // Post-commit, best-effort: product.updated busts each touched product's
    // cached PDP/listing (+ products:list); product.restocked fires the
    // back-in-stock email for a line a reactivation made sellable again.
    await emitProductStockCacheBust(flip.touchedProductIds, session.user.id);
    for (const productId of flip.restockedProductIds) {
      await bus.emit("product.restocked", { productId }, { actorUserId: session.user.id }).catch(() => {});
    }
    revalidatePath("/admin/catalog/products");
  }
  await emitUpdated(activeFlipped);

  revalidatePath("/admin/catalog/stock");
  return { ok: true, message: "Emplacement mis à jour." };
}

/** Promote a location to the single default (clears the previous default). */
export async function setDefaultLocationAction(id: string): Promise<ActionState> {
  const session = await requirePermission("stock", "update");
  if (!UUID_RE.test(id)) return { ok: false, error: "validation", message: "ID d'emplacement invalide." };
  const loc = await stockLocationService.findById(id);
  if (!loc) return { ok: false, error: "not_found", message: "Emplacement introuvable." };
  // Only an ACTIVE location can become the default: reactivation (which moves
  // the totals by delta) must come first. This pre-check gives the fast answer;
  // setDefault re-checks it atomically in its UPDATE (a deactivation can commit
  // in between) and returns false instead of promoting.
  const inactive: ActionState = {
    ok: false,
    error: "inactive",
    message: "Réactivez d'abord cet emplacement (Modifier → Emplacement actif) avant d'en faire l'emplacement par défaut.",
  };
  if (!loc.is_active) return inactive;

  try {
    if (!(await stockLocationService.setDefault(id))) return inactive;
  } catch {
    return { ok: false, error: "db", message: "Impossible de définir l'emplacement par défaut. Réessayez." };
  }
  // Post-commit, best-effort audit of the default switch (re-promoting the
  // current default changes nothing).
  if (!loc.is_default) {
    await bus
      .emit(
        "stock_location.updated",
        { locationId: id, name: loc.name, changedFields: ["is_default"] },
        { actorUserId: session.user.id },
      )
      .catch(() => {});
  }
  revalidatePath("/admin/catalog/stock");
  return { ok: true, message: `« ${loc.name} » est désormais l'emplacement par défaut.` };
}

/**
 * Soft-delete a location. Refuses the default location. When the location still
 * holds stock, the caller must say WHAT happens to it:
 *   - { stock: "transfer", destinationId } → move its stock to another active
 *     location (totals unchanged), then delete;
 *   - { stock: "writeoff" } → write the stock off (totals DROP), then delete.
 * An INACTIVE location's units are already out of the totals (setLocationActive),
 * so its transfer adds them back as sellable and its writeoff drops nothing more.
 * With no option on a stock-holding location it refuses (the UI always passes
 * one) — so a delete can never silently orphan units from the cached totals.
 */
export async function deleteLocationAction(
  id: string,
  opts?: { stock: "transfer" | "writeoff"; destinationId?: string },
): Promise<ActionState> {
  const session = await requirePermission("stock", "update");
  if (!UUID_RE.test(id)) return { ok: false, error: "validation", message: "ID d'emplacement invalide." };

  const loc = await stockLocationService.findById(id);
  if (!loc) return { ok: false, error: "not_found", message: "Emplacement introuvable." };
  if (loc.is_default) {
    return { ok: false, error: "forbidden", message: "L'emplacement par défaut ne peut pas être supprimé." };
  }

  // A location that is the source or destination of a non-terminal transfer must not be
  // deleted — a completion moves stock through an ACTIVE, non-deleted location, so a
  // deleted one makes réception throw "introuvable ou inactif" and STRANDS the transfer
  // (it could then only be cancelled). Mirrors the deactivation guard in
  // updateLocationAction. The 0-stock path below skips evacuation entirely, so without
  // this check an empty but transfer-linked location deletes clean and strands them.
  const pendingTransfers = await stockTransferService.countPendingForLocation(id).catch(() => 0);
  if (pendingTransfers > 0) {
    return {
      ok: false,
      error: "has_transfers",
      message: `Cet emplacement a ${pendingTransfers} transfert(s) en cours : finalisez-les ou annulez-les avant de le supprimer.`,
    };
  }

  const units = await stockLocationService.locationStockUnits(id);
  let evacuated: Awaited<ReturnType<typeof stockLocationService.evacuateLocation>> | null = null;
  if (units > 0) {
    if (!opts) {
      return {
        ok: false,
        error: "has_stock",
        message: `Cet emplacement contient encore ${units} unité(s). Choisissez quoi faire de ce stock.`,
      };
    }
    if (opts.stock === "transfer" && (!opts.destinationId || !UUID_RE.test(opts.destinationId))) {
      return { ok: false, error: "validation", message: "Emplacement de destination invalide." };
    }
    try {
      evacuated = await stockLocationService.evacuateLocation(id, {
        mode: opts.stock,
        destinationId: opts.destinationId,
        actorUserId: session.user.id,
      });
    } catch (err) {
      // Lines are moved one transaction each, so some may have committed before
      // the failure — refresh cached availability broadly all the same, and emit
      // what those committed lines changed (a retry won't reselect them: their
      // levels are 0 now).
      bustCacheTag(CACHE_TAGS.productsList);
      if (err instanceof EvacuatePartialError) {
        await emitProductStockCacheBust(err.touchedProductIds, session.user.id);
        for (const productId of err.restockedProductIds) {
          await bus.emit("product.restocked", { productId }, { actorUserId: session.user.id }).catch(() => {});
        }
        if (err.touchedProductIds.length > 0) revalidatePath("/admin/catalog/products");
      }
      revalidatePath("/admin/catalog/stock");
      return {
        ok: false,
        error: "evacuate_failed",
        message: err instanceof Error ? err.message : "Impossible de déplacer le stock.",
      };
    }
  }

  const deleted = await stockLocationService.softDelete(id);
  // Post-commit, best-effort: audit trail (who deleted it, incl. a stock
  // write-off — the ledger rows carry the per-line detail) + outbound webhooks.
  if (deleted) {
    await bus
      .emit(
        "stock_location.deleted",
        { locationId: id, name: loc.name, isActive: loc.is_active },
        { actorUserId: session.user.id },
      )
      .catch(() => {});
  }
  // A writeoff drops the cached totals (a product can hit 0 / out-of-stock); a
  // transfer keeps them but moved levels. Either way, when this location held
  // stock, bust the broad products:list tag so cached PDPs refresh availability.
  if (units > 0) bustCacheTag(CACHE_TAGS.productsList);
  if (evacuated) {
    // product.updated for every product whose total / in_stock actually moved
    // (per-product cache bust + ERP webhooks see the write-off drop);
    // product.restocked for a line the move made sellable again.
    await emitProductStockCacheBust(evacuated.touchedProductIds, session.user.id);
    for (const productId of evacuated.restockedProductIds) {
      await bus.emit("product.restocked", { productId }, { actorUserId: session.user.id }).catch(() => {});
    }
    if (evacuated.touchedProductIds.length > 0) revalidatePath("/admin/catalog/products");
  }
  revalidatePath("/admin/catalog/stock");
  // An INACTIVE location's units were already out of the totals (taken out on
  // deactivation) — a writeoff just clears its levels, it removes nothing more.
  const suffix =
    units > 0
      ? opts?.stock === "transfer"
        ? " Le stock a été transféré."
        : loc.is_active
          ? " Le stock a été retiré des totaux."
          : " Son stock (déjà exclu des totaux) a été retiré."
      : "";
  return { ok: true, message: `Emplacement supprimé.${suffix}` };
}
