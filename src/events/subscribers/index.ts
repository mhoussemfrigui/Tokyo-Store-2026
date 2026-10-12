import "server-only";

import { registerAttributeCacheSubscriber } from "./invalidate-attribute-cache";
import { registerAuditSubscriber } from "./audit-everything";
import { registerAuditTrailSubscriber } from "./audit-trail";
import { registerBlogCacheSubscriber } from "./invalidate-blog-cache";
import { registerCatalogCacheSubscriber } from "./invalidate-catalog-cache";
import { registerCmsCacheSubscriber } from "./invalidate-cms-cache";
import { registerMediaCacheSubscriber } from "./invalidate-media-cache";
import { registerMediaStorageCleanupSubscriber } from "./cleanup-media-storage";
import { registerDetourageMainImageSubscriber } from "./detourage-main-image";
import { registerMarketingOptInSyncSubscriber } from "./sync-marketing-optin";
import { registerNewsletterToProfileSyncSubscriber } from "./sync-newsletter-to-profile";
import { registerUserNameFromProfileSyncSubscriber } from "./sync-user-name-from-profile";
import { registerMetricsCounterSubscriber } from "./metrics-counter";
import { registerOrderReceiptSubscriber } from "./send-order-receipt";
import { registerPromotionCacheSubscriber } from "./invalidate-promotion-cache";
import { registerStructuredLoggerSubscriber } from "./structured-logger";
import { registerWelcomeCouponSubscriber } from "./send-welcome-coupon";
import { registerWelcomeEmailSubscriber } from "./send-welcome-email";
import { registerPromotionAnnouncementSubscriber } from "./send-promotion-announcement";
import { registerPriceDropSubscriber } from "./notify-price-drop";
import { registerOrderStatusEmailSubscriber } from "./send-order-status";
import { registerOrderConfirmedEmailSubscriber } from "./send-order-confirmed";
import { registerBackInStockSubscriber } from "./notify-back-in-stock";
import { registerLowStockSubscriber } from "./notify-low-stock";
import { registerIssueBlOnShipSubscriber } from "./issue-bl-on-ship";
import { registerReembedProductSubscriber } from "./reembed-product";
import { registerWebhookDispatchSubscriber } from "./dispatch-webhooks";
import { registerAutoTransferSubscriber, registerOrderCancelTransferSubscriber } from "./auto-transfer";
import { registerTransferNotifySubscriber } from "./notify-transfer";
import { registerShipDepotDecrementSubscriber } from "./ship-depot-decrement";

/**
 * Register every subscriber at server boot.
 *
 * The flag is stored on `globalThis` — NOT a module-local boolean. The bus's
 * handler registry already persists across dev HMR via `globalThis`, so a
 * module-local guard (which RESETS when Next.js re-evaluates this file on HMR)
 * would re-append every handler onto the surviving registry — each event then
 * fires N+1 times in dev (duplicate audit rows, welcome emails, cache busts,
 * S3 deletes). Pinning the guard to `globalThis` too makes registration truly
 * once-per-process AND HMR-safe, matching the registry's lifetime.
 *
 * Registration order matters only for fan-out fairness — Promise.allSettled
 * on the bus side means every subscriber runs concurrently and one's
 * failure can't starve another. We still register the structured logger
 * first so its line is the first thing in the log for any given trace.
 */

declare global {
  var __gz_subscribers_registered: boolean | undefined;
}

export function registerAllSubscribers() {
  if (globalThis.__gz_subscribers_registered) return;
  globalThis.__gz_subscribers_registered = true;

  // ── Telemetry (wildcard listeners) — register before domain subscribers
  //    so they observe every event in a stable order.
  registerStructuredLoggerSubscriber();
  registerMetricsCounterSubscriber();
  registerAuditSubscriber();
  registerAuditTrailSubscriber();

  // ── Domain reactions
  registerWelcomeEmailSubscriber();
  registerWelcomeCouponSubscriber();
  registerPromotionAnnouncementSubscriber();
  registerPriceDropSubscriber();
  registerOrderStatusEmailSubscriber();
  registerOrderConfirmedEmailSubscriber();
  registerBackInStockSubscriber();
  registerLowStockSubscriber();
  registerOrderReceiptSubscriber();
  // Order-driven store→depot auto-replenishment (per-location + auto-request on)
  // + cancel the linked transfers when the order is cancelled.
  registerAutoTransferSubscriber();
  registerOrderCancelTransferSubscriber();
  registerTransferNotifySubscriber();
  // Per-location: shipping a parcel drops the depot's physical level (the total
  // already dropped at order placement) — keeps the auto-request shortfall exact.
  registerShipDepotDecrementSubscriber();
  registerIssueBlOnShipSubscriber();
  registerMarketingOptInSyncSubscriber();
  registerNewsletterToProfileSyncSubscriber();
  registerUserNameFromProfileSyncSubscriber();
  registerMediaStorageCleanupSubscriber();
  registerDetourageMainImageSubscriber();
  registerCatalogCacheSubscriber();
  registerCmsCacheSubscriber();
  registerMediaCacheSubscriber();
  registerBlogCacheSubscriber();
  registerAttributeCacheSubscriber();
  registerPromotionCacheSubscriber();

  // ── Semantic search: keep product embeddings fresh on catalogue edits.
  registerReembedProductSubscriber();

  // ── Outbound webhooks: enqueue a delivery per (event × subscribed ERP endpoint).
  registerWebhookDispatchSubscriber();

  // Add new subscribers here. Naming: `register<What>Subscriber`. Each
  // lives in its own file under this folder and exports the register fn
  // so the wildcard audit handler always fires first.
}

registerAllSubscribers();
