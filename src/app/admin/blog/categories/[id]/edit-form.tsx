"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";

import { updateBlogCategoryAction } from "@/lib/actions/blog";
import { type ActionState } from "@/lib/actions/types";

type Initial = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
  noindex: boolean;
};

export function BlogCategoryEditForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    async (prev, formData) => {
      const result = await updateBlogCategoryAction(prev, formData);
      if (result.ok) router.push("/admin/blog/categories");
      return result;
    },
    null,
  );

  return (
    <form action={formAction} className="space-y-4 rounded-[28px] border border-border bg-card p-5">
      <input type="hidden" name="categoryId" value={initial.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="name" label="Nom" required defaultValue={initial.name} />
        <Field name="slug" label="Slug" defaultValue={initial.slug} />
        <Field
          name="displayOrder"
          label="Ordre d'affichage"
          type="number"
          defaultValue={String(initial.displayOrder ?? 0)}
        />
      </div>
      <Field
        name="description"
        label="Description"
        textarea
        defaultValue={initial.description ?? ""}
      />
      <label className="flex items-end gap-2 pb-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={initial.isActive}
          className="h-4 w-4 accent-[var(--primary)]"
        />
        Active (visible sur le blog)
      </label>

      <div className="space-y-3 rounded-[22px] border border-border bg-[#fbf9f8] p-4">
        <p className="text-[13px] font-bold text-foreground">
          SEO & indexation
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field name="metaTitle" label="Meta title" defaultValue={initial.metaTitle ?? ""} />
          <Field
            name="metaDescription"
            label="Meta description"
            textarea
            defaultValue={initial.metaDescription ?? ""}
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Vide = le nom (titre) et la description de la catégorie. Pilote la balise &lt;title&gt;, la
          meta description et le JSON-LD de la page /blog/{initial.slug}.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="noindex"
            defaultChecked={initial.noindex}
            className="h-4 w-4 accent-[var(--primary)]"
          />
          Noindex (exclure des moteurs de recherche)
        </label>
      </div>

      {state && !state.ok && <p className="text-xs text-destructive">{state.message}</p>}
      {state?.ok && <p className="text-xs text-primary">{state.message}</p>}
      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-11 items-center rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {isPending ? "Mise à jour…" : "Enregistrer"}
        </button>
        <a
          href="/admin/blog/categories"
          className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
        >
          Annuler
        </a>
      </div>
    </form>
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
      <label
        htmlFor={id}
        className="text-[13px] font-bold text-foreground"
      >
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
