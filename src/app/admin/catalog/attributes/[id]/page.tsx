import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { attributeQueries } from "@/modules/catalog/attribute";
import { categoryQueries, type CategoryTreeNode } from "@/modules/catalog/category";
import { isUuid } from "@/lib/utils/uuid";
import { requirePermission } from "@/lib/auth/session";

import { AttributeDetailPanel } from "./attribute-detail-panel";

export const metadata: Metadata = { title: "Modifier l'attribut" };

/** Flatten the category tree to an ordered, depth-tagged list for the picker. */
function flattenTree(nodes: CategoryTreeNode[], depth = 0): { id: string; name: string; depth: number }[] {
  return nodes.flatMap((n) => [
    { id: n.id, name: n.name, depth },
    ...flattenTree(n.children, depth + 1),
  ]);
}

export default async function AttributeEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePermission("attributes", "view");
  if (!isUuid(id)) notFound();
  const [attribute, tree, selectedCategoryIds, usedByProducts] = await Promise.all([
    attributeQueries.getAttributeWithValues(id),
    categoryQueries.getCategoryTree(),
    attributeQueries.listCategoriesForAttribute(id),
    attributeQueries.listProductsUsingAttribute(id),
  ]);
  if (!attribute) notFound();
  const categories = flattenTree(tree);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/attributes"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux attributs
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">
          {attribute.name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">/{attribute.slug}</p>
      </div>

      <AttributeDetailPanel
        attribute={{
          id: attribute.id,
          slug: attribute.slug,
          name: attribute.name,
          kind: attribute.kind,
          displayOrder: attribute.display_order,
          isActive: attribute.is_active,
        }}
        values={attribute.values.map((v) => ({
          id: v.id,
          slug: v.slug,
          label: v.label,
          displayOrder: v.display_order,
          colorHex: v.color_hex,
        }))}
        categories={categories}
        selectedCategoryIds={selectedCategoryIds}
        usedByProducts={usedByProducts}
      />
    </div>
  );
}
