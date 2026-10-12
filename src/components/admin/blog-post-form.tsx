"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Save, X } from "lucide-react";

import {
  createBlogPostAction,
  updateBlogPostAction,
} from "@/lib/actions/blog";
import { type ActionState } from "@/lib/actions/types";
import {
  searchProductsForPickerAction,
  type RelatedProductOption,
} from "@/lib/actions/related-products";
import { MediaPicker } from "@/components/admin/media-picker";
import { RichBodyField } from "@/components/admin/rich-body-field";
import { FormTabs, FormTab, useNoResetSubmit } from "@/components/admin/_components/form-tabs";
import { SelectField } from "@/components/ui/select-field";

/**
 * Blog post form — create + edit. Featured image via MediaPicker; the body
 * is raw HTML edited through `RichBodyField` (textarea + médiathèque image
 * insertion) and sanitised at render time on the storefront.
 */

export type BlogPostFormInitial = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  categoryId: string | null;
  authorId: string | null;
  featuredImageMediaId: string | null;
  readingMinutes: number | null;
  metaTitle: string | null;
  metaDescription: string | null;
  isPublished: boolean;
};

type TabId = "content" | "media" | "categorization" | "seo";

const TABS: { id: TabId; label: string }[] = [
  { id: "content", label: "Contenu" },
  { id: "media", label: "Média" },
  { id: "categorization", label: "Catégorisation" },
  { id: "seo", label: "SEO" },
];

export function BlogPostForm({
  mode,
  categories,
  authors = [],
  tags = [],
  currentTagIds = [],
  initialProducts = [],
  initial,
  successHref,
}: {
  mode: "create" | "edit";
  categories: { id: string; name: string }[];
  authors?: { id: string; name: string }[];
  tags?: { id: string; name: string }[];
  currentTagIds?: string[];
  /** Products cited by this post, hydrated to cards (edit mode). Empty on create. */
  initialProducts?: RelatedProductOption[];
  initial?: BlogPostFormInitial;
  successHref?: string;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    mode === "edit" ? updateBlogPostAction : createBlogPostAction,
    null,
  );
  // Keep the operator's typed content (title/body/excerpt/SEO) when a save fails
  // validation / slug-conflict — React 19 otherwise resets the uncontrolled fields
  // on every action settle, wiping a just-written long-form article. (Matches
  // every sibling content form; this was the sole omission.)
  const onSubmit = useNoResetSubmit(formAction, state);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(currentTagIds);

  // On a successful CREATE, jump to the new post's edit page (the form stays put
  // otherwise, where a second submit would create a duplicate). Edit stays in
  // place and just shows the success banner.
  useEffect(() => {
    if (mode === "create" && state?.ok && state.id) {
      router.push(`/admin/blog/posts/${state.id}`);
    }
  }, [mode, state, router]);

  const toggleTag = (id: string) =>
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-4">
      {mode === "edit" && initial && <input type="hidden" name="postId" value={initial.id} />}

      <FormTabs tabs={TABS} defaultTab="content">
        {(activeTab) => (
          <>
            {/* ─── Contenu ─────────────────────────────────────────────── */}
            <FormTab id="content" active={activeTab} spacing="4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field name="title" label="Titre" required defaultValue={initial?.title} />
                <Field
                  name="slug"
                  label="Slug"
                  defaultValue={initial?.slug}
                  helper="Auto si vide"
                />
                <Field
                  name="excerpt"
                  label="Extrait"
                  textarea
                  defaultValue={initial?.excerpt ?? ""}
                />
                <Field
                  name="readingMinutes"
                  label="Lecture (minutes)"
                  type="number"
                  min={1}
                  max={120}
                  defaultValue={initial?.readingMinutes ?? ""}
                  placeholder="auto (~200 mots/min)"
                  helper="Entre 1 et 120 min. Vide = recalcul automatique depuis le corps."
                />
              </div>
            </FormTab>

            {/* ─── Catégorisation (catégorie + tags) ───────────────────── */}
            <FormTab id="categorization" active={activeTab} spacing="4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  name="categoryId"
                  label="Catégorie"
                  defaultValue={initial?.categoryId ?? ""}
                  options={[
                    { value: "", label: "—" },
                    ...categories.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
                <Select
                  name="authorId"
                  label="Auteur"
                  defaultValue={initial?.authorId ?? ""}
                  options={[
                    { value: "", label: "— Aucun (byline par défaut)" },
                    ...authors.map((a) => ({ value: a.id, label: a.name })),
                  ]}
                />
              </div>

              {tags.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Tags
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Cliquez pour activer / désactiver. Aucune limite.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {tags.map((t) => {
                      const active = selectedTagIds.includes(t.id);
                      return (
                        <button
                          type="button"
                          key={t.id}
                          onClick={() => toggleTag(t.id)}
                          className={`inline-flex h-9 items-center rounded-full border px-3 text-xs font-medium transition ${
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-card text-muted-foreground hover:bg-surface"
                          }`}
                        >
                          {t.name}
                        </button>
                      );
                    })}
                  </div>
                  {selectedTagIds.map((id) => (
                    <input key={id} type="hidden" name="tagIds" value={id} />
                  ))}
                </div>
              )}

              {/* ─── Produits cités dans l'article ─────────────────────────
                  Curated, searchable + reorderable product picker — mirrors the
                  product form's manual cross-sell picker. Optional: zero is valid. */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Produits cités dans l&apos;article
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Produits mentionnés dans l&apos;article. Facultatif ; l&apos;ordre est conservé.
                </p>
                <div className="mt-2">
                  <CitedProductsPicker initialSelected={initialProducts} />
                </div>
              </div>
            </FormTab>

            {/* ─── Média + corps ───────────────────────────────────────── */}
            <FormTab id="media" active={activeTab} spacing="4">
              <div>
                <MediaPicker
                  name="featuredImageMediaId"
                  value={initial?.featuredImageMediaId ?? null}
                  label="Image de couverture"
                  scope="cms"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Dimensions recommandées : 1600 × 900 px (format 16:9, paysage). JPG ou WebP, &lt; 400 Ko.
                  Affichée en couverture de l'article et en vignette (listes, partages, aperçu social).
                </p>
              </div>

              <RichBodyField
                name="body"
                label="Corps de l'article (HTML)"
                rows={12}
                defaultValue={initial?.body}
                helper="HTML autorisé. « Insérer une image » importe l'image dans la médiathèque (webp/avif) et l'ajoute au curseur."
              />
            </FormTab>

            {/* ─── SEO ─────────────────────────────────────────────────── */}
            <FormTab id="seo" active={activeTab} spacing="4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field name="metaTitle" label="Meta title" defaultValue={initial?.metaTitle ?? ""} />
                <Field
                  name="metaDescription"
                  label="Meta description"
                  defaultValue={initial?.metaDescription ?? ""}
                />
              </div>
            </FormTab>
          </>
        )}
      </FormTabs>

      <label className="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="publish"
          defaultChecked={initial?.isPublished ?? false}
          className="h-4 w-4 accent-[var(--primary)]"
        />
        Publier
      </label>

      {state && !state.ok && (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {state.message}
        </div>
      )}
      {state?.ok && (
        <div className="rounded-2xl border border-primary/40 bg-primary/5 p-3 text-xs text-primary">
          {state.message}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {isPending ? "Enregistrement…" : mode === "create" ? "Créer" : "Enregistrer"}
        </button>
        {successHref && (
          <Link
            href={successHref}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-border px-5 text-sm font-medium"
          >
            <X className="h-4 w-4" /> Annuler
          </Link>
        )}
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  required,
  textarea,
  type,
  rows,
  defaultValue,
  helper,
  placeholder,
  min,
  max,
}: {
  name: string;
  label: string;
  required?: boolean;
  textarea?: boolean;
  type?: string;
  rows?: number;
  defaultValue?: string | number | null;
  helper?: string;
  placeholder?: string;
  /** Numeric bounds — the browser blocks an out-of-range value on submit. */
  min?: number;
  max?: number;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      {textarea ? (
        <textarea
          id={id}
          name={name}
          rows={rows ?? 3}
          defaultValue={defaultValue ?? ""}
          placeholder={placeholder}
          className="mt-1 w-full rounded-2xl border border-border bg-background p-3 text-sm font-mono"
        />
      ) : (
        <input
          id={id}
          name={name}
          type={type ?? "text"}
          required={required}
          min={type === "number" ? min : undefined}
          max={type === "number" ? max : undefined}
          defaultValue={defaultValue ?? ""}
          placeholder={placeholder}
          className="mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm"
        />
      )}
      {helper && <p className="mt-1 text-[10px] text-muted-foreground">{helper}</p>}
    </div>
  );
}

function Select({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
}) {
  return (
    <SelectField
      name={name}
      label={label}
      defaultValue={defaultValue ?? ""}
      options={options}
    />
  );
}

/**
 * « Produits cités dans l'article » — a curated, searchable + reorderable
 * product picker. Mirrors the product form's manual cross-sell picker
 * (ComplementaryProductsPicker): a debounced search box over
 * `searchProductsForPickerAction` + an ordered selected list. Emits one hidden
 * `productIds` input per pick (display order = FormData order), the source of
 * truth read by the blog actions. Optional — an empty list is valid.
 */
function CitedProductsPicker({
  initialSelected,
}: {
  initialSelected: RelatedProductOption[];
}) {
  const [selected, setSelected] = useState<RelatedProductOption[]>(initialSelected);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RelatedProductOption[]>([]);
  const [searching, setSearching] = useState(false);

  const selectedIds = new Set(selected.map((p) => p.id));

  // Debounced product search. All state updates happen inside the (async) timer;
  // the results dropdown is render-gated on `query.length >= 2`.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const hits = await searchProductsForPickerAction(q);
        if (!cancelled) setResults(hits);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const add = (p: RelatedProductOption) => {
    if (selectedIds.has(p.id)) return;
    setSelected((prev) => [...prev, p]);
  };
  const remove = (id: string) => setSelected((prev) => prev.filter((p) => p.id !== id));
  const move = (id: string, dir: -1 | 1) =>
    setSelected((prev) => {
      const i = prev.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const moveBtn =
    "grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-30";

  return (
    <div className="space-y-4">
      {/* One hidden input per pick — the FormData source of truth (ordered). */}
      {selected.map((p) => (
        <input key={p.id} type="hidden" name="productIds" value={p.id} />
      ))}

      <div className="space-y-3 rounded-2xl border border-border bg-surface/30 p-3.5">
        <div>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un produit à citer…"
            className="h-10 w-full rounded-full border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          {query.trim().length >= 2 && (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-2xl border border-border bg-card p-1">
              {searching && (
                <li className="px-3 py-2 text-xs text-muted-foreground">Recherche…</li>
              )}
              {!searching &&
                results.filter((r) => !selectedIds.has(r.id)).length === 0 && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">Aucun résultat.</li>
                )}
              {results
                .filter((r) => !selectedIds.has(r.id))
                .map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => add(r)}
                      className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-surface"
                    >
                      <ProductThumb url={r.imageUrl} />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {r.name}
                      </span>
                      <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>

        {selected.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-card p-3 text-center text-xs text-muted-foreground">
            Aucun produit cité — utilisez la recherche.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {selected.map((p, i) => (
              <li
                key={p.id}
                className="flex items-center gap-2.5 rounded-2xl border border-border bg-card p-2"
              >
                <span className="w-5 text-center text-[11px] font-semibold text-muted-foreground">
                  {i + 1}
                </span>
                <ProductThumb url={p.imageUrl} />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{p.name}</span>
                <button
                  type="button"
                  onClick={() => move(p.id, -1)}
                  disabled={i === 0}
                  aria-label="Monter"
                  className={moveBtn}
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(p.id, 1)}
                  disabled={i === selected.length - 1}
                  aria-label="Descendre"
                  className={moveBtn}
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  aria-label="Retirer"
                  className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProductThumb({ url }: { url: string | null }) {
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-surface">
      {url ? (
        <Image src={url} alt="" width={40} height={40} className="h-full w-full object-contain" />
      ) : (
        <span className="text-[10px] text-muted-foreground">—</span>
      )}
    </span>
  );
}
