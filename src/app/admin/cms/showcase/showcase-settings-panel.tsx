"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Loader2, Plus, Save, Search, X } from "lucide-react";

import { saveShowcaseSettingsAction } from "@/lib/actions/showcase-settings";
import { searchProductsForPickerAction, type RelatedProductOption } from "@/lib/actions/related-products";
import { type ActionState } from "@/lib/actions/types";
import { FormTabs, FormTab, useNoResetSubmit } from "@/components/admin/_components/form-tabs";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import {
  FieldSection,
  NumberField,
  TextField,
  TextareaField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { SelectField } from "@/components/ui/select-field";
import { MediaPicker } from "@/components/admin/media-picker";
import { SORT_OPTIONS } from "@/lib/catalog/sort-options";
import type { CollectionPageConfig, CollectionSlug } from "@/lib/pages/collection-page-config";

/** Recommended hero image — the catalogue hero renders as a small landscape vignette
 *  (~224×128 px, object-cover) opposite the title, so a compact ~16:9 crop fits. */
const HERO_RECO = "Paysage ~16:9 — 880×500 px (affichée en vignette, recadrée au centre).";

/** A pinned product as hydrated by the page (or picked from a search hit). */
export type ShowcaseProductOption = { id: string; name: string; published: boolean };
export type ShowcasePageData = {
  slug: CollectionSlug;
  label: string;
  config: CollectionPageConfig;
  pinnedIds: string[];
};

/**
 * Admin hub for the showcase pages. One form, one tab per page; each tab
 * controls content, selection + manual pins and SEO. Every tab posts together
 * (FormTabs keeps panels mounted). `products` = the already-pinned products
 * only — the pin picker searches the catalogue server-side.
 */
export function ShowcaseSettingsPanel({
  pages,
  products,
}: {
  pages: ShowcasePageData[];
  products: ShowcaseProductOption[];
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveShowcaseSettingsAction,
    null,
  );
  // React 19 resets a <form action> after it settles — without this guard a FAILED save
  // would wipe every uncontrolled field across all three tabs. Only resets on success.
  const onSubmit = useNoResetSubmit(formAction, state);
  const tabs = pages.map((p) => ({ id: p.slug, label: p.label }));
  // Controlled active tab so the footer Preview button can target the tab in view.
  const [activeTab, setActiveTab] = useState<string>(pages[0]?.slug ?? "nouveautes");
  const activePage = pages.find((p) => p.slug === activeTab) ?? pages[0];

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-6">
      <FormTabs
        tabs={tabs}
        defaultTab={pages[0]?.slug ?? "nouveautes"}
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
      >
        {(active) => (
          <>
            {pages.map((p) => (
              <FormTab key={p.slug} id={p.slug} active={active}>
                <ShowcaseTabBody page={p} products={products} />
              </FormTab>
            ))}
          </>
        )}
      </FormTabs>

      {state && !state.ok && <AdminCallout tone="danger">{state.message}</AdminCallout>}
      {state?.ok && <AdminCallout tone="success">{state.message}</AdminCallout>}

      <div className="sticky bottom-4 z-10 flex items-center justify-end gap-2">
        {/* Preview the tab in view — opens the live page in a new tab (greyed when hidden). */}
        {activePage &&
          (activePage.config.visible ? (
            <a
              href={`/${activePage.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground shadow-lift hover:bg-surface"
            >
              <ExternalLink className="h-4 w-4" /> Voir la page
            </a>
          ) : (
            // Keyboard-focusable + SR-announced disabled control (aria-disabled, not the
            // `disabled` attribute, which would drop it from the tab order and hide the
            // reason): the explanation lives in aria-label, not only the hover `title`.
            <button
              type="button"
              aria-disabled="true"
              aria-label="Aperçu indisponible : la page est masquée — réactivez-la pour l'ouvrir."
              title="La page est masquée — réactivez-la pour l'ouvrir."
              onClick={(e) => e.preventDefault()}
              className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-muted-foreground opacity-60 shadow-lift"
            >
              <ExternalLink className="h-4 w-4" /> Page masquée
            </button>
          ))}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {pending ? "Enregistrement…" : "Enregistrer les vitrines"}
        </button>
      </div>
    </form>
  );
}

function ShowcaseTabBody({
  page,
  products,
}: {
  page: ShowcasePageData;
  products: ShowcaseProductOption[];
}) {
  const { slug, config, pinnedIds } = page;
  const f = (k: string) => `pages.${slug}.${k}`;

  // Controlled mirrors (inputs stay uncontrolled via defaultValue/defaultChecked, but
  // their onChange drives live UI): the pin over-count warning uses the CURRENTLY-typed
  // limit, and the CTA-band editor only shows when the toggle is on.
  const [liveLimit, setLiveLimit] = useState<number>(config.limit);
  const [showCta, setShowCta] = useState<boolean>(config.showClosingCta);

  return (
    <div className="space-y-8">
      {/* Preview lives next to « Enregistrer » in the sticky footer (targets the active tab). */}
      <FieldSection title="Contenu" description="L'en-tête de la page (titre, sous-titre, visuel).">
        <ToggleField
          name={f("visible")}
          label="Page visible"
          description="Décochez pour masquer la page (elle renverra une 404 et sera retirée des menus)."
          defaultChecked={config.visible}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name={f("eyebrow")} label="Sur-titre (eyebrow)" defaultValue={config.eyebrow} />
          <TextField name={f("title")} label="Titre" defaultValue={config.title} />
        </div>
        <TextField name={f("subtitle")} label="Sous-titre" defaultValue={config.subtitle} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name={f("cta_label")} label="Bouton — libellé (optionnel)" defaultValue={config.ctaLabel} />
          <TextField
            name={f("cta_href")}
            label="Bouton — lien (optionnel)"
            defaultValue={config.ctaHref}
            placeholder="/montres-homme"
          />
        </div>
        <div>
          <p className="mb-2 text-[13px] font-bold text-foreground">
            Image hero (optionnel)
          </p>
          <MediaPicker
            name={f("hero_media_id")}
            value={config.heroMediaId}
            scope="cms"
            emptyLabel="Choisir une image hero"
          />
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            Recommandé : {HERO_RECO}
          </p>
        </div>
      </FieldSection>

      <FieldSection
        title="Sélection & épingles"
        description="Les produits épinglés s'affichent en premier ; la sélection automatique complète ensuite."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            name={f("limit")}
            label="Produits affichés (max)"
            defaultValue={String(config.limit)}
            // No HTML min/max: this field lives on all three (mounted-but-hidden) tabs, and a
            // native constraint failure on a hidden-panel control silently blocks the whole
            // multi-tab save (the browser aborts submit, never firing onSubmit). The server
            // clamps to 1–100 via asNum(); the helper + live warning guide the operator.
            helper="Entre 1 et 100 (ajusté automatiquement sinon)."
            onChange={(v) => {
              const n = Number(v);
              if (Number.isFinite(n) && n > 0) setLiveLimit(Math.min(Math.floor(n), 100));
            }}
          />
          {slug === "top-ventes" && (
            <NumberField
              name={f("window_days")}
              label="Fenêtre des ventes (jours)"
              defaultValue={String(config.windowDays)}
              helper="Période du classement — 1 à 365 jours (ajusté automatiquement sinon)."
            />
          )}
        </div>
        {slug === "promotions" && (
          <SelectField
            name={f("promo_strategy")}
            label="Source des promotions"
            defaultValue={config.promoStrategy}
            options={[
              {
                value: "engine",
                label: "Moteur de promotions (recommandé)",
                description: "Promotions actives — prix effectif identique à la fiche produit.",
              },
              {
                value: "compare_at",
                label: "Prix barré uniquement",
                description: "Produits dont l'ancien prix est supérieur au prix actuel.",
              },
              { value: "both", label: "Les deux", description: "Union des deux sources." },
            ]}
          />
        )}
        <PinPicker name={f("pins")} products={products} initial={pinnedIds} limit={liveLimit} />
      </FieldSection>

      <FieldSection
        title="Mise en page"
        description="Tri par défaut de la grille. La page affiche les produits dans une grille catégorie (filtres marque / prix / disponibilité, tri et « Charger plus »)."
      >
        <SelectField
          name={f("default_sort")}
          label="Tri par défaut"
          defaultValue={config.defaultSort}
          options={[
            { value: "", label: "En vedette (sélection manuelle — défaut)" },
            ...SORT_OPTIONS.filter((o) => o.value !== "featured").map((o) => ({
              value: o.value,
              label: o.label,
            })),
          ]}
          helper="Ordre initial de la grille (le visiteur peut toujours le changer)."
        />
        <SelectField
          name={f("nav_bar")}
          label="Barre de navigation (sous l'en-tête)"
          defaultValue={config.navBar}
          options={[
            { value: "retour", label: "Bouton « Retour » seul (épuré) — défaut" },
            { value: "categories", label: "Catégories principales du site" },
            { value: "hidden", label: "Masquée (aucune barre)" },
          ]}
          helper="La bande sous le titre : rien, les catégories racines du site, ou un simple retour redessiné."
        />
      </FieldSection>

      <FieldSection
        title="État vide"
        description="Le message affiché quand la page n'a aucun produit (ex. aucune promotion en cours)."
      >
        <TextField name={f("empty_title")} label="Titre" defaultValue={config.empty.title} />
        <TextareaField
          name={f("empty_body")}
          label="Texte"
          rows={3}
          defaultValue={config.empty.body}
        />
      </FieldSection>

      <FieldSection
        title="Bandeau de fin (appel à l'action)"
        description="Un bandeau facultatif en bas de page (titre + texte + bouton) pour relancer le visiteur."
      >
        <ToggleField
          name={f("show_closing_cta")}
          label="Afficher le bandeau de fin"
          description="Activez pour afficher le bandeau d'appel à l'action au bas de la page."
          defaultChecked={config.showClosingCta}
          onChange={setShowCta}
        />
        {/* The CTA-band fields stay MOUNTED whatever the toggle (so they always post — the
            keys are in COMMON_FIELDS and would be NULL-overwritten otherwise — AND so typed
            copy is never lost on toggle-off); they're only visually collapsed when off. */}
        <div className={showCta ? "space-y-4" : "hidden"} aria-hidden={!showCta}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name={f("cta_band_eyebrow")} label="Sur-titre" defaultValue={config.ctaBand.eyebrow} />
            <TextField name={f("cta_band_title")} label="Titre" defaultValue={config.ctaBand.title} />
          </div>
          <TextareaField
            name={f("cta_band_subtitle")}
            label="Sous-titre"
            rows={2}
            defaultValue={config.ctaBand.subtitle}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name={f("cta_band_label")} label="Bouton — libellé" defaultValue={config.ctaBand.ctaLabel} />
            <TextField
              name={f("cta_band_href")}
              label="Bouton — lien"
              defaultValue={config.ctaBand.ctaHref}
              placeholder="/"
            />
          </div>
        </div>
      </FieldSection>

      <FieldSection title="SEO" description="Métadonnées de référencement de la page.">
        <TextField name={f("meta_title")} label="Meta title" defaultValue={config.seo.metaTitle} />
        <TextareaField
          name={f("meta_description")}
          label="Meta description"
          rows={2}
          defaultValue={config.seo.metaDescription}
        />
        <ToggleField
          name={f("noindex")}
          label="Noindex"
          description="Exclure la page des moteurs de recherche."
          defaultChecked={config.seo.noindex}
        />
      </FieldSection>
    </div>
  );
}

/** Max pins per page — the setShowcasePins workflow's `.max(50)`. */
const MAX_PINS = 50;

/**
 * Manual product pin editor — search the catalog, add to an ordered list,
 * reorder, remove. Posts a CSV of product ids in a hidden input the action
 * splits and hands to the showcase workflow.
 *
 * The search runs SERVER-side over the whole published catalogue (debounced,
 * ≥ 2 characters) — a preloaded client-side list only ever covered the newest
 * products, so most of the catalogue could never be pinned. `products` seeds
 * the local id → product map with the already-pinned ones; each picked hit is
 * added to it so a new pin renders with its name, not a raw UUID. A pin whose
 * product no longer resolves (deleted) or is unpublished is flagged: the
 * storefront skips it, so it doesn't count toward the display slots.
 */
function PinPicker({
  name,
  products,
  initial,
  limit,
}: {
  name: string;
  products: ShowcaseProductOption[];
  initial: string[];
  /** The page's display cap ("Produits affichés (max)") — pins beyond it won't render. */
  limit: number;
}) {
  const [pinned, setPinned] = useState<string[]>(initial);
  const [q, setQ] = useState("");
  const [known, setKnown] = useState<Map<string, ShowcaseProductOption>>(
    () => new Map(products.map((p) => [p.id, p])),
  );
  // Last completed search, tagged with the term it answers (an older, slower
  // response for a previous term is dropped — see `latestTerm`).
  const [hits, setHits] = useState<{ term: string; items: RelatedProductOption[]; failed: boolean } | null>(
    null,
  );
  const [searching, startSearch] = useTransition();
  const latestTerm = useRef("");

  const term = q.trim();
  useEffect(() => {
    latestTerm.current = term;
    if (term.length < 2) return;
    const t = setTimeout(() => {
      startSearch(async () => {
        let next: { term: string; items: RelatedProductOption[]; failed: boolean };
        try {
          next = { term, items: await searchProductsForPickerAction(term), failed: false };
        } catch {
          next = { term, items: [], failed: true };
        }
        if (latestTerm.current === term) setHits(next);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  const pinnedSet = new Set(pinned);
  const current = term.length >= 2 && hits?.term === term ? hits : null;
  const results = current ? current.items.filter((p) => !pinnedSet.has(p.id)).slice(0, 8) : [];
  // Pins the storefront will actually render (a deleted / unpublished product is skipped).
  const liveCount = pinned.filter((id) => known.get(id)?.published === true).length;
  const deadCount = pinned.length - liveCount;

  const add = (p: RelatedProductOption) => {
    // Cap at MAX_PINS to match the setShowcasePins workflow's limit (avoids a
    // confusing "Validation échouée" partial save).
    if (pinnedSet.has(p.id) || pinned.length >= MAX_PINS) return;
    setKnown((prev) => new Map(prev).set(p.id, { id: p.id, name: p.name, published: true }));
    setPinned((prev) => (prev.includes(p.id) || prev.length >= MAX_PINS ? prev : [...prev, p.id]));
    setQ("");
  };
  const remove = (id: string) => setPinned((prev) => prev.filter((x) => x !== id));
  const move = (i: number, dir: -1 | 1) =>
    setPinned((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <div>
      <input type="hidden" name={name} value={pinned.join(",")} />
      <label className="text-[13px] font-bold text-foreground">
        Produits épinglés (affichés en premier)
      </label>
      {liveCount > limit && (
        <p className="mt-1 rounded-[12px] border border-[#f3e3bd] bg-[#fff4e0] px-2.5 py-1.5 text-[11px] text-[#b45309]">
          {liveCount} épingles pour {limit} emplacements — seules les {limit} premières
          s&apos;afficheront. Augmentez «&nbsp;Produits affichés (max)&nbsp;» ci-dessus pour toutes les montrer.
        </p>
      )}
      {deadCount > 0 && (
        <p className="mt-1 rounded-[12px] border border-[#f3e3bd] bg-[#fff4e0] px-2.5 py-1.5 text-[11px] text-[#b45309]">
          {deadCount > 1
            ? `${deadCount} épingles pointent vers un produit supprimé ou non publié — ignorées en boutique. Retirez-les ci-dessous.`
            : "1 épingle pointe vers un produit supprimé ou non publié — ignorée en boutique. Retirez-la ci-dessous."}
        </p>
      )}
      {pinned.length >= MAX_PINS && (
        <p className="mt-1 text-[12px] text-muted-foreground">
          Maximum {MAX_PINS} épingles atteint — retirez-en une pour en ajouter une autre.
        </p>
      )}
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        {/* A plain labelled search with a results list of buttons (NOT a full ARIA combobox —
            that needs aria-activedescendant + arrow-key option navigation we don't implement).
            An aria-live region announces the result count/searching state. */}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher un produit à épingler…"
          aria-label="Rechercher un produit à épingler"
          type="search"
          className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] pl-10 pr-10 text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none"
        />
        {searching && term.length >= 2 && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        <span className="sr-only" aria-live="polite">
          {term.length < 2
            ? ""
            : searching
              ? "Recherche en cours…"
              : current
                ? `${results.length} résultat${results.length > 1 ? "s" : ""}`
                : ""}
        </span>
        {results.length > 0 ? (
          <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-[16px] border border-border bg-card shadow-lift">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => add(p)}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[14px] hover:bg-[#fffbfb]"
                >
                  <Plus className="h-3.5 w-3.5 text-primary" strokeWidth={2.5} /> {p.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          current &&
          !searching && (
            <p className="absolute z-20 mt-1 w-full rounded-[16px] border border-border bg-card px-4 py-2.5 text-[14px] text-muted-foreground shadow-lift">
              {current.failed
                ? "Recherche indisponible — réessayez."
                : current.items.length > 0
                  ? "Tous les résultats sont déjà épinglés."
                  : "Aucun résultat."}
            </p>
          )
        )}
      </div>
      {pinned.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          Aucun produit épinglé — la page affichera uniquement la sélection automatique.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {pinned.map((id, i) => (
            <li
              key={id}
              className="flex items-center gap-2 rounded-[14px] border border-border bg-card px-3 py-2"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#fdecef] text-[11px] font-bold text-[#d40530]">
                {i + 1}
              </span>
              <PinLabel product={known.get(id)} />
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30"
                aria-label="Monter"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === pinned.length - 1}
                className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30"
                aria-label="Descendre"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => remove(id)}
                className="grid h-7 w-7 place-items-center rounded-full text-destructive hover:bg-destructive/10"
                aria-label="Retirer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A pin row's label — flags a pin the storefront will skip. */
function PinLabel({ product }: { product: ShowcaseProductOption | undefined }) {
  if (!product) {
    return (
      <span className="min-w-0 flex-1 truncate text-[14px] italic text-muted-foreground">
        (produit supprimé)
      </span>
    );
  }
  return (
    <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">
      {product.name}
      {!product.published && (
        <span className="ml-2 rounded-full bg-[#fff4e0] px-2 py-0.5 text-[10px] font-bold uppercase text-[#b45309]">
          non publié
        </span>
      )}
    </span>
  );
}
