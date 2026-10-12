"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  LayoutGrid,
  ListChecks,
  Plus,
  Save,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { RichTextField } from "@/components/admin/_components/rich-text-field";
import { HighlightsEditor } from "@/components/admin/_components/highlights-editor";
import { minorToDinars, dinarsToMinor } from "@/lib/price";
import { percentFromBps } from "@/lib/tax/shared";

import { createProductAction, updateProductAction } from "@/lib/actions/catalog";
import { type ActionState } from "@/lib/actions/types";
import { MediaPicker } from "@/components/admin/media-picker";
import { CareAssignmentPicker } from "@/components/admin/care-assignment-picker";
import {
  FormTab,
  TabbedFormError,
  useNoResetSubmit,
  useTabErrorFocus,
} from "@/components/admin/_components/form-tabs";
import { SelectField } from "@/components/ui/select-field";
import { BrandPicker } from "@/components/admin/_components/brand-picker";
import {
  searchProductsForPickerAction,
  type RelatedProductOption,
} from "@/lib/actions/related-products";
import type { AttributeKind } from "@/modules/catalog/attribute/schema";
import { PRODUCT_FORM_ID, readProductField } from "@/components/admin/_components/product-ai-context";
import {
  ProductPromotionsPanel,
  type ProductPromotionRow,
} from "@/components/admin/product-promotions-panel";
import {
  ProductVariantsEditor,
  type InitialVariant,
} from "@/components/admin/product-variants-editor";

/**
 * Unified product form — create + edit.
 *
 * Pass `mode="create"` and no `initial` to render the empty form.
 * Pass `mode="edit"` with `initial` (full snapshot) to render the editor
 * — every field is pre-populated; saving routes through `updateProductAction`
 * which only patches changed fields.
 *
 * Every editable column on `products` plus association tables (media,
 * category, brand, attribute values) is exposed:
 *
 *   - slug              text, editable (uniqueness checked server-side)
 *   - name              text
 *   - platform / sku    free-form
 *   - price / oldPrice  edited in TND, stored as integer minor units (millimes)
 *   - condition         enum (état)
 *   - shortDesc / desc  text
 *   - inStock / stockQty + publish
 *   - video*            url + poster media + title + caption (Vidéo produit tab)
 *   - displayOrder      sort key (Général tab)
 *   - mediaIds          gallery — drag-reorder via the MediaPicker
 *   - categoryIds       multi-select (checkboxes)
 *   - primaryCategoryId one of the selected category ids
 *   - brandId           single select
 *   - attributeValueIds M2M product↔attribute-value (select/multiselect)
 *
 * UI is split into tabs in the order a merchant naturally builds a product:
 * Essentiel (Général, Prix, Stock — what's needed to publish a sellable SKU)
 * → Classement (Catégorisation, Attributs, Variantes — where it lives + its
 * specs) → Contenu (Description, Média, Vidéo produit,
 * FAQ — how it's presented) → Marketing (Promotions)
 * → Référencement (SEO). Hidden sections stay mounted so the FormData
 * captures every input on submit regardless of which tab is currently
 * visible.
 */

/** One active Tokyo Care plan as shown in the product form's "Tokyo Care" tab. */
export type ProductFormCarePlan = { id: string; name: string; priceSummary: string };

export type ProductFormInitial = {
  id: string;
  slug: string;
  name: string;
  platform: string | null;
  sku: string | null;
  gtin?: string | null;
  mpn?: string | null;
  /** Item condition (état). Defaults to "new" when absent. */
  condition?: "new" | "used" | "refurbished";
  externalRef?: string | null;
  /** Stored Tokyo Care overrides for this product (edit mode) — pre-fills the picker. */
  careLinks?: { carePlanId: string; mode: "include" | "exclude"; overrideDinars: string }[];
  /**
   * Warranty override (global → category → product cascade). `null` ⇒ inherit
   * from the category / global default; a number pins this product's own
   * coverage in months (`0` = explicit "no warranty"). `warrantyLabel` is an
   * optional custom phrase shown instead of the auto "Garantie X ans".
   */
  warrantyMonths?: number | null;
  warrantyLabel?: string | null;
  /**
   * Display-only hint of what this product inherits when `warrantyMonths` is
   * left blank — e.g. "Garantie 2 ans (catégorie)" or "Aucune garantie
   * (réglage global)". Computed by the edit/create page from the cascade so
   * the operator sees the fallback without having to dig.
   */
  warrantyInheritedLabel?: string | null;
  /**
   * Per-product TVA override stored in BASIS POINTS (1900 = 19 %). `null` ⇒
   * inherit (fall back to the matched tax rule / category / global default);
   * a number pins this product's own rate. The admin enters a PERCENT — the
   * field shows `percentFromBps(taxRateBps)` and the action converts it back
   * to bps via `bpsFromPercent`.
   */
  taxRateBps?: number | null;
  productType?: "simple" | "variable";
  /** null = inherit global default, true = shared pool, false = per-variant. */
  sharedVariantStock?: boolean | null;
  shortDesc: string;
  description: string;
  /** "Caractéristiques clés" bullets (ordered, variable count). Empty ⇒ none. */
  highlights?: string[];
  priceCents: number;
  oldPriceCents: number | null;
  inStock: boolean;
  stockQty: number | null;
  /** Min units per order (≥1, null = no minimum). */
  minPurchaseQty: number | null;
  /** Max units per order (≥1, null = no maximum; 1 = sold individually). */
  maxPurchaseQty: number | null;
  videoUrl: string | null;
  /** Video poster media id (MediaPicker value). */
  videoPosterMediaId: string | null;
  videoTitle: string | null;
  videoDescription: string | null;
  displayOrder: number;
  isPublished: boolean;
  /** When false this product never receives any reduction. Defaults true. */
  isDiscountable?: boolean;
  mediaIds: string[];
  categoryIds: string[];
  primaryCategoryId: string | null;
  brandId: string | null;
  // SEO / Référencement (admin "SEO" tab). All optional — empty falls back to
  // the product name / short description / primary image at render time.
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
  noindex?: boolean;
  /** Custom Open Graph / social-share image (MediaPicker value). */
  ogImageMediaId?: string | null;
  /**
   * Official external URLs (schema.org Product.sameAs), one per line. Only
   * editable + emitted when the global `seo.product_sameas_enabled` switch is
   * on (passed as `sameAsEnabled`).
   */
  sameAs?: string | null;
  /** "Vous aimerez aussi" rail mode. Defaults to "auto" (derived rail). */
  relatedMode?: "auto" | "same_subcategory" | "same_brand" | "mixed" | "ai" | "manual";
  /** Curated related products (manual/ai modes), hydrated to cards for the picker. */
  relatedProducts?: RelatedProductOption[];
  /** Curated complementary products ("Accessoires supplémentaires"), hydrated to cards for the picker. */
  complementaryProducts?: RelatedProductOption[];
};

/**
 * Categories shape: the FULL recursive catalog tree (roots → children →
 * … any depth, mirroring `CategoryTreeNode` projected to {id, name,
 * children}). The form renders a storefront-style drill-down picker: the
 * admin navigates into a branch, ticks any nodes at ANY level, and marks one
 * as primary. Selections persist while drilling between branches.
 */
export type ProductFormCategoryNode = {
  id: string;
  name: string;
  children: ProductFormCategoryNode[];
};

/**
 * Attribute + its values, eager-loaded server-side. `kind = "select"`
 * renders as a radio group (one value per attribute); `kind = "multiselect"`
 * renders as checkboxes (zero-to-many values per attribute).
 */
export type ProductFormAttribute = {
  id: string;
  slug: string;
  name: string;
  kind: AttributeKind;
  values: { id: string; slug: string; label: string; colorHex?: string | null }[];
};

type TabId =
  | "general"
  | "price"
  | "stock"
  | "description"
  | "highlights"
  | "media"
  | "categorization"
  | "attributes"
  | "variants"
  | "promotions"
  | "related"
  | "complementary"
  | "care"
  | "faq"
  | "video"
  | "seo";

/**
 * Tab order follows the natural editing flow, grouped by concern:
 *
 *   ── Essentiel (what's needed to publish a sellable SKU) ──
 *     Général · Prix · Stock
 *   ── Classement (where it lives + its filterable specs) ──
 *     Catégorisation · Attributs · Variantes
 *   ── Contenu (how it's presented on its page) ──
 *     Description · Média · Vidéo produit · FAQ
 *   ── Marketing & fulfilment ──
 *     Promotions
 *   ── Référencement ──
 *     SEO
 *
 * `FormTabs` renders the strip straight from this array; the <FormTab>
 * panels below are matched by id, so reordering here is all it takes.
 */
const TABS: { id: TabId; label: string; group: string }[] = [
  // Essentiel — the fields required to publish a sellable product.
  { id: "general", label: "Général", group: "Essentiel" },
  { id: "price", label: "Prix", group: "Essentiel" },
  { id: "stock", label: "Stock", group: "Essentiel" },
  // Classement — where the product lives + its filterable specs.
  { id: "categorization", label: "Catégorisation", group: "Classement" },
  { id: "attributes", label: "Attributs", group: "Classement" },
  { id: "variants", label: "Variantes", group: "Classement" },
  // Contenu — how the product is presented on its page.
  { id: "description", label: "Description", group: "Contenu" },
  { id: "highlights", label: "Caractéristiques clés", group: "Contenu" },
  { id: "media", label: "Média", group: "Contenu" },
  { id: "video", label: "Vidéo produit", group: "Contenu" },
  { id: "faq", label: "FAQ", group: "Contenu" },
  // Marketing — promotions + cross-sell.
  { id: "promotions", label: "Promotions", group: "Marketing" },
  { id: "related", label: "Vous aimerez aussi", group: "Marketing" },
  { id: "complementary", label: "Produits supplémentaires", group: "Marketing" },
  { id: "care", label: "Tokyo Care", group: "Marketing" },
  // Référencement.
  { id: "seo", label: "SEO", group: "Référencement" },
];

const TAB_LABELS = Object.fromEntries(TABS.map((t) => [t.id, t.label])) as Record<
  TabId,
  string
>;
const TAB_ORDER = TABS.map((t) => t.id);

/**
 * Field key → owning tab. Covers the schema keys `flattenZodError` emits
 * (create/update-product), the workflow's keyed conflicts (`slug`/`sku`/`gtin`),
 * AND the action-layer price guard's `priceTnd` key — so any failed submit jumps
 * the operator straight to the tab that holds the offending value instead of
 * leaving it buried on one of ~15 hidden tabs behind a generic banner.
 */
const FIELD_TAB: Record<string, TabId> = {
  name: "general",
  slug: "general",
  platform: "general",
  sku: "general",
  gtin: "general",
  mpn: "general",
  condition: "general",
  externalRef: "general",
  warrantyMonths: "general",
  warrantyLabel: "general",
  productType: "general",
  displayOrder: "general",
  priceTnd: "price",
  priceCents: "price",
  oldPriceCents: "price",
  taxRateBps: "price",
  inStock: "stock",
  stockQty: "stock",
  minPurchaseQty: "stock",
  maxPurchaseQty: "stock",
  sharedVariantStock: "general",
  categoryIds: "categorization",
  primaryCategoryId: "categorization",
  brandId: "categorization",
  attributeValueIds: "attributes",
  attributeScalars: "attributes",
  shortDesc: "description",
  description: "description",
  highlights: "highlights",
  mediaIds: "media",
  videoUrl: "video",
  videoPosterMediaId: "video",
  videoTitle: "video",
  videoDescription: "video",
  relatedMode: "related",
  relatedProductIds: "related",
  complementaryProductIds: "complementary",
  isDiscountable: "promotions",
  metaTitle: "seo",
  metaDescription: "seo",
  canonicalUrl: "seo",
  noindex: "seo",
  ogImageMediaId: "seo",
  sameAs: "seo",
};

/**
 * Visual section grouping for the flat tab strip — PRESENTATION ONLY. The
 * panels (and their ids) are unchanged; this just clusters the tabs under
 * their concern label so the strip is scannable (Essentiel / Classement /
 * Contenu / Marketing / Référencement). The product form renders its OWN
 * grouped strip from this map (rather than the bare shared `FormTabs` strip)
 * so other admin forms that use `FormTabs` are untouched. Every id here must
 * exist in `TABS`; together they cover every tab exactly once.
 */
const TAB_GROUPS: { label: string; ids: TabId[] }[] = [
  { label: "Essentiel", ids: ["general", "price", "stock"] },
  { label: "Classement", ids: ["categorization", "attributes", "variants"] },
  {
    label: "Contenu",
    ids: ["description", "highlights", "media", "video", "faq"],
  },
  { label: "Marketing", ids: ["promotions", "related", "complementary", "care"] },
  { label: "Référencement", ids: ["seo"] },
];

/**
 * Create-mode wizard steps.
 *
 * The wizard is pure PRESENTATION over the very same mounted panels the flat
 * tab strip renders — it just groups the create-relevant panels into an
 * ordered, guided sequence. The edit-only sub-editors
 * (Variantes / FAQ / Promotions-list) are intentionally absent:
 * they need a saved product id, so they only become available once the
 * product exists (on its edit page, after the first save).
 *
 * Every panel listed across these steps stays MOUNTED at all times (hidden
 * via the `hidden` attribute when its step isn't active), so the single
 * `<form>`'s `FormData` captures every input on submit regardless of which
 * step is visible — identical guarantee to the flat-tabs layout.
 */
const WIZARD_STEPS: { id: string; label: string; panels: TabId[] }[] = [
  { id: "essentiel", label: "Essentiel", panels: ["general"] },
  { id: "prix-stock", label: "Prix & stock", panels: ["price", "stock"] },
  { id: "classement", label: "Classement", panels: ["categorization", "attributes"] },
  {
    id: "contenu",
    label: "Contenu & média",
    panels: ["description", "highlights", "media", "video"],
  },
  {
    // "Finalisation" reuses the existing SEO panel, plus the isDiscountable
    // toggle (the only create-relevant part of Promotions); the Publier
    // checkbox + submit live in the action bar below the steps.
    id: "finalisation",
    label: "Finalisation",
    panels: ["promotions", "related", "seo"],
  },
];

export type ProductFaqInitial = {
  question: string;
  answer: string;
  displayOrder: number;
  isPublished: boolean;
};

type Props = {
  mode: "create" | "edit";
  brands: { id: string; name: string; slug: string; isActive?: boolean }[];
  categories: ProductFormCategoryNode[];
  /** Attribute dimensions + their values (eager-loaded). Empty = no attributes defined yet. */
  attributes?: ProductFormAttribute[];
  /** Currently-assigned attribute value IDs for this product (edit mode). */
  productValueIds?: string[];
  /**
   * Currently-saved SCALAR values for kind=number/text attributes (edit mode),
   * keyed by attribute id. Preloads the number/text inputs in the picker.
   */
  initialScalars?: Record<string, { numericValue: number | null; textValue: string | null }>;
  /** Existing FAQs for this product (edit mode only — creates have no FAQ tab content). */
  initialFaqs?: ProductFaqInitial[];
  /** Promotions targeting this product (edit mode only). */
  initialPromotions?: ProductPromotionRow[];
  /** RBAC gates for the inline promotions panel (promotions:create/update/delete). */
  promoCanCreate?: boolean;
  promoCanUpdate?: boolean;
  promoCanDelete?: boolean;
  /** Existing variants for this product (edit mode only). */
  initialVariants?: InitialVariant[];
  /** Active Tokyo Care plans the operator can force-include / exclude on this product. */
  carePlans?: ProductFormCarePlan[];
  /** Plan ids already offered on this product via CATEGORY scope (the "Auto" outcome hint). */
  careScopeOfferedIds?: string[];
  initial?: ProductFormInitial;
  /** Where to send the user after a successful submit. */
  successHref?: string;
  /**
   * Presentation mode for the panels.
   *
   * - `"tabs"` (default) — the flat pill strip; used by EDIT and by the
   *   "Vue complète" toggle. Edit mode is ALWAYS `tabs`.
   * - `"wizard"` — the stepped, guided create flow (create page only).
   *
   * Both layouts render the exact same always-mounted panels, so the single
   * `FormData` submit contract is identical regardless of layout.
   */
  layout?: "tabs" | "wizard";
  /**
   * Whether the global `seo.product_sameas_enabled` master switch (admin SEO
   * tab) is on. Gates the per-product "liens officiels" (sameAs) field — hidden
   * entirely when off, so the feature is opt-in site-wide. Resolved server-side
   * via getSeoConfig and passed by the create / edit pages.
   */
  sameAsEnabled?: boolean;
};

export function ProductForm({
  mode,
  brands,
  categories,
  attributes,
  productValueIds,
  initialScalars,
  initialFaqs,
  initialPromotions,
  promoCanCreate = true,
  promoCanUpdate = true,
  promoCanDelete = true,
  initialVariants,
  carePlans,
  careScopeOfferedIds,
  initial,
  successHref,
  layout = "tabs",
  sameAsEnabled = false,
}: Props) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    mode === "edit" ? updateProductAction : createProductAction,
    null,
  );
  // Dispatch imperatively so a FAILED save keeps every typed value (React 19
  // would otherwise reset the whole form, even on `{ ok: false }`).
  const onSubmit = useNoResetSubmit(formAction, state);

  // The FAQ + Variantes sub-editors have NO save button of their own: they mirror
  // their edited data into this main <form> (hidden `faqItemsJson` / `variantsJson`),
  // and `updateProductAction` folds both into the single product save. So the
  // whole product — every tab — is persisted by the one "Enregistrer" button, and
  // `state` / `isPending` below drive those editors' post-save behaviour.

  // Controlled so the Promotions / FAQ tab bodies share the active tab.
  const [activeTab, setActiveTab] = useState<TabId>("general");

  // LIVE price + old price (TND strings) mirrored from the Prix tab, so a direct
  // markdown (ancien prix > prix) is reflected in the Promotions tab AS THE
  // OPERATOR TYPES. Display-only — the inputs stay uncontrolled (FormData reads
  // them on submit); these just drive the read-only « Réduction directe » banner.
  const [priceLive, setPriceLive] = useState<string>(
    initial?.priceCents != null ? String(minorToDinars(initial.priceCents)) : "",
  );
  const [oldPriceLive, setOldPriceLive] = useState<string>(
    initial?.oldPriceCents != null ? String(minorToDinars(initial.oldPriceCents)) : "",
  );
  const toCents = (v: string): number | null => {
    const n = parseFloat(v.replace(",", "."));
    return Number.isFinite(n) && n > 0 ? dinarsToMinor(n) : null;
  };
  const priceCentsLive = toCents(priceLive);
  const oldPriceCentsLive = toCents(oldPriceLive);
  // A real reduction = an ancien prix strictly above the sale price.
  const priceReduction =
    priceCentsLive != null && oldPriceCentsLive != null && oldPriceCentsLive > priceCentsLive
      ? { oldCents: oldPriceCentsLive, newCents: priceCentsLive }
      : null;

  // On a failed submit, jump to the tab that owns the offending field — a bad
  // price, video URL or meta-length error would otherwise be invisible behind
  // the generic banner on whichever of ~15 hidden tabs it lives.
  useTabErrorFocus({ state, fieldTabMap: FIELD_TAB, tabOrder: TAB_ORDER, setActiveTab });

  const visibleTabs = TABS;

  // Derive the EFFECTIVE active tab: if the selected tab is somehow not in the
  // strip, fall back to Général so the body never goes blank.
  const effectiveActiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : "general";

  // ─── Wizard state (create only) ──────────────────────────────────────
  // `useWizard` lets the admin flip between the guided step layout and the
  // flat "Vue complète (onglets)". Wizard is the DEFAULT for create; edit
  // never enters this branch (layout is always "tabs" there).
  const wizardEnabled = layout === "wizard" && mode === "create";
  const [useWizard, setUseWizard] = useState(true);
  const [step, setStep] = useState(0);
  const showWizard = wizardEnabled && useWizard;

  const currentStep = WIZARD_STEPS[step] ?? WIZARD_STEPS[0];
  const isLastStep = step >= WIZARD_STEPS.length - 1;
  const isFirstStep = step <= 0;
  // Which panels are visible in the wizard right now — only the active
  // step's. Every panel still renders (mounted + hidden), so FormData is
  // unaffected; this just drives the `hidden` attribute per step.
  const stepVisiblePanels = new Set<TabId>(currentStep.panels);

  // Wizard: on a FAILED submit, jump to the STEP that owns the first erroring
  // field. `useTabErrorFocus` above sets the active TAB, but the wizard renders
  // panels by STEP (`stepVisiblePanels`), so a missing name / bad price would
  // stay hidden and the clear error banner would point at an off-screen field.
  // This maps each errored field → its tab (FIELD_TAB) → the step whose panels
  // include that tab, and jumps there. Once-per-state guard (identity-compare
  // the fresh ActionState object) so a manual step change afterwards sticks.
  const stepJumpRef = useRef<ActionState | null>(null);
  useEffect(() => {
    if (!showWizard || !state || state.ok || state === stepJumpRef.current) return;
    stepJumpRef.current = state;
    const errs = state.fieldErrors;
    if (!errs) return;
    const erroredTabs = new Set<TabId>();
    for (const key of Object.keys(errs)) {
      const tab = FIELD_TAB[key];
      if (tab) erroredTabs.add(tab);
    }
    const target = WIZARD_STEPS.findIndex((s) => s.panels.some((p) => erroredTabs.has(p)));
    if (target >= 0) setStep(target);
    // React only to a new `state`; showWizard is stable during a submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // After a successful CREATE, route to the new product's EDIT page so the
  // operator can immediately add variants / FAQ (the edit-only
  // sub-editors that need a saved id). `createProductAction` returns the new
  // id on `state.id`. Edit mode keeps its existing in-place success banner.
  useEffect(() => {
    if (mode === "create" && state?.ok && state.id) {
      router.push(`/admin/catalog/products/${state.id}`);
    }
  }, [mode, state, router]);

  // In the wizard, panel visibility is driven by the active STEP (a step
  // groups several panels), so we override `<FormTab visible>`. In the flat
  // tabs layout we return `undefined` and let `<FormTab>` fall back to its
  // `id === active` check. Either way every panel stays mounted — only the
  // `hidden` attribute flips — so the single FormData captures everything.
  const vis = (id: TabId): boolean | undefined =>
    showWizard ? stepVisiblePanels.has(id) : undefined;

  // ─── AI generation context ───────────────────────────────────────────
  // Built at click time from the LIVE form (latest typed values). The brand
  // is stored as an id in a hidden input, so we resolve its label here where
  // the `brands` list is in scope. The category/attribute candidate lists are
  // built inside their own pickers (which own that data + apply the result).
  const liveBrandLabel = (): string => {
    const id = readProductField("brandId");
    return id ? (brands.find((b) => b.id === id)?.name ?? "") : "";
  };
  // The full set of always-mounted panels. Shared verbatim by the flat tabs
  // layout (driven by `active`) and the wizard (driven by `vis`/step) so the
  // submit contract is identical between the two presentations.
  const renderPanels = (activeTab: TabId) => (
          <>
            {/* ─── Général (Identité) ──────────────────────────────────── */}
            <FormTab id="general" active={activeTab} visible={vis("general")}>
              {/* Wizard-only friendly hint — name (this step) + price (next
                  step) are the practically-required fields. Purely advisory:
                  it never blocks navigation; the server validates on submit. */}
              {showWizard && (
                <p className="rounded-2xl border border-dashed border-primary/30 bg-primary/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                  Pour créer le produit, seuls le{" "}
                  <span className="font-semibold text-foreground">nom</span>{" "}
                  (cette étape) et le{" "}
                  <span className="font-semibold text-foreground">prix</span>{" "}
                  (étape suivante) sont indispensables. Tout le reste est
                  optionnel et modifiable plus tard.
                </p>
              )}
              <Section
                title="Type de produit"
                description="Forme du produit. « Variable » active la gestion des variantes."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    name="productType"
                    label="Type"
                    defaultValue={initial?.productType ?? "simple"}
                    options={[
                      { value: "simple", label: "Simple", description: "Un seul article vendable." },
                      {
                        value: "variable",
                        label: "Variable",
                        description: "Plusieurs variantes (couleur, capacité…) avec leur propre SKU / prix / stock.",
                      },
                    ]}
                    helper="« Variable » débloque l'onglet Variantes : assignez d'abord des valeurs dans Attributs, puis générez les déclinaisons."
                  />
                  <SelectField
                    name="sharedVariantStock"
                    label="Stock des variantes"
                    defaultValue={
                      initial?.sharedVariantStock == null
                        ? "inherit"
                        : initial.sharedVariantStock
                          ? "shared"
                          : "per_variant"
                    }
                    options={[
                      { value: "inherit", label: "Par défaut (réglage global)", description: "Suit le mode défini dans Catalogue → Stock." },
                      { value: "per_variant", label: "Par variante", description: "Chaque variante suit son propre stock." },
                      { value: "shared", label: "Partagé", description: "Toutes les variantes puisent dans le stock du produit (ce champ Stock) — utile quand le stock par variante n'est pas connu." },
                    ]}
                    helper="Produits variables uniquement. En mode « Partagé », le champ Stock ci-dessous est le pool commun à toutes les variantes."
                  />
                </div>
              </Section>
              <Section
                title="Identité"
                description="Nom affiché, identifiant d'URL, références internes (SKU / code-barres) et pastille. Ces champs identifient le produit dans la boutique et le back-office."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    name="name"
                    label="Nom"
                    required
                    defaultValue={initial?.name}
                    helper="Nom commercial affiché partout (fiche, listes, panier, factures). C'est le seul champ obligatoire avec le prix."
                  />
                  <Field
                    name="slug"
                    label="Slug"
                    defaultValue={initial?.slug}
                    helper="Identifiant dans l'URL de la fiche (/mon-slug). Laisser vide pour le générer depuis le nom ; l'unicité est vérifiée à l'enregistrement."
                  />
                  <Field
                    name="sku"
                    label="SKU"
                    defaultValue={initial?.sku ?? ""}
                    helper="Référence interne. Pour un produit variable, c'est le SKU parent."
                  />
                  <Field
                    name="gtin"
                    label="GTIN / UPC / EAN"
                    defaultValue={initial?.gtin ?? ""}
                    helper="Code-barres mondial (8–14 chiffres). Améliore Google Shopping."
                  />
                  <Field
                    name="mpn"
                    label="MPN"
                    defaultValue={initial?.mpn ?? ""}
                    helper="Référence fabricant (Manufacturer Part Number)."
                  />
                  <SelectField
                    name="condition"
                    label="État"
                    defaultValue={initial?.condition ?? "new"}
                    options={[
                      { value: "new", label: "Neuf", description: "Produit neuf, sous emballage." },
                      { value: "used", label: "Occasion", description: "Produit déjà utilisé." },
                      {
                        value: "refurbished",
                        label: "Reconditionné",
                        description: "Remis à neuf / testé.",
                      },
                    ]}
                    helper="État du produit. Alimente la fiche (« Détails ») et Google Shopping (itemCondition)."
                  />
                  <Field
                    name="externalRef"
                    label="Référence externe (ERP)"
                    defaultValue={initial?.externalRef ?? ""}
                    helper="Code de liaison avec un système externe (ERP / PIM). Unique ; utilisé par l'API pour synchroniser ce produit par référence. Distinct du SKU."
                  />
                  <Field
                    name="displayOrder"
                    label="Ordre d'affichage"
                    type="number"
                    defaultValue={initial?.displayOrder ?? 0}
                    helper="Plus bas = affiché en premier dans les listes."
                  />
                </div>
                {/* Preserve any existing `platform` value across saves —
                    the column is still read by the storefront for legacy
                    rows, but new SKUs should carry their characteristics via
                    the Attributs tab (mouvement, matière, étanchéité…) so
                    filtering + faceting work consistently. */}
                {initial?.platform && (
                  <input type="hidden" name="platform" value={initial.platform} />
                )}
                <p className="rounded-2xl border border-dashed border-border bg-surface/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                  Les caractéristiques (mouvement, matière, étanchéité…) sont
                  gérées comme des attributs. Renseignez-les depuis l&apos;onglet{" "}
                  <span className="font-medium text-foreground">Attributs</span>{" "}
                  pour qu&apos;elles alimentent les filtres de catégorie.
                </p>
              </Section>
              <Section
                title="Garantie"
                description="Surcharge la garantie héritée de la catégorie et du réglage global. Laisser vide pour hériter automatiquement."
              >
                {initial?.warrantyInheritedLabel && (
                  <p className="-mt-1 mb-4 inline-flex flex-wrap items-center gap-1.5 rounded-2xl border border-dashed border-border bg-surface/40 px-3.5 py-2 text-xs leading-relaxed text-muted-foreground">
                    Hérité si laissé vide :{" "}
                    <span className="font-semibold text-foreground">
                      {initial.warrantyInheritedLabel}
                    </span>
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    name="warrantyMonths"
                    label="Durée (mois)"
                    type="number"
                    defaultValue={initial?.warrantyMonths ?? ""}
                    helper="Vide = hériter. 0 = sans garantie (force l'absence). 24 = 2 ans."
                  />
                  <Field
                    name="warrantyLabel"
                    label="Libellé personnalisé"
                    defaultValue={initial?.warrantyLabel ?? ""}
                    helper="Optionnel. Remplace l'intitulé auto « Garantie 2 ans ». Un « X » isolé est remplacé par la durée saisie — ex. « Garantie constructeur X » → « Garantie constructeur 2 ans »."
                  />
                </div>
              </Section>
            </FormTab>

            {/* ─── Prix ────────────────────────────────────────────────── */}
            <FormTab id="price" active={activeTab} visible={vis("price")}>
              <Section
                title="Prix"
                description="Prix de vente, ancien prix et devise. Les montants sont saisis en dinars et stockés en millimes. Pour un produit variable, chaque variante peut redéfinir son propre prix dans l'onglet Variantes."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    name="priceTnd"
                    label="Prix (TND)"
                    type="number"
                    step="0.001"
                    required
                    defaultValue={
                      initial?.priceCents != null
                        ? minorToDinars(initial.priceCents)
                        : undefined
                    }
                    onChange={setPriceLive}
                    helper="Prix de vente affiché. En dinars ; les décimales sont des millimes (ex. 249,900 = 249 DT 900)."
                  />
                  <Field
                    name="oldPriceTnd"
                    label="Ancien prix (TND)"
                    type="number"
                    step="0.001"
                    defaultValue={
                      initial?.oldPriceCents != null
                        ? minorToDinars(initial.oldPriceCents)
                        : ""
                    }
                    onChange={setOldPriceLive}
                    helper="Prix de référence barré. S'il est supérieur au prix de vente, la fiche affiche l'ancien prix rayé + le pourcentage de remise. Laisser vide pour ne rien barrer."
                  />
                  {/* Currency is a STORE-GLOBAL setting now (Commandes → Devises),
                      not per-product — the old €/TND selector was removed. */}
                  <Field
                    name="taxRateBps"
                    label="TVA (%)"
                    type="number"
                    step="0.01"
                    defaultValue={
                      initial?.taxRateBps != null
                        ? percentFromBps(initial.taxRateBps)
                        : ""
                    }
                    helper="Taux de TVA propre à ce produit. Vide = hériter (règle fiscale / catégorie / global). 0 = sans TVA. Ex. 19 = 19 %."
                  />
                </div>
              </Section>
            </FormTab>

            {/* ─── Stock ───────────────────────────────────────────────── */}
            {/* The stock surface on the per-product form sets the *initial*
                values for this SKU. Bulk inventory ops (import from API,
                CSV upload, audit log) belong on the global stock page at
                /admin/catalog/stock. */}
            <FormTab id="stock" active={activeTab} visible={vis("stock")}>
              <Section
                title="Stock"
                description="Disponibilité et quantité pour ce produit. Pour ajuster plusieurs produits en même temps, utilisez la page Stock du catalogue."
              >
                {/* Keyed on the loaded stock so the inputs AND their hidden
                    page-load twins below re-seed together whenever the server
                    values change (after a save / revalidation) — the pair must
                    never disagree, or an untouched field would read as an edit. */}
                <div
                  key={`${initial?.stockQty ?? ""}:${initial?.inStock ?? ""}`}
                  className="grid items-start gap-4 sm:grid-cols-2"
                >
                  <CheckboxCard
                    name="inStock"
                    title="En stock"
                    defaultChecked={initial?.inStock ?? true}
                    description="Disponibilité affichée sur la fiche : coché = « En stock » + bouton d'achat actif ; décoché = « Rupture de stock ». Une quantité remise au-dessus de 0 sur un produit épuisé le remet en vente."
                  />
                  <Field
                    name="stockQty"
                    label="Quantité en stock"
                    type="number"
                    min={0}
                    defaultValue={initial?.stockQty ?? ""}
                    helper="Nombre d'unités vendables. Laisser vide = ne pas suivre les quantités. Pour un produit à clés, c'est le minimum : ajouter des clés l'augmente."
                  />
                  {/* Edit only: the values this page loaded. The save writes stock
                      ONLY when the operator changed it, and refuses if the stock
                      moved meanwhile (a sale) — so saving an unrelated field can
                      never resurrect a sold unit. */}
                  {mode === "edit" && initial && (
                    <>
                      <input type="hidden" name="stockQtyOriginal" value={initial.stockQty ?? ""} />
                      <input type="hidden" name="inStockOriginal" value={initial.inStock ? "on" : ""} />
                    </>
                  )}
                </div>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <Field
                    name="minPurchaseQty"
                    label="Quantité minimum par commande"
                    type="number"
                    min={1}
                    defaultValue={initial?.minPurchaseQty ?? ""}
                    helper="Le client doit en commander au moins ce nombre. Vide ou 1 = aucun minimum."
                  />
                  <Field
                    name="maxPurchaseQty"
                    label="Quantité maximum par commande"
                    type="number"
                    min={1}
                    defaultValue={initial?.maxPurchaseQty ?? ""}
                    helper="Plafond par commande pour ce produit. Vide = illimité. 1 = vendu à l'unité."
                  />
                </div>
                <Link
                  href="/admin/catalog/stock"
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-4 text-xs font-medium text-muted-foreground transition hover:bg-surface hover:text-foreground"
                >
                  Voir l&apos;inventaire global →
                </Link>
              </Section>
            </FormTab>

            {/* ─── Description ─────────────────────────────────────────── */}
            {/* Both fields accept HTML — rendered with DOMPurify on the
                storefront. Admins type raw HTML; a helper block lists the
                supported tags so they don't have to guess. */}
            <FormTab id="description" active={activeTab} visible={vis("description")}>
              <Section
                title="Description courte"
                description="Affichée juste sous le titre du produit (en-tête de la fiche). Garder concis : 1–2 phrases."
              >
                <RichTextField
                  name="shortDesc"
                  rows={3}
                  defaultValue={initial?.shortDesc}
                  placeholder="<p>Une montre automatique au boîtier acier, bracelet cuir et étanchéité 50 m.</p>"
                />
              </Section>
              <Section
                title="Description complète"
                description="Onglet « Description » de la fiche produit. Idéal pour les paragraphes détaillés, les listes et les liens."
              >
                <RichTextField
                  name="description"
                  rows={14}
                  defaultValue={initial?.description}
                  placeholder={`<p>Présentation détaillée du produit…</p>\n<ul>\n  <li>Premier point</li>\n  <li>Second point</li>\n</ul>`}
                />
              </Section>
            </FormTab>

            {/* ─── Caractéristiques clés ───────────────────────────────── */}
            <FormTab id="highlights" active={activeTab} visible={vis("highlights")}>
              <Section
                title="Caractéristiques clés"
                description="Puces mises en avant en haut de la fiche produit (ex : « Neuf · testé par nos techniciens », « Facture officielle incluse »). Ordre et nombre libres. Laisser vide pour afficher automatiquement les attributs du produit."
              >
                <HighlightsEditor initial={initial?.highlights ?? []} />
              </Section>
            </FormTab>

            {/* ─── Média ───────────────────────────────────────────────── */}
            <FormTab id="media" active={activeTab} visible={vis("media")}>
              <Section
                title="Média"
                description="Galerie d'images de la fiche produit. La première image est utilisée comme visuel principal."
              >
                <MediaPicker
                  name="mediaIds"
                  multi
                  value={initial?.mediaIds ?? []}
                  label="Galerie d'images (premier = principale)"
                  scope="products"
                />
              </Section>
            </FormTab>

            {/* ─── Catégorisation ──────────────────────────────────────── */}
            <FormTab id="categorization" active={activeTab} visible={vis("categorization")}>
              <Section
                title="Catégorisation"
                description="Marque + emplacement dans l'arbre des catégories. Choisissez d'abord la catégorie racine, puis cochez les sous-catégories où ce produit doit apparaître."
              >
                <BrandPicker
                  name="brandId"
                  defaultBrandId={initial?.brandId ?? null}
                  brands={brands}
                />
                <CategoryTreePicker
                  categories={categories}
                  initialPrimary={initial?.primaryCategoryId ?? null}
                  initialSelected={initial?.categoryIds ?? []}
                />
              </Section>
            </FormTab>

            {/* ─── Attributs (M2M) ─────────────────────────────────────── */}
            <FormTab id="attributes" active={activeTab} visible={vis("attributes")}>
              <Section
                title="Attributs"
                description="Valeurs d'attributs portées par ce produit. Sert à alimenter les filtres de catégorie."
              >
                <AttributesPicker
                  attributes={attributes ?? []}
                  initialSelected={productValueIds ?? []}
                  initialScalars={initialScalars ?? {}}
                />
              </Section>
            </FormTab>

            {/* ─── Variantes ───────────────────────────────────────────────
                Edit-mode only — the editor needs the saved product id + its
                assigned attribute values to generate combinations. Saves via
                its own action (separate from the main product save). */}
            <FormTab id="variants" active={activeTab} visible={vis("variants")}>
              <Section
                title="Variantes"
                description="Déclinaisons vendables d'un produit variable (couleur, capacité…), chacune avec son propre SKU, prix et stock. Générez-les depuis les valeurs d'attributs assignées dans l'onglet Attributs."
              >
                {mode === "edit" && initial ? (
                  <ProductVariantsEditor
                    // Re-seed from the server whenever the saved variant SET
                    // changes (a save that inserted/removed rows): new rows then
                    // carry their real ids + page-load stock, instead of being
                    // re-inserted (fresh ids) on the next save.
                    key={(initialVariants ?? []).map((v) => v.id).join(",")}
                    attributes={attributes ?? []}
                    selectedValueIds={productValueIds ?? []}
                    basePriceCents={initial.priceCents}
                    productName={initial.name}
                    productSku={initial.sku}
                    productStockQty={initial.stockQty}
                    initial={initialVariants ?? []}
                    // Persisted by the ONE product save; these drive the editor's
                    // post-save stock re-baseline + dirty reset.
                    state={state}
                    pending={isPending}
                  />
                ) : (
                  <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
                    Enregistrez d&apos;abord le produit, puis revenez pour générer et gérer ses variantes.
                  </p>
                )}
              </Section>
            </FormTab>

            {/* ─── Promotions ──────────────────────────────────────────────
                Rendered INSIDE the tab. Its toggle/delete buttons are
                type="button" + onClick server actions; "Nouvelle promotion" is a
                type="button" that opens CreatePromotionModal, whose reused
                PromotionForm <form> is portaled to <body> — so no second <form>
                is ever nested inside the main product form. */}
            <FormTab id="promotions" active={activeTab} visible={vis("promotions")}>
              <Section
                title="Remises & réductions"
                description="Contrôlez si ce produit peut recevoir des réductions."
              >
                <CheckboxCard
                  name="isDiscountable"
                  title="Autoriser les remises sur ce produit"
                  defaultChecked={initial?.isDiscountable ?? true}
                  description="Décochez pour bloquer toute réduction — promotion automatique, code promo et les points — quoi qu'il arrive. Une catégorie marquée « non remisable » impose aussi ce blocage à ses produits."
                />
              </Section>
              {mode === "edit" && initial ? (
                <ProductPromotionsPanel
                  productId={initial.id}
                  productName={initial.name}
                  promotions={initialPromotions ?? []}
                  priceReduction={priceReduction}
                  canCreate={promoCanCreate}
                  canUpdate={promoCanUpdate}
                  canDelete={promoCanDelete}
                />
              ) : (
                <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
                  Enregistrez d&apos;abord le produit. Vous pourrez ensuite
                  créer une promotion ciblée depuis sa page d&apos;édition.
                </p>
              )}
            </FormTab>

            {/* ─── Vous aimerez aussi (cross-sell) ─────────────────────────
                Controls the storefront related-products rail: a derived mode
                (category/brand/mix) OR a curated list (manual search / AI). */}
            <FormTab id="related" active={activeTab} visible={vis("related")}>
              <Section
                title="Vous aimerez aussi"
                description="Choisissez comment le carrousel de produits recommandés est rempli sur la fiche produit."
              >
                <RelatedProductsPicker
                  initialMode={initial?.relatedMode ?? "auto"}
                  initialSelected={initial?.relatedProducts ?? []}
                  currentSlug={initial?.slug ?? null}
                  brandLabel={liveBrandLabel}
                />
              </Section>
            </FormTab>

            {/* ─── Produits supplémentaires (manual-only cross-sell) ─────────
                A second, curated product↔product relation rendered on the PDP
                as small cards under "Produits Supplémentaires" ("Complétez votre
                achat"). No mode / AI: the section appears only when products are
                hand-picked here. Label kept in lockstep with the storefront
                heading so the control is discoverable. */}
            <FormTab id="complementary" active={activeTab} visible={vis("complementary")}>
              <Section
                title="Produits supplémentaires"
                description="Sélectionnez les produits proposés en complément sur la fiche produit (section « Produits Supplémentaires »). La section n'apparaît que si vous en choisissez."
              >
                <ComplementaryProductsPicker
                  initialSelected={initial?.complementaryProducts ?? []}
                  currentSlug={initial?.slug ?? null}
                />
              </Section>
            </FormTab>

            {/* ─── Tokyo Care ──────────────────────────────────────────────
                Per-product protection-plan overrides (force include / exclude +
                optional price). Mirrors into the main <form> via hidden
                `careMode.<id>` / `careOverride.<id>` inputs, parsed by
                `pickCareLinks` and persisted in the single product save. */}
            <FormTab id="care" active={activeTab} visible={vis("care")}>
              <Section
                title="Tokyo Care"
                description="Garanties bonus (protection) proposées sur ce produit. Par défaut, chaque plan suit son périmètre de catégories ; forcez-le ici pour ce produit si besoin. La TVA du service se règle dans Système → Taxes."
              >
                <CareAssignmentPicker
                  plans={carePlans ?? []}
                  scopeOfferedIds={careScopeOfferedIds ?? []}
                  initial={initial?.careLinks ?? []}
                />
              </Section>
            </FormTab>

            {/* ─── FAQ ─────────────────────────────────────────────────────
                Rendered INSIDE the tab. No save button of its own: once edited,
                the editor mirrors its list into the main product <form> (hidden
                `faqItemsJson`), and the single "Enregistrer" persists it via
                `updateProductAction`. Edit-only (needs a productId). */}
            <FormTab id="faq" active={activeTab} visible={vis("faq")}>
              {mode === "edit" && initial ? (
                <ProductFaqEditorBody
                  initialFaqs={initialFaqs ?? []}
                />
              ) : (
                <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
                  Enregistrez d&apos;abord le produit. Vous pourrez ensuite
                  ajouter des questions / réponses depuis sa page d&apos;édition.
                </p>
              )}
            </FormTab>

            {/* ─── Vidéo produit ───────────────────────────────────────────
                Drives the PDP video section. Every part is editable here:
                the source URL, the poster shown before play, and the
                heading + caption. Leaving the URL empty hides the whole
                section on the storefront. ("Publier" lives in the action
                bar, "Ordre d'affichage" in the Général tab.) */}
            <FormTab id="video" active={activeTab} visible={vis("video")}>
              <Section
                title="Vidéo produit"
                description="Section vidéo affichée sur la fiche produit. Laissez l'URL vide pour masquer complètement la section."
              >
                <Field
                  name="videoUrl"
                  label="URL de la vidéo"
                  type="url"
                  defaultValue={initial?.videoUrl ?? ""}
                  helper="YouTube (watch, youtu.be, shorts), ou une URL MP4 directe. Vide = pas de section vidéo."
                />

                <div>
                  <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                    Affichée avant la lecture de la vidéo. Laisser vide pour
                    utiliser l&apos;image principale du produit.
                  </p>
                  <MediaPicker
                    name="videoPosterMediaId"
                    value={initial?.videoPosterMediaId ?? null}
                    scope="products"
                    label="Image d'aperçu (poster)"
                    emptyLabel="Choisir un poster"
                  />
                </div>

                <div className="grid gap-4">
                  <Field
                    name="videoTitle"
                    label="Titre de la section"
                    defaultValue={initial?.videoTitle ?? ""}
                    helper="Ex. : « La Rolex en action ». Laissez vide pour ne pas afficher de titre."
                  />
                  <Field
                    name="videoDescription"
                    label="Légende"
                    textarea
                    rows={2}
                    defaultValue={initial?.videoDescription ?? ""}
                    helper="Court texte sous le titre. Laissez vide pour ne rien afficher."
                  />
                </div>
              </Section>
            </FormTab>

            {/* ─── SEO / Référencement ──────────────────────────────────────
                Per-product search + social overrides. All optional — empty
                fields fall back to the product name / short description /
                primary image at render (see [slug]/page generateMetadata +
                the Product JSON-LD). */}
            <FormTab id="seo" active={activeTab} visible={vis("seo")}>
              <Section
                title="SEO / Référencement"
                description="Surcharges pour les moteurs de recherche et les aperçus sur les réseaux sociaux. Laissez les champs vides pour réutiliser le nom et la description courte du produit."
              >
                <SeoFields
                  initialName={initial?.name ?? ""}
                  initialSlug={initial?.slug ?? ""}
                  initialShortDesc={initial?.shortDesc ?? ""}
                  initialMetaTitle={initial?.metaTitle ?? ""}
                  initialMetaDescription={initial?.metaDescription ?? ""}
                />

                <Field
                  name="canonicalUrl"
                  label="URL canonique"
                  type="url"
                  defaultValue={initial?.canonicalUrl ?? ""}
                  helper="Vide = l'URL du produit. À renseigner pour pointer une variante / un doublon vers la fiche principale (évite le contenu dupliqué)."
                />

                {/* Per-product schema.org sameAs — only shown when the global
                    master switch (Réglages → SEO) is on. Hidden ⇒ the field
                    isn't submitted, so any saved value is preserved untouched. */}
                {sameAsEnabled && (
                  <Field
                    name="sameAs"
                    label="Liens officiels (sameAs)"
                    textarea
                    rows={3}
                    defaultValue={initial?.sameAs ?? ""}
                    helper="Facultatif. Une URL par ligne (jusqu'à 10) pointant vers le MÊME produit sur un site officiel (page constructeur, boutique officielle…). Émis dans les données structurées (Product.sameAs). Les URL invalides ou non http(s) sont ignorées."
                  />
                )}

                <div>
                  <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                    Affichée lors du partage sur les réseaux sociaux et la
                    messagerie. Laisser vide pour utiliser l&apos;image
                    principale. (WebP / JPG — l&apos;AVIF n&apos;est pas rendu de
                    façon fiable par tous les réseaux.)
                  </p>
                  <MediaPicker
                    name="ogImageMediaId"
                    value={initial?.ogImageMediaId ?? null}
                    scope="products"
                    label="Image de partage (Open Graph)"
                    emptyLabel="Choisir une image sociale"
                  />
                </div>

                <CheckboxCard
                  name="noindex"
                  title="Exclure des moteurs de recherche (noindex)"
                  defaultChecked={initial?.noindex ?? false}
                  description="Le produit reste visible sur la boutique mais n'apparaît pas dans Google. Utile pour les fiches fines, en double, ou en déstockage — sans avoir à le dépublier."
                />
              </Section>
            </FormTab>
          </>
  );

  return (
    <div className="space-y-5">
      <form
        id={PRODUCT_FORM_ID}
        action={formAction}
        onSubmit={onSubmit}
        // noValidate: the required fields (nom, prix) live on panels that are
        // mounted-but-`hidden` when their tab/step isn't active. The browser
        // CANNOT focus a hidden invalid control, so native constraint validation
        // would block the submit SILENTLY (a console-only "not focusable"
        // warning, no visible message). Disabling it routes every submit to the
        // server, which returns clear field errors that <TabbedFormError> shows
        // and useTabErrorFocus / the wizard step-jump bring on screen. The
        // `required` attributes stay for semantics / a11y. Pre-hydration the
        // server action is still the fallback and validates all the same.
        noValidate
        className="space-y-5"
      >
      {mode === "edit" && initial && (
        <input type="hidden" name="productId" value={initial.id} />
      )}

      {/* Layout switch — wizard exposes a "Vue complète (onglets)" toggle so
          the operator can drop into the familiar flat-tabs editing surface at
          any point and come back. The toggle only renders in create+wizard;
          edit always shows the flat tabs with no toggle. The PANELS are
          identical between layouts — only their chrome differs — so flipping
          never drops a pending input value. */}
      {wizardEnabled && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-border bg-surface/40 px-4 py-2.5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {useWizard
              ? "Mode assisté — avancez étape par étape. Vous pourrez ajouter variantes et FAQ après la création."
              : "Vue complète — tous les onglets sur une seule page."}
          </p>
          <button
            type="button"
            onClick={() => setUseWizard((v) => !v)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs font-semibold text-foreground transition hover:bg-surface"
          >
            {useWizard ? (
              <>
                <LayoutGrid className="h-3.5 w-3.5" /> Vue complète (onglets)
              </>
            ) : (
              <>
                <ListChecks className="h-3.5 w-3.5" /> Mode assisté (étapes)
              </>
            )}
          </button>
        </div>
      )}

      {wizardEnabled ? (
        // CREATE path. One stable shell hosts BOTH the step indicator and the
        // full tab strip — toggling between them only swaps the HEADER, never
        // the panel body, so the always-mounted panels (and any sub-editor
        // state) survive a switch. `renderPanels` is driven by step (wizard)
        // or by `activeTab` (full view); either way every panel stays mounted.
        <WizardShell
          mode={useWizard ? "steps" : "tabs"}
          steps={WIZARD_STEPS}
          step={step}
          onStepChange={setStep}
          tabs={visibleTabs}
          activeTab={effectiveActiveTab}
          onActiveTabChange={setActiveTab}
        >
          {renderPanels(effectiveActiveTab)}
        </WizardShell>
      ) : (
        // EDIT (and any plain-tabs usage) — grouped flat tab strip. Same
        // always-mounted panel set as before; only the strip chrome changed
        // (sections), and it lives in a LOCAL shell so the shared FormTabs is
        // untouched for other admin forms.
        <ProductTabsShell
          tabs={visibleTabs}
          activeTab={effectiveActiveTab}
          onActiveTabChange={setActiveTab}
        >
          {renderPanels(effectiveActiveTab)}
        </ProductTabsShell>
      )}

      <TabbedFormError
        state={state}
        fieldTabMap={FIELD_TAB}
        tabLabels={TAB_LABELS}
        onJumpToTab={setActiveTab}
      />

      {showWizard ? (
        /* ─── Wizard action bar ──────────────────────────────────────────
            Précédent / Suivant navigate the steps; the submit
            ("Créer le produit") shows ONLY on the last step. The Publier
            checkbox lives here too (last-step "Finalisation"), inside the
            main <form>, so FormData captures it like every other field. */
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={isFirstStep}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-border px-5 text-sm font-medium transition hover:bg-surface disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> Précédent
          </button>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {isLastStep && (
              <CheckboxCard
                name="publish"
                title="Publier le produit"
                defaultChecked={initial?.isPublished ?? false}
                compact
              />
            )}
            {isLastStep ? (
              <button
                type="submit"
                disabled={isPending}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {isPending ? "Création…" : "Créer le produit"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  setStep((s) => Math.min(WIZARD_STEPS.length - 1, s + 1))
                }
                className="inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background"
              >
                Suivant <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Publish toggle — always visible in the action bar regardless of
              the active tab. Lives inside the main <form>, so FormData
              captures it on submit like any tab field. */}
          <CheckboxCard
            name="publish"
            title="Publier le produit"
            defaultChecked={initial?.isPublished ?? false}
            compact
          />

          <div className="flex gap-2">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {isPending ? "Enregistrement…" : mode === "create" ? "Créer" : "Enregistrer"}
          </button>
          {successHref && (
            <Link
              href={successHref}
              className="inline-flex h-11 items-center gap-2 rounded-full border border-border px-5 text-sm font-medium"
            >
              <X className="h-4 w-4" /> Annuler
            </Link>
          )}
          </div>
        </div>
      )}
    </form>
    </div>
  );
}

/**
 * Create-page shell.
 *
 * Mirrors the `FormTabs` card (one rounded-3xl rectangle hosting a sticky
 * header + the panel body) and is the SINGLE stable wrapper for the create
 * path. Its header switches by `mode`:
 *
 *   - `"steps"` — a numbered, labelled STEP INDICATOR (the assisted wizard):
 *     each step shows its number (or a check once completed) + its label,
 *     current highlighted, completed marked, all clickable to jump.
 *   - `"tabs"` — the same flat pill strip as `FormTabs` ("Vue complète").
 *
 * Because this one component wraps the panels in BOTH modes, toggling the
 * header never unmounts the body — the always-mounted panels (and any
 * sub-editor state typed before the toggle) are preserved.
 *
 * Crucially this is PURE CHROME: `children` is the full, always-mounted set
 * of panels passed straight through from `ProductForm`. The shell only
 * influences which panels are un-`hidden` (via each panel's `visible` prop,
 * computed by the parent from the active step/tab), so the single `FormData`
 * still captures every input regardless of what's visible.
 */
function WizardShell({
  mode,
  steps,
  step,
  onStepChange,
  tabs,
  activeTab,
  onActiveTabChange,
  children,
}: {
  mode: "steps" | "tabs";
  steps: { id: string; label: string; panels: TabId[] }[];
  step: number;
  onStepChange: (next: number) => void;
  tabs: ReadonlyArray<{ id: TabId; label: string }>;
  activeTab: TabId;
  onActiveTabChange: (next: TabId) => void;
  children: React.ReactNode;
}) {
  const active = steps[step] ?? steps[0];
  // "Vue complète" (tabs) mode → the shared top tab-bar card.
  if (mode === "tabs") {
    return (
      <TabbedProductCard tabs={tabs} activeTab={activeTab} onActiveTabChange={onActiveTabChange}>
        {children}
      </TabbedProductCard>
    );
  }
  // "steps" mode → the guided create wizard: a top step indicator + body.
  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-soft">
      <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-3 py-3 backdrop-blur sm:px-5">
        {/* Step indicator — numbered + labelled; current highlighted,
            completed steps show a check. */}
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
              {steps.map((s, i) => {
                const isCurrent = i === step;
                const isDone = i < step;
                return (
                  <li key={s.id} className="flex items-center">
                    <button
                      type="button"
                      onClick={() => onStepChange(i)}
                      aria-current={isCurrent ? "step" : undefined}
                      className={`inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3 text-xs font-semibold transition ${
                        isCurrent
                          ? "bg-foreground text-background shadow-soft"
                          : "text-muted-foreground hover:bg-surface hover:text-foreground"
                      }`}
                    >
                      <span
                        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                          isCurrent
                            ? "bg-background text-foreground"
                            : isDone
                              ? "bg-primary/15 text-primary"
                              : "bg-surface text-muted-foreground"
                        }`}
                      >
                        {isDone ? <Check className="h-3.5 w-3.5" /> : i + 1}
                      </span>
                      <span className="whitespace-nowrap">{s.label}</span>
                    </button>
                    {i < steps.length - 1 && (
                      <span
                        aria-hidden
                        className="mx-1 hidden h-px w-5 bg-border sm:block"
                      />
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="mt-2 px-1.5 text-xs text-muted-foreground">
              Étape{" "}
              <span className="font-semibold text-foreground">{step + 1}</span>{" "}
              sur {steps.length} ·{" "}
              <span className="font-semibold text-foreground">{active.label}</span>
            </p>
      </div>

      {/* Panel body — receives ALL panels (mounted); only the active
          step's/tab's are un-hidden, the rest stay mounted+hidden. */}
      <div className="p-5 sm:p-6">{children}</div>
    </div>
  );
}

/** Resolve the visible tab groups: TAB_GROUPS filtered to the tabs actually
 *  present, with an "Autres" safety-net cluster so a tab can never go
 *  unreachable. Used by the product tab bar (TabbedProductCard). */
function buildTabGroups(
  tabs: ReadonlyArray<{ id: TabId; label: string }>,
): { label: string; ids: TabId[] }[] {
  const present = new Set(tabs.map((t) => t.id));
  const grouped = new Set<TabId>();
  const groups = TAB_GROUPS.map((g) => {
    const ids = g.ids.filter((id) => {
      if (!present.has(id)) return false;
      grouped.add(id);
      return true;
    });
    return { label: g.label, ids };
  }).filter((g) => g.ids.length > 0);
  const ungrouped = tabs.filter((t) => !grouped.has(t.id));
  if (ungrouped.length > 0) groups.push({ label: "Autres", ids: ungrouped.map((t) => t.id) });
  return groups;
}

/**
 * Product form chrome — a top tab bar of per-section ivory "tubes" that FLOW
 * inline. Each section (Essentiel / Classement / Contenu / Marketing /
 * Référencement) is its own tube (gold inline label + pills; the active tab is a
 * raised white pill), but the tubes pack left-to-right and a tube's tabs spill
 * onto the next line when they don't all fit — `box-decoration-clone` repaints the
 * tube background on each wrapped line so it reads as one tube spanning two rows.
 * No dead space between sections; the panel body keeps the full width.
 *
 * Pure chrome: `children` is the full set of always-mounted panels; selecting a
 * tab only flips which panel is un-`hidden`, so the single-FormData contract is
 * unchanged.
 */
function TabbedProductCard({
  tabs,
  activeTab,
  onActiveTabChange,
  children,
}: {
  tabs: ReadonlyArray<{ id: TabId; label: string }>;
  activeTab: TabId;
  onActiveTabChange: (next: TabId) => void;
  children: React.ReactNode;
}) {
  const labelById = new Map(tabs.map((t) => [t.id, t.label] as const));
  const groups = buildTabGroups(tabs);

  return (
    <div className="rounded-[28px] border border-border bg-card p-4 sm:p-5">
      {/* Narrow screens — the mockup's product-detail mobile sub-tabs: a single
          horizontal scroll row of pills, grouped by a small crimson label. */}
      <div className="mb-4 -mx-1 overflow-x-auto px-1 [scrollbar-width:none] lg:hidden">
        <div className="flex w-max items-center gap-1.5">
          {groups.map((g) => (
            <div key={g.label} className="flex shrink-0 items-center gap-1.5">
              <span className="px-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-primary">
                {g.label}
              </span>
              {g.ids.map((id) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onActiveTabChange(id)}
                    className={`shrink-0 whitespace-nowrap rounded-full border-[1.5px] px-[14px] py-[8px] text-[13px] transition ${
                      active
                        ? "border-foreground bg-foreground font-extrabold text-background"
                        : "border-input bg-card font-semibold text-foreground"
                    }`}
                  >
                    {labelById.get(id)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Desktop — the mockup's product-detail layout: a sticky LEFT grouped nav
          (crimson section labels, the active sub-tab a raised white pill) beside the
          always-mounted panel body. Plain aria-pressed toggles (no roving tabindex),
          so we don't over-promise a tab-widget; panels keep FormTab's role. */}
      <div className="lg:grid lg:grid-cols-[216px_minmax(0,1fr)] lg:gap-5">
        <nav
          aria-label="Sections du produit"
          className="hidden lg:sticky lg:top-3 lg:flex lg:flex-col lg:gap-3 lg:self-start lg:rounded-[20px] lg:border lg:border-border lg:bg-[#fbf9f8] lg:p-3"
        >
          {groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-0.5">
              <span className="px-2.5 pb-1 text-[11px] font-extrabold uppercase tracking-[0.14em] text-primary">
                {g.label}
              </span>
              {g.ids.map((id) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onActiveTabChange(id)}
                    className={`flex h-[38px] w-full items-center rounded-[11px] px-2.5 text-left text-[14px] transition ${
                      active
                        ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.06)]"
                        : "font-semibold text-[#3d4046] hover:bg-card"
                    }`}
                  >
                    {labelById.get(id)}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

/**
 * Edit-path shell — the rounded card hosting the grouped tab strip + the
 * always-mounted panel body. Mirrors the shared `FormTabs` chrome 1:1 (same
 * card, sticky glassy header, `p-5 sm:p-6` body) so the edit layout is
 * visually identical to before EXCEPT the strip is now grouped. Kept LOCAL to
 * the product form so the shared `FormTabs` (used by every other admin form)
 * is untouched. All panels stay mounted — only the `hidden` attribute flips —
 * so the single FormData captures every input regardless of the active tab.
 */
function ProductTabsShell({
  tabs,
  activeTab,
  onActiveTabChange,
  children,
}: {
  tabs: ReadonlyArray<{ id: TabId; label: string }>;
  activeTab: TabId;
  onActiveTabChange: (next: TabId) => void;
  children: React.ReactNode;
}) {
  return (
    <TabbedProductCard tabs={tabs} activeTab={activeTab} onActiveTabChange={onActiveTabChange}>
      {children}
    </TabbedProductCard>
  );
}

/**
 * FAQ editor body — renders INSIDE the FAQ tab. Manages its own list state
 * (add / edit / remove rows) and, ONCE edited, mirrors it into the main product
 * `<form>` as a hidden `faqItemsJson` input (associated via the HTML `form`
 * attribute, so no invalid nested <form>). It has NO save button of its own:
 * the single product "Enregistrer" persists the FAQ via `updateProductAction`.
 */
function ProductFaqEditorBody({
  initialFaqs,
}: {
  initialFaqs: ProductFaqInitial[];
}) {
  const [items, setItems] = useState<ProductFaqInitial[]>(initialFaqs);
  // Only mirror FAQs into the MAIN product save once the operator actually edits
  // them — an untouched FAQ tab shouldn't re-write (churn) the rows on every
  // unrelated product save.
  const [dirty, setDirty] = useState(false);

  const updateItem = (idx: number, patch: Partial<ProductFaqInitial>) => {
    setDirty(true);
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const removeItem = (idx: number) => {
    setDirty(true);
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const addItem = () => {
    setDirty(true);
    setItems((prev) => [
      ...prev,
      {
        question: "",
        answer: "",
        displayOrder: prev.length,
        isPublished: true,
      },
    ]);
  };

  // Strip empty rows before serialising so an admin who clicks "Ajouter"
  // and then "Enregistrer" without typing doesn't end up with blank FAQ
  // rows in the DB. Validation also kicks in server-side, but this keeps
  // the JSON tidy.
  const trimmed = items
    .map((it, idx) => ({
      question: it.question.trim(),
      answer: it.answer.trim(),
      displayOrder: Number.isFinite(it.displayOrder) ? it.displayOrder : idx,
      isPublished: it.isPublished,
    }))
    .filter((it) => it.question.length > 0 && it.answer.length > 0);

  return (
    <div className="space-y-4">
      {/* Mirror the FAQ list into the MAIN product form so the single
          "Enregistrer" saves the FAQs in the same submit (updateProductAction
          reads `faqItemsJson`). Only emitted once the list is edited, so an
          untouched FAQ tab never re-writes the rows on an unrelated save. */}
      {dirty && (
        <input
          type="hidden"
          form={PRODUCT_FORM_ID}
          name="faqItemsJson"
          value={JSON.stringify(trimmed)}
        />
      )}

      <section className="space-y-4 rounded-3xl border border-border bg-card p-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[14.5px] text-foreground">
              FAQ produit
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Questions / réponses affichées sur la fiche produit. Laisser
              vide pour masquer la section.
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
                      placeholder="Ex. Ce produit est-il sous garantie ?"
                      className="mt-1.5 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
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
                      placeholder="Réponse détaillée, claire et concise."
                      className="mt-1.5 w-full rounded-2xl border border-border bg-background p-3 text-sm leading-relaxed focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
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
                        className="mt-1.5 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <label className="flex cursor-pointer items-center gap-2.5 self-end rounded-2xl border border-border bg-card px-4 py-3 text-sm font-medium transition hover:bg-surface/40 has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5">
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
    </div>
  );
}

/** Flat index of a node id → its node + breadcrumb path of names (root→node). */
type CategoryFlatEntry = { node: ProductFormCategoryNode; pathNames: string[] };
function indexCategoryTree(
  nodes: ProductFormCategoryNode[],
): Map<string, CategoryFlatEntry> {
  const map = new Map<string, CategoryFlatEntry>();
  const walk = (list: ProductFormCategoryNode[], ancestors: string[]) => {
    for (const n of list) {
      const pathNames = [...ancestors, n.name];
      map.set(n.id, { node: n, pathNames });
      if (n.children.length) walk(n.children, pathNames);
    }
  };
  walk(nodes, []);
  return map;
}

/**
 * ANY-DEPTH drill-down category picker — mirrors the storefront mega-menu's
 * navigate-into-a-branch model (src/components/site-header.tsx).
 *
 * UX: the admin starts at the roots and clicks a node WITH children to drill
 * into it (a breadcrumb above lets them climb back up to any ancestor or the
 * roots). A checkbox on every node selects it at ANY level (multi-select); a
 * star marks exactly one selected node as primary. Selections PERSIST while
 * drilling between branches — the `selected` set is keyed by id, never reset
 * on navigation (fixes the old drop-on-root-switch behaviour).
 *
 * Submission contract — UNCHANGED from the 2-level picker, so create/update
 * workflows are identical:
 *   - `primaryCategoryId` = the starred selected id (hidden input)
 *   - `categoryIds`       = one hidden input per ticked node id (FormData's
 *     getAll collects them all)
 * The form stores the EXPLICIT ticked ids only — descendant roll-up is a
 * list-filter concern, not a storage one.
 */
function CategoryTreePicker({
  categories,
  initialPrimary,
  initialSelected,
}: {
  categories: ProductFormCategoryNode[];
  initialPrimary: string | null;
  initialSelected: string[];
}) {
  // id → {node, breadcrumb names}; rebuilt only when the tree changes.
  const flat = useMemo(() => indexCategoryTree(categories), [categories]);

  // Selected ids persist across drilling — keyed by id, branch-independent.
  // Seed only with ids that still exist in the current tree.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected.filter((id) => flat.has(id))),
  );
  // Primary: explicit initial if still present & selected, else the first
  // valid selected id, else "" (no primary yet).
  const [primary, setPrimary] = useState<string>(() => {
    const seedSelected = initialSelected.filter((id) => flat.has(id));
    if (initialPrimary && seedSelected.includes(initialPrimary)) return initialPrimary;
    return seedSelected[0] ?? "";
  });

  // Drill position: array of ancestor ids (empty = roots level). Seeded to
  // the parent chain of the primary/first-selected node so edit mode opens
  // where the product already lives.
  const seedPath = (() => {
    const focus = (initialPrimary && flat.has(initialPrimary))
      ? initialPrimary
      : initialSelected.find((id) => flat.has(id));
    if (!focus) return [] as string[];
    // pathNames is root→node names; map back to the id chain MINUS the focus
    // node itself, so we land on the LEVEL that lists `focus`.
    const ids: string[] = [];
    let level = categories;
    const names = flat.get(focus)!.pathNames.slice(0, -1);
    for (const name of names) {
      const hit = level.find((n) => n.name === name);
      if (!hit) break;
      ids.push(hit.id);
      level = hit.children;
    }
    return ids;
  })();
  const [path, setPath] = useState<string[]>(seedPath);

  // The list of nodes shown at the current drill level: roots when `path` is
  // empty, otherwise the children of the deepest node in `path`.
  const currentLevel: ProductFormCategoryNode[] = (() => {
    if (path.length === 0) return categories;
    const last = path[path.length - 1];
    return flat.get(last)?.node.children ?? [];
  })();

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Unticking the primary clears the star (caller re-stars another).
        setPrimary((p) => (p === id ? "" : p));
      } else {
        next.add(id);
        // First selection becomes primary automatically.
        setPrimary((p) => (p === "" ? id : p));
      }
      return next;
    });

  const selectedList = Array.from(selected);

  if (categories.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
        Aucune catégorie disponible. Créez d&apos;abord une catégorie depuis{" "}
        <span className="font-medium">/admin/catalog/categories</span>.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Hidden inputs the server action reads — IDENTICAL contract to the
          former 2-level picker: one primaryCategoryId + N categoryIds. */}
      <input type="hidden" name="primaryCategoryId" value={primary} />
      {selectedList.map((id) => (
        <input key={id} type="hidden" name="categoryIds" value={id} />
      ))}

      {/* Breadcrumb — click any crumb (or « Catégories ») to climb back up. */}
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => setPath([])}
          className={`inline-flex h-7 items-center rounded-full px-2.5 font-medium transition ${
            path.length === 0
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:bg-surface hover:text-foreground"
          }`}
        >
          Catégories
        </button>
        {path.map((id, idx) => (
          <span key={id} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setPath((p) => p.slice(0, idx + 1))}
              className={`inline-flex h-7 items-center rounded-full px-2.5 font-medium transition ${
                idx === path.length - 1
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-surface hover:text-foreground"
              }`}
            >
              {flat.get(id)?.node.name ?? "—"}
            </button>
          </span>
        ))}
      </div>

      {/* Current level — each node: a checkbox (select at this level) + the
          name; nodes WITH children get a "drill in" affordance; selected
          nodes get a star to (un)mark primary. */}
      {currentLevel.length > 0 ? (
        <div className="grid gap-2 rounded-2xl border border-border bg-surface/40 p-3 sm:grid-cols-2 md:grid-cols-3">
          {currentLevel.map((node) => {
            const checked = selected.has(node.id);
            const isPrimary = primary === node.id;
            const hasChildren = node.children.length > 0;
            return (
              <div
                key={node.id}
                className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-sm transition ${
                  checked ? "border-primary/40 bg-card" : "border-transparent bg-card hover:bg-background"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(node.id)}
                  aria-label={`Sélectionner ${node.name}`}
                  className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                />
                {/* Star toggles primary — only meaningful once selected. */}
                <button
                  type="button"
                  onClick={() => {
                    if (!checked) toggle(node.id);
                    setPrimary(node.id);
                  }}
                  aria-label={`Définir « ${node.name} » comme catégorie principale`}
                  title="Catégorie principale"
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full transition ${
                    isPrimary
                      ? "text-amber-500"
                      : "text-muted-foreground hover:text-amber-500"
                  }`}
                >
                  <Star className={`h-3.5 w-3.5 ${isPrimary ? "fill-amber-500" : ""}`} />
                </button>
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {hasChildren && (
                  <button
                    type="button"
                    onClick={() => setPath((p) => [...p, node.id])}
                    aria-label={`Ouvrir les sous-catégories de ${node.name}`}
                    className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full border border-border px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-surface hover:text-foreground"
                  >
                    {node.children.length}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {path.length === 0
            ? "Aucune catégorie disponible."
            : `« ${flat.get(path[path.length - 1])?.node.name ?? ""} » n'a pas de sous-catégorie. Cochez-la ci-dessus pour y placer le produit.`}
        </p>
      )}

      {/* Selected summary — chips with breadcrumb path; primary flagged; click
          ✕ to deselect. Persists regardless of the current drill position. */}
      {selectedList.length > 0 ? (
        <div className="rounded-2xl border border-border bg-card p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Catégories sélectionnées
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedList.map((id) => {
              const entry = flat.get(id);
              const label = entry ? entry.pathNames.join(" › ") : id;
              const isPrimary = primary === id;
              return (
                <span
                  key={id}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                    isPrimary
                      ? "bg-foreground text-background"
                      : "border border-border bg-surface/40 text-foreground"
                  }`}
                >
                  {isPrimary && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
                  {label}
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={`Retirer ${label}`}
                    className="grid h-4 w-4 place-items-center rounded-full transition hover:bg-background/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Cochez les catégories où ce produit doit apparaître (tous niveaux).
            L&apos;étoile désigne la catégorie principale — elle pilote le fil
            d&apos;Ariane et l&apos;URL canonique du produit.
          </p>
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-3 text-xs leading-relaxed text-muted-foreground">
          Aucune catégorie sélectionnée. Cochez une ou plusieurs catégories
          ci-dessus — naviguez dans l&apos;arborescence pour atteindre
          n&apos;importe quel niveau.
        </p>
      )}
    </div>
  );
}

/**
 * Attributes picker.
 *
 * One row per attribute. `multiselect` renders as checkboxes (any number
 * of values may be ticked); `select` renders as radio buttons (admin
 * picks at most one). Internally we keep one `Set<string>` of ticked
 * value IDs across all attributes — that's the only state the server
 * cares about.
 *
 * Hidden inputs: `<input name="attributeValueIds">` per ticked value.
 * The server action reads them via `formData.getAll("attributeValueIds")`.
 *
 * Empty state — no attributes defined yet — points the admin at the
 * attributes admin where they can create some.
 */
function AttributesPicker({
  attributes,
  initialSelected,
  initialScalars = {},
}: {
  attributes: ProductFormAttribute[];
  initialSelected: string[];
  initialScalars?: Record<string, { numericValue: number | null; textValue: string | null }>;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected),
  );

  // Per-product scalars (number/text). Kept as raw strings so an emptied input
  // round-trips as "" → the server clears the row. Hidden inputs below carry
  // each one to the save action (`attrScalarNum.<id>` / `attrScalarText.<id>`).
  const [scalars, setScalars] = useState<Record<string, { num: string; text: string }>>(() => {
    const init: Record<string, { num: string; text: string }> = {};
    for (const a of attributes) {
      if (a.kind === "number" || a.kind === "text") {
        const s = initialScalars[a.id];
        init[a.id] = {
          num: s?.numericValue != null ? String(s.numericValue) : "",
          text: s?.textValue ?? "",
        };
      }
    }
    return init;
  });
  const setScalar = (id: string, patch: Partial<{ num: string; text: string }>) =>
    setScalars((s) => ({ ...s, [id]: { num: s[id]?.num ?? "", text: s[id]?.text ?? "", ...patch } }));

  // ─── AI attribution ──────────────────────────────────────────────────
  // The model affects values STRICTLY from the candidates below; we map the
  // returned attribute name + value label back to value ids (case-insensitive)
  // and union them in — single-choice attributes keep only the first match.
  const toggle = (vid: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(vid);
      else next.delete(vid);
      return next;
    });

  // Remove this attribute from the product entirely. Essential for `select`
  // (radio) kinds, which otherwise can't be un-picked once chosen — and for any
  // kind, the explicit way to "remove an attribute from the product". Clears the
  // value assignments (or the scalar) so on save the links are dropped.
  const clearAttr = (attr: ProductFormAttribute) => {
    if (attr.kind === "number" || attr.kind === "text") {
      setScalar(attr.id, { num: "", text: "" });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const v of attr.values) next.delete(v.id);
        return next;
      });
    }
  };

  const attrHasValue = (attr: ProductFormAttribute): boolean => {
    if (attr.kind === "number" || attr.kind === "text") {
      const s = scalars[attr.id];
      return Boolean((s?.num ?? "").trim() || (s?.text ?? "").trim());
    }
    return attr.values.some((v) => selected.has(v.id));
  };

  // For "select" attributes, picking a value clears any other value in
  // the same attribute. Cheap to recompute because the attribute set is
  // small (< 50 in practice).
  const selectOne = (attr: ProductFormAttribute, vid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const v of attr.values) next.delete(v.id);
      next.add(vid);
      return next;
    });

  if (attributes.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
        Aucun attribut défini. Créez-en un dans{" "}
        <span className="font-medium">/admin/catalog/attributes</span>.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Hidden inputs the server action reads via formData.getAll(). */}
      {Array.from(selected).map((vid) => (
        <input key={vid} type="hidden" name="attributeValueIds" value={vid} />
      ))}

      <p className="rounded-2xl border border-dashed border-border bg-surface/40 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
        Les valeurs cochées alimentent les filtres de catégorie et, pour un
        produit <span className="font-medium text-foreground">variable</span>,
        servent de base à la génération des variantes dans l&apos;onglet{" "}
        <span className="font-medium text-foreground">Variantes</span>.
      </p>

      {attributes.map((attr) => (
        <div
          key={attr.id}
          className="rounded-2xl border border-border bg-surface/40 p-3"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {attr.name}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {attrHasValue(attr) && (
                <button
                  type="button"
                  onClick={() => clearAttr(attr)}
                  className="rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                  title={`Retirer « ${attr.name} » de ce produit`}
                >
                  Effacer
                </button>
              )}
              <span className="rounded-full bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {KIND_BADGE[attr.kind]}
              </span>
            </div>
          </div>
          <AttributeInput
            attr={attr}
            selected={selected}
            scalar={scalars[attr.id]}
            onToggle={toggle}
            onSelectOne={selectOne}
            onSetScalar={(patch) => setScalar(attr.id, patch)}
          />
        </div>
      ))}
    </div>
  );
}

/** Short per-kind badge shown in the product editor's attribute rows. */
const KIND_BADGE: Record<AttributeKind, string> = {
  multiselect: "Multi-choix",
  select: "Choix unique",
  color: "Couleur",
  boolean: "Oui / Non",
  number: "Nombre",
  text: "Texte",
};

/**
 * Renders the right input for a single attribute, per kind:
 *  - select   → radio (one value)
 *  - multiselect/color → checkboxes (colour shows a swatch)
 *  - boolean  → a single Oui/Non toggle over the attribute's one value
 *  - number   → numeric input (per-product scalar)
 *  - text     → free-text input (per-product scalar, informational)
 * Scalar kinds emit a hidden input the save action reads.
 */
function AttributeInput({
  attr,
  selected,
  scalar,
  onToggle,
  onSelectOne,
  onSetScalar,
}: {
  attr: ProductFormAttribute;
  selected: Set<string>;
  scalar?: { num: string; text: string };
  onToggle: (vid: string, checked: boolean) => void;
  onSelectOne: (attr: ProductFormAttribute, vid: string) => void;
  onSetScalar: (patch: Partial<{ num: string; text: string }>) => void;
}) {
  if (attr.kind === "number") {
    const val = scalar?.num ?? "";
    return (
      <div className="mt-3">
        <input
          type="number"
          step="any"
          value={val}
          onChange={(e) => onSetScalar({ num: e.target.value })}
          placeholder="Valeur (ex: 256)"
          className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm focus:outline-none sm:max-w-xs"
        />
        <input type="hidden" name={`attrScalarNum.${attr.id}`} value={val} />
      </div>
    );
  }

  if (attr.kind === "text") {
    const val = scalar?.text ?? "";
    return (
      <div className="mt-3">
        <input
          type="text"
          value={val}
          onChange={(e) => onSetScalar({ text: e.target.value })}
          placeholder="Texte informatif"
          className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm focus:outline-none"
        />
        <input type="hidden" name={`attrScalarText.${attr.id}`} value={val} />
      </div>
    );
  }

  if (attr.values.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">Aucune valeur pour cet attribut.</p>;
  }

  if (attr.kind === "boolean") {
    const v = attr.values[0];
    return (
      <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-xl bg-card px-3 py-2 text-sm transition hover:bg-background sm:max-w-xs">
        <input
          type="checkbox"
          checked={selected.has(v.id)}
          onChange={(e) => onToggle(v.id, e.target.checked)}
          className="h-4 w-4 accent-[var(--primary)]"
        />
        Oui — ce produit porte « {attr.name} »
      </label>
    );
  }

  if (attr.kind === "color") {
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        {attr.values.map((v) => {
          const ticked = selected.has(v.id);
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onToggle(v.id, !ticked)}
              aria-pressed={ticked}
              title={v.label}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                ticked
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-background"
              }`}
            >
              <span
                className="h-4 w-4 rounded-full border border-border"
                style={{ backgroundColor: v.colorHex || "transparent" }}
              />
              {v.label}
            </button>
          );
        })}
      </div>
    );
  }

  // select (radio) + multiselect (checkbox)
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
      {attr.values.map((v) => {
        const ticked = selected.has(v.id);
        return (
          <label
            key={v.id}
            className="flex cursor-pointer items-center gap-2 rounded-xl bg-card px-3 py-2 text-sm transition hover:bg-background"
          >
            <input
              type={attr.kind === "multiselect" ? "checkbox" : "radio"}
              // Browser radio grouping by name only matters when we rely on
              // native single-select behaviour. We manage the selection state
              // ourselves so the name is unique-per-attribute to avoid
              // accidental cross-attribute collisions.
              name={`attr-${attr.slug}`}
              checked={ticked}
              onChange={(e) => {
                if (attr.kind === "multiselect") onToggle(v.id, e.target.checked);
                else onSelectOne(attr, v.id);
              }}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            {v.label}
          </label>
        );
      })}
    </div>
  );
}

/**
 * Controlled SEO title + description inputs with a live Google-style SERP
 * preview and character counters.
 *
 * Uncontrolled `<Field>`s can't drive a live preview, so these manage their
 * own state — but still submit through the normal FormData path via `name`
 * (so they flow into `updateProductAction` like every other field). The
 * counters use Google's practical truncation points (~60 title / ~160
 * description) purely as guidance; longer values are accepted and stored.
 */
function SeoFields({
  initialName,
  initialSlug,
  initialShortDesc,
  initialMetaTitle,
  initialMetaDescription,
}: {
  initialName: string;
  initialSlug: string;
  initialShortDesc: string;
  initialMetaTitle: string;
  initialMetaDescription: string;
}) {
  const [metaTitle, setMetaTitle] = useState(initialMetaTitle);
  const [metaDescription, setMetaDescription] = useState(initialMetaDescription);

  // Display-only host for the preview, derived from the configured site URL
  // (inlined at build) so we don't hardcode the domain.
  const siteHost = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://tokyostore.tn")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const stripHtml = (s: string) =>
    s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  const effectiveTitle = metaTitle.trim() || initialName || "Nom du produit";
  const effectiveDesc =
    metaDescription.trim() ||
    stripHtml(initialShortDesc) ||
    "La description courte du produit s'affiche ici.";
  const previewPath = initialSlug ? `/${initialSlug}` : "/votre-produit";

  const counterClass = (n: number, max: number) =>
    n === 0 ? "text-muted-foreground" : n <= max ? "text-emerald-600" : "text-amber-600";

  return (
    <div className="space-y-4">
      {/* Live SERP preview */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Aperçu Google — rendu approximatif dans les résultats de recherche
        </p>
        <div className="space-y-0.5">
          <p className="truncate text-xs text-emerald-700 dark:text-emerald-400">
            {siteHost}
            {previewPath}
          </p>
          <p className="truncate text-base font-medium text-[#1a0dab] dark:text-[#8ab4f8]">
            {effectiveTitle}
          </p>
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
            {effectiveDesc}
          </p>
        </div>
      </div>

      <label className="block">
        <span className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Meta title
          </span>
          <span className={`text-[11px] tabular-nums ${counterClass(metaTitle.length, 60)}`}>
            {metaTitle.length}/60
          </span>
        </span>
        <input
          type="text"
          name="metaTitle"
          value={metaTitle}
          onChange={(e) => setMetaTitle(e.target.value)}
          placeholder={initialName || "Titre pour les moteurs de recherche"}
          className="mt-2 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
          Titre affiché dans l&apos;onglet du navigateur et comme lien bleu dans
          Google. ~50–60 caractères pour éviter la troncature. Vide = nom du
          produit.
        </span>
      </label>

      <label className="block">
        <span className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Meta description
          </span>
          <span className={`text-[11px] tabular-nums ${counterClass(metaDescription.length, 160)}`}>
            {metaDescription.length}/160
          </span>
        </span>
        <textarea
          name="metaDescription"
          value={metaDescription}
          onChange={(e) => setMetaDescription(e.target.value)}
          rows={3}
          placeholder="Résumé attractif affiché sous le titre dans Google."
          className="mt-2 w-full rounded-2xl border border-border bg-background p-3 text-sm leading-relaxed focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
          Texte gris affiché sous le titre dans les résultats de recherche.
          ~120–160 caractères. Vide = description courte du produit.
        </span>
      </label>
    </div>
  );
}

/* ─────────────────────── "Vous aimerez aussi" picker ─────────────────────── */

const RELATED_MODE_OPTIONS: {
  value: "auto" | "same_subcategory" | "same_brand" | "mixed" | "ai" | "manual";
  label: string;
  hint: string;
}[] = [
  { value: "auto", label: "Automatique", hint: "Catégorie, marque puis nouveautés (comportement par défaut)." },
  { value: "same_subcategory", label: "Même sous-catégorie", hint: "Produits aléatoires de la catégorie principale." },
  { value: "same_brand", label: "Même marque", hint: "Produits aléatoires de la même marque." },
  { value: "mixed", label: "Mixte (catégorie + marque)", hint: "Mélange aléatoire des deux." },
  { value: "manual", label: "Manuel", hint: "Vous choisissez les produits via la recherche." },
];

type RelatedMode = (typeof RELATED_MODE_OPTIONS)[number]["value"];

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

/**
 * "Vous aimerez aussi" configuration: a selection MODE (derived
 * category/brand/mix, AI, or manual) plus, for the curated modes (manual/ai),
 * a searchable + reorderable product list. Emits `relatedMode` + one
 * `relatedProductIds` hidden input per selected id (order = display order) —
 * the list is ALWAYS emitted so a curated selection survives toggling to a
 * derived mode and back. The AI button calls the panel-controlled
 * `produits/related` task via `generateRelatedProductsAction`.
 */
function RelatedProductsPicker({
  initialMode,
  initialSelected,
  currentSlug,
}: {
  initialMode: RelatedMode;
  initialSelected: RelatedProductOption[];
  currentSlug: string | null;
  brandLabel: () => string;
}) {
  const [mode, setMode] = useState<RelatedMode>(initialMode);
  const [selected, setSelected] = useState<RelatedProductOption[]>(initialSelected);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RelatedProductOption[]>([]);
  const [searching, setSearching] = useState(false);

  // "ai" stays a curated (manual-list) mode for legacy products; new products
  // pick "manual" (the AI auto-pick was removed with the rest of AI generation).
  const curated = mode === "manual" || mode === "ai";
  const selectedIds = new Set(selected.map((p) => p.id));

  // Debounced product search (curated modes only). All state updates happen
  // inside the (async) timer — never synchronously in the effect body — and
  // the results dropdown is render-gated on `query.length >= 2`, so a short /
  // empty query simply hides stale results without a synchronous setState.
  useEffect(() => {
    if (!curated) return;
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
  }, [query, curated]);

  const add = (p: RelatedProductOption) => {
    if (p.slug === currentSlug || selectedIds.has(p.id)) return;
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
      {/* ALWAYS emitted so a curated list persists across mode toggles. */}
      <input type="hidden" name="relatedMode" value={mode} />
      {selected.map((p) => (
        <input key={p.id} type="hidden" name="relatedProductIds" value={p.id} />
      ))}

      <div className="grid gap-2 sm:grid-cols-2">
        {RELATED_MODE_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-2.5 rounded-2xl border p-3 transition ${
              mode === opt.value
                ? "border-primary/50 bg-primary/5"
                : "border-border bg-card hover:bg-surface"
            }`}
          >
            <input
              type="radio"
              name="relatedModeRadio"
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{opt.label}</span>
              <span className="block text-[11px] text-muted-foreground">{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {curated ? (
        <div className="space-y-3 rounded-2xl border border-border bg-surface/30 p-3.5">
          <div>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher un produit à ajouter…"
              className="h-10 w-full rounded-full border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            {query.trim().length >= 2 && (
              <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-2xl border border-border bg-card p-1">
                {searching && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">Recherche…</li>
                )}
                {!searching &&
                  results.filter((r) => r.slug !== currentSlug && !selectedIds.has(r.id)).length ===
                    0 && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">Aucun résultat.</li>
                  )}
                {results
                  .filter((r) => r.slug !== currentSlug && !selectedIds.has(r.id))
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
              Aucun produit sélectionné — utilisez la recherche.
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
          <p className="text-[11px] text-muted-foreground">
            Jusqu&apos;à 8 produits sont affichés sur la fiche, dans cet ordre.
          </p>
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-3 text-xs leading-relaxed text-muted-foreground">
          Le carrousel est rempli automatiquement selon le mode choisi. Une liste manuelle ou
          générée par IA reste conservée si vous repassez en mode « Manuel » ou « IA ».
        </p>
      )}
    </div>
  );
}

/**
 * "Accessoires supplémentaires" picker — the MANUAL-ONLY twin of
 * `RelatedProductsPicker`. There is no mode toggle and no AI: the curated list
 * IS the feature (an empty list renders no PDP section). Same UX bones as the
 * related picker's curated branch — debounced product search + a reorderable
 * selected list — emitting one hidden `complementaryProductIds` input per pick
 * so the existing FormData → action → workflow path persists it.
 */
function ComplementaryProductsPicker({
  initialSelected,
  currentSlug,
}: {
  initialSelected: RelatedProductOption[];
  currentSlug: string | null;
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
    if (p.slug === currentSlug || selectedIds.has(p.id)) return;
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
      {/* One hidden input per pick — the FormData source of truth. */}
      {selected.map((p) => (
        <input key={p.id} type="hidden" name="complementaryProductIds" value={p.id} />
      ))}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Produits suggérés en complément sur la fiche produit (accessoires, entretien…).
      </p>

      <div className="space-y-3 rounded-2xl border border-border bg-surface/30 p-3.5">
        <div>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un produit à ajouter…"
            className="h-10 w-full rounded-full border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          {query.trim().length >= 2 && (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-2xl border border-border bg-card p-1">
              {searching && (
                <li className="px-3 py-2 text-xs text-muted-foreground">Recherche…</li>
              )}
              {!searching &&
                results.filter((r) => r.slug !== currentSlug && !selectedIds.has(r.id)).length ===
                  0 && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">Aucun résultat.</li>
                )}
              {results
                .filter((r) => r.slug !== currentSlug && !selectedIds.has(r.id))
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
            Aucun accessoire sélectionné.
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

/**
 * Single reusable toggle card — the one consistent checkbox pattern used by
 * EVERY boolean option on the product form (inStock, isDiscountable,
 * noindex + the action-bar publish toggle). Replaces ~6 copy-pasted variants
 * that drifted on accent colour,
 * input height and helper-text size.
 *
 * Presentation only: it renders a native `<input type="checkbox" name=…>`
 * (the FormData source of truth is unchanged — same `name`, same
 * `defaultChecked`) wrapped in a tappable label with a title + an optional
 * description slot used to EXPLAIN what the toggle does. One shared primary
 * accent; the whole card highlights when checked.
 *
 * `compact` renders the pill variant (no description) used in the action bar
 * where the publish toggle sits inline next to the submit button.
 */
function CheckboxCard({
  name,
  title,
  description,
  defaultChecked,
  compact,
  onCheckedChange,
}: {
  name: string;
  title: string;
  description?: string;
  defaultChecked?: boolean;
  compact?: boolean;
  /**
   * Optional change notifier. The input stays UNCONTROLLED (`defaultChecked`)
   * so the FormData source of truth is unchanged — this just lets a parent
   * mirror the value for UI reactivity (e.g. show/hide a tab).
   */
  onCheckedChange?: (checked: boolean) => void;
}) {
  if (compact) {
    return (
      <label className="flex cursor-pointer items-center gap-2.5 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium transition hover:bg-surface/40 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          onChange={(e) => onCheckedChange?.(e.target.checked)}
          className="h-4 w-4 shrink-0 rounded border-border accent-[var(--primary)]"
        />
        {title}
      </label>
    );
  }
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-card p-4 transition hover:bg-surface/40 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[var(--primary)]"
      />
      <span className="min-w-0 flex-1 text-sm">
        <span className="block font-semibold text-foreground">{title}</span>
        {description && (
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

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
      className={`rounded-3xl border bg-card p-5 sm:p-6 ${
        accent ? "border-primary/30 shadow-soft" : "border-border"
      }`}
    >
      <header className="mb-5">
        <h2 className="text-[14.5px] text-foreground">
          {title}
        </h2>
        {description && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  name,
  label,
  type,
  step,
  min,
  required,
  textarea,
  rows,
  defaultValue,
  helper,
  onChange,
}: {
  name: string;
  label: string;
  type?: string;
  step?: string;
  min?: number | string;
  required?: boolean;
  textarea?: boolean;
  rows?: number;
  defaultValue?: string | number | null;
  helper?: string;
  /** Optional LIVE value callback — the input stays uncontrolled (FormData reads
   *  it on submit); this only mirrors the value for in-form reactions (e.g. the
   *  price reduction reflected in the Promotions tab). */
  onChange?: (value: string) => void;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
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
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          className="mt-2 w-full rounded-2xl border border-border bg-background p-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      ) : (
        <input
          id={id}
          name={name}
          type={type ?? "text"}
          step={step}
          min={min}
          required={required}
          defaultValue={defaultValue ?? ""}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          className="mt-2 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      )}
      {helper && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}

