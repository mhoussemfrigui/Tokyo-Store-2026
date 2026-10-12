import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { brandQueries } from "@/modules/catalog/brand";
import { categoryQueries } from "@/modules/catalog/category";
import { attributeQueries } from "@/modules/catalog/attribute";
import { getSeoConfig } from "@/lib/seo/config";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ProductForm } from "@/components/admin/product-form";
import { toCategoryPickerTree } from "@/lib/catalog/category-picker-tree";
import { loadCarePlanOptions } from "@/lib/care/product-form-data";
import { requirePermission } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Nouveau produit" };

// Creation needs the freshest catalog reference data (brands / categories /
// attributes can change between requests), and there is nothing to cache —
// render dynamically so a just-added brand/category shows up immediately.
export const dynamic = "force-dynamic";

/**
 * Dedicated product-CREATION page — hosts the assisted, stepped wizard
 * (Phase 2 of the Produits overhaul). Gated on `products:create` — the same
 * grant the submit action requires — so a view-only operator is refused up
 * front instead of filling the whole wizard and losing it to a 404 on submit.
 * Like every admin page it MUST call its own `requirePermission`: the admin
 * layout only checks admin-area access (any grant) and isolates no module.
 *
 * Loads ONLY what create needs — brands, the category tree (same shape the
 * list / edit pages pass to `ProductForm`), and attributes. The edit-only
 * data (product snapshot, FAQs, variants, promotions) is skipped:
 * the wizard hides the sub-editors that depend on a saved id. On a
 * successful create, `ProductForm` routes to the new product's edit page so
 * the operator can add variants / FAQ next.
 */
export default async function NewProductPage() {
  await requirePermission("products", "create");
  const [brands, categories, attributes, seo, carePlans] = await Promise.all([
    brandQueries.listAllBrands(),
    categoryQueries.getCategoryTree(),
    attributeQueries.listAttributesWithValues(),
    getSeoConfig().catch(() => null),
    loadCarePlanOptions(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/products"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux produits
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="Nouveau produit"
            description="Suivez les étapes pour créer le produit. Variantes, FAQ et promotions ciblées s'ajoutent ensuite, après la première sauvegarde."
          />
        </div>
      </div>

      <ProductForm
        mode="create"
        layout="wizard"
        brands={brands.map((b) => ({ id: b.id, name: b.name, slug: b.slug, isActive: b.is_active }))}
        categories={toCategoryPickerTree(categories)}
        attributes={attributes
          .filter((a) => a.is_active)
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
        carePlans={carePlans}
        successHref="/admin/catalog/products"
        sameAsEnabled={seo?.productSameAsEnabled ?? false}
      />
    </div>
  );
}
