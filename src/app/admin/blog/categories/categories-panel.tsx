"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import {
  createBlogCategoryAction,
  deleteBlogCategoryAction,
} from "@/lib/actions/blog";
import { type ActionState } from "@/lib/actions/types";

type Category = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isActive: boolean;
};

export function BlogCategoriesPanel({ categories }: { categories: Category[] }) {
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<Category | null>(null);
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    createBlogCategoryAction,
    null,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Taxonomie des articles de blog. Le storefront filtre par catégorie via{" "}
          <code>/blog/&lt;slug&gt;</code>.
        </AdminNote>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
        >
          <Plus className="h-4 w-4" />
          {adding ? "Fermer" : "Nouvelle catégorie"}
        </button>
      </div>

      {adding && (
        <form action={formAction} className="space-y-3 rounded-[28px] border border-border bg-card p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="name" label="Nom" required />
            <Field name="slug" label="Slug (auto si vide)" />
            <Field name="displayOrder" label="Ordre d'affichage" type="number" defaultValue="0" />
          </div>
          <Field name="description" label="Description" textarea />
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Active (visible sur le blog)
          </label>
          {state && !state.ok && <p className="text-xs text-destructive">{state.message}</p>}
          {state?.ok && <p className="text-xs text-primary">{state.message}</p>}
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex h-11 items-center rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
            >
              {isPending ? "Création…" : "Créer"}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
            >
              Annuler
            </button>
          </div>
        </form>
      )}

      {categories.length === 0 ? (
        <Empty>Aucune catégorie pour le moment.</Empty>
      ) : (
        <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
          {categories.map((c) => (
            <Row key={c.id} category={c} onAskDelete={() => setToDelete(c)} />
          ))}
        </ul>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer cette catégorie ?"
          description="Les articles associés ne seront plus rattachés à cette catégorie."
          preview={
            <div className="rounded-2xl border border-border bg-surface/40 p-2 text-xs">
              <p className="font-medium">{toDelete.name}</p>
              <p className="text-[11px] text-muted-foreground">/blog/{toDelete.slug}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteBlogCategoryAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

function Row({ category, onAskDelete }: { category: Category; onAskDelete: () => void }) {
  return (
    <li className="flex items-center justify-between gap-3 p-4">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold">
          {category.name}
          {!category.isActive && (
            <span className="inline-flex items-center rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold text-[#5b5d62]">
              Inactif
            </span>
          )}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {category.isActive ? (
            <a
              href={`/blog/${category.slug}`}
              target="_blank"
              rel="noreferrer"
              className="transition hover:text-foreground hover:underline"
            >
              /blog/{category.slug}
            </a>
          ) : (
            <>/blog/{category.slug}</>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link
          href={`/admin/blog/categories/${category.id}`}
          aria-label="Modifier"
          className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <Pencil className="h-4 w-4" />
        </Link>
        <IconButton
          icon={<Trash2 className="h-4 w-4" />}
          aria-label="Supprimer"
          tone="danger"
          onClick={onAskDelete}
        />
      </div>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
      {children}
    </div>
  );
}

function Field({
  name,
  label,
  type,
  required,
  textarea,
  defaultValue,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  textarea?: boolean;
  defaultValue?: string;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-bold text-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      {textarea ? (
        <textarea
          id={id}
          name={name}
          rows={3}
          defaultValue={defaultValue}
          className="mt-1 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
        />
      ) : (
        <input
          id={id}
          name={name}
          type={type ?? "text"}
          required={required}
          defaultValue={defaultValue}
          className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
        />
      )}
    </div>
  );
}
