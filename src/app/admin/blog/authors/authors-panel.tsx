"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2, RotateCcw, UserRound } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import { deleteAuthorAction, restoreAuthorAction } from "@/lib/actions/authors";

export type AuthorRowData = {
  id: string;
  slug: string;
  name: string;
  jobTitle: string | null;
  isActive: boolean;
  postCount: number;
};

export function AuthorsPanel({
  authors,
  archived,
}: {
  authors: AuthorRowData[];
  archived: AuthorRowData[];
}) {
  const router = useRouter();
  const [toDelete, setToDelete] = useState<AuthorRowData | null>(null);
  const [pending, startTransition] = useTransition();

  const restore = (id: string) =>
    startTransition(async () => {
      await restoreAuthorAction(id);
      router.refresh();
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Profils éditoriaux (schema.org Person) signant les articles. Chaque auteur a une page
          publique <code>/auteur/&lt;slug&gt;</code> et une byline sur ses articles.
        </AdminNote>
        <Link
          href="/admin/blog/authors/new"
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
        >
          <Plus className="h-4 w-4" />
          Nouvel auteur
        </Link>
      </div>

      {authors.length === 0 ? (
        <Empty>Aucun auteur pour le moment. Créez un profil pour signer vos articles.</Empty>
      ) : (
        <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
          {authors.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--background)] text-muted-foreground">
                  <UserRound className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    {a.name}
                    {!a.isActive && (
                      <span className="inline-flex items-center rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold text-[#5b5d62]">
                        Inactif
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {a.jobTitle ? `${a.jobTitle} · ` : ""}
                    {a.isActive ? (
                      <a
                        href={`/auteur/${a.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="transition hover:text-foreground hover:underline"
                      >
                        /auteur/{a.slug}
                      </a>
                    ) : (
                      <>/auteur/{a.slug}</>
                    )}{" "}
                    · {a.postCount} article{a.postCount === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/admin/blog/authors/${a.id}`}
                  aria-label="Modifier"
                  className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                >
                  <Pencil className="h-4 w-4" />
                </Link>
                <IconButton
                  icon={<Trash2 className="h-4 w-4" />}
                  aria-label="Archiver"
                  tone="danger"
                  onClick={() => setToDelete(a)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[14px] font-bold text-muted-foreground">Archivés</h2>
          <ul className="divide-y divide-border rounded-[22px] border border-dashed border-border bg-card/60">
            {archived.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-muted-foreground">{a.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">/auteur/{a.slug}</p>
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => restore(a.id)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3.5 text-[13px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Restaurer
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Archiver cet auteur ?"
          description="L'auteur est archivé (non supprimé). Ses articles retombent sur la byline par défaut ; vous pourrez le restaurer."
          preview={
            <div className="rounded-2xl border border-border bg-surface/40 p-2 text-xs">
              <p className="font-medium">{toDelete.name}</p>
              <p className="text-[11px] text-muted-foreground">/auteur/{toDelete.slug}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteAuthorAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
      {children}
    </div>
  );
}
