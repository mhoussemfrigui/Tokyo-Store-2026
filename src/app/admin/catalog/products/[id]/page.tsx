import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ExternalLink, Eye } from "lucide-react";

import { productService } from "@/modules/catalog/product/service";
import { productQueries } from "@/modules/catalog/product";
import { brandQueries } from "@/modules/catalog/brand";
import { categoryQueries } from "@/modules/catalog/category";
import { categoryWarrantyFromChain, getDefaultWarranty, resolveWarranty } from "@/lib/warranty";
import { loadCategoryChains } from "@/lib/catalog/category-chain";
import { attributeQueries, attributeService } from "@/modules/catalog/attribute";
import { faqService } from "@/modules/cms/faq/service";
import { promotionService } from "@/modules/promotion";
import { getSeoConfig } from "@/lib/seo/config";
import {
  productBrandLink,
  productCategoryLinks,
  productMediaLink,
  productRelatedLinks,
  productComplementaryLinks,
} from "@/associations/catalog.service";
import { resolveRelatedProductOptionsAction } from "@/lib/actions/related-products";
import { ProductForm } from "@/components/admin/product-form";
import { toCategoryPickerTree } from "@/lib/catalog/category-picker-tree";
import { loadCarePlanOptions, loadProductCareLinks } from "@/lib/care/product-form-data";
import { scopeOfferedPlanIdsForCategories } from "@/lib/care/scope";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { isUuid } from "@/lib/utils/uuid";

export const metadata: Metadata = { title: "Modifier le produit" };

export default async function ProductEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requirePermission("products", "view");
  // Resolve promotion permissions to GATE the inline "Promotions sur ce produit"
  // panel: the create/toggle/delete actions each requirePermission and notFound()
  // on deny, which would replace the product editor with the 404 boundary — so a
  // view-only operator must not see controls it can't use.
  const promoPerms = await resolveUserPermissions(session.user.id);
  const promoCan = {
    // view gates the LISTING itself — the rows expose secret coupon codes + shareable
    // /promo URLs, which the promotions module withholds from a non-viewer (its page
    // requirePermission('promotions','view')s), so a products-only operator must not
    // read them here either.
    view: permissionSetAllows(promoPerms, "promotions", "view"),
    create: permissionSetAllows(promoPerms, "promotions", "create"),
    update: permissionSetAllows(promoPerms, "promotions", "update"),
    delete: permissionSetAllows(promoPerms, "promotions", "delete"),
  };
  // Creation lives at the static /admin/catalog/products/new route (the
  // assisted wizard), which takes precedence over this dynamic segment.
  // Any other non-UUID segment (typos, /create) lands here; 404 cleanly.
  if (!isUuid(id)) notFound();
  const product = await productService.findById(id);
  if (!product) notFound();

  const [
    brands,
    categories,
    links,
    brandId,
    mediaLinks,
    attributes,
    productValueIds,
    productScalars,
    productFaqs,
    productPromotions,
    productVariants,
    relatedIds,
    complementaryIds,
  ] = await Promise.all([
    brandQueries.listAllBrands(),
    categoryQueries.getCategoryTree(),
    productCategoryLinks.listForProduct(product.id),
    productBrandLink.findBrandId(product.id),
    productMediaLink.list(product.id),
    attributeQueries.listAttributesWithValues(),
    attributeService.listValueIdsForProduct(product.id),
    attributeService.getScalarsForProduct(product.id),
    faqService.listForAdminProduct(product.id),
    // Promotions targeting this product (scope='product', scope_id=product.id).
    // Drives the sidecar panel below the product form.
    promotionService.listForProductScope(product.id),
    productQueries.listVariantsForProduct(product.id),
    productRelatedLinks.listForProduct(product.id),
    productComplementaryLinks.listForProduct(product.id),
  ]);

  const categoryIds = links.map((l) => l.category_id);
  const primaryCategoryId =
    links.find((l) => l.is_primary)?.category_id ?? null;
  const mediaIds = mediaLinks.map((m) => m.media_id);
  // Per-product scalars (number/text) keyed by attribute id for the picker.
  const initialScalars: Record<string, { numericValue: number | null; textValue: string | null }> = {};
  for (const s of productScalars) {
    initialScalars[s.attribute_id] = {
      numericValue: s.numeric_value != null ? Number(s.numeric_value) : null,
      textValue: s.text_value ?? null,
    };
  }
  // Hydrate the curated "Vous aimerez aussi" list (manual/ai modes) into cards.
  const relatedProducts =
    relatedIds.length > 0 ? await resolveRelatedProductOptionsAction(relatedIds) : [];
  // Hydrate the curated "Accessoires supplémentaires" list (manual-only) into
  // cards — reuse the SAME id→card resolver as the related picker.
  const complementaryProducts =
    complementaryIds.length > 0 ? await resolveRelatedProductOptionsAction(complementaryIds) : [];

  // Tokyo Care — the active plans the operator can force on/off, this product's
  // stored overrides, and which plans its categories already offer (the "Auto" hint).
  const [carePlans, careLinks, careScopeOfferedIds] = await Promise.all([
    loadCarePlanOptions(),
    loadProductCareLinks(product.id),
    scopeOfferedPlanIdsForCategories(categoryIds),
  ]);

  // What this product inherits when its own warranty override is blank —
  // resolve the cascade with an empty product level (the primary category's
  // full ancestor chain child → root, then global). Shown as a hint in the form
  // so the operator sees the fallback without leaving the page. Same precedence
  // as the storefront mapper (@/lib/api/products) so the hint never disagrees
  // with the PDP.
  const [globalWarranty, primaryCatChains, seo] = await Promise.all([
    getDefaultWarranty(),
    primaryCategoryId ? loadCategoryChains([primaryCategoryId]) : Promise.resolve(null),
    getSeoConfig().catch(() => null),
  ]);
  const inheritedWarranty = resolveWarranty(
    { months: null, label: null },
    categoryWarrantyFromChain(primaryCategoryId ? primaryCatChains?.get(primaryCategoryId) : null),
    globalWarranty,
  );
  const warrantyInheritedLabel = inheritedWarranty.display
    ? `${inheritedWarranty.display} (${inheritedWarranty.source === "category" ? "catégorie" : "réglage global"})`
    : "Aucune garantie (réglage global)";

  // Variant attribute-combos load after we know the variant ids; shape into
  // the editor's `InitialVariant[]`.
  const variantValueLinks = await productQueries.listVariantValueLinks(
    productVariants.map((v) => v.id),
  );
  const initialVariants = productVariants.map((v) => ({
    id: v.id,
    sku: v.sku,
    gtin: v.gtin,
    mpn: v.mpn,
    // The stored label — the source of truth for a MANUAL (attribute-free)
    // variant; for attribute variants it's re-derived from the combo on save.
    label: v.label,
    priceCents: v.price_cents,
    oldPriceCents: v.old_price_cents,
    stockQty: v.stock_qty,
    inStock: v.in_stock,
    isDefault: v.is_default,
    imageMediaId: v.image_media_id,
    attributeValueIds: variantValueLinks.get(v.id) ?? [],
  }));
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/products"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux produits
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold text-foreground sm:text-3xl">
              {product.name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              /{product.slug} · créé le {product.created_at.toLocaleDateString("fr-FR")}
            </p>
          </div>
          {/* View (published) / Preview (draft) — opens the storefront PDP in a
              new tab. Drafts are admin-only previews (the storefront 404s them
              for everyone else), so the label + amber styling flag the state. */}
          <a
            href={`/${product.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition ${
              product.is_published
                ? "border-border bg-card text-foreground hover:bg-surface"
                : "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309] hover:bg-[#ffedcc] dark:text-amber-300"
            }`}
          >
            {product.is_published ? (
              <>
                <ExternalLink className="h-4 w-4" /> Voir le produit
              </>
            ) : (
              <>
                <Eye className="h-4 w-4" /> Aperçu
              </>
            )}
          </a>
        </div>
      </div>

      <ProductForm
        mode="edit"
        sameAsEnabled={seo?.productSameAsEnabled ?? false}
        brands={brands.map((b) => ({ id: b.id, name: b.name, slug: b.slug, isActive: b.is_active }))}
        categories={toCategoryPickerTree(categories)}
        attributes={attributes
          // Hide DEACTIVATED attributes (the storefront ignores them) so they
          // can't be newly assigned — but KEEP any the product still uses, so
          // existing selections + variant axes + per-product scalars stay
          // visible and manageable (a number/text attr has no values to match,
          // so check its scalar too).
          .filter(
            (a) =>
              a.is_active ||
              a.values.some((v) => productValueIds.includes(v.id)) ||
              ((a.kind === "number" || a.kind === "text") && initialScalars[a.id] != null),
          )
          .map((a) => ({
            id: a.id,
            slug: a.slug,
            name: a.name,
            kind: a.kind,
            values: a.values.map((v) => ({
              id: v.id,
              slug: v.slug,
              label: v.label,
              colorHex: v.color_hex,
            })),
          }))}
        productValueIds={productValueIds}
        initialScalars={initialScalars}
        initialVariants={initialVariants}
        carePlans={carePlans}
        careScopeOfferedIds={careScopeOfferedIds}
        initialFaqs={productFaqs.map((f) => ({
          question: f.question,
          answer: f.answer,
          displayOrder: f.display_order,
          isPublished: f.is_published,
        }))}
        initialPromotions={
          promoCan.view
            ? productPromotions.map((p) => ({
                id: p.id,
                name: p.name,
                triggerKind: p.trigger_kind,
                code: p.code,
                urlSlug: p.url_slug,
                discountType: p.discount_type,
                discountValue: p.discount_value,
                startsAt: p.starts_at?.toISOString() ?? null,
                endsAt: p.ends_at?.toISOString() ?? null,
                isActive: p.is_active,
                usesCount: p.uses_count,
                maxUses: p.max_uses,
              }))
            : []
        }
        promoCanCreate={promoCan.create}
        promoCanUpdate={promoCan.update}
        promoCanDelete={promoCan.delete}
        initial={{
          id: product.id,
          slug: product.slug,
          name: product.name,
          platform: product.platform,
          sku: product.sku,
          shortDesc: product.short_desc,
          description: product.description,
          highlights: product.highlights ?? [],
          priceCents: product.price_cents,
          oldPriceCents: product.old_price_cents,
          inStock: product.in_stock,
          stockQty: product.stock_qty,
          minPurchaseQty: product.min_purchase_qty,
          maxPurchaseQty: product.max_purchase_qty,
          videoUrl: product.video_url,
          videoPosterMediaId: product.video_poster_media_id,
          videoTitle: product.video_title,
          videoDescription: product.video_description,
          displayOrder: product.display_order,
          isPublished: product.is_published,
          isDiscountable: product.is_discountable,
          mediaIds,
          categoryIds,
          primaryCategoryId,
          brandId,
          gtin: product.gtin,
          mpn: product.mpn,
          condition: product.condition,
          externalRef: product.external_ref,
          warrantyMonths: product.warranty_months,
          warrantyLabel: product.warranty_label,
          taxRateBps: product.tax_rate_bps,
          warrantyInheritedLabel,
          productType: product.product_type,
          sharedVariantStock: product.shared_variant_stock,
          metaTitle: product.meta_title,
          metaDescription: product.meta_description,
          canonicalUrl: product.canonical_url,
          noindex: product.noindex,
          ogImageMediaId: product.og_image_media_id,
          sameAs: product.same_as,
          relatedMode: product.related_mode,
          relatedProducts,
          complementaryProducts,
          careLinks,
        }}
        successHref="/admin/catalog/products"
      />
    </div>
  );
}
