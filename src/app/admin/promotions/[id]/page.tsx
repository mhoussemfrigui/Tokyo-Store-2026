import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";

import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions, permissionSetAllows } from "@/lib/rbac/authorize";
import { db } from "@/lib/db/client";
import { promotionService } from "@/modules/promotion";
import { AnnounceNowButton } from "../announce-now-button";
import { orders } from "@/modules/order/schema";
import { authService } from "@/modules/auth/service";
import { segmentService } from "@/modules/customer/segment.service";
import { customerUserLink } from "@/associations/customer-user.service";
import { isUuid } from "@/lib/utils/uuid";
import { formatCents } from "@/lib/price";
import { formatStoreDateTime } from "@/lib/time/store-tz";
import { PromotionForm } from "../promotion-form";
import { loadPromotionScopeChoices } from "../scope-choices";

export const metadata: Metadata = { title: "Éditer la promotion" };
export const dynamic = "force-dynamic";

export default async function EditPromotionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requirePermission("promotions", "view");
  if (!isUuid(id)) notFound();

  const promo = await promotionService.findById(id);
  if (!promo) notFound();

  // promotions:update gates the manual « Annoncer maintenant » action.
  const perms = await resolveUserPermissions(session.user.id);
  const canManage = permissionSetAllows(perms, "promotions", "update");
  // Live now? (the announce button + immediate announce need a live promo.)
  const nowMs = Date.now();
  const isLive =
    promo.is_active &&
    !promo.deleted_at &&
    !(promo.starts_at && promo.starts_at.getTime() > nowMs) &&
    !(promo.ends_at && promo.ends_at.getTime() <= nowMs);

  // MULTI-target (scope='targeted') product set — loaded up front so the scope-
  // choice lists can guarantee every selected entity is shown (even past the cap).
  const scopeTargetRows = await promotionService.listScopeTargets(id);
  const scopeTargets = scopeTargetRows.map((t) => ({
    targetType: t.target_type as "product" | "category" | "brand",
    targetId: t.target_id,
    // A product target may pin ONE variant (migration 0173) — carried so the edit
    // form re-checks the right variant and re-saving doesn't drop the constraint.
    variantId: t.target_type === "product" ? (t.variant_id ?? null) : null,
  }));

  const [scopeChoices, stats, redemptions, targets, allSegments] =
    await Promise.all([
      // Name-ordered, capped scope-target lists that ALWAYS include this
      // promotion's current target(s) (even past the cap / since archived).
      loadPromotionScopeChoices(
        { scope: promo.scope, id: promo.scope_id },
        {
          product: scopeTargets.filter((t) => t.targetType === "product").map((t) => t.targetId),
          category: scopeTargets.filter((t) => t.targetType === "category").map((t) => t.targetId),
          brand: scopeTargets.filter((t) => t.targetType === "brand").map((t) => t.targetId),
          productVariant: scopeTargets
            .filter((t) => t.targetType === "product" && t.variantId)
            .map((t) => `${t.targetId}:${t.variantId}`),
        },
      ),
      promotionService.statsForPromotion(id),
      promotionService.listRecentRedemptions(id, 50),
      promotionService.listTargets(id),
      segmentService.list({ includeDisabled: true }),
    ]);

  // Split the target rows back into the form's buckets. Customer targets hold
  // profile ids → reverse-resolve to the emails the form displays.
  const targetSegmentIds = targets.filter((t) => t.target_type === "segment").map((t) => t.target_id);
  const customerProfileIds = targets.filter((t) => t.target_type === "customer").map((t) => t.target_id);

  // Segment options: enabled segments PLUS any already-targeted (even if since
  // disabled) so a routine edit-save doesn't silently drop a disabled-segment
  // target (the form only submits ids that render as checkboxes).
  const segmentRows = allSegments
    .filter((s) => s.enabled || targetSegmentIds.includes(s.id))
    .map((s) => ({ id: s.id, name: s.name }));

  let targetCustomerEmails: string[] = [];
  if (customerProfileIds.length > 0) {
    const profileToUser = await customerUserLink.findByProfileIds(customerProfileIds);
    const userIdList = [...profileToUser.values()];
    const userById = userIdList.length
      ? await authService.findUsersByIds(userIdList)
      : new Map<string, { email: string }>();
    targetCustomerEmails = customerProfileIds
      .map((pid) => {
        const uid = profileToUser.get(pid);
        return uid ? userById.get(uid)?.email ?? null : null;
      })
      .filter((e): e is string => !!e);
  }

  // Resolve order numbers + client emails for the redemption detail table.
  // Cross-module lookups happen HERE (the page), keeping the promotion module
  // free of order/auth imports.
  const orderIds = [...new Set(redemptions.map((r) => r.order_id))];
  const userIds = [...new Set(redemptions.map((r) => r.user_id).filter((v): v is string => !!v))];
  const [orderRows, emailById] = await Promise.all([
    orderIds.length
      ? db
          .select({ id: orders.id, order_number: orders.order_number })
          .from(orders)
          .where(inArray(orders.id, orderIds))
      : Promise.resolve([] as { id: string; order_number: string }[]),
    userIds.length
      ? authService.findUsersByIds(userIds)
      : Promise.resolve(new Map<string, { email: string }>()),
  ]);
  const orderNumById = new Map(orderRows.map((o) => [o.id, o.order_number]));
  // Shop time (Africa/Tunis), not the container's UTC runtime zone.
  const dateFmt = (d: Date) => formatStoreDateTime(d);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-[-0.02em] text-foreground sm:text-3xl">
            {promo.name}
          </h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
            {stats.redemptions > 0
              ? `${stats.redemptions} utilisations · ${formatCents(stats.revenue_impact_cents)} de réductions accordées`
              : "Aucune utilisation enregistrée pour l'instant."}
          </p>
        </div>
        {canManage && isLive && (
          <AnnounceNowButton promotionId={promo.id} alreadyAnnounced={promo.announced_at != null} />
        )}
      </header>

      <PromotionForm
        mode="edit"
        initial={{
          id: promo.id,
          name: promo.name,
          targetSegmentIds,
          targetCustomerEmails,
          triggerKind: promo.trigger_kind,
          code: promo.code,
          urlSlug: promo.url_slug,
          scope: promo.scope,
          scopeId: promo.scope_id,
          scopeTargets,
          discountType: promo.discount_type,
          discountValue: promo.discount_value,
          maxDiscountCents: promo.max_discount_cents,
          minCartCents: promo.min_cart_cents,
          maxCartCents: promo.max_cart_cents,
          maxUses: promo.max_uses,
          maxUsesPerUser: promo.max_uses_per_user,
          startsAt: promo.starts_at?.toISOString() ?? null,
          endsAt: promo.ends_at?.toISOString() ?? null,
          announceAt: promo.announce_at?.toISOString() ?? null,
          announcedAt: promo.announced_at?.toISOString() ?? null,
          isActive: promo.is_active,
          isStackable: promo.is_stackable,
          excludeDiscountedItems: promo.exclude_discounted_items,
          grantsFreeShipping: promo.grants_free_shipping,
          firstOrderOnly: promo.first_order_only,
          audienceRuleTree: promo.audience_rule_tree ?? null,
          displayPriority: promo.display_priority,
        }}
        products={scopeChoices.products}
        categories={scopeChoices.categories}
        brands={scopeChoices.brands}
        productVariants={scopeChoices.productVariants}
        scopeTruncated={scopeChoices.truncated}
        segments={segmentRows}
        cancelHref="/admin/promotions"
      />

      {/* ─── Performance / utilisations détaillées ─────────────────────── */}
      <section className="rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Utilisations</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          Les 50 dernières utilisations. Une ligne négative correspond à une
          réduction annulée (remboursement / annulation de commande).
        </p>
        {redemptions.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Aucune utilisation enregistrée pour l&apos;instant.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[12px] uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="py-2 pr-3 font-semibold">Date</th>
                  <th className="py-2 pr-3 font-semibold">Client</th>
                  <th className="py-2 pr-3 font-semibold">Commande</th>
                  <th className="py-2 pr-3 font-semibold">Code</th>
                  <th className="py-2 pl-3 text-right font-semibold">Réduction</th>
                </tr>
              </thead>
              <tbody>
                {redemptions.map((r) => {
                  const num = orderNumById.get(r.order_id);
                  return (
                    <tr key={r.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3 text-muted-foreground">{dateFmt(r.created_at)}</td>
                      <td className="py-2 pr-3">
                        {r.user_id ? emailById.get(r.user_id)?.email ?? "—" : "Invité"}
                      </td>
                      <td className="py-2 pr-3">
                        {num ? (
                          <Link
                            href={`/admin/orders/${r.order_id}`}
                            className="text-primary hover:underline"
                          >
                            {num}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.code_used ?? "—"}</td>
                      <td
                        className={`py-2 pl-3 text-right font-medium ${
                          r.discount_cents < 0 ? "text-destructive" : ""
                        }`}
                      >
                        {formatCents(r.discount_cents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
