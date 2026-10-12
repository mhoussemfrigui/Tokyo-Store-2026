"use client";

import { startTransition, useEffect, useRef, useState } from "react";

import type { ActionState } from "@/lib/actions/types";
import { cn } from "@/lib/utils";

/**
 * Shared admin form tab-strip primitive — the single tab bar used by every
 * tabbed admin form. One rounded card hosts both the tab strip and the
 * panel body, so the tabs read as attached to the form rather than
 * floating above it.
 *
 * Visual structure:
 *   ┌──────────────────────── card ─────────────────────────┐
 *   │  ▢ Tab 1   Tab 2   Tab 3   ...        ← tab bar      │
 *   │  ────────────────────────────────  bottom border     │
 *   │                                                       │
 *   │   <FormTab id="x"> ...panel body... </FormTab>       │
 *   │                                                       │
 *   └───────────────────────────────────────────────────────┘
 *
 *   - The whole form is wrapped in a single rounded card so the tabs and
 *     the panel body share one rectangle (no floating tab strip).
 *   - The active tab gets a solid `bg-card` chip with a soft shadow; the
 *     border-b under the tab bar lines the rest of the row so the active
 *     tab visibly "connects" to the panel below.
 *   - Sticky behaviour is preserved — the bar keeps `bg-card/95
 *     backdrop-blur` so it stays legible when content scrolls under it.
 *   - On narrow viewports the tab list scrolls horizontally with a hidden
 *     scrollbar.
 *
 * Usage:
 *
 *   <FormTabs
 *     tabs={[{ id: "general", label: "Général" }, ...]}
 *     defaultTab="general"
 *   >
 *     {(active) => (
 *       <>
 *         <FormTab id="general" active={active}>...</FormTab>
 *         <FormTab id="other"   active={active}>...</FormTab>
 *       </>
 *     )}
 *   </FormTabs>
 *
 * Why a render-prop (rather than a context):
 *   - Every form already manages its own state side-by-side with the tabs
 *     (highlights, value-props, selected-filter sets, etc.). Threading the
 *     active tab through a hook would force every form to be split into a
 *     wrapper + inner component; the render-prop keeps the existing layout
 *     intact.
 *   - All panels remain mounted (hidden via the HTML `hidden` attribute)
 *     so the `FormData` still captures every input on submit regardless
 *     of which tab is visible.
 */

export type FormTabDef<TId extends string = string> = {
  id: TId;
  label: string;
  /** Optional leading icon (e.g. a Lucide component). */
  icon?: React.ElementType;
  /** Optional trailing badge / count (e.g. a pending-review count). */
  badge?: React.ReactNode;
  /**
   * Optional group label — when a tabbed form carries many sub-tabs it renders
   * VERTICALLY (the mockup's product-detail left nav), and consecutive tabs that
   * share a `group` are bucketed under a crimson uppercase group heading. Ignored
   * in the horizontal strip. Omit it for ungrouped (a single flat list).
   */
  group?: string;
};

/**
 * The bare segmented tab STRIP — a soft ivory track with a raised white active
 * pill (olive text). Card-less, so admin pages whose tab panels are their OWN
 * cards (multi-card dashboards: stock, security, order detail, mailing…) can
 * share the EXACT tab look without nesting a card inside a card. `FormTabs` wraps
 * this in the rounded card + panel body; standalone dashboards render just the
 * strip. Supports an optional per-tab icon + badge.
 */
export function FormTabStrip<TId extends string>({
  tabs,
  activeTab,
  onSelect,
  className,
}: {
  tabs: ReadonlyArray<FormTabDef<TId>>;
  activeTab: TId;
  onSelect: (next: TId) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-fit max-w-full flex-wrap items-center gap-1 rounded-[14px] bg-[var(--background)] p-1",
        className,
      )}
    >
      {tabs.map((t) => {
        const active = activeTab === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] px-[14px] py-[8px] text-[13px] transition",
              active
                ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
                : "font-semibold text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="h-4 w-4 shrink-0" strokeWidth={1.9} />}
            {t.label}
            {t.badge != null && t.badge !== false && (
              <span
                className={cn(
                  "ml-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold leading-none",
                  active ? "bg-primary/[0.12] text-primary" : "bg-foreground/[0.06] text-muted-foreground",
                )}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A standalone sub-tab strip wrapped in its OWN white nav card — for pages whose
 * sub-tab CONTENT is several separate cards (stock, mailing, security, tax, order
 * detail…). Without the card the soft segmented track sits on the bare page
 * canvas, which is the SAME colour, so the strip looks like it floats with no
 * container. This gives it the proper boxed "nav bar" home the mockup uses.
 * (When the content is a single panel, use `FormTabs` instead — it already hosts
 * the strip in its card.)
 */
export function SubTabBar<TId extends string>({
  tabs,
  activeTab,
  onSelect,
  className,
}: {
  tabs: ReadonlyArray<FormTabDef<TId>>;
  activeTab: TId;
  onSelect: (next: TId) => void;
  className?: string;
}) {
  return (
    <div className={cn("rounded-[20px] border border-border bg-card p-2", className)}>
      <FormTabStrip
        tabs={tabs}
        activeTab={activeTab}
        onSelect={onSelect}
        className="w-full flex-nowrap overflow-x-auto"
      />
    </div>
  );
}

export function FormTabs<TId extends string>({
  tabs,
  defaultTab,
  activeTab: controlledActiveTab,
  onActiveTabChange,
  children,
  className,
  orientation = "auto",
}: {
  tabs: ReadonlyArray<FormTabDef<TId>>;
  /** Initial tab in uncontrolled mode (ignored when `activeTab` is set). */
  defaultTab: TId;
  /**
   * Controlled active tab — when provided, the parent owns the state and
   * `onActiveTabChange` MUST also be provided. Use this when a sibling
   * component outside `children` needs to react to which tab is open
   * (e.g. a separate `<form>` rendered below that should only show on
   * the FAQ tab).
   */
  activeTab?: TId;
  onActiveTabChange?: (next: TId) => void;
  /** Render-prop that receives the active tab id. */
  children: (activeTab: TId) => React.ReactNode;
  className?: string;
  /**
   * Layout of the tab navigation (the ADMIN UI mockup's product-detail sub-tabs):
   * "horizontal" = the segmented strip on top (few tabs); "vertical" = a sticky
   * left nav, grouped by `group`, with the content beside it (many tabs, like the
   * product editor). "auto" (default) picks vertical once there are ≥ 6 tabs. On
   * narrow screens the vertical layout falls back to a horizontal scroll strip.
   */
  orientation?: "horizontal" | "vertical" | "auto";
}) {
  const [internalActiveTab, setInternalActiveTab] = useState<TId>(defaultTab);
  const activeTab = controlledActiveTab ?? internalActiveTab;
  const setActiveTab = (next: TId) => {
    if (onActiveTabChange) onActiveTabChange(next);
    else setInternalActiveTab(next);
  };

  const vertical = orientation === "vertical" || (orientation === "auto" && tabs.length >= 6);

  if (vertical) {
    // Bucket consecutive tabs that share a `group` (the mockup's product-detail
    // nav headings). Ungrouped tabs collapse to one label-less bucket.
    const groups: { label?: string; items: FormTabDef<TId>[] }[] = [];
    for (const t of tabs) {
      const last = groups[groups.length - 1];
      if (last && last.label === t.group) last.items.push(t);
      else groups.push({ label: t.group, items: [t] });
    }
    return (
      <div className={cn("rounded-[28px] border border-border bg-card p-4 sm:p-5", className)}>
        {/* Narrow screens: a horizontal scroll strip (mockup's mobile sub-tabs). */}
        <div className="mb-4 -mx-1 overflow-x-auto px-1 [scrollbar-width:none] lg:hidden">
          <FormTabStrip tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} className="w-max flex-nowrap" />
        </div>
        <div className="lg:grid lg:grid-cols-[216px_minmax(0,1fr)] lg:gap-5">
          <nav
            aria-label="Sections"
            className="hidden lg:sticky lg:top-3 lg:flex lg:flex-col lg:gap-3 lg:self-start lg:rounded-[20px] lg:border lg:border-border lg:bg-[#fbf9f8] lg:p-3"
          >
            {groups.map((g, gi) => (
              <div key={g.label ?? `g${gi}`} className="flex flex-col gap-0.5">
                {g.label && (
                  <span className="px-2.5 pb-1 text-[11px] font-extrabold uppercase tracking-[0.14em] text-primary">
                    {g.label}
                  </span>
                )}
                {g.items.map((t) => {
                  const active = activeTab === t.id;
                  const Icon = t.icon;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setActiveTab(t.id)}
                      aria-pressed={active}
                      className={cn(
                        "flex h-[38px] w-full items-center justify-between gap-2 rounded-[11px] px-2.5 text-left text-[14px] transition",
                        active
                          ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.06)]"
                          : "font-semibold text-[#3d4046] hover:bg-card",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {Icon && <Icon className="h-4 w-4 shrink-0" strokeWidth={1.9} />}
                        <span className="truncate">{t.label}</span>
                      </span>
                      {t.badge != null && t.badge !== false && (
                        <span
                          className={cn(
                            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold leading-none",
                            active ? "bg-primary/[0.12] text-primary" : "bg-foreground/[0.06] text-muted-foreground",
                          )}
                        >
                          {t.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="min-w-0">{children(activeTab)}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[28px] border border-border bg-card",
        className,
      )}
    >
      {/* Tab bar — the segmented track: the active tab is a raised white pill
          (crimson text). Sticky + glassy, with a bottom border anchoring it to the
          panel. The track is content-width (capped at the container) and WRAPS to
          more rows when needed, so no tab is ever hidden. */}
      <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-3 py-2.5 backdrop-blur">
        <FormTabStrip tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} />
      </div>

      {/* Panel body — children control their own visibility via <FormTab>. */}
      <div className="p-5 sm:p-6">{children(activeTab)}</div>
    </div>
  );
}

/**
 * Single tab panel. Stays mounted so any input inside is included in the
 * form's `FormData` on submit; visibility is toggled via `hidden`.
 *
 * Visibility is normally derived from `id === active` (the classic tab
 * strip, one panel at a time). Pass an explicit `visible` boolean to
 * override that — used by the create wizard, where a single STEP groups
 * several panels (e.g. Prix + Stock) and so can't be expressed as one
 * active id. Either way the panel stays mounted; only the `hidden`
 * attribute flips, so the single `FormData` always captures every input.
 *
 * `spacing` controls the vertical rhythm inside the active panel — forms
 * can pick `space-y-4` or `space-y-5` to match their density.
 */
export function FormTab<TId extends string>({
  id,
  active,
  visible,
  spacing = "5",
  className,
  children,
}: {
  id: TId;
  active: TId;
  /** Explicit visibility override (wizard steps group multiple panels). */
  visible?: boolean;
  spacing?: "4" | "5";
  className?: string;
  children: React.ReactNode;
}) {
  const isActive = visible ?? id === active;
  return (
    <div
      role="tabpanel"
      hidden={!isActive}
      className={cn(
        isActive && (spacing === "4" ? "space-y-4" : "space-y-5"),
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Wire a tabbed form's submit RESULT to its tab strip.
 *
 * The failure mode this fixes: a tabbed form (product, category, brand,
 * collection…) keeps every panel mounted but hidden, so a validation error on
 * a value that lives on a DIFFERENT tab (a bad `videoUrl` on the Vidéo tab, an
 * over-long meta description on the SEO tab, a slug conflict on Général) is
 * INVISIBLE — the operator only sees a generic banner and cannot find the
 * offending field. This hook reads `state.fieldErrors`, maps each errored field
 * to the tab that owns it via `fieldTabMap`, and jumps `setActiveTab` to the
 * FIRST erroring tab on every new failure so the highlighted control is on
 * screen. It also returns the set of erroring tabs (to badge the strip) and a
 * `fieldError(key)` reader for inline per-field messages.
 *
 * Pair it with {@link TabbedFormError}, which renders the generic message plus a
 * clickable, tab-labelled list of the individual field errors.
 */
export function useTabErrorFocus<TId extends string>({
  state,
  fieldTabMap,
  tabOrder,
  setActiveTab,
}: {
  state: ActionState | null | undefined;
  fieldTabMap: Readonly<Record<string, TId>>;
  tabOrder: ReadonlyArray<TId>;
  setActiveTab: (id: TId) => void;
}): {
  erroringTabs: Set<TId>;
  fieldError: (key: string) => string | undefined;
  hasFieldErrors: boolean;
} {
  const fieldErrors =
    state && !state.ok && state.fieldErrors ? state.fieldErrors : undefined;

  // Which tabs own at least one erroring field (recomputed each render).
  const erroringTabs = new Set<TId>();
  if (fieldErrors) {
    for (const key of Object.keys(fieldErrors)) {
      const tab = fieldTabMap[key];
      if (tab) erroringTabs.add(tab);
    }
  }

  // Jump to the first erroring tab on each NEW failing state. Identity-compare
  // the state object (a fresh one per submit) so we DON'T re-jump when the
  // operator manually navigates tabs afterwards to fix other fields.
  const handledRef = useRef<ActionState | null>(null);
  useEffect(() => {
    if (!state || state.ok || state === handledRef.current) return;
    handledRef.current = state;
    if (!state.fieldErrors) return;
    const first = tabOrder.find((id) => {
      for (const key of Object.keys(state.fieldErrors!)) {
        if (fieldTabMap[key] === id) return true;
      }
      return false;
    });
    if (first) setActiveTab(first);
    // Only react to a new `state`; fieldTabMap/tabOrder/setActiveTab are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return {
    erroringTabs,
    hasFieldErrors: !!fieldErrors && Object.keys(fieldErrors).length > 0,
    fieldError: (key) => fieldErrors?.[key],
  };
}

/**
 * `onSubmit` for a `useActionState` form that KEEPS the operator's input when
 * the action fails.
 *
 * The failure mode this fixes: React 19 resets every `<form action={fn}>` once
 * its action settles — the reset is queued BEFORE the action runs
 * (`startHostTransition` → `requestFormReset`), whatever it returns. Every
 * uncontrolled `defaultValue` / `defaultChecked` field (name, slug, SKU, prix,
 * stock, garantie…) therefore snaps back to its saved value — or to empty in
 * create mode — even when the action answers `{ ok: false }`, and
 * {@link useTabErrorFocus} then jumps to a field that no longer shows what was
 * typed. A re-save after fixing the flagged field silently reverts the rest.
 *
 * The returned handler `preventDefault()`s — so React skips the form `action`
 * and its reset — and dispatches `new FormData(form, submitter)` itself inside
 * `startTransition` (so `isPending` still tracks the save). A dispatch made that
 * way never resets the form. On SUCCESS it resets the form explicitly, as React
 * did, so the fields re-read the fresh server values (auto slug…) and add forms
 * still clear after a successful add.
 *
 * Keep `action={formAction}` on the `<form>` as well: before hydration the
 * browser falls back to it (progressive enhancement, not a GET carrying every
 * field in the URL); once hydrated, the `preventDefault()` here short-circuits it.
 *
 *   const onSubmit = useNoResetSubmit(formAction, state);
 *   <form action={formAction} onSubmit={onSubmit}>…</form>
 */
export function useNoResetSubmit(
  dispatch: (formData: FormData) => void,
  state: ActionState | null | undefined,
): (event: React.FormEvent<HTMLFormElement>) => void {
  // The form last submitted through this handler — reset once its save succeeds.
  const formRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (event) => {
    // React bubbles `submit` through PORTALS: a dialog `<form>` portaled out of
    // this form's subtree (the product editor's PromotionForm) lands here too.
    // Leave it alone so React runs THAT form's own action.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    const form = event.currentTarget;
    formRef.current = form;
    // Carry the clicked submit button's name/value, like a native submit.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(form, submitter);
    startTransition(() => dispatch(formData));
  };
}

/**
 * The result banner for a tabbed form. On success it shows the confirmation; on
 * failure it shows the generic message AND, when `state.fieldErrors` is present,
 * a list of each field error tagged with the tab that holds it — each tag is a
 * button that jumps to that tab. Combined with {@link useTabErrorFocus} (which
 * auto-jumps to the first one), the operator always sees WHAT is wrong and WHERE.
 */
export function TabbedFormError<TId extends string>({
  state,
  fieldTabMap,
  tabLabels,
  onJumpToTab,
  className,
}: {
  state: ActionState | null | undefined;
  // `TId` is pinned from `fieldTabMap`'s VALUE position; the key-position uses
  // below are wrapped in `NoInfer` so TS doesn't widen `TId` to `string`.
  fieldTabMap: Readonly<Record<string, TId>>;
  tabLabels: Readonly<Record<NoInfer<TId>, string>>;
  onJumpToTab: (id: NoInfer<TId>) => void;
  className?: string;
}) {
  if (!state) return null;
  if (state.ok) {
    return (
      <div
        role="status"
        className={cn(
          "rounded-2xl border border-primary/40 bg-primary/5 p-3 text-xs text-primary",
          className,
        )}
      >
        {state.message ?? "Enregistré."}
      </div>
    );
  }

  const entries = Object.entries(state.fieldErrors ?? {});
  return (
    <div
      role="alert"
      className={cn(
        "space-y-2 rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive",
        className,
      )}
    >
      <p className="font-semibold">{state.message}</p>
      {entries.length > 0 && (
        <ul className="space-y-1.5">
          {entries.map(([key, msg]) => {
            const tab = fieldTabMap[key];
            const label = tab ? tabLabels[tab] : undefined;
            return (
              <li key={key} className="flex flex-wrap items-center gap-1.5">
                {tab && label && (
                  <button
                    type="button"
                    onClick={() => onJumpToTab(tab)}
                    className="shrink-0 rounded-full border border-destructive/40 px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wide transition hover:bg-destructive/10"
                  >
                    {label}
                  </button>
                )}
                <span>{msg}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
