import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { careService } from "@/modules/catalog/care/service";
import { requirePermission } from "@/lib/auth/session";
import { minorToDinars } from "@/lib/price";
import { CareForm, type CareFormInitial } from "@/components/admin/care-form";
import { loadCareCategoryOptions } from "../_categories";

export const metadata: Metadata = { title: "Modifier le plan Tokyo Care" };

/** Millimes → a dinar string for the form; 0/empty stays blank so the placeholder shows. */
function dinarStr(cents: number): string {
  return cents > 0 ? String(minorToDinars(cents)) : "";
}

export default async function EditCarePlanPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("care", "update");
  const { id } = await params;

  const [plan, targets, categories] = await Promise.all([
    careService.findById(id),
    careService.getScopeTargets(id),
    loadCareCategoryOptions(),
  ]);
  if (!plan) notFound();

  const categoryTargets = targets.filter((t) => t.target_type === "category");
  const initial: CareFormInitial = {
    planId: plan.id,
    name: plan.name,
    slug: plan.slug,
    description: plan.description ?? "",
    durationMonths: plan.duration_months,
    pricingMode: plan.pricing_mode === "flat" ? "flat" : "percent",
    priceFlat: dinarStr(plan.price_cents),
    pricePercent: plan.price_bps > 0 ? String(plan.price_bps / 100) : "",
    priceRoundTo: dinarStr(plan.price_round_to_cents),
    minCharge: dinarStr(plan.min_charge_cents),
    minProductPrice: dinarStr(plan.min_product_price_cents),
    requireWarranty: plan.require_warranty,
    applicableConditions: Array.isArray(plan.applicable_conditions) ? plan.applicable_conditions : [],
    perksText: Array.isArray(plan.perks) ? plan.perks.join("\n") : "",
    icon: plan.icon ?? "",
    isActive: plan.is_active,
    displayPriority: plan.display_priority,
    scopeCategoryIds: categoryTargets.map((t) => t.target_id),
    scopeIncludeDescendants: categoryTargets[0]?.include_descendants ?? true,
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/care"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" aria-hidden /> Tokyo Care
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">{plan.name}</h1>
      </div>
      <CareForm mode="edit" categories={categories} initial={initial} />
    </div>
  );
}
