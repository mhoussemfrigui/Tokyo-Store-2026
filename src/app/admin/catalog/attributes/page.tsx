import type { Metadata } from "next";

import { attributeQueries } from "@/modules/catalog/attribute";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";

import { AttributesPanel } from "./attributes-panel";

export const metadata: Metadata = { title: "Attributs" };

export default async function AttributesAdminPage() {
  const session = await requirePermission("attributes", "view");
  const perms = await resolveUserPermissions(session.user.id);
  // Mutating controls: the server enforces these (lib/actions/attribute.ts); gate
  // the buttons so a view-only operator doesn't click into a 403. Edit/view links
  // stay (the detail page is itself view-gated; only its save needs update).
  const canCreate = permissionSetAllows(perms, "attributes", "create");
  const canDelete = permissionSetAllows(perms, "attributes", "delete");
  const attributes = await attributeQueries.listAttributesWithValues();

  return (
    <AttributesPanel
      attributes={attributes.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        kind: a.kind,
        displayOrder: a.display_order,
        isActive: a.is_active,
        valueCount: a.values.length,
      }))}
      canCreate={canCreate}
      canDelete={canDelete}
    />
  );
}
