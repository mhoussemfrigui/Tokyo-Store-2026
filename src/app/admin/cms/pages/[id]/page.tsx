import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ExternalLink } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { pageService } from "@/modules/cms/page/service";
import { isUuid } from "@/lib/utils/uuid";
import { getEditBlocks } from "@/lib/pages/page-blocks-data";
import { listCategories } from "@/lib/api/categories";
import { deliveryService } from "@/modules/delivery";
import { listNavBrands } from "@/lib/api/brands";
import { PageMetaForm } from "./page-meta-form";
import { PageComposer } from "./page-composer";

export const metadata: Metadata = { title: "Éditer la page" };

export default async function PageBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePermission("pages", "view");
  if (!isUuid(id)) notFound();
  const page = await pageService.findById(id);
  if (!page) notFound();

  const [blocks, categories, brands, pickups] = await Promise.all([
    getEditBlocks(page),
    listCategories().catch(() => []),
    listNavBrands().catch(() => []),
    // In-store pickup points (Livraison) a « Boutiques » card can be linked to.
    deliveryService.listPickups({ includeDisabled: true, kind: "in_store" }).catch(() => []),
  ]);
  // Legacy = never saved in the composer (NULL column). A stored "[]" is an operator's
  // deliberate clear, not legacy content — don't show the « ancien contenu » banner then.
  const usingLegacy = page.blocks == null && blocks.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/cms/pages"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux pages
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-black text-foreground sm:text-3xl">
            {page.title}
          </h1>
          <Link
            href={`/${page.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-1.5 text-[13px] font-bold text-foreground hover:bg-surface"
          >
            Voir la page <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
        <p className="mt-1 text-[14px] text-muted-foreground">
          <code className="rounded-[6px] bg-surface px-1.5 py-0.5">/{page.slug}</code>
          {" · "}
          {page.is_published ? "publiée" : "brouillon"}
          {page.is_system && " · page système"}
        </p>
      </div>

      <PageMetaForm
        pageId={page.id}
        isSystem={page.is_system}
        initial={{
          slug: page.slug,
          title: page.title,
          metaTitle: page.meta_title,
          metaDescription: page.meta_description,
          ogImageMediaId: page.og_image_media_id,
          canonicalUrl: page.canonical_url,
          noindex: page.noindex,
        }}
      />

      <div>
        <h2 className="mb-1 text-[18px] font-black text-foreground">Contenu (blocs)</h2>
        <p className="mb-3 text-[13px] text-muted-foreground">
          Composez la page avec des blocs réordonnables (texte, en-tête, éditorial, chiffres,
          chronologie, galerie, FAQ…). Chaque image passe par la médiathèque.
        </p>
        <PageComposer
          pageId={page.id}
          initialBlocks={blocks}
          usingLegacy={usingLegacy}
          categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
          brands={brands.map((b) => ({ slug: b.slug, name: b.name }))}
          pickups={pickups.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled }))}
        />
      </div>
    </div>
  );
}
