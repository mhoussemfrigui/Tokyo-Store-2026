import type { Metadata } from "next";

import { categoryQueries } from "@/modules/catalog/category";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";

import { CategoriesPanel, type CategoryTreeNode } from "./categories-panel";

export const metadata: Metadata = { title: "Catégories" };

// The recursive node shape returned by getCategoryTree (DB row + children).
type DbTreeNode = Awaited<ReturnType<typeof categoryQueries.getCategoryTree>>[number];

export default async function CategoriesAdminPage() {
  const session = await requirePermission("categories", "view");
  // Resolve the viewer's grants ONCE, then derive every gate from it.
  const perms = await resolveUserPermissions(session.user.id);
  // Category CRUD gates → hide list controls whose server action would 404 for
  // a view-only operator (and stop logging false permission-denied probes).
  const canCreate = permissionSetAllows(perms, "categories", "create");
  const canUpdate = permissionSetAllows(perms, "categories", "update");
  const canDelete = permissionSetAllows(perms, "categories", "delete");
  const tree = await categoryQueries.getCategoryTree();

  // Project the DB tree into the panel's view model recursively, preserving
  // every level of nesting (root → child → grandchild → …). `reachable` tracks
  // storefront visibility down the chain: a node is reachable only when it AND
  // every ancestor is active (a category active under a deactivated parent 404s),
  // so the panel can hide its "Voir sur la boutique" link + flag it.
  const toNode = (n: DbTreeNode, parentReachable: boolean): CategoryTreeNode => {
    const reachable = parentReachable && n.is_active;
    return {
      id: n.id,
      slug: n.slug,
      name: n.name,
      tagline: n.tagline,
      isActive: n.is_active,
      displayOrder: n.display_order,
      reachable,
      children: n.children.map((c) => toNode(c, reachable)),
    };
  };
  // Roots have no ancestor, so their reachability is just their own is_active.
  const nodes = tree.map((n) => toNode(n, true));

  return (
    <CategoriesPanel
      tree={nodes}
      canCreate={canCreate}
      canUpdate={canUpdate}
      canDelete={canDelete}
    />
  );
}
