import type { Metadata } from "next";

import { reviewService, getReviewConfig } from "@/modules/catalog/review";
import { STATUS_FILTERS, SOURCE_FILTERS } from "@/modules/catalog/review/filters";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { ReviewsModerationPanel } from "./reviews-panel";

export const metadata: Metadata = { title: "Avis" };

// Moderation list filtering is SERVER-side (not a client `.filter()` over a
// capped page) so the actionable queue can't be starved: querying e.g.
// status=pending returns the newest *pending* rows, not the newest of all
// statuses (which a flood of approved/AI reviews would otherwise crowd out).
// The list is PAGED (?page=N, PAGE_SIZE rows) and filterable by product name
// (?q=) so every review stays reachable — a single capped read used to hide
// everything past the newest 300 while the badges showed the full counts.
// STATUS_FILTERS / SOURCE_FILTERS are single-sourced in the review module so
// this server-side parsing can't drift from the panel's chips (see filters.ts).
const PAGE_SIZE = 100;
const MAX_QUERY = 100;

export default async function AdminReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; source?: string; q?: string; page?: string }>;
}) {
  const session = await requirePermission("reviews", "view");
  const sp = await searchParams;
  const activeStatus = (STATUS_FILTERS as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as (typeof STATUS_FILTERS)[number])
    : "pending"; // default view = the moderation queue
  const activeSource = (SOURCE_FILTERS as readonly string[]).includes(sp.source ?? "")
    ? (sp.source as (typeof SOURCE_FILTERS)[number])
    : "all";
  const activeQuery = (sp.q ?? "").trim().slice(0, MAX_QUERY);
  const filter = {
    status: activeStatus === "all" ? undefined : activeStatus,
    source: activeSource === "all" ? undefined : activeSource,
    q: activeQuery || undefined,
  };

  const [total, matrix, config, perms] = await Promise.all([
    reviewService.countForAdmin(filter),
    // Full status × source matrix in a single grouped scan — the panel folds it
    // into facet-scoped status/source badges (and the FakesCard source totals).
    reviewService.statusSourceMatrix(),
    getReviewConfig(),
    resolveUserPermissions(session.user.id),
  ]);

  // Per-action RBAC — the server enforces each (see lib/actions/reviews.ts); these
  // gate the matching CONTROLS so a view-only moderator sees them disabled rather
  // than clicking into a 403.
  const canModerate = permissionSetAllows(perms, "reviews", "manage");
  const perm = {
    moderate: canModerate,
    create: permissionSetAllows(perms, "reviews", "create"),
    delete: permissionSetAllows(perms, "reviews", "delete"),
    updateSettings: permissionSetAllows(perms, "reviews", "update"),
  };

  // Clamp ?page to the last page (e.g. a bookmarked page emptied by deletions).
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requested = Math.trunc(Number(sp.page) || 1);
  const page = Math.min(Math.max(requested, 1), pageCount);
  const rows = await reviewService.listForAdmin({
    ...filter,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const reviews = rows.map(({ review, productName, productSlug, productDeleted, productPublished }) => ({
    id: review.id,
    productName: productName ?? "—",
    productSlug: productSlug ?? null,
    // A review can outlive its product's visibility (soft-deleted or
    // unpublished since) — flagged so the row doesn't link to a 404.
    productState: productDeleted ? ("deleted" as const) : productPublished ? ("live" as const) : ("draft" as const),
    authorName: review.author_name,
    rating: review.rating,
    title: review.title,
    body: review.body,
    status: review.status,
    source: review.source,
    verifiedPurchase: review.verified_purchase,
    createdAt: review.created_at.toISOString(),
  }));

  return (
    <ReviewsModerationPanel
      reviews={reviews}
      activeStatus={activeStatus}
      activeSource={activeSource}
      activeQuery={activeQuery}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      matrix={matrix}
      perm={perm}
      config={config}
    />
  );
}
