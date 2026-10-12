import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { categoryQueries } from "@/modules/catalog/category";
import { attributeQueries } from "@/modules/catalog/attribute";
import { CategoryForm } from "@/components/admin/category-form";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import type { CategoryTreeNode } from "@/modules/catalog/category";

export const metadata: Metadata = { title: "Nouvelle catégorie" };

// Freshest reference data; nothing to cache — a just-added parent must appear.
export const dynamic = "force-dynamic";

/** Flatten the whole tree into selectable parents, each labelled with its full
 *  ancestor path (root → child → …). All categories are valid parents on create. */
function flattenParents(nodes: CategoryTreeNode[], prefix = ""): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const n of nodes) {
    const label = prefix ? `${prefix} › ${n.name}` : n.name;
    out.push({ id: n.id, name: label });
    if (n.children.length > 0) out.push(...flattenParents(n.children, label));
  }
  return out;
}

export default async function NewCategoryPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string }>;
}) {
  const sp = await searchParams;
  // Gated on `categories:create` (the grant the submit action requires). Like
  // every admin page it MUST call its own `requirePermission`: the admin layout
  // only checks admin-area access (any grant) and isolates no module.
  const session = await requirePermission("categories", "create");
  // The inline "Nouvel attribut" creator's action needs attributes:create — gate
  // its visibility so a categories-only operator doesn't get a 404 on submit.
  const canCreateAttribute = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "attributes",
    "create",
  );
  const [tree, attributes] = await Promise.all([
    categoryQueries.getCategoryTree(),
    attributeQueries.listAttributes(),
  ]);

  const parents = flattenParents(tree);
  // Pre-select the parent only when the query id is a real, live category.
  const defaultParentId =
    sp.parent && parents.some((p) => p.id === sp.parent) ? sp.parent : null;

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
          Nouvelle catégorie
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Renseignez l&apos;identité et le contenu. La FAQ et les filtres avancés se complètent
          ensuite, après la première sauvegarde.
        </p>
      </div>

      <CategoryForm
        mode="create"
        parents={parents}
        defaultParentId={defaultParentId}
        attributes={attributes.map((a) => ({ id: a.id, name: a.name, slug: a.slug }))}
        canCreateAttribute={canCreateAttribute}
        successHref="/admin/catalog/categories"
      />
    </div>
  );
}
