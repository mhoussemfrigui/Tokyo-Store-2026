import type { CategoryTreeNode } from "@/modules/catalog/category";
import type { ProductFormCategoryNode } from "@/components/admin/product-form";

/**
 * Project the full recursive catalog tree (`CategoryTreeNode`, ANY depth) down to
 * the {id, name, children} shape the product-form drill-down picker + the Produits
 * list filter consume. Single source for the Produits list / create / edit pages —
 * each used to carry a byte-for-byte copy of this type + projector. Returns
 * `ProductFormCategoryNode[]`, the exact picker prop shape (so the local type
 * redeclaration the pages used to carry is redundant too).
 *
 * Lives in this NEUTRAL module (no "use client" / no "server-only") because all
 * three callers are Server Components: a function exported from the client-boundary
 * `product-form.tsx` cannot be CALLED server-side (it would surface as a client
 * reference). The `ProductFormCategoryNode` import is type-only, so nothing from
 * the client module is bundled here.
 */
export function toCategoryPickerTree(nodes: CategoryTreeNode[]): ProductFormCategoryNode[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    children: toCategoryPickerTree(n.children),
  }));
}
