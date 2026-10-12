"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2, X } from "lucide-react";

import {
  createBannerAction,
  updateBannerAction,
} from "@/lib/actions/cms";
import { type ActionState } from "@/lib/actions/types";
import { MediaPicker } from "@/components/admin/media-picker";
import {
  FormTabs,
  FormTab,
  TabbedFormError,
  useNoResetSubmit,
  useTabErrorFocus,
} from "@/components/admin/_components/form-tabs";
import { SelectField } from "@/components/ui/select-field";
import { storeLocalDateTimeInput } from "@/lib/time/store-tz";
import {
  BANNER_BUTTON_VARIANTS,
  BANNER_BUTTON_VARIANT_LABELS,
  GRID_POSITIONS,
  GRID_POSITION_LABELS,
  MAX_BANNER_BUTTONS,
  PLACEMENT_LABELS,
  STRIP_TONES,
  STRIP_TONE_LABELS,
  type BannerButton,
} from "@/lib/cms/banner-model";

type TabId = "content" | "image" | "link" | "targeting" | "schedule";

const ALL_TABS: { id: TabId; label: string }[] = [
  { id: "content", label: "Contenu" },
  // « Visuel » (matches the field labels) — only for placements that render one;
  // hidden for the header_strip (text bar) + footer (newsletter), see `tabs` below.
  { id: "image", label: "Visuel" },
  { id: "link", label: "Lien" },
  // Targeting + grid position only apply to the in-grid (category_grid)
  // placement — filtered out for the others (see `tabs`).
  { id: "targeting", label: "Ciblage" },
  { id: "schedule", label: "Programmation" },
];
const TAB_LABELS = Object.fromEntries(ALL_TABS.map((t) => [t.id, t.label])) as Record<
  TabId,
  string
>;
const TAB_ORDER = ALL_TABS.map((t) => t.id);

/**
 * Which tab holds each workflow field (the `fieldErrors` keys) — a failed save
 * jumps to the tab of the first bad field (e.g. an end date before the start
 * lives on « Programmation », invisible from « Contenu »).
 */
const FIELD_TAB: Record<string, TabId> = {
  placement: "content",
  name: "content",
  eyebrow: "content",
  title: "content",
  subtitle: "content",
  description: "content",
  displayOrder: "content",
  isActive: "content",
  showText: "content",
  stripTone: "content",
  stripIcon: "content",
  showCountdown: "content",
  imageMediaId: "image",
  imageMobileMediaId: "image",
  videoUrl: "image",
  ctaLabel: "link",
  ctaHref: "link",
  buttons: "link",
  targetKind: "targeting",
  targetRef: "targeting",
  afterLoadMoreCount: "targeting",
  gridPosition: "targeting",
  startAt: "schedule",
  endAt: "schedule",
};

/** Render-ready picker options for the in-grid banner targets. */
export type BannerTargetOptions = {
  categories: { value: string; label: string }[];
  brands: { value: string; label: string }[];
  filters: { value: string; label: string }[];
};

const TARGET_KIND_OPTIONS = [
  { value: "none", label: "Toutes les listes (global)" },
  { value: "category", label: "Une catégorie" },
  { value: "brand", label: "Une marque" },
  { value: "filter", label: "Un filtre (attribut)" },
];

const GRID_POSITION_OPTIONS = GRID_POSITIONS.map((v) => ({
  value: v,
  label: GRID_POSITION_LABELS[v],
}));
const STRIP_TONE_OPTIONS = STRIP_TONES.map((v) => ({ value: v, label: STRIP_TONE_LABELS[v] }));

/**
 * Convert a stored ISO timestamp to the `YYYY-MM-DDTHH:mm` string an
 * `<input type="datetime-local">` accepts, in the STORE zone (Africa/Tunis) so
 * the wall-clock round-trips exactly with the server-side parse regardless of
 * the operator's browser zone. Empty/invalid → "" (no preset). Matches the
 * promotion form's converter (both delegate to storeLocalDateTimeInput).
 */
const isoToLocalInput = storeLocalDateTimeInput;

// NOTE: "checkout" is intentionally omitted — no storefront surface renders a
// checkout-placement banner (there is no listLive("checkout") consumer), so
// offering it here would only collect orphan data. The enum value is kept in
// the DB schema for existing rows; re-add this option once a consumer exists.
//
// The `footer` + five `nav_*` placements are intentionally NOT offered here.
// `footer` is a singleton edited from CMS → Footer. The `nav_*` placements are
// LEGACY: dropdown featured imagery now lives in nav_items.config image blocks
// (CMS → Nav Menu builder), not nav_* banner rows — the labels below are kept
// only so a pre-migration nav_* row reached by URL still opens with a readable,
// LOCKED placement (see `lockedTo` below); nothing creates them here any more.
const PLACEMENTS = [
  { value: "home_hero", label: "Hero accueil" },
  { value: "header_strip", label: "Bandeau header" },
  { value: "category_grid", label: "Entre les produits (listing)" },
];

/**
 * Recommended image dimensions ONLY for the placements whose form offers an image
 * tab (hero, in-grid, and the nav_* featured panels via DEFAULT_RECO). Desktop =
 * the landscape crop; mobile = the optional crop art-directed below `sm` (640px).
 * The header_strip (text bar) and footer (newsletter, no image slot) have no image
 * tab, so they are intentionally absent — adding them would advertise a crop that
 * never renders.
 */
const IMAGE_RECO: Record<string, { desktop: string; mobile: string }> = {
  home_hero: {
    desktop: "Paysage 16:9 — 2400×1350 px (min 1600×900)",
    mobile: "Portrait 4:5 — 1080×1350 px (min 800×1000)",
  },
  category_grid: {
    // The in-grid card renders the image as a landscape panel beside the copy —
    // a wide 16:9 crop fits it (the old 21:9 slab assumed a full-bleed band).
    desktop: "Paysage 16:9 — 1600×900 px",
    mobile: "Paysage 16:9 — 1200×675 px",
  },
};
const DEFAULT_RECO = {
  desktop: "Paysage 16:9 — 2400×1350 px",
  mobile: "Portrait 4:5 — 1080×1350 px",
};
/** Recommended source video for the home hero (kept short + light to autoplay).
 *  The médiathèque ne gère que les images → la vidéo est HÉBERGÉE ailleurs (CDN) et
 *  référencée par URL ; l'image du visuel sert d'affiche + de repli. */
const VIDEO_RECO =
  "URL d'une vidéo hébergée (CDN) — MP4/WebM 16:9, ≤ 10 s, ≤ 6 Mo. Muette, en boucle ; l'image sert d'affiche.";

/** Human label for a locked-placement form (Footer/Nav editors embed this). */
export type BannerFormInitial = {
  id: string;
  placement: string;
  name: string;
  eyebrow: string | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageMediaId: string | null;
  imageMobileMediaId: string | null;
  videoUrl: string | null;
  showText: boolean;
  /** Resolved editable CTAs (effectiveBannerButtons) — the home hero editor seed. */
  buttons: BannerButton[];
  startAt: string | null;
  endAt: string | null;
  displayOrder: number;
  isActive: boolean;
  targetKind: string;
  targetRef: string | null;
  afterLoadMoreCount: number;
  gridPosition: string;
  stripTone: string;
  stripIcon: string | null;
  showCountdown: boolean;
};

export function BannerForm({
  mode,
  initial,
  successHref,
  defaultPlacement,
  targetOptions,
  lockPlacement,
}: {
  mode: "create" | "edit";
  initial?: BannerFormInitial;
  successHref?: string;
  /** Pre-selected placement for a fresh banner (e.g. the active placement tab). */
  defaultPlacement?: string;
  /** Category / brand / filter pickers for in-grid (category_grid) targeting. */
  targetOptions: BannerTargetOptions;
  /**
   * Fix the placement to a single value and hide the selector — used by the
   * dedicated Footer editor (CMS → Footer) which embeds this form constrained
   * to the `footer` placement. On create it posts a hidden `placement` input so
   * the action still receives it. Falls back to `defaultPlacement` /
   * `initial.placement`.
   */
  lockPlacement?: string;
}) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    mode === "edit" ? updateBannerAction : createBannerAction,
    null,
  );

  // Editing a row whose placement the selector doesn't offer (checkout, or a
  // footer / `nav_*` singleton reached by URL) pins it: the select can't show
  // it, and posting its raw value made every save of a `nav_*` row fail the
  // banner validation (« Validation échouée »).
  const offered = PLACEMENTS.some((p) => p.value === initial?.placement);
  const lockedTo =
    lockPlacement ?? (mode === "edit" && initial && !offered ? initial.placement : undefined);

  // Placement drives which tabs + fields are offered, and is controlled so
  // changing it can fold tabs away mid-edit. When locked, it's pinned to the
  // lock value and the selector is replaced by a read-only label.
  const [placement, setPlacement] = useState<string>(
    lockedTo ?? initial?.placement ?? defaultPlacement ?? "home_hero",
  );
  const [targetKind, setTargetKind] = useState<string>(initial?.targetKind ?? "none");
  const [targetRef, setTargetRef] = useState<string>(initial?.targetRef ?? "");
  const [activeTab, setActiveTab] = useState<TabId>("content");
  useTabErrorFocus({ state, fieldTabMap: FIELD_TAB, tabOrder: TAB_ORDER, setActiveTab });
  // React 19 resets a form after its action settles — a FAILED save would wipe every
  // uncontrolled field (name/title/schedule/…). This handler suppresses that reset and
  // only resets on success, matching every other tabbed admin editor.
  const onSubmit = useNoResetSubmit(formAction, state);

  // Per-placement capabilities (requirement #1 — the form collects EXACTLY what the
  // matching storefront renderer reads, so there are no silent dead inputs). What each
  // renderer actually uses:
  //   home_hero     → eyebrow, title, subtitle, description, image(+mobile), video, buttons
  //   category_grid → eyebrow, title, subtitle, image(+mobile), 1 CTA (label+link), targeting
  //   header_strip  → title (the message), tone/icon/countdown, a link (wraps the message)
  //   footer        → eyebrow, title, subtitle, newsletter button LABEL (no image/desc/link)
  //   nav_*         → eyebrow/subtitle, title, image, a featured-panel link (locked, by URL)
  const isHero = placement === "home_hero";
  const isGrid = placement === "category_grid";
  const isStrip = placement === "header_strip";
  const isFooter = placement === "footer";
  const isNav = Boolean(lockedTo?.startsWith("nav_"));
  // The strip is a text bar and the footer newsletter has no image slot — neither renders one.
  const showImageTab = !isStrip && !isFooter;
  // Only the hero renders an art-directed mobile crop + a description. The strip renders
  // neither an eyebrow nor a subtitle (just the one-line message = title).
  const hasMobilePicker = isHero || isGrid;
  const showEyebrow = !isStrip;
  const showSubtitle = !isStrip;
  const showDescription = isHero;
  // Single-CTA controls (non-hero): the grid pill + footer newsletter use a LABEL; the grid
  // pill, strip message and nav featured panel use a LINK. (The hero uses the ButtonsEditor.)
  const showCtaLabel = isGrid || isFooter;
  const showCtaHref = isGrid || isStrip || isNav;
  const reco = IMAGE_RECO[placement] ?? DEFAULT_RECO;
  const tabs = ALL_TABS.filter((t) => {
    if (t.id === "targeting") return isGrid;
    if (t.id === "image") return showImageTab;
    return true;
  });

  // When the placement switch hides the currently-open tab, fall back to Contenu
  // so the panel is never blank (image → strip/footer; targeting → non-grid).
  const onPlacementChange = (next: string) => {
    setPlacement(next);
    const nextNoImage = next === "header_strip" || next === "footer";
    const nextGrid = next === "category_grid";
    if ((activeTab === "image" && nextNoImage) || (activeTab === "targeting" && !nextGrid)) {
      setActiveTab("content");
    }
  };

  // Switching the target kind clears the previously-picked ref (a category
  // slug must not linger when the kind flips to brand/filter).
  const onTargetKindChange = (next: string) => {
    setTargetKind(next);
    setTargetRef("");
  };

  const refOptions =
    targetKind === "category"
      ? targetOptions.categories
      : targetKind === "brand"
        ? targetOptions.brands
        : targetKind === "filter"
          ? targetOptions.filters
          : [];
  const refLabel =
    targetKind === "category"
      ? "Catégorie ciblée"
      : targetKind === "brand"
        ? "Marque ciblée"
        : "Filtre ciblé";

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-4">
      {mode === "edit" && initial && <input type="hidden" name="id" value={initial.id} />}

      <FormTabs
        tabs={tabs}
        defaultTab="content"
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
      >
        {() => (
          <>
            {/* ─── Contenu — placement, titres, description, statut ───── */}
            <FormTab id="content" active={activeTab} spacing="4">
              <div className="grid gap-3 sm:grid-cols-2">
                {lockedTo ? (
                  // Locked: show a read-only label instead of the selector. The placement
                  // is posted (hidden input) on BOTH create and update — re-writing the same
                  // value is a no-op, and it lets the action gate footer/nav_* writes on the
                  // `navigation` permission (their dedicated editors own them).
                  <div>
                    <input type="hidden" name="placement" value={lockedTo} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Emplacement
                    </span>
                    <p className="mt-1 flex h-11 items-center rounded-2xl border border-border bg-surface px-4 text-sm text-muted-foreground">
                      {PLACEMENT_LABELS[lockedTo] ?? lockedTo}
                    </p>
                  </div>
                ) : (
                  <SelectField
                    name="placement"
                    label="Emplacement"
                    options={PLACEMENTS}
                    value={placement}
                    onChange={onPlacementChange}
                    required
                  />
                )}
                <Field name="name" label="Nom interne" required defaultValue={initial?.name} />
                {showEyebrow && (
                  <Field name="eyebrow" label="Surtitre" defaultValue={initial?.eyebrow ?? ""} />
                )}
                <Field
                  name="title"
                  label={isStrip ? "Message" : "Titre"}
                  required
                  defaultValue={initial?.title}
                />
                {showSubtitle && (
                  <Field name="subtitle" label="Sous-titre" defaultValue={initial?.subtitle ?? ""} />
                )}
                <Field
                  name="displayOrder"
                  label="Ordre d'affichage"
                  type="number"
                  defaultValue={initial?.displayOrder ?? 0}
                />
              </div>
              {showDescription && (
                <Field
                  name="description"
                  label="Description"
                  textarea
                  defaultValue={initial?.description ?? ""}
                />
              )}

              {/* Hero: show / hide the text overlay (requirement #4). The hidden
                  `showTextField` marker lets the action tell "unchecked" (false) apart
                  from "this placement has no such field" (→ leave the column default
                  true), so creating a non-hero banner never stores show_text=false. */}
              {isHero && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="hidden" name="showTextField" value="1" />
                  <input
                    type="checkbox"
                    name="showText"
                    defaultChecked={initial?.showText ?? true}
                    className="h-4 w-4 accent-[var(--primary)]"
                  />
                  Afficher le texte &amp; les boutons par-dessus l&apos;image/la vidéo
                  <span className="text-muted-foreground">
                    (décochez pour une diapositive visuelle seule)
                  </span>
                </label>
              )}

              {/* Header strip: tone + icon + countdown (requirement #7). */}
              {isStrip && (
                <div className="space-y-3 rounded-2xl border border-border bg-surface/40 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Style du bandeau
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SelectField
                      name="stripTone"
                      label="Couleur / ton"
                      options={STRIP_TONE_OPTIONS}
                      defaultValue={initial?.stripTone ?? "olive"}
                    />
                    <Field
                      name="stripIcon"
                      label="Icône / emoji (optionnel)"
                      defaultValue={initial?.stripIcon ?? ""}
                      placeholder="✨"
                      // 16 UTF-16 units so a single multi-codepoint ZWJ emoji
                      // (e.g. 👨‍👩‍👧‍👦 = 11 units) isn't truncated/rejected.
                      maxLength={16}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    {/* Marker: distinguishes "unchecked" from "not this placement" (see showText). */}
                    <input type="hidden" name="showCountdownField" value="1" />
                    <input
                      type="checkbox"
                      name="showCountdown"
                      defaultChecked={initial?.showCountdown ?? false}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                    Afficher un compte à rebours jusqu&apos;à la date de fin
                    <span className="text-muted-foreground">(définissez « Fin » en Programmation)</span>
                  </label>
                </div>
              )}

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={initial?.isActive ?? true}
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                Active (sera affichée selon la fenêtre temporelle)
              </label>
            </FormTab>

            {/* ─── Image — desktop + (hero / in-grid) mobile crop + (hero) video ── */}
            {showImageTab && (
              <FormTab id="image" active={activeTab} spacing="4">
                <div>
                  <MediaPicker
                    name="imageMediaId"
                    value={initial?.imageMediaId ?? null}
                    label={hasMobilePicker ? "Visuel (bureau)" : "Visuel"}
                    scope="cms"
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    Recommandé : {reco.desktop}.
                  </p>
                </div>
                {hasMobilePicker && (
                  <div className="border-t border-border/60 pt-4">
                    <MediaPicker
                      name="imageMobileMediaId"
                      value={initial?.imageMobileMediaId ?? null}
                      label="Visuel mobile (optionnel)"
                      scope="cms"
                    />
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      Recommandé : {reco.mobile}. Laissez vide pour réutiliser le visuel bureau sur
                      mobile.
                    </p>
                  </div>
                )}
                {isHero && (
                  <div className="border-t border-border/60 pt-4">
                    <Field
                      name="videoUrl"
                      label="Vidéo — URL (optionnel)"
                      type="url"
                      defaultValue={initial?.videoUrl ?? ""}
                      placeholder="https://cdn.exemple.com/hero.mp4"
                    />
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      {VIDEO_RECO}
                    </p>
                  </div>
                )}
              </FormTab>
            )}

            {/* ─── Lien — editable buttons (hero) OR a single CTA (per placement) ── */}
            <FormTab id="link" active={activeTab} spacing="4">
              {isHero ? (
                <ButtonsEditor initial={initial?.buttons ?? []} />
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {showCtaLabel && (
                      <Field
                        name="ctaLabel"
                        label={isFooter ? "Bouton newsletter — texte" : "Bouton — texte"}
                        defaultValue={initial?.ctaLabel ?? ""}
                      />
                    )}
                    {showCtaHref && (
                      <Field
                        name="ctaHref"
                        label={isStrip ? "Lien du bandeau" : "Bouton — lien"}
                        defaultValue={initial?.ctaHref ?? ""}
                      />
                    )}
                  </div>
                  {isStrip && (
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Le lien rend tout le bandeau cliquable (optionnel).
                    </p>
                  )}
                  {isFooter && (
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Libellé du bouton d&apos;inscription à la newsletter (le footer n&apos;affiche
                      ni image, ni lien — seulement surtitre / titre / sous-titre + ce bouton).
                    </p>
                  )}
                </>
              )}
            </FormTab>

            {/* ─── Ciblage + position — in-grid placement only ─────────── */}
            {isGrid && (
              <FormTab id="targeting" active={activeTab} spacing="4">
                <p className="rounded-2xl border border-border bg-surface/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
                  Ces réglages ne concernent que les bannières « Entre les produits ». Choisissez où
                  la bannière apparaît dans la liste et à quelle fréquence elle se répète.
                </p>
                <SelectField
                  name="gridPosition"
                  label="Position dans la liste"
                  options={GRID_POSITION_OPTIONS}
                  defaultValue={initial?.gridPosition ?? "after_rows"}
                  helper="« En haut » l'épingle au-dessus de la liste ; « Après le 1er Charger plus » l'affiche une seule fois ; « Tous les N blocs » la répète selon la cadence ci-dessous (1 bloc = 20 produits / une page « Charger plus »)."
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField
                    name="targetKind"
                    label="Cibler"
                    options={TARGET_KIND_OPTIONS}
                    value={targetKind}
                    onChange={onTargetKindChange}
                    helper="« Global » l'affiche sur toutes les listes."
                  />
                  <Field
                    name="afterLoadMoreCount"
                    label="Répéter tous les N blocs"
                    type="number"
                    min={1}
                    max={20}
                    defaultValue={initial?.afterLoadMoreCount ?? 2}
                    placeholder="2"
                  />
                </div>
                {targetKind !== "none" && (
                  <SelectField
                    name="targetRef"
                    label={refLabel}
                    options={refOptions}
                    value={targetRef}
                    onChange={setTargetRef}
                    placeholder="Sélectionner la cible…"
                    helper={
                      refOptions.length === 0
                        ? "Aucune cible disponible — créez d'abord une catégorie / marque / filtre."
                        : undefined
                    }
                  />
                )}
              </FormTab>
            )}

            {/* ─── Programmation ───────────────────────────────────────── */}
            <FormTab id="schedule" active={activeTab} spacing="4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  name="startAt"
                  label="Début"
                  type="datetime-local"
                  step="60"
                  defaultValue={isoToLocalInput(initial?.startAt)}
                />
                <Field
                  name="endAt"
                  label="Fin"
                  type="datetime-local"
                  step="60"
                  defaultValue={isoToLocalInput(initial?.endAt)}
                />
              </div>
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
  );
}

/**
 * Editable CTA list for the home hero (requirement #5). Each row is a label +
 * link + design (mapped on the storefront to the shared button system). The
 * whole list serialises to a single hidden `buttons` JSON input; the workflow
 * re-parses + sanitises it (drops rows missing a label or a real link, safe-
 * href's the links, caps the count), so incomplete rows just vanish on save.
 */
function ButtonsEditor({ initial }: { initial: BannerButton[] }) {
  const [rows, setRows] = useState<BannerButton[]>(initial);

  const setRow = (i: number, patch: Partial<BannerButton>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () =>
    setRows((rs) =>
      rs.length >= MAX_BANNER_BUTTONS
        ? rs
        : [...rs, { label: "", href: "", variant: "on-photo" }],
    );
  const remove = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) =>
    setRows((rs) => {
      const j = i + dir;
      if (j < 0 || j >= rs.length) return rs;
      const copy = rs.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const designOptions = BANNER_BUTTON_VARIANTS.map((v) => ({
    value: v,
    label: BANNER_BUTTON_VARIANT_LABELS[v],
  }));

  return (
    <div className="space-y-3">
      {/* The single source of truth posted to the action. */}
      <input type="hidden" name="buttons" value={JSON.stringify(rows)} />

      {rows.length === 0 && (
        <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-[11px] leading-relaxed text-muted-foreground">
          Aucun bouton. Ajoutez-en un ci-dessous — un bouton a besoin d&apos;un texte et d&apos;un
          lien pour s&apos;afficher.
        </p>
      )}

      {rows.map((b, i) => (
        <div key={i} className="space-y-3 rounded-2xl border border-border bg-surface/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Bouton {i + 1}
            </span>
            <div className="flex items-center gap-1">
              <IconBtn
                label="Monter"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                icon={<ArrowUp className="h-3.5 w-3.5" />}
              />
              <IconBtn
                label="Descendre"
                disabled={i === rows.length - 1}
                onClick={() => move(i, 1)}
                icon={<ArrowDown className="h-3.5 w-3.5" />}
              />
              <IconBtn
                label="Supprimer"
                danger
                onClick={() => remove(i)}
                icon={<Trash2 className="h-3.5 w-3.5" />}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput
              label="Texte"
              value={b.label}
              onChange={(v) => setRow(i, { label: v })}
              placeholder="Découvrir"
            />
            <TextInput
              label="Lien"
              value={b.href}
              onChange={(v) => setRow(i, { href: v })}
              placeholder="/boutique ou https://…"
            />
          </div>
          <SelectField
            label={`Design du bouton ${i + 1}`}
            options={designOptions}
            value={b.variant}
            onChange={(v) => setRow(i, { variant: v as BannerButton["variant"] })}
          />
          {/* An incomplete row (text XOR link) is silently dropped on save — warn inline
              so the operator knows it won't appear rather than discovering it on reload. */}
          {Boolean(b.label.trim()) !== Boolean(b.href.trim()) && (
            <p className="text-[11px] leading-relaxed text-amber-600">
              Ce bouton nécessite un texte ET un lien — sinon il ne sera pas enregistré.
            </p>
          )}
        </div>
      ))}

      {rows.length < MAX_BANNER_BUTTONS && (
        <button
          type="button"
          onClick={add}
          className="inline-flex h-10 items-center gap-2 rounded-full border border-border px-4 text-sm font-medium hover:bg-surface"
        >
          <Plus className="h-4 w-4" /> Ajouter un bouton
        </button>
      )}
    </div>
  );
}

/** Small round icon action used by the buttons editor rows. */
function IconBtn({
  label,
  icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-8 w-8 place-items-center rounded-full transition disabled:opacity-30 ${
        danger
          ? "text-destructive hover:bg-destructive/10"
          : "text-muted-foreground hover:bg-surface hover:text-foreground"
      }`}
    >
      {icon}
    </button>
  );
}

/** Controlled text input matching the Field look (for the buttons editor rows). */
function TextInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm"
      />
    </label>
  );
}

function Field({
  name,
  label,
  required,
  textarea,
  type,
  step,
  min,
  max,
  maxLength,
  defaultValue,
  placeholder,
}: {
  name: string;
  label: string;
  required?: boolean;
  textarea?: boolean;
  type?: string;
  step?: string | number;
  min?: number;
  max?: number;
  maxLength?: number;
  defaultValue?: string | number | null;
  placeholder?: string;
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
          rows={3}
          defaultValue={defaultValue ?? ""}
          placeholder={placeholder}
          className="mt-1 w-full rounded-2xl border border-border bg-background p-3 text-sm"
        />
      ) : (
        <input
          id={id}
          name={name}
          type={type ?? "text"}
          required={required}
          step={step}
          min={min}
          max={max}
          maxLength={maxLength}
          defaultValue={defaultValue ?? ""}
          placeholder={placeholder}
          className="mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm"
        />
      )}
    </div>
  );
}
