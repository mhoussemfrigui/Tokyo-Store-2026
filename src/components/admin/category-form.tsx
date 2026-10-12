"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { Plus, Save, Trash2, X } from "lucide-react";

import {
  createCategoryAction,
  updateCategoryAction,
} from "@/lib/actions/catalog";
import { upsertCategoryFaqsAction } from "@/lib/actions/cms";
import { createCategoryFilterAttributeAction } from "@/lib/actions/attribute";
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
import { CATEGORY_FORM_ID } from "@/components/admin/_components/product-ai-context";
import { SelectField } from "@/components/ui/select-field";
import { percentFromBps } from "@/lib/tax/shared";

/** Host shown in the SEO SERP preview (mirrors the product editor). */
const SEO_SITE_HOST = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://tokyostore.tn")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");
/** Char-counter colour: muted when empty, green within budget, amber when over. */
const seoCounterClass = (n: number, max: number) =>
  n === 0 ? "text-muted-foreground" : n <= max ? "text-emerald-600" : "text-amber-600";
/**
 * Category form — create + edit modes.
 *
 *   Exposes every column on the categories table: slug (editable), tagline,
 *   description, hero image (MediaPicker), SEO (meta_title, meta_description),
 *   parent reparenting, display_order, is_active, plus the editorial block
 *   (eyebrow, title, body) and the 4-slot value-prop cards that render on
 *   the storefront category landing page.
 *
 *   The slug must be unique SITE-WIDE — across categories, products, brands,
 *   pages and reserved routes (checkSlugAvailability) — on top of the sibling
 *   check under the (new) parent. The workflow enforces both and returns a
 *   fieldError on `slug`.
 *
 *   Storefront filters are wired through the attributes module — the
 *   admin ticks which `product_attributes` apply to a category and the M2M
 *   `category_attribute_filters` is replaced atomically server-side. (The old
 *   JSONB `filter_config` column it replaced was dropped in migration 0004.)
 */

type ValuePropInput = { icon: string; iconMediaId?: string | null; title: string; body: string };

/** Hidden sibling form id — lets the FAQ editor live inside the FAQ tab without nesting <form>. */
const CATEGORY_FAQ_FORM_ID = "gz-category-faq-form";

export type CategoryFormInitial = {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  /** ERP linkage code (unique among live categories). */
  externalRef?: string | null;
  heroMediaId: string | null;
  boutiqueImageMediaId?: string | null;
  /** Listing chip icon: a curated lucide key + an optional custom image id. */
  icon?: string | null;
  iconMediaId?: string | null;
  parentId: string | null;
  displayOrder: number;
  metaTitle: string | null;
  metaDescription: string | null;
  /** SEO overrides (parity with products). */
  canonicalUrl?: string | null;
  noindex?: boolean;
  ogImageMediaId?: string | null;
  isActive: boolean;
  /** When false, products in this category never receive any reduction. Defaults true. */
  isDiscountable?: boolean;
  /**
   * Category-level warranty default (global → category → product cascade).
   * `null` ⇒ inherit the global default; a number sets months for every
   * product in this category that hasn't set its own override. A sub-category
   * value wins over its parent.
   */
  warrantyMonths?: number | null;
  warrantyLabel?: string | null;
  /**
   * Category-level TVA default in BASIS POINTS (1900 = 19 %). `null` ⇒ inherit
   * the global default; a number sets the rate for every product in this
   * category that hasn't set its own override. A sub-category value wins over
   * its parent. The admin enters a PERCENT (see `percentFromBps`).
   */
  taxRateBps?: number | null;
  editorialEyebrow?: string | null;
  editorialTitle?: string | null;
  editorialBody?: string | null;
  valueProps?: ValuePropInput[] | null;
};

export type CategoryFaqInitial = {
  question: string;
  answer: string;
  displayOrder: number;
  isPublished: boolean;
};

type Props = {
  mode: "create" | "edit";
  /** All categories EXCEPT the one being edited (avoid self-parenting). */
  parents: { id: string; name: string }[];
  defaultParentId?: string | null;
  /** Live attributes the admin can tick as filters for this category. */
  attributes?: { id: string; name: string; slug: string }[];
  /** Attribute IDs already linked to this category (edit mode). */
  filterAttributeIds?: string[];
  /** Existing FAQs for this category (edit mode only). */
  initialFaqs?: CategoryFaqInitial[];
  initial?: CategoryFormInitial;
  successHref?: string;
  /**
   * True when the viewer holds attributes:create — the inline "Nouvel attribut"
   * creator's action requires it, so hide the creator for a categories-only
   * operator (its submit would otherwise 404 + log a false permission-denied
   * probe). Ticking EXISTING attributes as filters stays available. Defaults to
   * false so a caller that forgets to pass it fails safe (hidden).
   */
  canCreateAttribute?: boolean;
};

type TabId = "identity" | "image" | "content" | "filters" | "faq" | "seo";

const TABS: { id: TabId; label: string }[] = [
  { id: "identity", label: "Identité" },
  { id: "image", label: "Image hero" },
  { id: "content", label: "Contenu" },
  { id: "filters", label: "Filtres" },
  { id: "faq", label: "FAQ" },
  { id: "seo", label: "SEO" },
];

const TAB_LABELS = Object.fromEntries(TABS.map((t) => [t.id, t.label])) as Record<
  TabId,
  string
>;
const TAB_ORDER = TABS.map((t) => t.id);

/**
 * Maps each schema/form field key (the keys `flattenZodError` produces, plus the
 * slug-conflict key the workflow returns) to the tab that renders it, so a failed
 * submit can jump the operator to the offending field even when it lives on a
 * hidden tab. See {@link useTabErrorFocus}.
 */
const FIELD_TAB: Record<string, TabId> = {
  name: "identity",
  slug: "identity",
  externalRef: "identity",
  parentId: "identity",
  tagline: "identity",
  displayOrder: "identity",
  warrantyMonths: "identity",
  warrantyLabel: "identity",
  taxRateBps: "identity",
  isActive: "identity",
  isDiscountable: "identity",
  icon: "identity",
  iconMediaId: "identity",
  heroMediaId: "image",
  boutiqueImageMediaId: "image",
  description: "content",
  editorialEyebrow: "content",
  editorialTitle: "content",
  editorialBody: "content",
  valueProps: "content",
  filterAttributeIds: "filters",
  metaTitle: "seo",
  metaDescription: "seo",
  canonicalUrl: "seo",
  noindex: "seo",
  ogImageMediaId: "seo",
};

export function CategoryForm({
  mode,
  parents,
  defaultParentId,
  attributes,
  filterAttributeIds,
  initialFaqs,
  initial,
  successHref,
  canCreateAttribute = false,
}: Props) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    mode === "edit" ? updateCategoryAction : createCategoryAction,
    null,
  );
  // Dispatch imperatively so a FAILED save keeps every typed value.
  const onSubmit = useNoResetSubmit(formAction, state);

  // Controlled tab so a failed submit can jump to the tab that owns the bad
  // field (a hidden SEO/Filtres value would otherwise be invisible).
  const [activeTab, setActiveTab] = useState<TabId>("identity");
  useTabErrorFocus({ state, fieldTabMap: FIELD_TAB, tabOrder: TAB_ORDER, setActiveTab });

  // After a successful CREATE, navigate to the new category's edit page (mirrors
  // the product editor). This closes the inline create form, clears the stale
  // open-form + success-banner state, and lands on a page where the new category
  // (incl. its FAQ tab) is fully editable — also sidestepping the drill-down view
  // not surfacing the just-created node. Edit-mode saves stay in place.
  const router = useRouter();
  useEffect(() => {
    if (mode === "create" && state?.ok && state.id) {
      router.push(`/admin/catalog/categories/${state.id}`);
    }
  }, [mode, state, router]);

  // SEO fields are controlled so the "Générer (IA)" button can fill them.
  const [metaTitle, setMetaTitle] = useState(initial?.metaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(initial?.metaDescription ?? "");
  // FAQ editor state — lifted to the parent so the editor UI can live INSIDE
  // the FAQ tab while its <form> is a hidden sibling (referenced via form=),
  // avoiding nested <form> elements. NO default seeding: an empty FAQ set
  // stays empty (the storefront hides the FAQ section entirely).
  const [faqItems, setFaqItems] = useState<CategoryFaqInitial[]>(initialFaqs ?? []);
  const [faqState, faqAction, faqPending] = useActionState<ActionState | null, FormData>(
    upsertCategoryFaqsAction,
    null,
  );
  // FOLD-IN (mirrors the product editor): once the FAQ tab is edited, its list
  // rides the MAIN form's single "Enregistrer" via a hidden `faqItemsJson`
  // input, so an operator who edits FAQ rows and clicks the main button no
  // longer loses them (they used to persist ONLY via the separate "Enregistrer
  // la FAQ" button). `faqDirty` gates the fold-in so an untouched FAQ set is
  // never re-written on an unrelated save (the upsert churns rows). The
  // standalone FAQ form/button stays as a secondary path.
  const [faqDirty, setFaqDirty] = useState(false);
  const setFaqItemsDirty: React.Dispatch<React.SetStateAction<CategoryFaqInitial[]>> = (
    value,
  ) => {
    setFaqDirty(true);
    setFaqItems(value);
  };
  // Single serialisation reused by BOTH the main-form fold-in input and the
  // standalone FAQ <form>, so they never drift.
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

  const initialParent = initial?.parentId ?? defaultParentId ?? "";

  // ── Editorial fields — NO defaults. Each field shows exactly what's saved
  // (blank when unset). An empty field means the operator doesn't want that
  // content; the storefront renders nothing for it. Nothing is pre-filled.
  const initialEyebrow = initial?.editorialEyebrow ?? "";
  const initialTitle = initial?.editorialTitle ?? "";
  const initialBody = initial?.editorialBody ?? "";

  // ── Filter attributes — set of attribute IDs ticked as filters on this
  // category. Persisted through the M2M `category_attribute_filters` table
  // via the `setCategoryFilters` workflow, which the create/update category
  // actions invoke after the main category save.
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(
    () => new Set(filterAttributeIds ?? []),
  );
  const toggleFilter = (attrId: string, checked: boolean) =>
    setSelectedFilters((prev) => {
      const next = new Set(prev);
      if (checked) next.add(attrId);
      else next.delete(attrId);
      return next;
    });
  // Live attribute list — seeded from props, grown by the inline creator so a
  // freshly-created attribute appears (and is auto-ticked) without a page reload.
  const [attrList, setAttrList] = useState(attributes ?? []);
  const onAttrCreated = (attr: { id: string; name: string; slug: string }) => {
    setAttrList((prev) => (prev.some((a) => a.id === attr.id) ? prev : [...prev, attr]));
    toggleFilter(attr.id, true);
  };

  return (
    <div className="space-y-5">
    <form id={CATEGORY_FORM_ID} action={formAction} onSubmit={onSubmit} className="space-y-5">
      {mode === "edit" && initial && (
        <input type="hidden" name="categoryId" value={initial.id} />
      )}
      {mode === "edit" && initial && faqDirty && (
        /* Fold-in: once the FAQ tab is edited, its list rides the MAIN save so
           the single "Enregistrer" persists FAQ edits too (no lost FAQ). The
           server upserts best-effort and warns if it fails. */
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
              <Section
                title="Identité"
                description="Nom, slug, hiérarchie et statut de la catégorie."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field name="name" label="Nom" required defaultValue={initial?.name} />
                  <Field
                    name="slug"
                    label="Slug"
                    defaultValue={initial?.slug}
                    helper="Auto si vide. Unique sur tout le site (produits, catégories, marques, pages)."
                  />
                  <Field
                    name="tagline"
                    label="Accroche"
                    defaultValue={initial?.tagline ?? ""}
                    helper="Phrase courte affichée sous le titre."
                  />
                  <Field
                    name="displayOrder"
                    label="Ordre d'affichage"
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={initial?.displayOrder ?? 0}
                  />
                  <Field
                    name="externalRef"
                    label="Référence externe (ERP)"
                    defaultValue={initial?.externalRef ?? ""}
                    helper="Code de liaison avec un système externe (ERP / PIM). Unique ; sert à synchroniser cette catégorie par référence via l'API."
                  />
                  <SelectField
                    name="parentId"
                    label="Catégorie parente"
                    defaultValue={initialParent ?? ""}
                    options={[
                      { value: "", label: "— racine (catégorie principale) —" },
                      ...parents.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                  />
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      type="checkbox"
                      name="isActive"
                      defaultChecked={initial?.isActive ?? true}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                    Active (visible sur la boutique)
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      type="checkbox"
                      name="isDiscountable"
                      defaultChecked={initial?.isDiscountable ?? true}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                    Remises autorisées (sinon : aucune réduction sur ses produits)
                  </label>
                </div>
                <RichTextField
                  name="description"
                  label="Description"
                  helper="Intro longue affichée sous le titre de la page catégorie. HTML mis en forme (comme les fiches produits)."
                  rows={6}
                  defaultValue={initial?.description ?? ""}
                  placeholder="<p>Présentez l'univers de cette catégorie…</p>"
                />
              </Section>
              <Section
                title="Garantie"
                description="Garantie par défaut des produits de cette catégorie. Héritée du réglage global si laissée vide, et surchargeable au niveau de chaque produit. Une sous-catégorie prime sur sa catégorie parente."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    name="warrantyMonths"
                    label="Durée (mois)"
                    type="number"
                    min={0}
                    max={600}
                    step={1}
                    defaultValue={initial?.warrantyMonths ?? ""}
                    helper="Vide = hériter du global. 0 = sans garantie. 24 = 2 ans."
                  />
                  <Field
                    name="warrantyLabel"
                    label="Libellé personnalisé"
                    defaultValue={initial?.warrantyLabel ?? ""}
                    helper="Optionnel. Remplace « Garantie X ans » — ex. « Garantie 1 an »."
                  />
                  <Field
                    name="taxRateBps"
                    label="TVA (%)"
                    type="number"
                    min={0}
                    max={100}
                    step={0.01}
                    defaultValue={
                      initial?.taxRateBps != null
                        ? String(percentFromBps(initial.taxRateBps))
                        : ""
                    }
                    helper="Vide = hérite (global). Ex. 19 = 19 %. Une sous-catégorie prime sur sa parente."
                  />
                </div>
              </Section>
            </FormTab>

            {/* ─── 2. Image hero ──────────────────────────────────────── */}
            <FormTab id="image" active={activeTab}>
              <Section
                title="Image hero"
                description="Bannière large en haut de la page catégorie (1920×1080 recommandé)."
              >
                <MediaPicker
                  name="heroMediaId"
                  value={initial?.heroMediaId ?? null}
                  scope="categories"
                />
              </Section>
              <Section
                title="Image « Boutique » (page de sélection)"
                description="Visuel de la vignette de cette catégorie sur /boutique et dans le bloc « Catégories » de l'accueil. Distinct de l'image hero ci-dessus ; laissé vide, la vignette affiche un dégradé. Recommandé : portrait 4:5 — 1200×1500 px (une photo est recadrée ; un packshot détouré -nobg est centré sur la vitrine)."
              >
                <MediaPicker
                  name="boutiqueImageMediaId"
                  value={initial?.boutiqueImageMediaId ?? null}
                  scope="categories"
                />
              </Section>
              <Section
                title="Icône de listing"
                description="Pastille de la catégorie dans la barre de navigation du listing (icône au choix ou image personnalisée)."
              >
                <IconPicker
                  icon={initial?.icon ?? null}
                  iconMediaId={initial?.iconMediaId ?? null}
                  scope="categories"
                />
              </Section>
            </FormTab>

            {/* ─── 3. Contenu éditorial ───────────────────────────────── */}
            <FormTab id="content" active={activeTab}>
              <GlobalContentNote />
              <Section
                title="Contenu éditorial"
                description="Bloc storytelling affiché sous la liste des produits. Laissez un champ vide pour ne pas l'afficher — rien n'est ajouté par défaut."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    name="editorialEyebrow"
                    label="Eyebrow"
                    defaultValue={initialEyebrow}
                    helper="Ex. L'univers Montres Homme"
                  />
                  <Field
                    name="editorialTitle"
                    label="Titre éditorial"
                    defaultValue={initialTitle}
                    helper="Ex. Plus qu'un rayon. Une obsession."
                  />
                </div>
                <RichTextField
                  name="editorialBody"
                  label="Corps éditorial"
                  helper="Bloc storytelling sous la liste produits. HTML mis en forme."
                  rows={8}
                  defaultValue={initialBody}
                  placeholder="<p>Racontez l'histoire de cette catégorie…</p>"
                />

                <ValuePropsEditor initial={initial?.valueProps ?? null} />
              </Section>
            </FormTab>

            {/* ─── 4. Filtres ─── attribute linker ────────────────────── */}
            <FormTab id="filters" active={activeTab}>
              {/* Admin ticks which attributes apply as filters on the
                  storefront category page; the M2M
                  `category_attribute_filters` set is replaced atomically
                  server-side. */}
              <Section
                title="Filtres de la page catégorie"
                description="Attributs à activer comme filtres sur la page catégorie. Cochez ceux qui s'appliquent — ou créez-en un nouveau directement ici."
                accent
              >
                {/* Hidden inputs read by the server action via
                    formData.getAll("filterAttributeIds"). Always rendered (even
                    with no attributes yet) so the inline creator works and an
                    empty set still wipes the M2M. */}
                {Array.from(selectedFilters).map((id) => (
                  <input key={id} type="hidden" name="filterAttributeIds" value={id} />
                ))}
                {/* Sentinel: always submits the key so the action can wipe the
                    M2M to empty. Filtered out server-side by the UUID regex. */}
                <input type="hidden" name="filterAttributeIds" value="" />

                {/* Inline "create attribute" — creates it (optionally with seed
                    values) and ticks it as a filter in one step. Its action needs
                    attributes:create, so only render it for a viewer who holds that
                    grant (else the submit 404s); ticking existing attributes as
                    filters below stays available to any category editor. */}
                {canCreateAttribute && <CreateFilterAttribute onCreated={onAttrCreated} />}

                {attrList.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-[11px] text-muted-foreground">
                    Aucun attribut pour l&apos;instant. Créez-en un ci-dessus pour
                    l&apos;attacher comme filtre.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {attrList.map((attr) => {
                      const ticked = selectedFilters.has(attr.id);
                      return (
                        <label
                          key={attr.id}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-border bg-background px-4 py-3 text-sm transition hover:bg-surface"
                        >
                          <span className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={ticked}
                              onChange={(e) => toggleFilter(attr.id, e.target.checked)}
                              className="h-4 w-4 accent-[var(--primary)]"
                            />
                            <span className="font-medium text-foreground">{attr.name}</span>
                          </span>
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {attr.slug}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </Section>
            </FormTab>

            {/* ─── 4b. FAQ ────────────────────────────────────────────────
                Like the product form, the FAQ editor lives in a separate
                <form> below the main category form (HTML forbids nested
                forms). The tab body acts as a signpost. */}
            <FormTab id="faq" active={activeTab}>
              {mode === "edit" && initial ? (
                <CategoryFaqEditorBody
                  items={faqItems}
                  setItems={setFaqItemsDirty}
                  state={faqState}
                  pending={faqPending}
                  formId={CATEGORY_FAQ_FORM_ID}
                />
              ) : (
                <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
                  Enregistrez d&apos;abord la catégorie. Vous pourrez ensuite
                  ajouter des questions / réponses depuis sa page d&apos;édition.
                </p>
              )}
            </FormTab>

            {/* ─── 5. SEO ──────────────────────────────────────────────── */}
            <FormTab id="seo" active={activeTab}>
              <Section
                title="SEO"
                description="Méta-titre, méta-description, URL canonique et indexation envoyés aux moteurs de recherche."
              >
                {/* Live Google SERP preview — approximate search-result rendering. */}
                <div className="rounded-2xl border border-border bg-surface/40 p-4">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Aperçu Google — rendu approximatif
                  </p>
                  <div className="space-y-0.5">
                    <p className="truncate text-xs text-emerald-700 dark:text-emerald-400">
                      {SEO_SITE_HOST}/{initial?.slug ?? "votre-categorie"}
                    </p>
                    <p className="truncate text-base font-medium text-[#1a0dab] dark:text-[#8ab4f8]">
                      {metaTitle.trim() || initial?.name || "Nom de la catégorie"}
                    </p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {metaDescription.trim() ||
                        "La méta-description de la catégorie s'affiche ici."}
                    </p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="f-metaTitle"
                        className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                      >
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
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      50–60 caractères. Laisser vide pour utiliser le nom.
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="f-metaDescription"
                        className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                      >
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
                    helper="Optionnel. Replie les URL en double / à facettes sur une URL maître. Vide = /slug."
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
                description="Image affichée lors du partage de la page catégorie sur les réseaux sociaux. À défaut, l'image de partage par défaut du site est utilisée."
              >
                <MediaPicker
                  name="ogImageMediaId"
                  value={initial?.ogImageMediaId ?? null}
                  scope="categories"
                />
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

    {/* Hidden sibling <form> for the FAQ editor — its UI lives in the FAQ tab
        (wired via form=) so HTML form nesting inside the main category form is
        avoided. Carries the serialized FAQ list from the lifted state. */}
    {mode === "edit" && initial && (
      <form id={CATEGORY_FAQ_FORM_ID} action={faqAction} className="hidden">
        <input type="hidden" name="categoryId" value={initial.id} />
        <input type="hidden" name="categorySlug" value={initial.slug} />
        <input type="hidden" name="itemsJson" value={serializedFaqItems} />
      </form>
    )}
    </div>
  );
}

/**
 * Inline category-FAQ editor — same shape as `ProductFaqEditor`. Posts the
 * full FAQ list at once via `upsertCategoryFaqsAction`; the workflow soft-
 * deletes the prior set and inserts the new one transactionally.
 */
function CategoryFaqEditorBody({
  items,
  setItems,
  state,
  pending,
  formId,
}: {
  items: CategoryFaqInitial[];
  setItems: React.Dispatch<React.SetStateAction<CategoryFaqInitial[]>>;
  state: ActionState | null;
  pending: boolean;
  formId: string;
}) {
  const updateItem = (idx: number, patch: Partial<CategoryFaqInitial>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const removeItem = (idx: number) =>
    setItems((prev) => prev.filter((_, i) => i !== idx));

  const addItem = () =>
    setItems((prev) => [
      ...prev,
      {
        question: "",
        answer: "",
        displayOrder: prev.length,
        isPublished: true,
      },
    ]);

  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-3xl border border-border bg-card p-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[14.5px] text-foreground">
              FAQ catégorie
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Questions / réponses affichées sur la page catégorie. Laissez
              vide pour ne pas afficher la section FAQ.
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
              <li
                key={idx}
                className="rounded-2xl border border-border bg-surface/40 p-4"
              >
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
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Question
                    </label>
                    <input
                      type="text"
                      value={item.question}
                      onChange={(e) => updateItem(idx, { question: e.target.value })}
                      placeholder="Ex. Quels modes de paiement acceptez-vous ?"
                      className="mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Réponse
                    </label>
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
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Ordre
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={item.displayOrder}
                        onChange={(e) =>
                          updateItem(idx, {
                            displayOrder: Number.isFinite(Number(e.target.value))
                              ? Number(e.target.value)
                              : 0,
                          })
                        }
                        className="mt-1 h-10 w-full rounded-2xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <label className="flex items-end gap-2 pb-2 text-sm">
                      <input
                        type="checkbox"
                        checked={item.isPublished}
                        onChange={(e) =>
                          updateItem(idx, { isPublished: e.target.checked })
                        }
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

/**
 * Inline "create a filter attribute" form for the category filters tab. Creates
 * the attribute (optionally with comma- or line-separated seed values) via
 * `createCategoryFilterAttributeAction` and hands the new {id,name,slug} back so
 * the parent appends it to the list and ticks it as a filter — no page reload,
 * no detour to /admin/catalog/attributes.
 */
function CreateFilterAttribute({
  onCreated,
}: {
  onCreated: (attr: { id: string; name: string; slug: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [valuesText, setValuesText] = useState("");
  const [kind, setKind] = useState<"multiselect" | "select">("multiselect");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await createCategoryFilterAttributeAction({ name, kind, valuesText });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onCreated(res.attribute);
      setName("");
      setValuesText("");
      setOpen(false);
    } catch {
      setError("Échec de la création. Réessayez.");
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 text-xs font-semibold text-primary transition hover:bg-primary/10"
      >
        <Plus className="h-3.5 w-3.5" /> Nouvel attribut
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-primary/30 bg-surface/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Nouvel attribut de filtre
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Fermer"
          className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Nom
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex. Plateforme, Genre, Couleur"
            className="mt-1 h-10 w-full rounded-2xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Type
          </label>
          <SelectField
            ariaLabel="Type d'attribut"
            size="sm"
            value={kind}
            onChange={(v) => setKind(v as "multiselect" | "select")}
            className="mt-1"
            options={[
              { value: "multiselect", label: "Choix multiple" },
              { value: "select", label: "Choix unique" },
            ]}
          />
        </div>
      </div>
      <div>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Valeurs (optionnel)
        </label>
        <textarea
          value={valuesText}
          onChange={(e) => setValuesText(e.target.value)}
          rows={2}
          placeholder="Une par ligne ou séparées par des virgules — ex. Homme, Femme, Enfants"
          className="mt-1 w-full rounded-2xl border border-border bg-background p-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || !name.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          {pending ? "Création…" : "Créer & cocher"}
        </button>
      </div>
    </div>
  );
}

/**
 * Form section primitive — one labelled card per logical grouping, with a
 * prominent header + subtle description. Setting `accent` gives a
 * primary-tinted border so a particular section (e.g. the filter editor)
 * stands out from the rest.
 */
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
        <h2 className="text-[14.5px] text-foreground">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  name,
  label,
  required,
  type,
  defaultValue,
  helper,
  min,
  max,
  step,
}: {
  name: string;
  label: string;
  required?: boolean;
  type?: string;
  defaultValue?: string | number | null;
  helper?: string;
  /** Native number-input bounds — client affordance only; the server (zod) stays authoritative. */
  min?: number;
  max?: number;
  step?: number;
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
      <input
        id={id}
        name={name}
        type={type ?? "text"}
        required={required}
        defaultValue={defaultValue ?? ""}
        min={min}
        max={max}
        step={step}
        className="mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      {helper && <p className="mt-1 text-[10px] text-muted-foreground">{helper}</p>}
    </div>
  );
}
