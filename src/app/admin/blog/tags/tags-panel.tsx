"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import {
  createTagAction,
  deleteTagAction,
  updateTagAction,
} from "@/lib/actions/blog";
import { type ActionState } from "@/lib/actions/types";

type Tag = { id: string; name: string; slug: string };

/**
 * Blog tags admin — inline create + inline edit (name/slug) + delete-with-
 * confirm list. Editing fixes a typo in place instead of delete+recreate
 * (which would drop the tag from every post via the cascade).
 */
export function TagsPanel({ tags }: { tags: Tag[] }) {
  const [toDelete, setToDelete] = useState<Tag | null>(null);
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    createTagAction,
    null,
  );

  return (
    <div className="space-y-6">
      <form
        action={formAction}
        className="flex flex-wrap items-end gap-3 rounded-[28px] border border-border bg-card p-5"
      >
        <AdminNote className="w-full max-w-3xl">
          Pool partagé — chaque article peut être lié à plusieurs tags.
        </AdminNote>
        <Field name="name" label="Nom" required />
        <Field name="slug" label="Slug" helper="Auto si vide" />
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          <Plus className="h-4 w-4" />
          {isPending ? "Création…" : "Créer le tag"}
        </button>
        {state && !state.ok && (
          <p className="w-full text-xs text-destructive">{state.message}</p>
        )}
        {state?.ok && <p className="w-full text-xs text-primary">{state.message}</p>}
      </form>

      {tags.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          Aucun tag pour le moment.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
          {tags.map((t) => (
            <TagRow key={t.id} tag={t} onAskDelete={() => setToDelete(t)} />
          ))}
        </ul>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer ce tag ?"
          description="Les articles liés perdront ce tag (la suppression est hard)."
          preview={
            <div className="rounded-2xl border border-border bg-surface/40 p-2 text-xs">
              <p className="font-medium">{toDelete.name}</p>
              <p className="text-[11px] text-muted-foreground">/blog/tag/{toDelete.slug}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteTagAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

function TagRow({ tag, onAskDelete }: { tag: Tag; onAskDelete: () => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (editing) {
    return (
      <li className="p-4">
        <form
          action={(fd) =>
            start(async () => {
              fd.set("tagId", tag.id);
              const res = await updateTagAction(null, fd);
              if (res.ok) {
                setEditing(false);
                setErr(null);
                router.refresh();
              } else {
                setErr(res.message ?? "Erreur");
              }
            })
          }
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex-1 min-w-[140px]">
            <span className="text-[13px] font-bold text-foreground">Nom</span>
            <input name="name" defaultValue={tag.name} required className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none" />
          </label>
          <label className="flex-1 min-w-[140px]">
            <span className="text-[13px] font-bold text-foreground">Slug</span>
            <input name="slug" defaultValue={tag.slug} required className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none" />
          </label>
          <button type="submit" disabled={pending} className="inline-flex h-11 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60">
            <Check className="h-3.5 w-3.5" /> Enregistrer
          </button>
          <button type="button" onClick={() => { setEditing(false); setErr(null); }} className="inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-4 text-[13px] font-bold text-foreground transition hover:bg-surface">
            <X className="h-3.5 w-3.5" /> Annuler
          </button>
          {err && <p className="w-full text-[11px] text-destructive">{err}</p>}
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div>
        <p className="text-sm font-semibold">{tag.name}</p>
        <p className="text-[11px] text-muted-foreground">
          <a
            href={`/blog/tag/${tag.slug}`}
            target="_blank"
            rel="noreferrer"
            className="transition hover:text-foreground hover:underline"
          >
            /blog/tag/{tag.slug}
          </a>
        </p>
      </div>
      <div className="flex items-center gap-1">
        <IconButton icon={<Pencil className="h-4 w-4" />} aria-label="Modifier" onClick={() => setEditing(true)} />
        <IconButton icon={<Trash2 className="h-4 w-4" />} aria-label="Supprimer" tone="danger" onClick={onAskDelete} />
      </div>
    </li>
  );
}

function Field({
  name,
  label,
  required,
  helper,
}: {
  name: string;
  label: string;
  required?: boolean;
  helper?: string;
}) {
  const id = `f-${name}`;
  return (
    <div className="flex-1 min-w-[180px]">
      <label
        htmlFor={id}
        className="text-[13px] font-bold text-foreground"
      >
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      <input
        id={id}
        name={name}
        required={required}
        className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
      />
      {helper && <p className="mt-1 text-[12px] text-muted-foreground">{helper}</p>}
    </div>
  );
}
