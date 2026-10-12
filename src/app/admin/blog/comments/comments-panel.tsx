"use client";

import { useActionState, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Star, Trash2, X, Save, Loader2, CornerDownRight } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { AdminNote, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import {
  setBlogCommentStatusAction,
  deleteBlogCommentAction,
  saveBlogCommentsSettingsAction,
} from "@/lib/actions/blog-comments-admin";
import { type ActionState } from "@/lib/actions/types";
import { type BlogCommentStatus } from "@/modules/blog/schema";
import { type BlogCommentsConfig } from "@/lib/blog/comments-config";

type CommentRow = {
  id: string;
  authorName: string;
  body: string;
  rating: number | null;
  status: BlogCommentStatus;
  createdAt: string;
  postSlug: string;
  postTitle: string;
  parentAuthorName: string | null;
};

type Filter = "all" | BlogCommentStatus;

const STATUS_LABELS: Record<BlogCommentStatus, string> = {
  pending: "En attente",
  approved: "Publié",
  rejected: "Rejeté",
};
const STATUS_COLORS: Record<BlogCommentStatus, string> = {
  pending: "border border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]",
  approved: "border border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
  rejected: "bg-[#fdecef] text-[#d40530]",
};

const BASE = "/admin/blog/comments";
const tabHref = (status: Filter) => (status === "pending" ? BASE : `${BASE}?status=${status}`);
const pageHref = (status: Filter, page: number) => {
  const parts: string[] = [];
  if (status !== "pending") parts.push(`status=${status}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length ? `${BASE}?${parts.join("&")}` : BASE;
};

export function BlogCommentsPanel({
  comments,
  counts,
  config,
  status,
  page,
  pageSize,
  total,
}: {
  comments: CommentRow[];
  counts: Record<BlogCommentStatus, number>;
  config: BlogCommentsConfig;
  status: Filter;
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const [toDelete, setToDelete] = useState<CommentRow | null>(null);
  const [pending, startTransition] = useTransition();

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const moderate = (id: string, next: BlogCommentStatus) =>
    startTransition(async () => {
      await setBlogCommentStatusAction(id, next);
      router.refresh();
    });

  const tabs: { id: Filter; label: string; n?: number }[] = [
    { id: "pending", label: "En attente", n: counts.pending },
    { id: "approved", label: "Publiés", n: counts.approved },
    { id: "rejected", label: "Rejetés", n: counts.rejected },
    { id: "all", label: "Tous" },
  ];

  return (
    <div className="space-y-6">
      <AdminNote className="max-w-3xl">
        Modération des commentaires et notes laissés sur les articles de blog (comptes clients
        uniquement).
      </AdminNote>

      <CommentsSettings config={config} />

      {/* ── Filter tabs ─────────────────────────────────────────────── */}
      <SegmentedFilter
        ariaLabel="Filtrer les commentaires"
        value={status}
        onChange={(v) => router.push(tabHref(v), { scroll: false })}
        options={tabs.map((t) => ({ value: t.id, label: t.label, count: t.n }))}
      />

      {comments.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          Aucun commentaire {status !== "all" ? `« ${STATUS_LABELS[status].toLowerCase()} »` : ""}.
        </div>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li key={c.id} className="rounded-[22px] border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{c.authorName}</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_COLORS[c.status]}`}>
                      {STATUS_LABELS[c.status]}
                    </span>
                    {c.parentAuthorName && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--background)] px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                        <CornerDownRight className="h-3 w-3" />
                        réponse à {c.parentAuthorName}
                      </span>
                    )}
                    {c.rating != null && <Stars value={c.rating} />}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    sur{" "}
                    <Link href={`/blog/${c.postSlug}`} target="_blank" className="underline hover:text-foreground">
                      {c.postTitle}
                    </Link>{" "}
                    · {new Date(c.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.status !== "approved" && (
                    <IconButton
                      icon={<Check className="h-4 w-4" />}
                      aria-label="Publier"
                      tone="primary"
                      disabled={pending}
                      onClick={() => moderate(c.id, "approved")}
                    />
                  )}
                  {c.status !== "rejected" && (
                    <IconButton
                      icon={<X className="h-4 w-4" />}
                      aria-label="Rejeter"
                      tone="neutral"
                      disabled={pending}
                      onClick={() => moderate(c.id, "rejected")}
                    />
                  )}
                  <IconButton
                    icon={<Trash2 className="h-4 w-4" />}
                    aria-label="Supprimer"
                    tone="danger"
                    disabled={pending}
                    onClick={() => setToDelete(c)}
                  />
                </div>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      {/* ── Pagination ──────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <nav aria-label="Pagination des commentaires" className="flex items-center justify-between gap-3">
          {page > 1 ? (
            <Link
              href={pageHref(status, page - 1)}
              scroll={false}
              className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
            >
              ← Précédent
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground">
            Page {page} sur {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              href={pageHref(status, page + 1)}
              scroll={false}
              className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
            >
              Suivant →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer ce commentaire ?"
          description="Le commentaire est retiré définitivement du blog."
          preview={
            <div className="rounded-2xl border border-border bg-surface/40 p-2 text-xs">
              <p className="font-medium">{toDelete.authorName}</p>
              <p className="line-clamp-2 text-[11px] text-muted-foreground">{toDelete.body}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteBlogCommentAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-3 w-3 ${i <= value ? "fill-amber-400 text-amber-400" : "text-border"}`}
        />
      ))}
    </span>
  );
}

function CommentsSettings({ config }: { config: BlogCommentsConfig }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveBlogCommentsSettingsAction,
    null,
  );
  return (
    <form action={formAction} className="space-y-4 rounded-[28px] border border-border bg-card p-5">
      <div>
        <h2 className="text-[18px] font-black text-foreground">Paramètres</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Les commentaires sont réservés aux clients connectés.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle name="blog.comments.enabled" label="Commentaires activés" defaultChecked={config.enabled} />
        <Toggle name="blog.comments.ratings_enabled" label="Autoriser les notes (étoiles)" defaultChecked={config.ratingsEnabled} />
        <Toggle
          name="blog.comments.require_approval"
          label="Modération avant publication"
          hint="Désactivé : les commentaires sont publiés immédiatement."
          defaultChecked={config.requireApproval}
        />
        <div>
          <label htmlFor="cm-max" className="text-[13px] font-bold text-foreground">
            Longueur maximale (caractères)
          </label>
          <input
            id="cm-max"
            name="blog.comments.max_length"
            type="number"
            min={200}
            max={10000}
            defaultValue={config.maxLength}
            className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
          />
        </div>
      </div>
      {state && !state.ok && <p className="text-xs text-destructive">{state.message}</p>}
      {state?.ok && <p className="text-xs text-primary">{state.message}</p>}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Enregistrer
      </button>
    </form>
  );
}

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 h-4 w-4 accent-[var(--primary)]" />
      <span>
        {label}
        {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}
