import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { segmentService } from "@/modules/customer/segment.service";
import { segmentStats } from "@/lib/promotions/segment-stats";
import { SegmentsPanel, type SegmentView } from "./segments-panel";

export const metadata: Metadata = { title: "Segments clients — Marketing" };
// Segments + members are admin-live; never statically cache this surface.
export const dynamic = "force-dynamic";

export default async function SegmentsAdminPage() {
  const session = await requirePermission("promotions", "view");
  // The per-segment CSV export is the same bulk customer-PII surface as the Clients
  // export → gated on `customers:export`. Hide the control for an admin without it so
  // it can't 404 (the route enforces the grant).
  const canExport = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "customers",
    "export",
  );

  const segments = await segmentService.list({ includeDisabled: true });

  // Resolve manual rosters + live stats in parallel (dynamic segments have no member
  // rows; their stats — and count — come from the shared SQL compiler). Stats never
  // fail the page: a broken segment renders without its card.
  const [rosters, stats] = await Promise.all([
    Promise.all(
      segments.map((s) =>
        s.kind === "manual" ? segmentService.listMembers(s.id) : Promise.resolve([]),
      ),
    ),
    Promise.all(segments.map((s) => segmentStats(s).catch(() => null))),
  ]);

  const views: SegmentView[] = segments.map((s, i) => {
    const members = rosters[i];
    const st = stats[i];
    return {
      id: s.id,
      name: s.name,
      kind: s.kind === "dynamic" ? "dynamic" : "manual",
      rule: s.rule,
      ruleTree: s.rule_tree ?? null,
      enabled: s.enabled,
      memberCount: s.kind === "manual" ? members.length : st?.total ?? null,
      members,
      stats: st
        ? {
            total: st.total,
            optedIn: st.optedIn,
            female: st.female,
            male: st.male,
            otherGender: st.otherGender,
            genderUnset: st.genderUnset,
          }
        : null,
    };
  });

  return (
    <div className="space-y-6">
      <SegmentsPanel
        segments={views}
        canExport={canExport}
        title="Segments clients"
        description="Regroupements de clients réutilisables qu'une promotion ou un mailing peut cibler. Un segment MANUEL contient une liste explicite de clients ; un segment DYNAMIQUE s'évalue à la volée selon une règle composée (ET / OU / NON) — commandes, panier, démographie, anniversaires…"
      />
    </div>
  );
}
