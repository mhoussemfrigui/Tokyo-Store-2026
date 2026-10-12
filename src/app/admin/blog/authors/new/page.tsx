import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { getSeoConfig } from "@/lib/seo/config";
import { AuthorForm } from "@/components/admin/author-form";

export const metadata: Metadata = { title: "Nouvel auteur" };

function hostOf(u?: string | null): string {
  try {
    return u ? new URL(u).host : "tokyostore.tn";
  } catch {
    return "tokyostore.tn";
  }
}

export default async function NewAuthorPage() {
  await requirePermission("blog_authors", "create");
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
        <h1 className="mt-2 text-[26px] font-black tracking-[-0.02em] text-foreground sm:text-[30px]">Nouvel auteur</h1>
      </div>
      <AuthorForm mode="create" siteHost={siteHost} successHref="/admin/blog/authors" />
    </div>
  );
}
