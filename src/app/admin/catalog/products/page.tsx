import type { Metadata } from "next";

import { productService } from "@/modules/catalog/product/service";
import { categoryQueries } from "@/modules/catalog/category";
import { attributeQueries } from "@/modules/catalog/attribute";
import { productCategoryLinks, productMediaLink } from "@/associations/catalog.service";
import { findMediaByIds } from "@/modules/media/queries";
import { resolveMediaThumbUrl } from "@/modules/media/url-resolver";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { STORE_TIME_ZONE } from "@/lib/time/store-tz";

import { ProductsPanel } from "./products-panel";
import { ProductsWorkspace } from "./products-workspace";
import { ProductStatsPanel } from "./product-stats-panel";
import { toCategoryPickerTree } from "@/lib/catalog/category-picker-tree";

export const metadata: Metadata = { title: "Produits" };

/** « 12 sept. 2026 » in shop time (the list's « Supprimé le … » badge). */
const DELETED_AT_FMT = new Intl.DateTimeFormat("fr-FR", {
  timeZone: STORE_TIME_ZONE,
  dateStyle: "medium",
});

type ProductStatus = "draft" | "published" | "archived";

function parseStatus(v: string | undefined): ProductStatus | undefined {
  if (v === "draft" || v === "published" || v === "archived") return v;
  return undefined;
}

export default async function ProductsAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("products", "view");
  // Resolve per-action grants so the list renders read-only for a products:view-only
  // operator instead of mutating controls whose server action would 404 the whole
  // page (mirrors the stock / reviews / media sibling tabs). The actions re-check
  // server-side — this only hides controls the caller can't actually use.
  const perms = await resolveUserPermissions(session.user.id);
  const canCreate = permissionSetAllows(perms, "products", "create");
  const canUpdate = permissionSetAllows(perms, "products", "update");
  const canDelete = permissionSetAllows(perms, "products", "delete");
  // The bulk « Assigner attributs » control writes attribute assignments, gated on
  // attributes:update — an INDEPENDENT RBAC module, not products:update.
  const canBulkAttributes = permissionSetAllows(perms, "attributes", "update");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() || undefined : undefined;
  const categoryId = typeof sp.categoryId === "string" && sp.categoryId.length > 0
    ? sp.categoryId
    : undefined;
  const status = parseStatus(typeof sp.status === "string" ? sp.status : undefined);
  const page = Math.max(1, Number(sp.page) || 1);
  const pageSize = Math.min(Math.max(Number(sp.pageSize) || 25, 5), 100);

  // Scope by category via the link table — keeps the service free of M2M.
  // Roll up descendants: picking a parent category (e.g. "Montres Homme")
  // includes products filed only on its leaves (e.g. "Plongée").
  const productIds = categoryId
    ? await productCategoryLinks.listProductIdsInCategoryTree(categoryId)
    : null;

  const [{ items: products, total }, categories, attributes, stats] = await Promise.all([
    productService.listAdminPaged({ q, productIds, status, page, pageSize }),
    categoryQueries.getCategoryTree(),
    attributeQueries.listAttributesWithValues(),
    // Catalogue-wide statistics for the header pill + expandable breakdown.
    productService.getProductStats(),
  ]);

  // Resolve primary image thumbnails for the listing in one go (no N+1).
  const primaryMediaIds = await productMediaLink.primaryMediaIdsForProducts(
    products.map((p) => p.id),
  );
  const mediaMap = await findMediaByIds(Array.from(primaryMediaIds.values()));

  return (
    <ProductsWorkspace
      canCreate={canCreate}
      stats={<ProductStatsPanel stats={stats} />}
      list={
        <ProductsPanel
          canCreate={canCreate}
          canUpdate={canUpdate}
          canDelete={canDelete}
          canBulkAttributes={canBulkAttributes}
          products={products.map((p) => {
            const mid = primaryMediaIds.get(p.id);
            const m = mid ? mediaMap.get(mid) : null;
            return {
              id: p.id,
              slug: p.slug,
              name: p.name,
              priceCents: p.price_cents,
              currency: p.currency,
              inStock: p.in_stock,
              // Effective-availability pill (qty 0 ⇒ Indisponible). Simple products
              // only: a variable product's availability lives on its variants.
              stockQty: p.product_type === "simple" ? p.stock_qty : null,
              isPublished: p.is_published,
              primaryImageUrl: resolveMediaThumbUrl(m),
              createdAt: p.created_at.toISOString(),
              // Soft-deleted rows (the « Supprimé » filter) — formatted here, in the
              // STORE zone, so the client renders a stable label (no hydration drift).
              deletedAtLabel: p.deleted_at ? DELETED_AT_FMT.format(p.deleted_at) : null,
            };
          })}
          categories={toCategoryPickerTree(categories)}
          attributes={attributes.map((a) => ({
            id: a.id,
            slug: a.slug,
            name: a.name,
            kind: a.kind,
            values: a.values.map((v) => ({ id: v.id, slug: v.slug, label: v.label })),
          }))}
          filters={{ q: q ?? "", categoryId: categoryId ?? "", status: status ?? "" }}
          pagination={{ page, pageSize, total }}
        />
      }
    />
  );
}
