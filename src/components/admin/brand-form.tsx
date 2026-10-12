"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { Plus, Save, Trash2, X } from "lucide-react";

import {
  createBrandAction,
  updateBrandAction,
} from "@/lib/actions/catalog";
import { upsertBrandFaqsAction } from "@/lib/actions/cms";
import { type ActionState } from "@/lib/actions/types";
import { MediaPicker } from "@/components/admin/media-picker";
import { IconPicker } from "@/components/admin/_components/icon-picker";
import {
  FormTabs,
  FormTab,
  TabbedFormError,
  useNoResetSubmit,
  useTabErrorFocus,
} from "@/components/admin/_components/form-tabs";
import { RichTextField } from "@/components/admin/_components/rich-text-field";
import { ValuePropsEditor } from "@/components/admin/_components/value-props-editor";
import { GlobalContentNote } from "@/components/admin/_components/global-content-note";
import { BRAND_FORM_ID } from "@/components/admin/_components/product-ai-context";

/**
 * Brand form — create + edit modes. Mirrors CategoryForm: rich-text HTML
 * description + editorial, a FAQ tab, a full SEO tab (canonical / noindex / OG
 * image + char counters + SERP preview), an external ERP reference, and one-click
 * AI generation (feature="marques"). Logo + hero are MediaPickers.
 */

type ValuePropInput = { icon: string; iconMediaId?: string | null; title: string; body: string };

/** Hidden sibling form id — lets the FAQ editor live in the FAQ tab without nesting <form>. */
const BRAND_FAQ_FORM_ID = "gz-brand-faq-form";


/** Host shown in the SEO SERP preview (mirrors the product/category editor). */
const SEO_SITE_HOST = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://tokyostore.tn")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");
const seoCounterClass = (n: number, max: number) =>
  n === 0 ? "text-muted-foreground" : n <= max ? "text-emerald-600" : "text-amber-600";

export type BrandFormInitial = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  externalRef?: string | null;
  logoMediaId: string | null;
  /** Listing chip icon: a curated lucide key + an optional custom image id. */
  icon?: string | null;
  iconMediaId?: string | null;
  isActive: boolean;
  isDiscountable?: boolean;
  displayOrder?: number;
  heroMediaId?: string | null;
  tagline?: string | null;
  editorialEyebrow?: string | null;
  editorialTitle?: string | null;
  editorialBody?: string | null;
  valueProps?: ValuePropInput[] | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
  noindex?: boolean;
  ogImageMediaId?: string | null;
};

export type BrandFaqInitial = {
  question: string;
  answer: string;
  displayOrder: number;
  isPublished: boolean;
};

type TabId = "identity" | "image" | "content" | "faq" | "seo";

const TABS: { id: TabId; label: string }[] = [
  { id: "identity", label: "Identité" },
  { id: "image", label: "Image" },
  { id: "content", label: "Contenu" },
  { id: "faq", label: "FAQ" },
  { id: "seo", label: "SEO" },
];

const TAB_LABELS = Object.fromEntries(TABS.map((t) => [t.id, t.label])) as Record<
  TabId,
  string
>;
const TAB_ORDER = TABS.map((t) => t.id);

/** Field key → owning tab, so a failed submit jumps to the offending field. */
const FIELD_TAB: Record<string, TabId> = {
  name: "identity",
  slug: "identity",
  externalRef: "identity",
  tagline: "identity",
  isActive: "identity",
  isDiscountable: "identity",
  displayOrder: "identity",
  icon: "identity",
  iconMediaId: "identity",
  logoMediaId: "image",
  heroMediaId: "image",
  description: "content",
  editorialEyebrow: "content",
  editorialTitle: "content",
  editorialBody: "content",
  valueProps: "content",
  metaTitle: "seo",
  metaDescription: "seo",
  canonicalUrl: "seo",
  noindex: "seo",
  ogImageMediaId: "seo",
};

export function BrandForm({
  mode,
  initial,
  initialFaqs,
  successHref,
}: {
  mode: "create" | "edit";
  initial?: BrandFormInitial;
  initialFaqs?: BrandFaqInitial[];
  successHref?: string;
}) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    mode === "edit" ? updateBrandAction : createBrandAction,
    null,
  );
  // Dispatch imperatively so a FAILED save keeps every typed value.
  const onSubmit = useNoResetSubmit(formAction, state);

  // Controlled tab so a failed submit jumps to the tab holding the bad field.
  const [activeTab, setActiveTab] = useState<TabId>("identity");
  useTabErrorFocus({ state, fieldTabMap: FIELD_TAB, tabOrder: TAB_ORDER, setActiveTab });

  // After a successful CREATE, navigate to the new brand's edit page (mirrors the
  // category/product editors): closes the inline create form, clears the stale
  // banner, and lands where the FAQ tab + full editing are available.
  const router = useRouter();
  useEffect(() => {
    if (mode === "create" && state?.ok && state.id) {
      router.push(`/admin/catalog/brands/${state.id}`);
    }
  }, [mode, state, router]);

  const initialTagline = initial?.tagline ?? "";
  const initialEyebrow = initial?.editorialEyebrow ?? "";
  const initialTitle = initial?.editorialTitle ?? "";
  const initialBody = initial?.editorialBody ?? "";

  // SEO fields controlled so the "Générer (IA)" button can fill them.
  const [metaTitle, setMetaTitle] = useState(initial?.metaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(initial?.metaDescription ?? "");
  // FAQ editor state — lifted so the editor UI lives in the FAQ tab while its
  // <form> is a hidden sibling (referenced via form=), avoiding nested forms.
  const [faqItems, setFaqItems] = useState<BrandFaqInitial[]>(initialFaqs ?? []);
  // Once the operator touches the FAQ list, mirror it into the MAIN form (as
  // `faqItemsJson`) so the single "Enregistrer" persists FAQs too — no more losing
  // FAQ edits by clicking the main button instead of the secondary FAQ one.
  const [faqDirty, setFaqDirty] = useState(false);
  const setFaqItemsDirty: React.Dispatch<React.SetStateAction<BrandFaqInitial[]>> = (v) => {
    setFaqDirty(true);
    setFaqItems(v);
  };
  const [faqState, faqAction, faqPending] = useActionState<ActionState | null, FormData>(
    upsertBrandFaqsAction,
    null,
  );
  // Shared serialization — reused by the MAIN form's fold-in input AND the hidden
  // sibling FAQ form (the standalone "Enregistrer la FAQ" button).
  const serializedFaqItems = JSON.stringify(
    faqItems
      .map((it, idx) => ({
        question: it.question.trim(),
        answer: it.answer.trim(),
        displayOrder: Number.isFinite(it.displayOrder) ? it.displayOrder : idx,
        isPublished: it.isPublished,
      }))
      .filter((it) => it.question.length > 0 && it.answer.length > 0),
  );

  return (
    <div className="space-y-5">
    <form id={BRAND_FORM_ID} action={formAction} onSubmit={onSubmit} className="space-y-5">
      {mode === "edit" && initial && (
        <input type="hidden" name="brandId" value={initial.id} />
      )}
      {/* FAQ fold-in: once the FAQ tab is edited, the single "Enregistrer" persists
          FAQs too (the main action reads faqItemsJson). Absent until edited ⇒ an
          unrelated save never rewrites the FAQs. */}
      {mode === "edit" && initial && faqDirty && (
        <input type="hidden" name="faqItemsJson" value={serializedFaqItems} />
      )}

      <FormTabs
        tabs={TABS}
        defaultTab="identity"
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
      >
        {(activeTab) => (
          <>
            {/* ─── 1. Identité ─────────────────────────────────────────── */}
            <FormTab id="identity" active={activeTab}>
              <Section title="Identité" description="Nom, slug, référence ERP et statut.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field name="name" label="Nom" required defaultValue={initial?.name} />
                  <Field
                    name="slug"
                    label="Slug"
                    defaultValue={initial?.slug}
                    helper="Auto si vide (depuis le nom)."
                  />
                  <Field
                    name="externalRef"
                    label="Référence externe (ERP)"
                    defaultValue={initial?.externalRef ?? ""}
                    helper="Code de liaison avec un système externe (ERP / PIM). Unique ; sert à synchroniser cette marque par référence via l'API."
                  />
                  <Field
                    name="displayOrder"
                    label="Ordre d'affichage"
                    defaultValue={
                      initial?.displayOrder != null ? String(initial.displayOrder) : ""
                    }
                    helper="Position dans la liste des marques (/marques, barre de navigation). Plus petit = plus haut. Réorganisez aussi depuis la liste des marques."
                  />
                </div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="isActive"
                      defaultChecked={initial?.isActive ?? true}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                    Marque active (visible sur le storefront)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="isDiscountable"
                      defaultChecked={initial?.isDiscountable ?? true}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                    Éligible aux remises (décocher : les produits de cette marque ne reçoivent jamais de réduction)
                  </label>
                </div>
              </Section>

              <Section title="Description" description="Tagline et description longue (HTML) de la marque.">
                <Field
                  name="tagline"
                  label="Tagline"
                  defaultValue={initialTagline}
                  helper="Phrase courte affichée sous le logo sur la page marque."
                />
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Description
                  </label>
                  <p className="mb-2 mt-0.5 text-[10px] text-muted-foreground">
                    Intro longue affichée sur la page marque. HTML mis en forme (comme les fiches produits).
                  </p>
                  <RichTextField
                    name="description"
                    rows={6}
                    defaultValue={initial?.description ?? ""}
                    placeholder="<p>Présentez l'univers de cette marque…</p>"
                  />
                </div>
              </Section>
            </FormTab>

            {/* ─── 2. Logo & hero ──────────────────────────────────────── */}
            <FormTab id="image" active={activeTab}>
              <Section
                title="Logo & hero"
                description="Logo affiché dans les filtres, le mur « Nos grandes marques » de l'accueil et la page marque ; l'image hero coiffe la page marque. Logo recommandé : PNG ou SVG sur fond transparent, format paysage — env. 400×160 px (le logo est centré sans recadrage). Image hero : bannière large 21:9 — 2400×1030 px."
              >
                <MediaPicker
                  name="logoMediaId"
                  value={initial?.logoMediaId ?? null}
                  label="Logo"
                  scope="brands"
                />
                <MediaPicker
                  name="heroMediaId"
                  value={initial?.heroMediaId ?? null}
                  label="Image hero (page marque)"
                  scope="brands"
                />
              </Section>
              <Section
                title="Icône de listing"
                description="Pastille de la marque dans la barre de navigation du listing (icône au choix ou image personnalisée)."
              >
                <IconPicker
                  icon={initial?.icon ?? null}
                  iconMediaId={initial?.iconMediaId ?? null}
                  scope="brands"
                />
              </Section>
            </FormTab>

            {/* ─── 3. Contenu éditorial ────────────────────────────────── */}
            <FormTab id="content" active={activeTab}>
              <GlobalContentNote />
              <Section
                title="Contenu éditorial"
                description="Bloc storytelling affiché sur la page marque. Laissez un champ vide pour ne pas l'afficher."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field name="editorialEyebrow" label="Eyebrow" defaultValue={initialEyebrow} helper="Ex. L'univers Festina" />
                  <Field name="editorialTitle" label="Titre éditorial" defaultValue={initialTitle} helper="Ex. Au cœur de la high-tech." />
                </div>
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Corps éditorial
                  </label>
                  <p className="mb-2 mt-0.5 text-[10px] text-muted-foreground">
                    Bloc storytelling. HTML mis en forme.
                  </p>
                  <RichTextField
                    name="editorialBody"
                    rows={8}
                    defaultValue={initialBody}
                    placeholder="<p>Racontez l'histoire de cette marque…</p>"
                  />
                </div>

                <ValuePropsEditor initial={initial?.valueProps ?? null} scope="brands" />
              </Section>
            </FormTab>

            {/* ─── 4. FAQ ──────────────────────────────────────────────── */}
            <FormTab id="faq" active={activeTab}>
              {mode === "edit" && initial ? (
                <BrandFaqEditorBody
                  items={faqItems}
                  setItems={setFaqItemsDirty}
                  state={faqState}
                  pending={faqPending}
                  formId={BRAND_FAQ_FORM_ID}
                />
              ) : (
                <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
                  Enregistrez d&apos;abord la marque. Vous pourrez ensuite ajouter des
                  questions / réponses depuis sa page d&apos;édition.
                </p>
              )}
            </FormTab>

            {/* ─── 5. SEO ──────────────────────────────────────────────── */}
            <FormTab id="seo" active={activeTab}>
              <Section
                title="SEO"
                description="Méta-titre, méta-description, URL canonique et indexation envoyés aux moteurs de recherche."
              >
                {/* Live Google SERP preview. */}
                <div className="rounded-2xl border border-border bg-surface/40 p-4">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Aperçu Google — rendu approximatif
                  </p>
                  <div className="space-y-0.5">
                    <p className="truncate text-xs text-emerald-700 dark:text-emerald-400">
                      {SEO_SITE_HOST}/{initial?.slug ?? "votre-marque"}
                    </p>
                    <p className="truncate text-base font-medium text-[#1a0dab] dark:text-[#8ab4f8]">
                      {metaTitle.trim() || initial?.name || "Nom de la marque"}
                    </p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {metaDescription.trim() || "La méta-description de la marque s'affiche ici."}
                    </p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="flex items-center justify-between">
                      <label htmlFor="f-metaTitle" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Meta title
                      </label>
                      <span className={`text-[10px] font-medium ${seoCounterClass(metaTitle.trim().length, 60)}`}>
                        {metaTitle.trim().length}/60
                      </span>
                    </div>
                    <input
                      id="f-metaTitle"
                      name="metaTitle"
                      value={metaTitle}
                      onChange={(e) => setMetaTitle(e.target.value)}
                      className="mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <p className="mt-1 text-[10px] text-muted-foreground">50–60 caractères. Laisser vide pour utiliser le nom.</p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <label htmlFor="f-metaDescription" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Meta description
                      </label>
                      <span className={`text-[10px] font-medium ${seoCounterClass(metaDescription.trim().length, 160)}`}>
                        {metaDescription.trim().length}/160
                      </span>
                    </div>
                    <textarea
                      id="f-metaDescription"
                      name="metaDescription"
                      rows={3}
                      value={metaDescription}
                      onChange={(e) => setMetaDescription(e.target.value)}
                      className="mt-1 w-full rounded-2xl border border-border bg-background p-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <p className="mt-1 text-[10px] text-muted-foreground">120–160 caractères.</p>
                  </div>
                  <Field
                    name="canonicalUrl"
                    label="URL canonique"
                    defaultValue={initial?.canonicalUrl ?? ""}
                    helper="Optionnel. Replie les URL en double sur une URL maître. Vide = /slug."
                  />
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      type="checkbox"
                      name="noindex"
                      defaultChecked={initial?.noindex ?? false}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                    Noindex (exclure des moteurs de recherche)
                  </label>
                </div>
              </Section>
              <Section
                title="Image de partage (OG)"
                description="Image affichée lors du partage de la page marque sur les réseaux sociaux. À défaut, l'image de partage par défaut du site est utilisée."
              >
                <MediaPicker name="ogImageMediaId" value={initial?.ogImageMediaId ?? null} scope="brands" />
              </Section>
            </FormTab>
          </>
        )}
      </FormTabs>

      <TabbedFormError
        state={state}
        fieldTabMap={FIELD_TAB}
        tabLabels={TAB_LABELS}
        onJumpToTab={setActiveTab}
      />

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

    {/* Hidden sibling <form> for the FAQ editor — UI lives in the FAQ tab. */}
    {mode === "edit" && initial && (
      <form id={BRAND_FAQ_FORM_ID} action={faqAction} className="hidden">
        <input type="hidden" name="brandId" value={initial.id} />
        <input type="hidden" name="brandSlug" value={initial.slug} />
        <input type="hidden" name="itemsJson" value={serializedFaqItems} />
      </form>
    )}
    </div>
  );
}

/** Inline brand-FAQ editor — same shape as the category FAQ editor. */
function BrandFaqEditorBody({
  items,
  setItems,
  state,
  pending,
  formId,
}: {
  items: BrandFaqInitial[];
  setItems: React.Dispatch<React.SetStateAction<BrandFaqInitial[]>>;
  state: ActionState | null;
  pending: boolean;
  formId: string;
}) {
  const updateItem = (idx: number, patch: Partial<BrandFaqInitial>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));
  const addItem = () =>
    setItems((prev) => [...prev, { question: "", answer: "", displayOrder: prev.length, isPublished: true }]);

  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-3xl border border-border bg-card p-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[14.5px] text-foreground">FAQ marque</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Questions / réponses affichées sur la page marque. Laissez vide pour ne pas afficher la section.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addItem}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium hover:bg-surface"
            >
              <Plus className="h-3.5 w-3.5" />
              Ajouter une question
            </button>
          </div>
        </header>

        {items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
            Aucune question. Cliquez sur « Ajouter une question » pour commencer.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item, idx) => (
              <li key={idx} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Question {idx + 1}
                  </p>
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    aria-label="Supprimer cette question"
                    className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Question</label>
                    <input
                      type="text"
                      value={item.question}
                      onChange={(e) => updateItem(idx, { question: e.target.value })}
                      placeholder="Ex. La garantie est-elle officielle ?"
                      className="mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Réponse</label>
                    <textarea
                      value={item.answer}
                      onChange={(e) => updateItem(idx, { answer: e.target.value })}
                      rows={3}
                      placeholder="Réponse détaillée."
                      className="mt-1 w-full rounded-2xl border border-border bg-background p-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Ordre</label>
                      <input
                        type="number"
                        min={0}
                        value={item.displayOrder}
                        onChange={(e) =>
                          updateItem(idx, {
                            displayOrder: Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0,
                          })
                        }
                        className="mt-1 h-10 w-full rounded-2xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <label className="flex items-end gap-2 pb-2 text-sm">
                      <input
                        type="checkbox"
                        checked={item.isPublished}
                        onChange={(e) => updateItem(idx, { isPublished: e.target.checked })}
                        className="h-4 w-4 accent-[var(--primary)]"
                      />
                      Publiée
                    </label>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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

      <div className="flex gap-2">
        <button
          type="submit"
          form={formId}
          disabled={pending}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {pending ? "Enregistrement…" : "Enregistrer la FAQ"}
        </button>
      </div>
    </div>
  );
}

/** Form section primitive — one labelled card per logical grouping. */
function Section({
  title,
  description,
  accent,
  children,
}: {
  title: string;
  description?: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`space-y-4 rounded-3xl border bg-card p-5 ${
        accent ? "border-primary/30 shadow-soft" : "border-border"
      }`}
    >
      <header>
        <h2 className="text-[14.5px] text-foreground">{title}</h2>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  name,
  label,
  required,
  textarea,
  defaultValue,
  helper,
}: {
  name: string;
  label: string;
  required?: boolean;
  textarea?: boolean;
  defaultValue?: string;
  helper?: string;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      {textarea ? (
        <textarea
          id={id}
          name={name}
          rows={3}
          defaultValue={defaultValue ?? ""}
          className="mt-1 w-full rounded-2xl border border-border bg-background p-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      ) : (
        <input
          id={id}
          name={name}
          required={required}
          defaultValue={defaultValue ?? ""}
          className="mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      )}
      {helper && <p className="mt-1 text-[10px] text-muted-foreground">{helper}</p>}
    </div>
  );
}
