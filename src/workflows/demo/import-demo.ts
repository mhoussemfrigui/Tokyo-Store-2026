import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { DEMO_ORDERS } from "@/lib/demo/data";
import { emptyDataJobResult, importJobService, type DataJobResult } from "@/modules/import";
import { runProductImport } from "@/workflows/import/run-product-import";
import { productService } from "@/modules/catalog/product/service";
import { orderService } from "@/modules/order/service";
import { bus } from "@/events/bus";
import {
  seedAttributes,
  seedBanners,
  seedBrands,
  seedCategories,
  seedCustomers,
  seedFaqs,
  seedHomeDesign,
  seedNavigation,
  seedProductFaqs,
  seedSettings,
  type SegmentCtx,
} from "@/workflows/data/segments";
import { fail, ok, workflow } from "../shared";

/**
 * Demo content import.
 *
 * Reads `src/lib/demo/data.ts` and creates the matching DB rows so the
 * storefront looks like the original Lovable design out of the box.
 * Triggered from `/admin/system/import-demo`.
 *
 * Idempotent. Every entity is looked up by stable key (slug for brands,
 * name for banners, key for settings, slug for FAQ categories, question for
 * FAQs). Existing rows are skipped and the skip count surfaces in the
 * result so the operator sees what actually changed. Existing brands /
 * categories are never overwritten: their editorial + SEO fields are only
 * filled while blank, category FAQs only seeded when the category has none,
 * and a category an admin moved stays where it is.
 *
 * Implementation: this workflow now DELEGATES every content type to the
 * composable segment functions in `@/workflows/data/segments` (the same code
 * the background data-jobs run), so there is exactly ONE copy of each seed
 * rule. The granular `ImportCounts` shape is preserved by giving each
 * segment its own fresh `DataJobResult` and reading that segment's
 * created/skipped back into the matching field — the demo route's response
 * contract is unchanged.
 *
 * Image source: `public/demo-assets/*` — bundled into the Docker image's
 * `/app/public/` at build time; the segment seeds route each through the
 * standard media pipeline (WebP/AVIF variants per `media_settings`).
 */

const DEMO_IMAGES_DIR = path.join(process.cwd(), "public", "demo-assets");
/** The Tokyo Store migration feed (Google-Merchant RSS), bundled into
 *  public/demo-assets so the demo push imports the REAL Tokyo catalogue through
 *  the standard import pipeline — products, taxonomy, brands, SKU (g:id) and meta
 *  all come from the migration data. There is no separate "demo" catalogue. */
const DEMO_FEED_FILENAME = "tokyostore.xml";

type ImportCounts = {
  brandsCreated: number;
  brandsSkipped: number;
  brandsEdited: number;
  productsCreated: number;
  productsSkipped: number;
  bannersCreated: number;
  bannersSkipped: number;
  faqCategoriesCreated: number;
  faqCategoriesSkipped: number;
  faqsCreated: number;
  faqsSkipped: number;
  settingsCreated: number;
  settingsSkipped: number;
  navMenusCreated: number;
  navMenusSkipped: number;
  navItemsCreated: number;
  mediaCreated: number;
  attributesCreated: number;
  attributesSkipped: number;
  attributeValuesCreated: number;
  productAttributeLinksCreated: number;
  categoryFiltersCreated: number;
  categoriesEdited: number;
  customerProfilesCreated: number;
  customerProfilesSkipped: number;
  ordersCreated: number;
  ordersSkipped: number;
  refundsCreated: number;
  productFaqsCreated: number;
  categoryFaqsCreated: number;
  /** Background catalog-import job id (the live feed), or null when an import
   *  was already running. Products land asynchronously — poll the job at
   *  /admin/system/import. */
  productImportJobId: string | null;
  warnings: string[];
};

const emptyCounts = (): ImportCounts => ({
  brandsCreated: 0,
  brandsSkipped: 0,
  brandsEdited: 0,
  productsCreated: 0,
  productsSkipped: 0,
  bannersCreated: 0,
  bannersSkipped: 0,
  faqCategoriesCreated: 0,
  faqCategoriesSkipped: 0,
  faqsCreated: 0,
  faqsSkipped: 0,
  settingsCreated: 0,
  settingsSkipped: 0,
  navMenusCreated: 0,
  navMenusSkipped: 0,
  navItemsCreated: 0,
  mediaCreated: 0,
  attributesCreated: 0,
  attributesSkipped: 0,
  attributeValuesCreated: 0,
  productAttributeLinksCreated: 0,
  categoryFiltersCreated: 0,
  categoriesEdited: 0,
  customerProfilesCreated: 0,
  customerProfilesSkipped: 0,
  ordersCreated: 0,
  ordersSkipped: 0,
  refundsCreated: 0,
  productFaqsCreated: 0,
  categoryFaqsCreated: 0,
  productImportJobId: null,
  warnings: [],
});

/**
 * Resolve a relative "in N days" offset to an absolute Date. Local to the
 * order seed below (the segment seeds carry their own copy for their own
 * date math).
 */
function offsetDays(now: Date, days: number | null | undefined): Date | null {
  if (days === null || days === undefined) return null;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export const importDemoWorkflow = workflow<
  [{ actorUserId: string }],
  ImportCounts
>("demo.import", async ({ actorUserId }) => {
  if (!actorUserId) return fail("auth", "Admin requis.");
  const counts = emptyCounts();

  // Run one segment with its own fresh result so we can read its
  // created/skipped/mediaCreated back into the granular ImportCounts. Shared
  // warnings bubble up into `counts.warnings`.
  const runSeg = async (fn: (ctx: SegmentCtx) => Promise<void>): Promise<DataJobResult> => {
    const result = emptyDataJobResult();
    await fn({ actorUserId, result });
    counts.warnings.push(...result.warnings);
    counts.mediaCreated += result.mediaCreated;
    return result;
  };

  // ─── Chrome segments (mirror the original ordering) ──────────────────────
  // Attributes BEFORE categories — category filter chips reference attribute
  // ids resolved during the attribute seed.
  const attrRes = await runSeg(seedAttributes);
  counts.attributesCreated = attrRes.created; // attrs + values both counted in created
  counts.attributesSkipped = attrRes.skipped;

  const brandRes = await runSeg(seedBrands);
  counts.brandsCreated = brandRes.created;
  counts.brandsSkipped = brandRes.skipped;

  await runSeg(seedCategories); // editorial + filters + category FAQs (counts below)

  const faqRes = await runSeg(seedFaqs);
  counts.faqsCreated = faqRes.created;
  counts.faqsSkipped = faqRes.skipped;

  const settingRes = await runSeg(seedSettings);
  counts.settingsCreated = settingRes.created;
  counts.settingsSkipped = settingRes.skipped;

  const bannerRes = await runSeg(seedBanners);
  counts.bannersCreated = bannerRes.created;
  counts.bannersSkipped = bannerRes.skipped;

  // Home editorial blocks + the four mega-menu featured banners + the nav-bar
  // logo. Sourced from the demo's own uploaded média (no dependency on the async
  // product feed), so the home page, mega-menus, and header logo are fully
  // populated the moment this import returns. The mixed created-count (settings +
  // banners) folds into settingsCreated for the operator toast.
  const homeRes = await runSeg(seedHomeDesign);
  counts.settingsCreated += homeRes.created;

  await runSeg(seedNavigation);
  await runSeg(seedCustomers);
  await runSeg(seedProductFaqs);

  // ─── Products — import the full bundled catalog feed (BACKGROUND) ─────────
  // The demo catalog IS the live tokyostore.tn export. Seed it through the
  // SAME import pipeline the admin uses (single source of truth): create an
  // import_jobs row from the bundled feed and detach the runner so this
  // request returns once the chrome is seeded.
  // `createIfIdle` is the atomic single-flight gate (re-check + insert under
  // the job advisory lock); the hasActive() pre-check just avoids reading the
  // multi-MB feed when a job is obviously running.
  const busyWarning = "Un import catalogue est déjà en cours — produits non relancés.";
  if (await importJobService.hasActive()) {
    counts.warnings.push(busyWarning);
  } else {
    try {
      const feed = await readFile(path.join(DEMO_IMAGES_DIR, DEMO_FEED_FILENAME), "utf8");
      const job = await importJobService.createIfIdle({
        format: "xml",
        filename: "Catalogue Tokyo Store (démo)",
        source_content: feed,
        created_by: actorUserId,
      });
      if (!job) {
        counts.warnings.push(busyWarning);
      } else {
        counts.productImportJobId = job.id;
        void runProductImport(job.id, actorUserId).catch(async (err) => {
          console.error("[demo.import] product runner crashed", err);
          await importJobService
            .fail(job.id, err instanceof Error ? err.message : String(err))
            .catch(() => {});
        });
      }
    } catch (err) {
      counts.warnings.push(
        `Import catalogue non démarré: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Demo orders + partial refunds ───────────────────────────────────────
  // Orders aren't one of the reusable content segments (the demo's order
  // fixtures depend on products the feed imports asynchronously), so this
  // bespoke seed stays here. No-op while DEMO_ORDERS is empty.
  const importNow = new Date();
  void offsetDays; // reserved for future order-window math; kept for parity
  for (const o of DEMO_ORDERS) {
    const existing = await orderService.findByOrderNumber(o.orderNumber);
    if (existing) {
      counts.ordersSkipped++;
      continue;
    }
    const items: {
      productId: string;
      productName: string;
      productSlug: string;
      unitPriceCents: number;
      quantity: number;
      subtotalCents: number;
    }[] = [];
    let missingProduct = false;
    for (const it of o.items) {
      const prod = await productService.findBySlug(it.productSlug);
      if (!prod) {
        counts.warnings.push(
          `order ${o.orderNumber}: product '${it.productSlug}' not found — order skipped`,
        );
        missingProduct = true;
        break;
      }
      items.push({
        productId: prod.id,
        productName: prod.name,
        productSlug: prod.slug,
        unitPriceCents: it.unitPriceCents,
        quantity: it.quantity,
        subtotalCents: it.unitPriceCents * it.quantity,
      });
    }
    if (missingProduct) continue;

    const subtotalCents = items.reduce((acc, it) => acc + it.subtotalCents, 0);
    const totalCents = subtotalCents;
    const paidAt = new Date(importNow.getTime() - 5 * 24 * 60 * 60 * 1000);

    const order = await orderService.insertOrder({
      order_number: o.orderNumber,
      contact_email: o.contactEmail,
      contact_phone: o.contactPhone,
      status: "delivered",
      currency: "TND",
      subtotal_cents: subtotalCents,
      shipping_cents: 0,
      discount_cents: 0,
      tax_cents: 0,
      total_cents: totalCents,
      ship_full_name: o.shipFullName,
      ship_street_line1: o.shipStreet,
      ship_city: o.shipCity,
      ship_region: o.shipRegion,
      ship_postal_code: o.shipPostalCode,
      ship_country: "TN",
      ship_phone: o.contactPhone,
      payment_method: o.paymentMethod,
      payment_reference: o.paymentReference,
      paid_at: paidAt,
    });
    await orderService.insertItems(
      items.map((it) => ({
        order_id: order.id,
        product_id: it.productId,
        product_name: it.productName,
        product_slug: it.productSlug,
        unit_price_cents: it.unitPriceCents,
        quantity: it.quantity,
        subtotal_cents: it.subtotalCents,
      })),
    );
    counts.ordersCreated++;

    await orderService.insertRefund({
      order_id: order.id,
      amount_cents: o.refund.amountCents,
      reason: o.refund.reason,
      created_by_user_id: actorUserId,
    });
    counts.refundsCreated++;
  }

  await bus.emit(
    "demo.imported",
    {
      brandsCreated: counts.brandsCreated,
      productsCreated: counts.productsCreated,
      bannersCreated: counts.bannersCreated,
      faqsCreated: counts.faqsCreated,
      mediaCreated: counts.mediaCreated,
    },
    { actorUserId },
  );

  return ok(counts);
});
