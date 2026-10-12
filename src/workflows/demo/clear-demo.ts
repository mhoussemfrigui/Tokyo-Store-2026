import "server-only";

import { DEMO_ORDERS } from "@/lib/demo/data";
import { beginPurge, endPurge, isPurgeInProgress } from "@/lib/demo/purge-lock";
import { orderService } from "@/modules/order/service";
import { emptyDataJobResult, importJobService, type DataJobResult } from "@/modules/import";
import { bus } from "@/events/bus";
import {
  cleanAttributes,
  cleanBanners,
  cleanBrands,
  cleanCustomers,
  cleanFaqs,
  cleanNavigation,
  cleanProducts,
  cleanSettings,
  type SegmentCtx,
} from "@/workflows/data/segments";
import { fail, ok, workflow } from "../shared";

/**
 * WHOLE-STORE clear — the headless `POST /api/admin/system/demo?op=clear`
 * (its only caller; the admin UI's equivalent is CMS → Réglages « Tout
 * nettoyer »).
 *
 * ⚠ Despite the `demo.` name this is NOT scoped to demo rows: the demo
 * catalogue comes from the bundled product feed, so there is no fixture list to
 * scope to. It:
 *   - hard-deletes EVERY product (their reviews, wishlists, variants, stock
 *     levels cascade away), EVERY attribute, banner, brand, FAQ (+ FAQ
 *     categories) and navigation menu;
 *   - ARCHIVES (soft-deletes) EVERY customer profile;
 *   - resets only the demo settings still holding their seeded value (an
 *     edited value or an admin-chosen image survives);
 *   - reclaims Médiathèque images only once NOTHING references them any more.
 * Categories and orders survive (DEMO_ORDERS is empty).
 *
 * Gating: the route requires system_demo:manage AND the RBAC `*` wildcard;
 * this workflow refuses while an import/clean job or a purge is running, then
 * holds the purge single-flight marker for its own destructive window so
 * neither can start mid-clear.
 *
 * Implementation: DELEGATES to the composable clean segment functions in
 * `@/workflows/data/segments` (the same code the background `clean`
 * data-jobs run), so there is exactly ONE copy of each deletion rule. The
 * granular `ClearCounts` shape is preserved by giving each segment its own
 * fresh `DataJobResult` and reading its `deleted`/`mediaDeleted` back into
 * the matching field.
 *
 * Scope note: categories are seeded by `db:seed:catalog`, NOT by demo import
 * — clear-demo deliberately does NOT call `cleanCategories`, so the catalog
 * tree survives a clear (matching the original behaviour). Orders aren't a
 * reusable segment, so their bespoke deletion stays inline below.
 */

type ClearCounts = {
  productsDeleted: number;
  brandsDeleted: number;
  bannersDeleted: number;
  faqsDeleted: number;
  faqCategoriesDeleted: number;
  settingsDeleted: number;
  navMenusDeleted: number;
  navItemsDeleted: number;
  mediaDeleted: number;
  attributesDeleted: number;
  customerProfilesDeleted: number;
  ordersDeleted: number;
};

/** Same presumed-dead window as the data-job actions' stale-job janitor. */
const STALE_RUNNING_MINUTES = 15;

/**
 * Why a whole-store clear must NOT start right now (null = free to run). Mirrors
 * `startDataJobAction`'s single-flight gate: janitor first (a job orphaned by a
 * redeploy would otherwise block forever), then any queued/running import/clean
 * job, then the super-admin purge's in-progress marker. Exported for the
 * data-clean-scoping regression test.
 */
export async function clearDemoBlocker(): Promise<string | null> {
  await importJobService.failStaleRunning(STALE_RUNNING_MINUTES);
  if (await importJobService.hasActive()) {
    return "Une opération d'import/nettoyage est déjà en cours. Réessayez quand elle est terminée.";
  }
  if (await isPurgeInProgress()) {
    return "Une réinitialisation des données est en cours. Réessayez quand elle est terminée.";
  }
  return null;
}

export const clearDemoWorkflow = workflow<
  [{ actorUserId: string }],
  ClearCounts
>("demo.clear", async ({ actorUserId }) => {
  // Refuse to interleave with a feed import / data-job / purge (they write the
  // same tables with no transaction around the whole run).
  const blocker = await clearDemoBlocker();
  if (blocker) return fail("busy", blocker);
  // Hold the cluster-wide purge marker for our own lockless destructive window so
  // a data-job or a purge started meanwhile is refused (released in the finally;
  // a hard crash leaves it set until it auto-expires — see purge-lock.ts).
  await beginPurge();
  try {
    return await runClear(actorUserId);
  } finally {
    await endPurge().catch(() => {});
  }
});

async function runClear(actorUserId: string) {
  const counts: ClearCounts = {
    productsDeleted: 0,
    brandsDeleted: 0,
    bannersDeleted: 0,
    faqsDeleted: 0,
    faqCategoriesDeleted: 0,
    settingsDeleted: 0,
    navMenusDeleted: 0,
    navItemsDeleted: 0,
    mediaDeleted: 0,
    attributesDeleted: 0,
    customerProfilesDeleted: 0,
    ordersDeleted: 0,
  };

  // Run one clean segment with its own result so `deleted`/`mediaDeleted`
  // can be folded back into the granular ClearCounts. (The segment groups
  // FAQs + FAQ categories under one `deleted` tally and nav menus + items
  // likewise; ClearCounts splits those, so we attribute the combined total
  // to the primary field and leave the secondary at 0 — the demo route
  // response stays well-formed.)
  const runSeg = async (fn: (ctx: SegmentCtx) => Promise<void>): Promise<DataJobResult> => {
    const result = emptyDataJobResult();
    await fn({ actorUserId, result });
    counts.mediaDeleted += result.mediaDeleted;
    return result;
  };

  // ─── Orders (with their items, status history, and refunds) ──────────────
  // Bespoke (not a reusable segment): the demo seed creates fake orders that
  // must disappear. `deleteOrderById` removes items + status history +
  // refunds + the order row in one transaction. No-op while DEMO_ORDERS is
  // empty.
  for (const o of DEMO_ORDERS) {
    const order = await orderService.findByOrderNumber(o.orderNumber);
    if (!order) continue;
    const removed = await orderService.deleteOrderById(order.id);
    if (removed) counts.ordersDeleted++;
  }

  // ─── Catalog + chrome (delegated to clean segments) ──────────────────────
  // Order mirrors the original clear-demo: products (+ their media) first,
  // then attributes, then the rest. Categories are intentionally untouched.
  counts.productsDeleted = (await runSeg(cleanProducts)).deleted;
  counts.attributesDeleted = (await runSeg(cleanAttributes)).deleted;
  counts.bannersDeleted = (await runSeg(cleanBanners)).deleted;
  counts.brandsDeleted = (await runSeg(cleanBrands)).deleted;
  counts.faqsDeleted = (await runSeg(cleanFaqs)).deleted; // FAQs + FAQ categories
  counts.settingsDeleted = (await runSeg(cleanSettings)).deleted;
  counts.navMenusDeleted = (await runSeg(cleanNavigation)).deleted; // menus + items
  counts.customerProfilesDeleted = (await runSeg(cleanCustomers)).deleted;

  await bus.emit(
    "demo.cleared",
    {
      brandsDeleted: counts.brandsDeleted,
      productsDeleted: counts.productsDeleted,
      bannersDeleted: counts.bannersDeleted,
      faqsDeleted: counts.faqsDeleted,
      mediaDeleted: counts.mediaDeleted,
    },
    { actorUserId },
  );

  return ok(counts);
}
