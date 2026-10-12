import "server-only";

import { orderService } from "@/modules/order/service";
import { emptyDataJobResult } from "@/modules/import";
import {
  cleanAttributes,
  cleanBanners,
  cleanBrands,
  cleanCategories,
  cleanCustomers,
  cleanFaqs,
  cleanNavigation,
  cleanProducts,
  cleanSettings,
  type SegmentCtx,
} from "@/workflows/data/segments";
import { bus } from "@/events/bus";
import { endPurge } from "@/lib/demo/purge-lock";
import { importDemoWorkflow } from "./import-demo";

/**
 * DESTRUCTIVE "purge everything + relaunch demo" runner. Detached (fire-and-
 * forget): the confirm action triggers it after a super-admin + emailed-code
 * gate, and the import-demo panel polls the feed-import job that the relaunch
 * kicks. NOT tracked as its own import_jobs row on purpose — that would trip
 * importDemoWorkflow's single-flight gate and skip the feed import.
 *
 * Scope (per the owner's choice): hard-delete ALL orders + all content
 * (products, categories, brands, banners, nav, FAQs, attributes, demo
 * settings) + soft-delete ALL customer profiles. PRESERVES admin/staff accounts,
 * RBAC, and payment/system settings. Each step is isolated so one failure can't
 * strand the rest; the relaunch then re-seeds the demo (incl. the new flat
 * catalogue structure) and kicks the catalogue feed import.
 */
export async function runPurgeAndRelaunchDemo(actorUserId: string): Promise<void> {
  try {
    // 1a. Orders (hard) FIRST and GATING: a failure aborts before any content
    //     is wiped, so orders can't be left dangling against hard-deleted
    //     products. One atomic tx; all order children are ON DELETE CASCADE, so
    //     a throw here is genuinely unexpected (and correctly stops the purge).
    const ordersDeleted = await orderService.deleteAllOrders();

    // 1b. Content — categories INCLUDED (so the restructured tree re-seeds);
    //     products first so their links/media reclaim run before the tree drop.
    //     Each step is best-effort so one segment can't strand the rest.
    const seg = (): SegmentCtx => ({ actorUserId, result: emptyDataJobResult() });
    const cleans: Array<(ctx: SegmentCtx) => Promise<void>> = [
      cleanProducts,
      cleanCategories,
      cleanAttributes,
      cleanBanners,
      cleanBrands,
      cleanFaqs,
      cleanNavigation,
      cleanSettings,
      cleanCustomers, // soft-delete all profiles (FK-safe, the app's model)
    ];
    for (const fn of cleans) {
      try {
        await fn(seg());
      } catch (err) {
        console.error(`[demo:purge] clean step failed: ${fn.name}`, err);
      }
    }

    // 2. Relaunch — seeds all chrome + kicks the background feed product import.
    await importDemoWorkflow({ actorUserId });

    // 3. Audit the completed purge (success path only). The catalog cache
    //    subscriber also busts the storefront on it — best-effort from this
    //    detached runner; the authoritative bust is the import-demo poller's,
    //    once it sees the relaunched catalogue-feed job finish.
    await bus.emit("demo.purged", { ordersDeleted, actorUserId }, { actorUserId }).catch(() => {});
  } catch (err) {
    console.error("[demo:purge] aborted (orders delete failed — content left intact)", err);
  } finally {
    // Release the cluster-wide single-flight marker. A hard process kill that
    // skips this leaves the marker set (crash-evidence) until it auto-expires.
    await endPurge().catch(() => {});
  }
}
