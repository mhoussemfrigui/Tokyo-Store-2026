"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { SelectField } from "@/components/ui/select-field";
import { AdminNote, AdminSearch, AdminToolbar, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import {
  deleteBlogPostAction,
  restoreBlogPostAction,
  togglePostPublishAction,
} from "@/lib/actions/blog";

/** Post status quick-filter — ≤5 short options, so a segmented pill-bar (the
 *  value is kept as a plain string to match the Filters.status shape). */
const POST_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Tous" },
  { value: "draft", label: "Brouillon" },
  { value: "published", label: "Publié" },
  { value: "archived", label: "Archivé" },
];

type Post = {
  id: string;
  slug: string;
  title: string;
  isPublished: boolean;
  publishedAt: string | null;
  categoryId: string | null;
};

type Filters = { q: string; status: string; categoryId: string };
type Pagination = { page: number; pageSize: number; total: number };

export function BlogPostsPanel({
  posts,
  categories,
  filters,
  pagination,
}: {
  posts: Post[];
  categories: { id: string; name: string }[];
  filters?: Filters;
  pagination?: Pagination;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const f: Filters = filters ?? { q: "", status: "", categoryId: "" };
  const categoryName = new Map(categories.map((c) => [c.id, c.name] as const));
  const archived = f.status === "archived";
  const totalPages = pagination
    ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize))
    : 1;

  function updateFilters(patch: Partial<Filters> & { page?: number }) {
    const next = new URLSearchParams(searchParams.toString());
    for (const key of ["q", "status", "categoryId"] as const) {
      if (patch[key] !== undefined) {
        if (patch[key]) next.set(key, patch[key] as string);
        else next.delete(key);
      }
    }
    if (patch.page !== undefined) next.set("page", String(patch.page));
    else if (patch.q !== undefined || patch.status !== undefined || patch.categoryId !== undefined) {
      next.delete("page");
    }
    startTransition(() => router.push(`?${next.toString()}`));
  }

  const [toDelete, setToDelete] = useState<Post | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Articles publiés et brouillons. Le storefront n&apos;affiche que les publiés.
        </AdminNote>
        <Link
          href="/admin/blog/posts/new"
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
        >
          <Plus className="h-4 w-4" />
          Nouvel article
        </Link>
      </div>

      {/* Filters bar — status applies immediately (segmented pill-bar); search +
          category still apply on « Filtrer » (read from the form on submit, so
          omitting status from the patch preserves the segmented selection). */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          updateFilters({
            q: String(fd.get("q") ?? "").trim(),
            categoryId: String(fd.get("categoryId") ?? ""),
          });
        }}
      >
        <AdminToolbar className="rounded-[28px] border border-border bg-card p-3">
          <AdminSearch
            name="q"
            defaultValue={f.q}
            placeholder="Titre ou slug…"
            aria-label="Recherche"
            className="min-w-[200px] flex-1"
          />
          <SegmentedFilter
            ariaLabel="Statut"
            value={f.status}
            onChange={(v) => updateFilters({ status: v })}
            options={POST_STATUS_OPTIONS}
          />
          <SelectField
            name="categoryId"
            ariaLabel="Catégorie"
            defaultValue={f.categoryId}
            size="sm"
            className="min-w-[180px]"
            options={[
              { value: "", label: "Toutes" },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
          >
            Filtrer
          </button>
          {(f.q || f.status || f.categoryId) && (
            <button
              type="button"
              onClick={() => updateFilters({ q: "", status: "", categoryId: "" })}
              className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
            >
              Réinitialiser
            </button>
          )}
        </AdminToolbar>
      </form>

      {posts.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          Aucun article ne correspond aux filtres.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
          {posts.map((p) => (
            <Row
              key={p.id}
              post={p}
              archived={archived}
              categoryName={p.categoryId ? categoryName.get(p.categoryId) ?? null : null}
              onAskDelete={() => setToDelete(p)}
            />
          ))}
        </ul>
      )}

      {pagination && pagination.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm">
          <p className="text-xs text-muted-foreground">
            {pagination.total} résultat{pagination.total > 1 ? "s" : ""} · page{" "}
            {pagination.page} / {totalPages}
          </p>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => updateFilters({ page: pagination.page - 1 })}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3.5 text-[13px] font-bold text-foreground transition hover:bg-surface disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Précédent
            </button>
            <button
              type="button"
              disabled={pagination.page >= totalPages}
              onClick={() => updateFilters({ page: pagination.page + 1 })}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3.5 text-[13px] font-bold text-foreground transition hover:bg-surface disabled:opacity-40"
            >
              Suivant <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Archiver cet article ?"
          description="L'article sera archivé (masqué du blog), restaurable depuis le filtre « Archivé »."
          preview={
            <div className="rounded-2xl border border-border bg-surface/40 p-2 text-xs">
              <p className="font-medium">{toDelete.title}</p>
              <p className="text-[11px] text-muted-foreground">/blog/{toDelete.slug}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteBlogPostAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

function Row({
  post,
  archived,
  categoryName,
  onAskDelete,
}: {
  post: Post;
  archived: boolean;
  categoryName: string | null;
  onAskDelete: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Surface a failed publish toggle / restore (stale or concurrently removed
  // row → not_found) instead of the click silently changing nothing.
  const [error, setError] = useState<string | null>(null);
  // Only for a LIVE post — a draft keeps its published_at from a prior publish, so
  // gating on isPublished avoids « publié le … » on a row the badge calls Brouillon.
  const publishedLabel =
    post.isPublished && post.publishedAt
      ? new Date(post.publishedAt).toLocaleDateString("fr-FR", { dateStyle: "medium" })
      : null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{post.title}</p>
        <p className="text-[11px] text-muted-foreground">
          {post.isPublished && !archived ? (
            <a
              href={`/blog/${post.slug}`}
              target="_blank"
              rel="noreferrer"
              className="transition hover:text-foreground hover:underline"
            >
              /blog/{post.slug}
            </a>
          ) : (
            <>/blog/{post.slug}</>
          )}
          {categoryName && <span className="ml-2">· {categoryName}</span>}
          {publishedLabel && <span className="ml-2">· publié le {publishedLabel}</span>}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {archived ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const res = await restoreBlogPostAction(post.id);
                if (res.ok) router.refresh();
                else setError(res.message || "La restauration n'a pas pu être effectuée.");
              })
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[#cdebd6] bg-[#eaf7ee] px-3 text-[11px] font-bold text-[#15803d] disabled:opacity-60"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Restaurer
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const res = await togglePostPublishAction(post.id, !post.isPublished);
                  if (res.ok) router.refresh();
                  else setError(res.message || "La modification n'a pas pu être enregistrée.");
                })
              }
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                post.isPublished
                  ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
                  : "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]"
              }`}
            >
              {post.isPublished ? "Publié" : "Brouillon"}
            </button>
            <Link
              href={`/admin/blog/posts/${post.id}`}
              className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              aria-label="Modifier"
            >
              <Pencil className="h-4 w-4" />
            </Link>
            <IconButton
              icon={<Trash2 className="h-4 w-4" />}
              aria-label="Archiver"
              tone="danger"
              onClick={onAskDelete}
            />
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="w-full text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
