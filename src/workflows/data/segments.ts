import "server-only";

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  DEMO_ATTRIBUTES,
  DEMO_BANNERS,
  DEMO_BRANDS,
  DEMO_BRAND_EDITORIALS,
  DEMO_CATEGORY_ATTRIBUTE_FILTERS,
  DEMO_CATEGORY_EDITORIALS,
  DEMO_CATEGORY_FAQS,
  DEMO_CUSTOMER_PROFILES,
  DEMO_FAQS,
  DEMO_FAQ_CATEGORIES,
  DEMO_LOGO_SETTING,
  DEMO_NAV_MENUS,
  DEMO_PRODUCT_ATTRIBUTES,
  DEMO_PRODUCT_FAQS,
  DEMO_SETTINGS,
  type DemoBannerPlacement,
} from "@/lib/demo/data";
import {
  DEMO_SETTINGS_CLEAN_KEYS,
  DEMO_MEDIA_SETTING_SLOTS,
  planDemoSettingsClean,
} from "@/lib/demo/settings-clean-plan";
import { CATALOG_TREE, type CatalogNode } from "@/lib/db/catalog-tree";
import { MAIN_NAV_MENU_KEY, SYSTEM_NAV_MENU_KEYS } from "@/lib/cms/nav-menus";
import { navDropdownMediaIds, parseNavDropdown } from "@/lib/cms/nav-composer-model";
import {
  productBrandLink,
  productCategoryLinks,
  productMediaLink,
} from "@/associations/catalog.service";
import { brandService } from "@/modules/catalog/brand/service";
import { categoryService } from "@/modules/catalog/category/service";
import { productService } from "@/modules/catalog/product/service";
import { productQueries } from "@/modules/catalog/product";
import { attributeService } from "@/modules/catalog/attribute/service";
import { bannerService } from "@/modules/cms/banner/service";
import { faqService } from "@/modules/cms/faq/service";
import { settingService } from "@/modules/cms/setting/service";
import type { SettingType } from "@/modules/cms/setting/schema";
import { navigationService } from "@/modules/cms/navigation/service";
import { customerService } from "@/modules/customer/service";
import { mediaService } from "@/modules/media/service";
import { mediaQueries } from "@/modules/media";
import { redirectService } from "@/modules/redirects/service";
import { normalizeDestination, normalizeSourcePath, type ParsedRedirect } from "@/lib/redirects/normalize";
import type { DataJobResult } from "@/modules/import";
import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { isUuid } from "@/lib/utils/uuid";
import { makeImageUploader } from "./_image-uploader";

/**
 * Composable per-segment seed/clean functions.
 *
 * The logic here is lifted VERBATIM from `workflows/demo/import-demo.ts`
 * (seed) and `workflows/demo/clear-demo.ts` (clean) — same services, same
 * demo data, same idempotency contract — and split into one async function
 * per content segment so the background data-job runner can target a single
 * segment or fan out to "all". The demo workflows now delegate here so there
 * is exactly ONE copy of each rule.
 *
 * Counter sink: every function mutates the shared `DataJobResult` carried on
 * the `SegmentCtx`. Seeds bump `created` / `skipped` (+ `mediaCreated` for
 * image uploads); cleans bump `deleted` / `mediaDeleted`. The slow segments
 * (products is handled elsewhere; chrome segments are fast) may call
 * `onProgress` — currently only the runner sets `total`, so the chrome
 * seeds report a single tick each.
 *
 * Module boundary: like the demo workflows, these talk to module services +
 * association helpers only. The lone exception is media reclaim, which emits
 * `media.bulk_deleted` exactly as clear-demo does.
 *
 * Média reclaim rule (every clean): collect the média a segment OWNS before its
 * rows go, delete the rows, then hand the candidates to `reclaimUnreferencedMedia`
 * — it hard-deletes only the ones NOTHING else references any more (a banner
 * image reused by a home block, a packshot picked as a category hero… is kept,
 * and a live product's gallery row can't cascade away with a shared image).
 */

export type SegmentCtx = {
  actorUserId: string;
  result: DataJobResult;
  onProgress?: (processed: number, total: number) => Promise<void>;
};

/**
 * Hard-delete the candidate média that no catalog/CMS/blog/aid/settings row
 * references any more, and emit `media.bulk_deleted` for exactly the rows
 * removed (the storage subscriber purges their S3 objects; the cache subscriber
 * re-resolves storefront images). MUST run AFTER the owning rows are deleted,
 * so the references being torn down in the same step no longer count.
 * Exported for the data-clean-scoping regression test.
 */
export async function reclaimUnreferencedMedia(
  ctx: SegmentCtx,
  candidateIds: readonly (string | null | undefined)[],
): Promise<void> {
  const unique = Array.from(new Set(candidateIds.filter((id): id is string => Boolean(id))));
  if (!unique.length) return;
  const stillUsed = await mediaQueries.listReferencedMediaIds(unique);
  const toDelete = unique.filter((id) => !stillUsed.has(id));
  if (!toDelete.length) return;
  const removed = await mediaService.deleteByIds(toDelete);
  ctx.result.mediaDeleted += removed.ids.length;
  if (removed.ids.length) {
    // Attributed to the operator who ran the clean (the curated audit row
    // otherwise records a mass média deletion with no actor).
    await bus.emit(
      "media.bulk_deleted",
      {
        mediaIds: removed.ids,
        deletedCount: removed.ids.length,
        storageKeys: removed.storageKeys,
      },
      { actorUserId: ctx.actorUserId },
    );
  }
}

// ─────────────────────────────────────────────────────────── seed helpers

/**
 * Root catalog tree the demo depends on — shared verbatim with
 * `pnpm db:seed:catalog` via `src/lib/db/catalog-tree.ts`. Recursive
 * create-if-missing walk; sibling index = display_order. `findBySlug(slug,
 * parentId)` is sibling-scoped (null = roots only).
 *
 * Never rearranges the admin's tree: a PRE-EXISTING category keeps its parent
 * and display order (only rows created by this very run may be re-parented).
 */
export async function ensureCategoryTree(ctx: SegmentCtx): Promise<void> {
  const createdIds = new Set<string>();
  async function ensureLevel(nodes: CatalogNode[], parentId: string | null): Promise<void> {
    for (const [index, node] of nodes.entries()) {
      // 1. Steady state: a sibling-scoped match (already under the right parent).
      const sibling = await categoryService.findBySlug(node.slug, parentId);
      let nodeId: string;
      if (sibling) {
        nodeId = sibling.id;
        ctx.result.skipped += 1;
      } else {
        // 2. The slug may already exist under a DIFFERENT parent. Reuse that row
        //    (it carries its products) instead of inserting a duplicate — non-root
        //    slugs have no unique constraint. A pre-existing row was placed there
        //    by an admin (or an earlier tree), so it is LEFT where it is (a re-run
        //    of the demo import must not undo the admin's restructuring); only a
        //    row this run created is moved under the expected parent. Fresh
        //    installs never hit this branch (global lookup also misses → insert).
        const elsewhere = await categoryService.findBySlug(node.slug);
        if (elsewhere) {
          if (createdIds.has(elsewhere.id)) {
            await categoryService.update(elsewhere.id, { parent_id: parentId, display_order: index });
          } else {
            ctx.result.warnings.push(
              `Catégorie « ${elsewhere.name} » laissée sous son parent actuel (non replacée dans l'arborescence de démo).`,
            );
          }
          nodeId = elsewhere.id;
          ctx.result.skipped += 1;
        } else {
          const inserted = await categoryService.insert({
            slug: node.slug,
            name: node.name,
            tagline: node.tagline ?? null,
            parent_id: parentId,
            display_order: index,
          });
          nodeId = inserted.id;
          createdIds.add(inserted.id);
          ctx.result.created += 1;
        }
      }
      if (node.children?.length) await ensureLevel(node.children, nodeId);
    }
  }
  await ensureLevel(CATALOG_TREE, null);
}

/** Translate the demo placement string to the banner_placement enum. */
function demoBannerPlacement(p: DemoBannerPlacement | undefined): DemoBannerPlacement {
  return p ?? "home_hero";
}

// ════════════════════════════════════════════════════════════════════ SEED

/** True when an editorial/SEO column holds nothing the admin wrote (null, blank
 *  text, or an empty value-props list) — the only case a re-seed may fill it. */
function isBlank(value: string | readonly unknown[] | null | undefined): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  return value.length === 0;
}

/**
 * Fill-empty patch: keep only the demo values whose target column is still
 * blank on the live row, so re-running the import NEVER overwrites an admin's
 * editorial / SEO copy (the same "never clobber an admin edit" rule the
 * settings, home-design and navigation seeds follow). Empty result = no update.
 * Exported for the data-jobs-cache regression test.
 */
export function fillBlankFields<R extends object>(row: R, demo: Partial<R>): Partial<R> {
  const patch: Partial<R> = {};
  for (const key of Object.keys(demo) as (keyof R)[]) {
    const current = row[key] as string | readonly unknown[] | null | undefined;
    if (isBlank(current)) patch[key] = demo[key];
  }
  return patch;
}

/**
 * Categories: ensure the catalog tree, then patch editorial content, opt
 * categories into attribute filter chips, and seed per-category FAQs.
 * Mirrors steps 0, 8, 10 (filters), and 10c of the original demo import.
 *
 * Idempotent AND non-destructive: editorial fields are only filled while still
 * blank, and a category's demo FAQs are only seeded when it has no live FAQ —
 * an admin's copy and hand-written FAQs survive a re-run.
 *
 * NOTE: category filters depend on attributes existing — the runner seeds
 * attributes before categories in the "all" path, and `seedCategories` is
 * resilient to a missing attribute (the chip is simply skipped).
 */
export async function seedCategories(ctx: SegmentCtx): Promise<void> {
  await ensureCategoryTree(ctx);

  const allCats = await categoryService.listAll();
  const catSlugToRow = new Map(allCats.map((c) => [c.slug, c]));

  // Editorial content (update-in-place, blank fields only; never creates rows).
  for (const ed of DEMO_CATEGORY_EDITORIALS) {
    const cat = catSlugToRow.get(ed.slug);
    if (!cat) {
      ctx.result.warnings.push(`editorial: category '${ed.slug}' not found — skipped`);
      continue;
    }
    const patch = fillBlankFields(cat, {
      editorial_eyebrow: ed.eyebrow,
      editorial_title: ed.title,
      editorial_body: ed.body,
      value_props: ed.valueProps,
    });
    if (Object.keys(patch).length > 0) await categoryService.update(cat.id, patch);
  }

  // Attribute filter chips per category (replace, not append).
  const filtersByCategorySlug = new Map<string, string[]>();
  for (const f of DEMO_CATEGORY_ATTRIBUTE_FILTERS) {
    const attr = await attributeService.findAttributeBySlug(f.attributeSlug);
    if (!attr) continue;
    const arr = filtersByCategorySlug.get(f.categorySlug);
    if (arr) arr.push(attr.id);
    else filtersByCategorySlug.set(f.categorySlug, [attr.id]);
  }
  for (const [categorySlug, attributeIds] of filtersByCategorySlug) {
    const cat = catSlugToRow.get(categorySlug);
    if (!cat) {
      ctx.result.warnings.push(`category filter: category '${categorySlug}' not found — skipped`);
      continue;
    }
    await attributeService.setCategoryFilters(cat.id, attributeIds);
  }

  // Per-category FAQs — only for a category with NO live FAQ yet
  // (`replaceForCategory` soft-deletes the prior set, which would wipe the FAQs
  // an admin layered on from the category form's FAQ tab).
  const categoryFaqsBySlug = new Map<string, typeof DEMO_CATEGORY_FAQS>();
  for (const f of DEMO_CATEGORY_FAQS) {
    const arr = categoryFaqsBySlug.get(f.categorySlug);
    if (arr) arr.push(f);
    else categoryFaqsBySlug.set(f.categorySlug, [f]);
  }
  const faqCategoryIds = Array.from(categoryFaqsBySlug.keys())
    .map((slug) => catSlugToRow.get(slug)?.id)
    .filter((id): id is string => Boolean(id));
  const categoriesWithFaqs = await faqService.categoryIdsWithFaqs(faqCategoryIds);
  for (const [categorySlug, faqs] of categoryFaqsBySlug) {
    const cat = catSlugToRow.get(categorySlug);
    if (!cat) {
      ctx.result.warnings.push(`category faq: category '${categorySlug}' not found — skipped`);
      continue;
    }
    if (categoriesWithFaqs.has(cat.id)) {
      ctx.result.skipped += 1;
      continue;
    }
    await faqService.replaceForCategory(
      cat.id,
      faqs.map((f) => ({
        question: f.question,
        answer: f.answer,
        displayOrder: f.displayOrder,
        isPublished: f.isPublished,
      })),
    );
  }
}

/** Brands + brand editorials. Idempotent by slug; the editorial / SEO fields
 *  are only filled while still blank (a re-run never overwrites the admin's
 *  tagline, editorial copy or meta title/description). */
export async function seedBrands(ctx: SegmentCtx): Promise<void> {
  for (const b of DEMO_BRANDS) {
    const existing = await brandService.findBySlug(b.slug);
    if (existing) {
      ctx.result.skipped += 1;
      continue;
    }
    await brandService.insert({ slug: b.slug, name: b.name, is_active: true });
    ctx.result.created += 1;
  }

  // Editorial content (update-in-place, blank fields only).
  const brandRows = await brandService.listBySlugs(DEMO_BRANDS.map((b) => b.slug));
  for (const ed of DEMO_BRAND_EDITORIALS) {
    const brand = brandRows.find((b) => b.slug === ed.slug);
    if (!brand) {
      ctx.result.warnings.push(`editorial: brand '${ed.slug}' not found — skipped`);
      continue;
    }
    const patch = fillBlankFields(brand, {
      tagline: ed.tagline,
      editorial_eyebrow: ed.eyebrow,
      editorial_title: ed.title,
      editorial_body: ed.body,
      value_props: ed.valueProps,
      meta_title: ed.metaTitle,
      meta_description: ed.metaDescription,
    });
    if (Object.keys(patch).length > 0) await brandService.update(brand.id, patch);
  }
}

/** Banners (image upload + insert). Idempotent by name. */
export async function seedBanners(ctx: SegmentCtx): Promise<void> {
  const { uploadByKey } = makeImageUploader(ctx.actorUserId, ctx.result);
  for (const b of DEMO_BANNERS) {
    const existing = await bannerService.findByName(b.name);
    if (existing) {
      ctx.result.skipped += 1;
      continue;
    }
    const mediaId = await uploadByKey(b.image, "cms");
    await bannerService.insert({
      name: b.name,
      placement: demoBannerPlacement(b.placement),
      eyebrow: b.eyebrow ?? null,
      title: b.title,
      subtitle: b.subtitle ?? null,
      description: b.description ?? null,
      cta_label: b.ctaLabel ?? null,
      cta_href: b.ctaHref ?? null,
      secondary_cta_label: b.secondaryCtaLabel ?? null,
      secondary_cta_href: b.secondaryCtaHref ?? null,
      image_media_id: mediaId ?? null,
      display_order: b.displayOrder,
      is_active: true,
    });
    ctx.result.created += 1;
  }
}

/** Navigation menus + items. Items only seed when the menu is newly created. */
export async function seedNavigation(ctx: SegmentCtx): Promise<void> {
  for (const m of DEMO_NAV_MENUS) {
    let existingMenu = await navigationService.findMenuByKey(m.key);
    if (existingMenu) {
      ctx.result.skipped += 1;
    } else {
      existingMenu = await navigationService.insertMenu({
        key: m.key,
        name: m.name,
        description: m.description ?? null,
      });
      ctx.result.created += 1;
    }
    // Never overwrite an admin's edits to an existing menu's items. Count ALL
    // items (not just visible ones): an admin who HID every link (is_visible=false)
    // instead of deleting them has still edited the menu, so a re-import must not
    // treat it as empty and re-insert the defaults (which would duplicate rows +
    // resurrect the hidden links).
    const currentItems = await navigationService.listAllItemsForMenu(existingMenu.id);
    if (currentItems.length === 0) {
      let order = 0;
      for (const item of m.items) {
        await navigationService.insertItem({
          menu_id: existingMenu.id,
          label: item.label,
          description: item.description ?? null,
          href: item.href ?? null,
          internal_kind: item.internalKind ?? null,
          internal_ref: item.internalRef ?? null,
          display_order: order++,
          is_visible: true,
          open_in_new_tab: false,
        });
        ctx.result.created += 1;
      }
    }
  }
}

/** Settings. Idempotent by key (`upsert` only runs when the key is absent). */
export async function seedSettings(ctx: SegmentCtx): Promise<void> {
  for (const s of DEMO_SETTINGS) {
    const existing = await settingService.findByKey(s.key);
    if (existing) {
      ctx.result.skipped += 1;
      continue;
    }
    await settingService.upsert({
      key: s.key,
      value: s.value,
      type: s.type,
      group_key: s.groupKey,
      label: s.label,
    });
    ctx.result.created += 1;
  }
}

/**
 * Home design: the nav-bar logo, the luxury editorial home blocks (fiftyfifty /
 * appointment / complications / heritage), and the four mega-menu featured
 * banners. Mirrors `scripts/seed-tokyo-design.ts` but sources every image from
 * the demo's OWN uploads (public/demo-assets via the media pipeline) instead of
 * the async product feed — so the home page is fully populated the moment the
 * import returns, not only after the catalog lands.
 *
 * Idempotent: settings by key (never clobbers an admin edit), nav banners by
 * name. Runs in the SYNC chrome phase.
 */
export async function seedHomeDesign(ctx: SegmentCtx): Promise<void> {
  const { uploadByKey } = makeImageUploader(ctx.actorUserId, ctx.result);

  // 1. Nav-bar logo → site.logo_media_id (branding group). Without this the
  //    header falls back to the text wordmark.
  if (await settingService.findByKey(DEMO_LOGO_SETTING.settingKey)) {
    ctx.result.skipped += 1;
  } else {
    const logoId = await uploadByKey(DEMO_LOGO_SETTING.image, "cms");
    if (logoId) {
      await settingService.upsert({
        key: DEMO_LOGO_SETTING.settingKey,
        value: logoId,
        type: "media",
        group_key: "branding",
        label: "Logo (barre de navigation)",
      });
      ctx.result.created += 1;
    }
  }
  // The home editorial blocks, home-block images and mega-menu featured banners
  // were watch-era chrome retired with the legacy home — only the nav-bar logo
  // remains to seed here.
}

/** FAQ categories + help-scoped FAQs. Idempotent by slug / question text. */
export async function seedFaqs(ctx: SegmentCtx): Promise<void> {
  // FAQ categories.
  for (const c of DEMO_FAQ_CATEGORIES) {
    const existing = await faqService.findCategoryBySlug(c.slug);
    if (existing) {
      ctx.result.skipped += 1;
      continue;
    }
    await faqService.insertCategory({
      slug: c.slug,
      name: c.name,
      display_order: c.displayOrder,
    });
    ctx.result.created += 1;
  }

  // Help FAQs.
  const catRows = await faqService.listCategories();
  const catSlugToId = new Map(catRows.map((r) => [r.slug, r.id]));
  const existingFaqQuestions = new Set(await faqService.listLiveQuestions());
  for (const f of DEMO_FAQS) {
    if (existingFaqQuestions.has(f.question)) {
      ctx.result.skipped += 1;
      continue;
    }
    await faqService.insert({
      faq_category_id: catSlugToId.get(f.categorySlug) ?? null,
      question: f.question,
      answer: f.answer,
      display_order: f.displayOrder,
      scope: "help",
      is_published: true,
    });
    ctx.result.created += 1;
  }
}

/**
 * Product attributes + values + product↔value links.
 *
 * Not one of the 8 public segments, but seeded as part of "all" (and a
 * prerequisite for `seedCategories`' filter chips). Idempotent: attributes
 * by slug, values by (attribute, slug), links via the append-only
 * `addProductAttributeValues`.
 */
export async function seedAttributes(ctx: SegmentCtx): Promise<void> {
  const attrValueSlugToId = new Map<string, string>(); // key: `${attrSlug}/${valSlug}`
  for (const a of DEMO_ATTRIBUTES) {
    let attr = await attributeService.findAttributeBySlug(a.slug);
    if (attr) {
      ctx.result.skipped += 1;
    } else {
      attr = await attributeService.insertAttribute({
        slug: a.slug,
        name: a.name,
        kind: a.kind,
        display_order: a.displayOrder,
        is_active: true,
      });
      ctx.result.created += 1;
    }
    for (const v of a.values) {
      let val = await attributeService.findValueBySlug(attr.id, v.slug);
      if (!val) {
        val = await attributeService.insertValue({
          attribute_id: attr.id,
          slug: v.slug,
          label: v.label,
          display_order: v.displayOrder,
        });
        ctx.result.created += 1;
      }
      attrValueSlugToId.set(`${a.slug}/${v.slug}`, val.id);
    }
  }

  // Link products to attribute values (grouped so one call per product).
  const valuesByProductSlug = new Map<string, string[]>();
  for (const link of DEMO_PRODUCT_ATTRIBUTES) {
    const valueId = attrValueSlugToId.get(`${link.attributeSlug}/${link.valueSlug}`);
    if (!valueId) continue;
    const arr = valuesByProductSlug.get(link.productSlug);
    if (arr) arr.push(valueId);
    else valuesByProductSlug.set(link.productSlug, [valueId]);
  }
  for (const [productSlug, valueIds] of valuesByProductSlug) {
    const prod = await productService.findBySlug(productSlug);
    if (!prod) {
      ctx.result.warnings.push(`attribute link: product '${productSlug}' not found — skipped`);
      continue;
    }
    await attributeService.addProductAttributeValues(prod.id, valueIds);
  }
}

/**
 * Customer profiles. Not a public segment; seeded as part of "all". The
 * customer module has no "find by name" surface, so page the (small) admin
 * listing once and match on names — backfilling admin_notes when missing.
 */
export async function seedCustomers(ctx: SegmentCtx): Promise<void> {
  const allProfiles = await customerService.list({ limit: 200 });
  for (const c of DEMO_CUSTOMER_PROFILES) {
    const existing = allProfiles.items.find(
      (p) => p.first_name === c.firstName && p.last_name === c.lastName,
    );
    if (existing) {
      ctx.result.skipped += 1;
      if (!existing.admin_notes) {
        await customerService.updateProfile(existing.id, { admin_notes: c.adminNotes });
      }
      continue;
    }
    await customerService.insertProfile({
      first_name: c.firstName,
      last_name: c.lastName,
      phone: c.phone ?? null,
      marketing_opt_in: c.marketingOptIn,
      admin_notes: c.adminNotes,
    });
    ctx.result.created += 1;
  }
}

/**
 * Per-product FAQs. Not a public segment, but part of the original demo
 * import. Grouped per product; `replaceForProduct` resets to seed values.
 * No-op while `DEMO_PRODUCT_FAQS` is empty (catalog comes from the feed).
 */
export async function seedProductFaqs(ctx: SegmentCtx): Promise<void> {
  const productFaqsBySlug = new Map<string, typeof DEMO_PRODUCT_FAQS>();
  for (const f of DEMO_PRODUCT_FAQS) {
    const arr = productFaqsBySlug.get(f.productSlug);
    if (arr) arr.push(f);
    else productFaqsBySlug.set(f.productSlug, [f]);
  }
  for (const [productSlug, faqs] of productFaqsBySlug) {
    const prod = await productService.findBySlug(productSlug);
    if (!prod) {
      ctx.result.warnings.push(`product faq: product '${productSlug}' not found — skipped`);
      continue;
    }
    await faqService.replaceForProduct(
      prod.id,
      faqs.map((f) => ({
        question: f.question,
        answer: f.answer,
        displayOrder: f.displayOrder,
        isPublished: f.isPublished,
      })),
    );
  }
}

// ──────────────────────────────────────────── content snapshot + redirects
//
// These two seeds carry the store's REAL, bundled data (produced at build time
// by `scripts/export-content-snapshot.ts` + the ETL that writes
// `tokyo-catalog.xml` / `tokyo-redirects.json`) rather than the hand-authored
// DEMO_* fixtures the chrome seeds above use. `seedContentSnapshot` applies the
// site's CMS content "exactly as is"; `seedRedirects` points the old product
// URLs at the freshly-imported slugs. Both are idempotent.

const DEMO_ASSETS_DIR = path.join(process.cwd(), "public", "demo-assets");
const CONTENT_SNAPSHOT_PATH = path.join(DEMO_ASSETS_DIR, "tokyo-content.json");
const REDIRECTS_PATH = path.join(DEMO_ASSETS_DIR, "tokyo-redirects.json");

/** One content table's apply rule. `conflict` is the ON CONFLICT target; when
 *  it is a NATURAL key (slug/key) the snapshot `id` is dropped so we never
 *  collide with a boot-seeded system row (system pages, nav menus) and inbound
 *  FKs are remapped instead (see `seedContentSnapshot`). */
type ContentTableSpec = {
  table: string;
  rowsKey: string;
  /** ON CONFLICT target column. */
  conflict: string;
  /** Columns never written (generated columns are added automatically). */
  drop?: string[];
};

/**
 * Content tables in FK-safe insert order. Tables with a natural unique key
 * (settings/pages/faq_categories/nav_menus) conflict on it and DROP the
 * snapshot id; id-only tables preserve the snapshot id so their self / inbound
 * FKs (nav_items.parent_id, faqs → faq_categories, nav_items → nav_menus) stay
 * consistent after the natural-key tables are remapped.
 */
const CONTENT_TABLE_SPECS: ContentTableSpec[] = [
  { table: "faq_categories", rowsKey: "faq_categories", conflict: "slug", drop: ["id"] },
  { table: "nav_menus", rowsKey: "nav_menus", conflict: "key", drop: ["id"] },
  { table: "faqs", rowsKey: "faqs", conflict: "id" },
  { table: "nav_items", rowsKey: "nav_items", conflict: "id" },
  { table: "pages", rowsKey: "pages", conflict: "slug", drop: ["id"] },
  { table: "banners", rowsKey: "banners", conflict: "id" },
];

type SnapshotRow = Record<string, unknown>;

/** Map every `public/demo-assets/<stem>.<ext>` to its filename (stems are the
 *  snapshot's logical image names; the file carries the real extension). */
async function buildStemToFile(): Promise<Map<string, string>> {
  const files = await readdir(DEMO_ASSETS_DIR).catch(() => [] as string[]);
  const map = new Map<string, string>();
  for (const f of files) {
    const stem = f.replace(/\.[a-z0-9]+$/i, "");
    if (!map.has(stem)) map.set(stem, f);
  }
  return map;
}

/** The generated (non-insertable) columns on a content table, e.g. a tsvector
 *  `search_vector` — row_to_json captured them but they can't be written. */
async function generatedColumns(tables: readonly string[]): Promise<Set<string>> {
  const { rows } = await db.$client.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and is_generated = 'ALWAYS'
         and table_name = any($1::text[])`,
    [tables as string[]],
  );
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

/**
 * Generic, parametrized ON CONFLICT upsert for one content table. Returns the
 * number of rows written. jsonb/array/object values are JSON-stringified (pg
 * casts text → jsonb); an empty-string value in any `*_id` column is coerced to
 * NULL (a token that failed to resolve, never a legitimate id). Identifiers are
 * from the fixed schema (row_to_json), never user input.
 */
async function upsertContentTable(
  spec: ContentTableSpec,
  rows: SnapshotRow[],
  generated: Set<string>,
): Promise<number> {
  if (!rows.length) return 0;
  const drop = new Set([...(spec.drop ?? [])]);
  for (const g of generated) {
    const [t, c] = g.split(".");
    if (t === spec.table && c) drop.add(c);
  }
  const cols = Object.keys(rows[0]).filter((c) => !drop.has(c));
  if (!cols.includes(spec.conflict)) {
    throw new Error(`content upsert: conflict column '${spec.conflict}' missing from ${spec.table}`);
  }

  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = cols.map((c) => {
      let v = row[c] ?? null;
      if (v !== null && typeof v === "object") v = JSON.stringify(v); // jsonb
      if (v === "" && c.endsWith("_id")) v = null; // unresolved token → NULL
      params.push(v);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  const colList = cols.map((c) => `"${c}"`).join(", ");
  const setList = cols
    .filter((c) => c !== spec.conflict)
    .map((c) => `"${c}" = excluded."${c}"`)
    .join(", ");
  const sqlText =
    `insert into "${spec.table}" (${colList}) values ${tuples.join(", ")} ` +
    `on conflict ("${spec.conflict}") do update set ${setList}`;
  await db.$client.query(sqlText, params);
  return rows.length;
}

/**
 * Apply the bundled CONTENT snapshot (`tokyo-content.json`) verbatim: upload the
 * manifest images, remap `@@IMG:<stem>@@` → the new média id and `@@CAT:<slug>@@`
 * → the live category id, then upsert the nine content tables in FK-safe order.
 *
 * Idempotent: natural-key tables upsert in place (so a re-run, or a boot-seeded
 * system page, is updated not duplicated); id-only tables upsert on their
 * preserved snapshot id. Inbound FKs to the natural-key tables (nav_items →
 * nav_menus, faqs → faq_categories) are remapped to the live ids.
 *
 * `@@CAT@@` resolves only when the catalog tree is present (the one-click "all"
 * path seeds categories first); a content-only re-import leaves an unresolved
 * category soft-link NULL (warned), which the full import then fills.
 */
export async function seedContentSnapshot(ctx: SegmentCtx): Promise<void> {
  const raw = await readFile(CONTENT_SNAPSHOT_PATH, "utf8").catch(() => null);
  if (!raw) {
    ctx.result.warnings.push(
      "Instantané de contenu introuvable (public/demo-assets/tokyo-content.json) — contenu non importé.",
    );
    return;
  }
  const snap = JSON.parse(raw) as Record<string, unknown> & {
    _images?: string[];
    _categoryRefs?: string[];
  };

  // 1. Upload the manifest images → stem → new média id.
  const { uploadByFile } = makeImageUploader(ctx.actorUserId, ctx.result);
  const stemToFile = await buildStemToFile();
  const imgIdByStem = new Map<string, string>();
  for (const stem of snap._images ?? []) {
    const file = stemToFile.get(stem);
    if (!file) {
      ctx.result.warnings.push(`image '${stem}' absente de public/demo-assets/ — ignorée.`);
      continue;
    }
    const id = await uploadByFile(file, "cms");
    if (id) imgIdByStem.set(stem, id);
  }

  // 2. Resolve the category soft-links (@@CAT:slug@@) against the live tree.
  const catIdBySlug = new Map<string, string>();
  for (const slug of snap._categoryRefs ?? []) {
    const cat = await categoryService.findBySlug(slug);
    if (cat) catIdBySlug.set(slug, cat.id);
    else
      ctx.result.warnings.push(
        `Catégorie « ${slug} » absente — lien de contenu laissé vide (importez le catalogue pour le rétablir).`,
      );
  }

  // 3. Token substitution across the whole snapshot (string replace, then
  //    re-parse). Unresolved tokens collapse to "" and are coerced to NULL by
  //    the upserter for id columns / left blank for text settings.
  const substituted = JSON.parse(
    JSON.stringify(snap).replace(/@@(IMG|CAT):([^@]+)@@/g, (_m, kind: string, ref: string) =>
      kind === "IMG" ? imgIdByStem.get(ref) ?? "" : catIdBySlug.get(ref) ?? "",
    ),
  ) as Record<string, SnapshotRow[]>;

  // 4. site_settings via the module upsert (true upsert on `key`; the id is the
  //    DB's, never the snapshot's).
  const settings = (substituted.site_settings ?? []) as SnapshotRow[];
  for (const s of settings) {
    await settingService.upsert({
      key: String(s.key),
      value: (s.value as string | null) ?? null,
      type: s.type as SettingType,
      group_key: String(s.group_key ?? "general"),
      label: String(s.label ?? s.key),
      description: (s.description as string | null) ?? null,
    });
    ctx.result.created += 1;
  }

  // 5. The remaining tables via the generic upsert, remapping inbound FKs to the
  //    natural-key tables whose snapshot id we dropped.
  const generated = await generatedColumns(CONTENT_TABLE_SPECS.map((s) => s.table));
  const menuIdMap = new Map<string, string>(); // snapshot nav_menus.id → live id
  const faqCatIdMap = new Map<string, string>(); // snapshot faq_categories.id → live id

  for (const spec of CONTENT_TABLE_SPECS) {
    let rows = (substituted[spec.rowsKey] ?? []) as SnapshotRow[];

    if (spec.table === "faqs") {
      rows = rows.map((r) => ({
        ...r,
        faq_category_id: r.faq_category_id
          ? faqCatIdMap.get(String(r.faq_category_id)) ?? null
          : null,
      }));
    }
    if (spec.table === "nav_items") {
      rows = rows.map((r) => ({
        ...r,
        menu_id: r.menu_id ? menuIdMap.get(String(r.menu_id)) ?? null : null,
      }));
      // The snapshot is AUTHORITATIVE for each menu it provides. CLEAR that menu's
      // existing items before inserting — otherwise we upsert the snapshot rows by
      // their own ids ON TOP of the boot-materialized rows (ensureHeaderNavRoots /
      // ensureSystemNavMenus seed the `main` roots, « Explorer la maison » and the
      // footer columns with DIFFERENT ids), which doubled the entire nav (header +
      // page index + footer) on the first import and accumulated on every re-run.
      // Deleting first makes the import a clean, idempotent replace per menu.
      const liveMenuIds = [
        ...new Set(rows.map((r) => r.menu_id).filter((x): x is string => typeof x === "string" && !!x)),
      ];
      if (liveMenuIds.length > 0) {
        await db.$client.query(`DELETE FROM nav_items WHERE menu_id = ANY($1::uuid[])`, [liveMenuIds]);
      }
    }

    const written = await upsertContentTable(spec, rows, generated);
    ctx.result.created += written;

    // After the natural-key tables land, learn their live ids for the remaps.
    if (spec.table === "faq_categories") {
      const live = await faqService.listCategories();
      const bySlug = new Map(live.map((c) => [c.slug, c.id]));
      for (const r of rows) {
        const id = bySlug.get(String(r.slug));
        if (id) faqCatIdMap.set(String(r.id), id);
      }
    }
    if (spec.table === "nav_menus") {
      for (const r of rows) {
        const live = await navigationService.findMenuByKey(String(r.key));
        if (live) menuIdMap.set(String(r.id), live.id);
      }
    }
  }
}

/**
 * Point the OLD product URLs at the freshly-imported slugs (requirement 5).
 * Reads the bundled `tokyo-redirects.json` (built alongside the catalog feed:
 * `{source: "/<old-path>", slug: "<new-slug>"}`) and bulk-upserts a 301 per
 * row. `source_path` is a path on the CURRENT domain (the normalizer rejects
 * absolute URLs), so these fire once the new site serves the old paths.
 *
 * Runs AFTER the product import (so the destination slugs exist) in the "all"
 * and "products" paths. Idempotent: `bulkUpsert` conflicts on `source_path`.
 */
export async function seedRedirects(ctx: SegmentCtx): Promise<void> {
  const raw = await readFile(REDIRECTS_PATH, "utf8").catch(() => null);
  if (!raw) {
    ctx.result.warnings.push(
      "Table de redirections introuvable (public/demo-assets/tokyo-redirects.json) — redirections non créées.",
    );
    return;
  }
  const list = JSON.parse(raw) as { source: string; slug: string }[];
  const rows: ParsedRedirect[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const source = normalizeSourcePath(r.source);
    const destination = normalizeDestination(`/${r.slug}`);
    if (!source || !destination || source === destination) continue;
    if (seen.has(source)) continue; // one rule per source (bulkUpsert would otherwise race on the dup)
    seen.add(source);
    rows.push({ source, destination, status: 301 });
  }
  const res = await redirectService.bulkUpsert(rows);
  ctx.result.created += res.inserted + res.updated;
  if (rows.length < list.length) {
    ctx.result.warnings.push(
      `Redirections : ${list.length - rows.length} ligne(s) ignorée(s) (source/destination invalide ou en double).`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════ CLEAN

/**
 * Products: hard-delete EVERY product + its associations + media + product
 * FAQs, reclaiming orphaned S3 objects. The FK cascade also takes each
 * product's reviews, wishlist entries, variants and stock levels. Lifted from
 * clear-demo's product block (which already
 * wipes the entire catalog — the demo seeds it via the bundled feed, so there
 * is no hand-picked fixture list to scope to).
 */
export async function cleanProducts(ctx: SegmentCtx): Promise<void> {
  const productIds = await productService.listAllIds();
  if (productIds.length === 0) return;

  // Soft-delete product FAQs BEFORE the product rows disappear.
  for (const productId of productIds) {
    await faqService.replaceForProduct(productId, []);
  }

  // Collect media referenced by these products before the joins are gone — the
  // product_media GALLERY join, the product-OWNED columns (og_image_media_id
  // custom social card + video_poster_media_id) AND the variant images
  // (product_variants.image_media_id — the variant rows cascade away with the
  // product, so their média would otherwise be left orphaned).
  const galleryMediaIds = await productMediaLink.listMediaIdsForProducts(productIds);
  const ownMediaIds = (await productService.listByIds(productIds)).flatMap((p) => [
    p.og_image_media_id,
    p.video_poster_media_id,
  ]);
  const variantMediaIds = Array.from(
    (await productQueries.listVariantsForProducts(productIds)).values(),
  ).flatMap((variants) => variants.map((v) => v.image_media_id));

  await productMediaLink.deleteForProducts(productIds);
  await productCategoryLinks.deleteForProducts(productIds);
  await productBrandLink.deleteForProducts(productIds);
  const deletedIds = await productService.deleteByIds(productIds);
  ctx.result.deleted += deletedIds.length;

  // Drop media linked ONLY to those products — anything another entity still
  // uses (banner, category/brand hero, home-block setting, blog…) is kept.
  await reclaimUnreferencedMedia(ctx, [...galleryMediaIds, ...ownMediaIds, ...variantMediaIds]);
}

/**
 * Categories: HARD-delete ALL categories and detach their product links.
 *
 * Unlike clear-demo (which deliberately KEEPS the catalog tree), the
 * segmented `clean` flow lets the operator wipe categories on purpose.
 *
 * Hard delete (not soft) keeps a re-import fully clean: it removes the category
 * rows outright (and cascades `product_categories` links). As of migration 0017
 * `categories_root_slug_unique` is `WHERE parent_id IS NULL AND deleted_at IS
 * NULL`, so a soft-deleted root no longer reserves its slug — but hard delete
 * remains the teardown path so re-seed starts from a truly empty tree.
 *
 * Deleting every id in one statement is safe: `product_categories.category_id`
 * is `ON DELETE CASCADE` (we still detach those link rows first via the
 * association helper for deterministic ordering/counts), the self-FK
 * `categories.parent_id` is `ON DELETE SET NULL`, and
 * `category_attribute_filters.category_id` is `ON DELETE CASCADE`.
 */
export async function cleanCategories(ctx: SegmentCtx): Promise<void> {
  const cats = await categoryService.listAll();
  if (cats.length === 0) return;
  const ids = cats.map((c) => c.id);
  await productCategoryLinks.deleteForCategories(ids);
  const removed = await categoryService.hardDeleteByIds(ids);
  ctx.result.deleted += removed.length;
  // Reclaim the categories' own hero / social-card / icon média (previously
  // leaked on every clean) — unless something else still uses them.
  await reclaimUnreferencedMedia(
    ctx,
    cats.flatMap((c) => [c.hero_media_id, c.og_image_media_id, c.icon_media_id]),
  );
}

/** Brands (+ their logo/hero/social-card/icon images): hard-delete ALL brands
 *  (product↔brand links cascade), then reclaim the brand média nothing else uses. */
export async function cleanBrands(ctx: SegmentCtx): Promise<void> {
  // Collect every brand-owned média column BEFORE deleting. `listAll` (not the
  // 500-capped `list`) so a large brand set can't leak its images. (Brands an
  // admin had already soft-deleted are hard-deleted by `deleteAll` too; their
  // média, if any, stays visible in the Médiathèque orphans view.)
  const brandRows = await brandService.listAll();
  const removed = await brandService.deleteAll();
  ctx.result.deleted += removed.length;

  await reclaimUnreferencedMedia(
    ctx,
    brandRows.flatMap((b) => [b.logo_media_id, b.hero_media_id, b.og_image_media_id, b.icon_media_id]),
  );
}

/** Banners (+ orphaned hero images): wipe ALL banners. */
export async function cleanBanners(ctx: SegmentCtx): Promise<void> {
  const bannerIds = await bannerService.listAllIds();
  if (!bannerIds.length) return;

  const removed = await bannerService.deleteByIds(bannerIds);
  ctx.result.deleted += removed.length;

  // Banner images CAN be shared — « Bannières » runs on its own while products
  // exist, a banner visual can be reused by a home editorial block, and the
  // média picker lets an operator pick a packshot as a banner. Only reclaim the
  // ones nothing else references.
  await reclaimUnreferencedMedia(
    ctx,
    removed.flatMap((r) => [r.mediaId, r.mobileMediaId]),
  );
}

/**
 * Navigation: wipe EVERY nav item, and every menu EXCEPT the fixed-key system
 * menus (`main` + the three footer columns — see lib/cms/nav-menus.ts), which
 * are kept, emptied. Nothing recreates those rows at boot and the storefront
 * looks them up by key, so deleting them left the Footer / Nav Menu admin with
 * nothing to edit. An emptied menu renders nothing on the storefront, and a
 * later « Importer › Navigation » re-seeds its items (seedNavigation fills a
 * kept menu that has no items).
 */
export async function cleanNavigation(ctx: SegmentCtx): Promise<void> {
  const menus = await navigationService.listMenus();
  if (!menus.length) return;
  // Collect the média ids inside EVERY menu's `config` (dropdown image blocks)
  // BEFORE deleting the items — cleanBanners runs first and SKIPS reclaiming these
  // média because nav_items.config still references them then. Reclaiming here
  // (after the rows are gone) prevents them leaking as orphans on a full demo
  // clear. Not just `main`: any menu (header or future) can hold config imagery.
  const itemsByMenu = await navigationService
    .listItemsForMenus(menus.map((m) => m.id))
    .catch(() => new Map<string, { config: unknown }[]>());
  const navMediaIds = [...itemsByMenu.values()]
    .flat()
    .flatMap((it) => navDropdownMediaIds(parseNavDropdown(it.config as Record<string, unknown> | null)));
  const removedItems = await navigationService.deleteItemsByMenuIds(menus.map((m) => m.id));
  const removedMenus = await navigationService.deleteMenusByIds(
    menus.filter((m) => !SYSTEM_NAV_MENU_KEYS.includes(m.key)).map((m) => m.id),
  );
  ctx.result.deleted += removedItems.length + removedMenus.length;
  await reclaimUnreferencedMedia(ctx, navMediaIds);
}

/**
 * FAQs: wipe EVERY FAQ row (help + product- + category-scoped) and EVERY
 * FAQ category.
 *
 * FAQs carry no slug/name unique index, so a hard delete (vs the prior soft
 * `replaceFor*`) is purely about completeness — re-seed never collides. FAQs
 * are deleted before categories because the question rows reference a
 * category id (FK-less, but we keep the order tidy).
 */
export async function cleanFaqs(ctx: SegmentCtx): Promise<void> {
  const removedFaqs = await faqService.deleteAllFaqs();
  ctx.result.deleted += removedFaqs.length;
  const removedCategories = await faqService.deleteAllCategories();
  ctx.result.deleted += removedCategories.length;
}

/**
 * Settings: reset ONLY the demo settings that still hold their demo-seeded value.
 *
 * INTENTIONAL EXCEPTION to the "wipe ALL rows" rule that governs every other
 * clean segment. It never goes beyond the demo's own keys (payment/system config
 * the admin set up by hand is untouched) — and even those keys are the store's
 * LIVE identity/contact/social/logo/home settings, which the admin edits in place
 * and which the seeds skip when already present. So a key is deleted only while
 * it is still exactly what the demo seeded (see `planDemoSettingsClean`): an
 * edited value, an admin-chosen image or a key the demo never wrote survives.
 * The demo-uploaded images behind the deleted image keys are then reclaimed
 * (unless still used elsewhere — e.g. a home-block visual a banner shares).
 * Do NOT widen this to all settings or back to a key-only delete.
 *
 * No cache bust needed here: settings are read per request (getSettingsMap is a
 * React `cache()`, no `'use cache'` consumer carries CACHE_TAGS.settings); every
 * data-job still ends with a whole-storefront bust (`demo.cleared` subscriber +
 * the job poller — see src/lib/cache/bust-storefront.ts).
 */
export async function cleanSettings(ctx: SegmentCtx): Promise<void> {
  const current = new Map<string, string | null>();
  for (const key of DEMO_SETTINGS_CLEAN_KEYS) {
    const row = await settingService.findByKey(key);
    if (row) current.set(key, row.value);
  }
  if (current.size === 0) return;

  // Live média rows behind the image keys, for the demo-provenance check.
  const mediaIds = DEMO_MEDIA_SETTING_SLOTS.map((slot) => current.get(slot.settingKey)).filter(
    (id): id is string => isUuid(id),
  );
  const mediaRows = await mediaQueries.findMediaByIds(mediaIds);

  const plan = planDemoSettingsClean(current, mediaRows);
  const removed = await settingService.deleteByKeys(plan.deleteKeys);
  ctx.result.deleted += removed.length;
  if (plan.keptKeys.length) {
    ctx.result.skipped += plan.keptKeys.length;
    ctx.result.warnings.push(
      `Réglages : ${plan.keptKeys.length} réglage(s) personnalisé(s) conservé(s) (${plan.keptKeys.join(", ")}).`,
    );
  }
  await reclaimUnreferencedMedia(ctx, plan.mediaIds);
}

/**
 * Attributes: HARD-delete EVERY attribute (its values + M2M assignments
 * cascade away).
 *
 * Hard delete (not soft) is REQUIRED for a collision-free re-import: the
 * index `product_attributes_slug_unique` is a plain `UNIQUE(slug)` that does
 * NOT filter `deleted_at`, so a soft-deleted attribute would still occupy its
 * slug and re-seeding the same attribute would fail on that unique. We clear
 * each attribute's values first (the existing `deleteValue` path — also a
 * belt-and-suspenders against the `ON DELETE CASCADE` on
 * `product_attribute_values.attribute_id`), then hard-delete the attribute.
 *
 * `listAllAttributeIdsIncludingDeleted` is used (not `listAllAttributes`) so
 * any rows a prior soft-delete left behind are swept too.
 */
export async function cleanAttributes(ctx: SegmentCtx): Promise<void> {
  const attributeIds = await attributeService.listAllAttributeIdsIncludingDeleted();
  for (const attrId of attributeIds) {
    const values = await attributeService.listValuesForAttribute(attrId);
    for (const v of values) {
      await attributeService.deleteValue(v.id);
    }
    const removed = await attributeService.hardDeleteAttribute(attrId);
    if (removed) ctx.result.deleted += 1;
  }
}

/**
 * Customer profiles: soft-delete ALL profiles.
 *
 * Soft delete (not hard) is the app's deliberate model — `customer_profiles`
 * has no slug/name unique index, so a re-seed never collides on a soft-deleted
 * row, and soft delete keeps the row alive for its dependents: `addresses`
 * (FK ON DELETE CASCADE). Orders snapshot the buyer and
 * are linked by a soft (non-FK) user reference, so they're unaffected either
 * way. The purge-and-relaunch reuses this — "all customers" = all profiles
 * archived (not hard-wiped), which is enough for a clean demo.
 */
export async function cleanCustomers(ctx: SegmentCtx): Promise<void> {
  const profileIds = await customerService.listAllIds();
  for (const id of profileIds) {
    await customerService.softDeleteProfile(id);
    ctx.result.deleted += 1;
  }
}
