import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { getSeoConfig } from "@/lib/seo/config";
import { authorService } from "@/modules/authors/service";
import { AuthorForm } from "@/components/admin/author-form";

export const metadata: Metadata = { title: "Modifier l'auteur" };

function hostOf(u?: string | null): string {
  try {
    return u ? new URL(u).host : "tokyostore.tn";
  } catch {
    return "tokyostore.tn";
  }
}

export default async function EditAuthorPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("blog_authors", "update");
  const { id } = await params;
  const author = await authorService.findById(id);
  if (!author) notFound();
  const seo = await getSeoConfig().catch(() => null);
  const siteHost = hostOf(seo?.siteUrl);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/admin/blog/authors"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Retour aux auteurs
        </Link>
        <h1 className="mt-2 text-[26px] font-black tracking-[-0.02em] text-foreground sm:text-[30px]">Modifier l'auteur</h1>
      </div>
      <AuthorForm
        mode="edit"
        siteHost={siteHost}
        successHref="/admin/blog/authors"
        initial={{
          id: author.id,
          name: author.name,
          slug: author.slug,
          bio: author.bio,
          jobTitle: author.job_title,
          expertise: author.expertise,
          avatarMediaId: author.avatar_media_id,
          sameAs: author.same_as,
          metaTitle: author.meta_title,
          metaDescription: author.meta_description,
          canonicalUrl: author.canonical_url,
          noindex: author.noindex,
          isActive: author.is_active,
        }}
      />
    </div>
  );
}
