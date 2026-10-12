import type { Metadata } from "next";
import { inArray } from "drizzle-orm";

import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions, permissionSetAllows } from "@/lib/rbac/authorize";
import { promotionService } from "@/modules/promotion";
import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import { brands } from "@/modules/catalog/brand/schema";
import { PromotionsListPanel } from "./promotions-panel";

export const metadata: Metadata = { title: "Promotions" };
export const dynamic = "force-dynamic";

const TRIGGERS = ["auto", "code", "url"] as const;

export default async function PromotionsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; trigger?: string }>;
}) {
  const session = await requirePermission("promotions", "view");
  const sp = await searchParams;
  // Write actions (create/update/delete) gate the create button + row controls.
  const perms = await resolveUserPermissions(session.user.id);
  const canManage =
    permissionSetAllows(perms, "promotions", "create") ||
    permissionSetAllows(perms, "promotions", "update") ||
    permissionSetAllows(perms, "promotions", "delete");

  const q = sp.q?.trim() || undefined;
  const trigger = (TRIGGERS as readonly string[]).includes(sp.trigger ?? "")
    ? (sp.trigger as "auto" | "code" | "url")
    : undefined;
  const pageNum = Math.max(1, Number(sp.page) || 1);

  // SERVER-paginated + searchable (no more silent >500 drop / browser filter).
  const { items: rows, total, page, pageSize } = await promotionService.listPaged({
    page: pageNum,
    pageSize: 25,
    q,
    trigger,
  });

  const collectScopeIds = (scope: "product" | "category" | "brand"): string[] =>
    Array.from(
      new Set(
        rows
          .filter((r) => r.scope === scope && r.scope_id)
          .map((r) => r.scope_id!),
      ),
    );

  const productIds = collectScopeIds("product");
  const categoryIds = collectScopeIds("category");
  const brandIds = collectScopeIds("brand");

  // Batched lookups go direct to Drizzle — these are admin grids, no need
  // to add a `findByIds` to every service for one consumer.
  const [productRows, categoryRows, brandRows] = await Promise.all([
    productIds.length
      ? db
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(inArray(products.id, productIds))
      : Promise.resolve([] as { id: string; name: string }[]),
    categoryIds.length
      ? db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(inArray(categories.id, categoryIds))
      : Promise.resolve([] as { id: string; name: string }[]),
    brandIds.length
      ? db
          .select({ id: brands.id, name: brands.name })
          .from(brands)
          .where(inArray(brands.id, brandIds))
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  const labels = new Map<string, string>();
  for (const p of productRows) labels.set(p.id, p.name);
  for (const c of categoryRows) labels.set(c.id, c.name);
  for (const b of brandRows) labels.set(b.id, b.name);

  // Targeting reach per promo (0 = public; >0 = restricted to that many targets).
  const targetCounts = await promotionService.countTargetsForPromotions(rows.map((r) => r.id));
  // Multi-target product-set size per promo (for the « Ciblage multiple (N) » label).
  const scopeTargetsByPromo = await promotionService.listScopeTargetsForPromotions(
    rows.map((r) => r.id),
  );

  return (
    <PromotionsListPanel
      promotions={rows.map((r) => ({
        id: r.id,
        name: r.name,
        triggerKind: r.trigger_kind,
        code: r.code,
        urlSlug: r.url_slug,
        scope: r.scope,
        scopeId: r.scope_id,
        scopeLabel: r.scope_id ? labels.get(r.scope_id) ?? r.scope_id.slice(0, 8) : null,
        scopeTargetCount: scopeTargetsByPromo.get(r.id)?.length ?? 0,
        discountType: r.discount_type,
        discountValue: r.discount_value,
        minCartCents: r.min_cart_cents,
        startsAt: r.starts_at?.toISOString() ?? null,
        endsAt: r.ends_at?.toISOString() ?? null,
        isActive: r.is_active,
        isStackable: r.is_stackable,
        usesCount: r.uses_count,
        maxUses: r.max_uses,
        targetCount: targetCounts.get(r.id) ?? 0,
      }))}
      createHref="/admin/promotions/new"
      total={total}
      page={page}
      pageSize={pageSize}
      currentSearch={q ?? ""}
      currentTrigger={trigger ?? "all"}
      canManage={canManage}
    />
  );
}
