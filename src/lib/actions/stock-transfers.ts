"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { emitProductStockCacheBust } from "@/lib/catalog/product-cache-bust";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveInventoryConfig } from "@/lib/inventory/locations-config";
import { resolveSharedStockProductIds } from "@/lib/inventory/variant-stock";
import { listVariantsForProduct } from "@/modules/catalog/product/queries";
import { stockLocationService } from "@/modules/stock-location";
import {
  stockTransferService,
  TRANSFER_STATUSES,
  TRANSFERS_PAGE_SIZE,
  type TransferDetailItem,
  type TransferStatus,
} from "@/modules/stock-transfer";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Serializable transfer row for the Transferts list panel. */
type TransferListRow = {
  id: string;
  ref: number;
  status: TransferStatus;
  fromName: string | null;
  toName: string | null;
  itemCount: number;
  totalQty: number;
  createdAt: string;
  orderId: string | null;
  note: string | null;
};

/**
 * A page of transfers (optionally status-filtered) + the total for that filter +
 * the per-status counts, for the Transferts panel's server-side pagination.
 * Guarded by stock:view. Filtering + paging happen in the DB (not client-side on
 * a truncated window), so counts and page navigation stay correct at any volume.
 */
export async function listTransfersAction(opts: {
  status?: TransferStatus | "all";
  page?: number;
}): Promise<{
  ok: true;
  rows: TransferListRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<TransferStatus, number>;
}> {
  await requirePermission("stock", "view");
  const status = opts.status && opts.status !== "all" && TRANSFER_STATUSES.includes(opts.status) ? opts.status : undefined;
  const page = Math.max(1, Math.floor(opts.page ?? 1) || 1);
  const [list, counts] = await Promise.all([
    stockTransferService.list({ status, page, pageSize: TRANSFERS_PAGE_SIZE }),
    stockTransferService.countsByStatus(),
  ]);
  return {
    ok: true,
    rows: list.items.map((t) => ({
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
    })),
    total: list.total,
    page: list.page,
    pageSize: list.pageSize,
    counts,
  };
}

/** Read one transfer's line items (for the Transferts list's on-expand detail). */
export async function getTransferItemsAction(
  id: string,
): Promise<{ ok: true; items: TransferDetailItem[] } | { ok: false; message: string }> {
  await requirePermission("stock", "view");
  if (!UUID_RE.test(id)) return { ok: false, message: "Transfert invalide." };
  const detail = await stockTransferService.getById(id);
  if (!detail) return { ok: false, message: "Transfert introuvable." };
  return { ok: true, items: detail.items };
}

/**
 * Whether a product needs a VARIANT chosen for a transfer line, and its
 * selectable variants. A per-variant variable product tracks stock per variant,
 * so a pool-level (variantId null) transfer of it can never complete — the form
 * must make the operator pick a variant. A simple or shared-stock-variable
 * product transfers at the product level (perVariant = false). Guarded by
 * stock:view (read-only lookup for the manual transfer form).
 */
export async function getTransferProductVariantsAction(
  productId: string,
): Promise<
  | { ok: true; perVariant: false }
  | { ok: true; perVariant: true; variants: Array<{ id: string; label: string }> }
  | { ok: false; message: string }
> {
  await requirePermission("stock", "view");
  if (!UUID_RE.test(productId)) return { ok: false, message: "Produit invalide." };
  const shared = await resolveSharedStockProductIds([productId]);
  // resolveSharedStockProductIds only returns VARIABLE products (its own filter),
  // so "shared" here means variable+shared → pool-level transfer. Everything else
  // needs the variant grain decided by whether live variants exist.
  const variants = await listVariantsForProduct(productId);
  if (variants.length === 0 || shared.has(productId)) return { ok: true, perVariant: false };
  return {
    ok: true,
    perVariant: true,
    variants: variants.map((v) => ({ id: v.id, label: v.label || "Variante" })),
  };
}

/**
 * Create a stock transfer REQUEST (status "requested"). Guarded by stock:update
 * and gated on the `inventory.transfers_enabled` setting. Validates the two
 * locations are distinct + active and every line references a real, in-range
 * quantity — but NOT that the source currently holds the stock: a request can be
 * raised ahead of the goods; completion re-validates availability. Returns the
 * new transfer id so the client can open it.
 */
export async function createTransferAction(input: {
  fromLocationId: string;
  toLocationId: string;
  items: Array<{ productId: string; variantId?: string | null; qty: number }>;
  note?: string | null;
  orderId?: string | null;
}): Promise<ActionState> {
  const session = await requirePermission("stock", "update");

  const cfg = resolveInventoryConfig(await getSettingsMap());
  if (!cfg.transfersEnabled) {
    return { ok: false, error: "disabled", message: "Les transferts sont désactivés (voir Réglages)." };
  }

  const { fromLocationId, toLocationId } = input;
  if (!UUID_RE.test(fromLocationId) || !UUID_RE.test(toLocationId)) {
    return { ok: false, error: "validation", message: "Emplacement invalide." };
  }
  if (fromLocationId === toLocationId) {
    return { ok: false, error: "validation", message: "La source et la destination doivent être différentes." };
  }
  if (input.orderId != null && !UUID_RE.test(input.orderId)) {
    return { ok: false, error: "validation", message: "Commande liée invalide." };
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, error: "validation", message: "Ajoutez au moins une ligne au transfert." };
  }
  for (const it of input.items) {
    if (!UUID_RE.test(it.productId)) return { ok: false, error: "validation", message: "Produit invalide." };
    if (it.variantId != null && !UUID_RE.test(it.variantId)) {
      return { ok: false, error: "validation", message: "Variante invalide." };
    }
    if (!Number.isInteger(it.qty) || it.qty <= 0) {
      return { ok: false, error: "validation", message: "Chaque ligne doit avoir une quantité entière > 0." };
    }
  }

  // Both endpoints must be real, active locations — a request to/from a disabled
  // store is pointless (completion would reject it anyway).
  const [from, to] = await Promise.all([
    stockLocationService.findById(fromLocationId),
    stockLocationService.findById(toLocationId),
  ]);
  if (!from || !from.is_active) return { ok: false, error: "validation", message: "Emplacement source introuvable ou inactif." };
  if (!to || !to.is_active) return { ok: false, error: "validation", message: "Emplacement de destination introuvable ou inactif." };

  try {
    const transfer = await stockTransferService.create({
      fromLocationId,
      toLocationId,
      items: input.items,
      source: "manual",
      orderId: input.orderId ?? null,
      note: input.note ?? null,
      requestedBy: session.user.id,
    });
    // stock.transfer.requested is emitted by the service (create) so EVERY path
    // announces (manual, auto-request, ERP). Nothing to emit here.
    revalidatePath("/admin/catalog/stock");
    return { ok: true, id: transfer.id, message: `Transfert TR-${transfer.ref} créé.` };
  } catch (err) {
    return { ok: false, error: "unexpected", message: err instanceof Error ? err.message : "Échec de la création du transfert." };
  }
}

/**
 * Advance (or cancel) a transfer. Guarded by stock:update. The allowed
 * transitions are enforced in the service; completion moves every line's stock
 * atomically. On completion we bust the touched products' catalog cache so the
 * per-location matrix + storefront reflect the move.
 */
export async function transitionTransferAction(
  id: string,
  to: TransferStatus,
  opts: { cancelReason?: string | null } = {},
): Promise<ActionState> {
  const session = await requirePermission("stock", "update");
  if (!UUID_RE.test(id)) return { ok: false, error: "validation", message: "Transfert invalide." };
  if (!TRANSFER_STATUSES.includes(to)) return { ok: false, error: "validation", message: "Statut invalide." };

  try {
    const { row, touchedProductIds } = await stockTransferService.transition(id, to, {
      actorUserId: session.user.id,
      cancelReason: opts.cancelReason ?? null,
    });
    if (to === "completed" && touchedProductIds.length > 0) {
      await emitProductStockCacheBust(touchedProductIds, session.user.id);
    }
    // stock.transfer.completed / .cancelled are emitted by the service (transition)
    // so every path announces (incl. the order-cancel cascade). Nothing here.
    revalidatePath("/admin/catalog/stock");
    const label =
      to === "completed" ? "transféré" : to === "cancelled" ? "annulé" : to === "in_transit" ? "en transfert" : "accepté";
    return { ok: true, id: row.id, message: `Transfert TR-${row.ref} ${label}.` };
  } catch (err) {
    return { ok: false, error: "unexpected", message: err instanceof Error ? err.message : "Échec de la mise à jour du transfert." };
  }
}
