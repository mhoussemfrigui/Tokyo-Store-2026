"use client";

import { useActionState, useState } from "react";
import { Globe, Save } from "lucide-react";

import { updatePageAction } from "@/lib/actions/cms";
import { type ActionState } from "@/lib/actions/types";
import { MediaPicker } from "@/components/admin/media-picker";
import { AdminNote } from "@/components/admin/_components/filter-bar";

// Google SERP rules of thumb: title ~60 chars, description ~155.
const SERP_TITLE_CHARS = 60;
const SERP_DESC_CHARS = 155;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/**
 * Métadonnées form — slug, title, meta tags, og:image. Lives on the page
 * builder so admins can edit a page's SEO surface without leaving the
 * section editor.
 */
export function PageMetaForm({
  pageId,
  isSystem,
  initial,
}: {
  pageId: string;
  isSystem?: boolean;
  initial: {
    slug: string;
    title: string;
    metaTitle: string | null;
    metaDescription: string | null;
    ogImageMediaId: string | null;
    canonicalUrl: string | null;
    noindex: boolean;
  };
}) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    updatePageAction,
    null,
  );

  // Live SERP preview state — driven by uncontrolled inputs so the form
  // submit still goes through formAction without any controlled re-render
  // overhead per keystroke.
  const [slug, setSlug] = useState(initial.slug);
  const [title, setTitle] = useState(initial.title);
  const [metaTitle, setMetaTitle] = useState(initial.metaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(initial.metaDescription ?? "");

  const previewTitle = truncate(metaTitle.trim() || title.trim() || "Sans titre", SERP_TITLE_CHARS);
  const previewDesc = truncate(
    metaDescription.trim() || "Aucune description — Google composera un extrait depuis le contenu.",
    SERP_DESC_CHARS,
  );

  return (
    <form
      action={formAction}
      className="space-y-4 rounded-[28px] border border-border bg-card p-5"
    >
      <input type="hidden" name="pageId" value={pageId} />

      <header>
        <h2 className="text-[18px] font-black text-foreground">Métadonnées</h2>
        <AdminNote className="mt-1">
          Slug, titre et SEO. Modifier le slug change l&apos;URL publique.
        </AdminNote>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          name="slug"
          label={isSystem ? "Slug (verrouillé — page système)" : "Slug"}
          defaultValue={initial.slug}
          required
          readOnly={isSystem}
          onChange={setSlug}
        />
        <Field
          name="title"
          label="Titre"
          defaultValue={initial.title}
          required
          onChange={setTitle}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          name="metaTitle"
          label="Meta title"
          defaultValue={initial.metaTitle ?? ""}
          onChange={setMetaTitle}
        />
        <Field
          name="metaDescription"
          label="Meta description"
          defaultValue={initial.metaDescription ?? ""}
          helper="Affiché par les moteurs de recherche."
          onChange={setMetaDescription}
        />
      </div>

      {/* SERP preview card. Updates live as the admin types. */}
      <div className="rounded-[22px] border border-border bg-[#fbf9f8] p-4">
        <p className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
          <Globe className="h-3 w-3" /> Aperçu Google
        </p>
        <div className="max-w-2xl space-y-1">
          <p className="truncate text-[12px] text-emerald-700">
            tokyostore.tn › {slug || "(slug)"}
          </p>
          <p className="text-base font-medium leading-snug text-[#1a0dab]">
            {previewTitle}
          </p>
          <p className="text-[13px] leading-snug text-[#4d5156]">{previewDesc}</p>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Titres au-delà de {SERP_TITLE_CHARS} caractères et descriptions au-delà de {SERP_DESC_CHARS} sont tronqués.
        </p>
      </div>

      <div>
        <MediaPicker
          name="ogImageMediaId"
          value={initial.ogImageMediaId ?? null}
          label="Image og:image"
          scope="cms"
        />
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          Paysage 1200×630 px (ratio 1,91:1) recommandé pour les cartes réseaux sociaux.
          Vide = l&apos;image de partage par défaut (onglet Thème &amp; design).
        </p>
      </div>

      <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        <Field
          name="canonicalUrl"
          label="URL canonique (optionnel)"
          defaultValue={initial.canonicalUrl ?? ""}
          helper="Laissez vide pour utiliser l'URL de la page. Sinon, indique aux moteurs la version de référence."
        />
        <label className="flex items-start gap-2 pt-6 text-[14px]">
          <input
            type="checkbox"
            name="noindex"
            defaultChecked={initial.noindex}
            className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
          />
          <span>
            <span className="font-bold">Exclure des moteurs de recherche (noindex)</span>
            <span className="mt-0.5 block text-[12px] text-muted-foreground">
              Pour une page fine ou en double — elle ne sera pas indexée.
            </span>
          </span>
        </label>
      </div>

      {state && !state.ok && (
        <div role="alert" className="rounded-[14px] border border-destructive/40 bg-destructive/5 p-3 text-[13px] text-destructive">
          {state.message}
        </div>
      )}
      {state?.ok && (
        <div role="status" aria-live="polite" className="rounded-[14px] border border-primary/40 bg-primary/5 p-3 text-[13px] text-primary">
          {state.message}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
      >
        <Save className="h-4 w-4" />
        {isPending ? "Enregistrement…" : "Enregistrer les métadonnées"}
      </button>
    </form>
  );
}

function Field({
  name,
  label,
  defaultValue,
  required,
  readOnly,
  helper,
  onChange,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  readOnly?: boolean;
  helper?: string;
  onChange?: (v: string) => void;
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
      <input
        id={id}
        name={name}
        required={required}
        readOnly={readOnly}
        defaultValue={defaultValue ?? ""}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className={`mt-2 h-11 w-full rounded-[14px] border-[1.5px] px-4 text-[15px] transition focus:outline-none ${readOnly ? "cursor-not-allowed border-input bg-surface/60 text-muted-foreground" : "border-input bg-[#fbf9f8] focus:border-foreground focus:bg-white"}`}
      />
      {helper && <p className="mt-1 text-[12px] text-muted-foreground">{helper}</p>}
    </div>
  );
}
