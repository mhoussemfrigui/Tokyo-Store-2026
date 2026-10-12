import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { authorService } from "@/modules/authors/service";
import { AuthorsPanel, type AuthorRowData } from "./authors-panel";
import type { AuthorRow } from "@/modules/authors/schema";

export const metadata: Metadata = { title: "Auteurs" };

export default async function BlogAuthorsAdmin() {
  await requirePermission("blog_authors", "view");
  const [authors, archived, counts] = await Promise.all([
    authorService.listForAdmin(),
    authorService.listArchived(),
    authorService.countPostsByAuthor(),
  ]);
  const toRow = (a: AuthorRow): AuthorRowData => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    jobTitle: a.job_title,
    isActive: a.is_active,
    postCount: counts.get(a.id) ?? 0,
  });
  return <AuthorsPanel authors={authors.map(toRow)} archived={archived.map(toRow)} />;
}
