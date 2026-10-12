import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import {
  countSubscribers,
  listSubscribers,
  subscriberStatusCounts,
  type SubscriberStatusFilter,
} from "@/modules/newsletter/queries";
import { NewsletterPanel } from "./newsletter-panel";

export const metadata: Metadata = { title: "Newsletter" };

const PAGE_SIZE = 50;

/**
 * Stat cards, tabs, search and pagination all run in SQL over the WHOLE list
 * (the panel used to derive them from the newest 500 rows, so every number and
 * the CSV silently capped at 500). The CSV comes from the streamed
 * /api/admin/newsletter/export route with the same filters.
 */
export default async function NewsletterAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const session = await requirePermission("newsletter", "view");
  const sp = await searchParams;
  const status: SubscriberStatusFilter =
    sp.status === "all" || sp.status === "inactive" ? sp.status : "active";
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const page = Math.max(1, Math.floor(Number(sp.page ?? "1")) || 1);

  const [rows, total, counts, perms] = await Promise.all([
    listSubscribers({ status, q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countSubscribers({ status, q }),
    subscriberStatusCounts(),
    resolveUserPermissions(session.user.id),
  ]);
  const canManage = permissionSetAllows(perms, "newsletter", "manage");
  const canExport = permissionSetAllows(perms, "newsletter", "export");
  return (
    <NewsletterPanel
      canManage={canManage}
      canExport={canExport}
      counts={counts}
      filters={{ status, q: q ?? "" }}
      pagination={{ page, pageSize: PAGE_SIZE, total }}
      subscribers={rows.map((r) => ({
        id: r.id,
        email: r.email,
        source: r.source,
        isActive: r.is_active,
        createdAt: r.created_at.toISOString(),
        unsubscribedAt: r.unsubscribed_at?.toISOString() ?? null,
      }))}
    />
  );
}
