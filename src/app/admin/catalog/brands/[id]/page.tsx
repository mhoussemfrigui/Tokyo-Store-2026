import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { brandService } from "@/modules/catalog/brand/service";
import { faqService } from "@/modules/cms/faq/service";
import { BrandForm } from "@/components/admin/brand-form";
import { requirePermission } from "@/lib/auth/session";
import { isUuid } from "@/lib/utils/uuid";

export const metadata: Metadata = { title: "Modifier la marque" };

export default async function BrandEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Gate on "update" (the grant the save action requires), not just "view", so a
  // view-only operator doesn't fill the whole form before the save 404s (mirrors
  // the category edit page). The list panel hides the edit link for non-update
  // roles so this URL isn't reachable through the UI.
  await requirePermission("brands", "update");
  if (!isUuid(id)) notFound();
  const brand = await brandService.findById(id);
  if (!brand) notFound();

  const brandFaqs = await faqService.listForAdminBrand(id);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/brands"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux marques
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">
          {brand.name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">/{brand.slug}</p>
      </div>

      <BrandForm
        mode="edit"
        successHref="/admin/catalog/brands"
        initialFaqs={brandFaqs.map((f) => ({
          question: f.question,
          answer: f.answer,
          displayOrder: f.display_order,
          isPublished: f.is_published,
        }))}
        initial={{
          id: brand.id,
          slug: brand.slug,
          name: brand.name,
          description: brand.description,
          externalRef: brand.external_ref,
          logoMediaId: brand.logo_media_id,
          icon: brand.icon,
          iconMediaId: brand.icon_media_id,
          isActive: brand.is_active,
          isDiscountable: brand.is_discountable,
          displayOrder: brand.display_order,
          heroMediaId: brand.hero_media_id,
          tagline: brand.tagline,
          editorialEyebrow: brand.editorial_eyebrow,
          editorialTitle: brand.editorial_title,
          editorialBody: brand.editorial_body,
          valueProps: brand.value_props ?? null,
          metaTitle: brand.meta_title,
          metaDescription: brand.meta_description,
          canonicalUrl: brand.canonical_url,
          noindex: brand.noindex,
          ogImageMediaId: brand.og_image_media_id,
        }}
      />
    </div>
  );
}
