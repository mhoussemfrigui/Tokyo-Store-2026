import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { segmentService } from "@/modules/customer/segment.service";
import { isUuid } from "@/lib/utils/uuid";
import { PromotionForm } from "../promotion-form";
import { loadPromotionScopeChoices } from "../scope-choices";

export const metadata: Metadata = { title: "Nouvelle promotion" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  lockProduct?: string;
  lockCategory?: string;
  lockBrand?: string;
}>;

export default async function NewPromotionPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  await requirePermission("promotions", "create");
  const lockScope: { scope: "product" | "category" | "brand"; id: string } | undefined =
    sp.lockProduct && isUuid(sp.lockProduct)
      ? { scope: "product", id: sp.lockProduct }
      : sp.lockCategory && isUuid(sp.lockCategory)
        ? { scope: "category", id: sp.lockCategory }
        : sp.lockBrand && isUuid(sp.lockBrand)
          ? { scope: "brand", id: sp.lockBrand }
          : undefined;
  // Scope-target options for the (non-searchable) picker: name-ordered, capped
  // at 500 each with a truncation notice. A deep-linked (locked) target is
  // always included, even past the cap, so the locked picker shows its name.
  const scopeChoices = await loadPromotionScopeChoices(lockScope ?? null);
  // Segment targets — every live segment (empty = none defined → hidden).
  const segmentRows = (await segmentService.list()).map((s) => ({ id: s.id, name: s.name }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-black tracking-[-0.02em] text-foreground sm:text-3xl">
          Nouvelle promotion
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
          Configurez la cible, la mécanique de réduction, la fenêtre temporelle
          et les conditions. Tout est ré-éditable plus tard.
        </p>
      </header>

      <PromotionForm
        mode="create"
        products={scopeChoices.products}
        categories={scopeChoices.categories}
        brands={scopeChoices.brands}
        productVariants={scopeChoices.productVariants}
        scopeTruncated={scopeChoices.truncated}
        segments={segmentRows}
        cancelHref="/admin/promotions"
        // When the admin clicks "+ Nouvelle promotion" from a product/
        // category/brand admin page, that page deep-links with
        // `?lockProduct=<id>` (or `lockCategory`, `lockBrand`). The form
        // hides the scope selector and pre-fills the target so the
        // workflow can only land on that entity.
        lockScope={lockScope}
      />
    </div>
  );
}
