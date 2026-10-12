import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { categoryService } from "@/modules/catalog/category/service";
import { categoryQueries } from "@/modules/catalog/category";
import { attributeQueries, attributeService } from "@/modules/catalog/attribute";
import { faqService } from "@/modules/cms/faq/service";
import { CategoryForm } from "@/components/admin/category-form";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { isUuid } from "@/lib/utils/uuid";

export const metadata: Metadata = { title: "Modifier la catégorie" };

export default async function CategoryEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The edit form only saves via updateCategoryAction (categories:update), so
  // gate the page on "update" too — a view-only operator otherwise fills the
  // whole form before the save 404s (and logs a false permission-denied probe).
  // Mirrors new/page.tsx gating on "create"; the panel hides the edit control
  // for non-update roles so this URL isn't reachable through the UI.
  const session = await requirePermission("categories", "update");
  if (!isUuid(id)) notFound();
  const cat = await categoryService.findById(id);
  if (!cat) notFound();

  // The inline "Nouvel attribut" creator's action needs attributes:create — gate
  // its visibility so a categories-only operator doesn't get a 404 on submit.
  const canCreateAttribute = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "attributes",
    "create",
  );

  const [tree, attributes, currentFilterIds, categoryFaqs] = await Promise.all([
    categoryQueries.getCategoryTree(),
    attributeQueries.listAttributes(),
    attributeService.listCategoryFilters(id),
    faqService.listForAdminCategory(id),
  ]);
  // Flatten the WHOLE tree (every depth) into selectable parents, each labelled
  // with its full ancestor path. We exclude the node being edited AND its entire
  // descendant sub-tree: re-parenting a category under one of its own children
  // would create a `parent_id` cycle. `updateCategoryWorkflow` rejects that at
  // write time too (belt-and-braces), but pruning the options here means the UI
  // never offers an invalid parent in the first place.
  type TreeNode = (typeof tree)[number];
  const parents: { id: string; name: string }[] = [];
  const collectParents = (nodes: TreeNode[], prefix: string, insideSelfSubtree: boolean) => {
    for (const n of nodes) {
      const label = prefix ? `${prefix} › ${n.name}` : n.name;
      // `insideSelfSubtree` becomes true at the edited node and stays true for
      // everything beneath it, so the whole sub-tree (node + descendants) is
      // skipped as a candidate parent.
      const isSelfSubtree = insideSelfSubtree || n.id === id;
      if (!isSelfSubtree) parents.push({ id: n.id, name: label });
      if (n.children.length > 0) collectParents(n.children, label, isSelfSubtree);
    }
  };
  collectParents(tree, "", false);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/categories"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux catégories
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">
          {cat.name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">/{cat.slug}</p>
      </div>

      <CategoryForm
        mode="edit"
        parents={parents}
        canCreateAttribute={canCreateAttribute}
        attributes={attributes.map((a) => ({ id: a.id, name: a.name, slug: a.slug }))}
        filterAttributeIds={currentFilterIds}
        initialFaqs={categoryFaqs.map((f) => ({
          question: f.question,
          answer: f.answer,
          displayOrder: f.display_order,
          isPublished: f.is_published,
        }))}
        successHref="/admin/catalog/categories"
        initial={{
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          tagline: cat.tagline,
          description: cat.description,
          externalRef: cat.external_ref,
          heroMediaId: cat.hero_media_id,
          boutiqueImageMediaId: cat.boutique_image_media_id,
          icon: cat.icon,
          iconMediaId: cat.icon_media_id,
          parentId: cat.parent_id,
          displayOrder: cat.display_order,
          metaTitle: cat.meta_title,
          metaDescription: cat.meta_description,
          canonicalUrl: cat.canonical_url,
          noindex: cat.noindex,
          ogImageMediaId: cat.og_image_media_id,
          isActive: cat.is_active,
          isDiscountable: cat.is_discountable,
          warrantyMonths: cat.warranty_months,
          warrantyLabel: cat.warranty_label,
          taxRateBps: cat.tax_rate_bps,
          editorialEyebrow: cat.editorial_eyebrow,
          editorialTitle: cat.editorial_title,
          editorialBody: cat.editorial_body,
          valueProps: cat.value_props ?? null,
        }}
      />
    </div>
  );
}
