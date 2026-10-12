"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";

import { dinarsToMinor, minorToDinars } from "@/lib/price";
import { type ActionState } from "@/lib/actions/types";
import { MediaPicker } from "@/components/admin/media-picker";
import { PRODUCT_FORM_ID } from "@/components/admin/_components/product-ai-context";
import type { ProductFormAttribute } from "./product-form";

/** Existing variant rows, loaded server-side and passed in for editing. */
export type InitialVariant = {
  id: string;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  /** Stored label — source of truth for a MANUAL (attribute-free) variant. */
  label: string;
  priceCents: number;
  oldPriceCents: number | null;
  stockQty: number | null;
  inStock: boolean;
  isDefault: boolean;
  /** Per-variant image — set via the per-row MediaPicker, falls back to the
   *  product gallery on the storefront. */
  imageMediaId: string | null;
  attributeValueIds: string[];
};

type VariantDraft = {
  id: string | null;
  key: string;
  sku: string;
  gtin: string;
  mpn: string;
  /** Free-text name. Only used for MANUAL variants (no attributeValueIds); for
   *  attribute variants the label is derived from the combo on save. */
  label: string;
  /** Price in TND (major units) for the input; converted to integer minor units (millimes) on submit. */
  priceTnd: string;
  /** Compare-at price in TND, or "" for none. */
  oldPriceTnd: string;
  /** Stock as a string so "" can mean untracked. */
  stockQty: string;
  inStock: boolean;
  /**
   * The stock this row had when it was loaded / last saved (existing variants
   * only). Posted with the row so the server writes stock ONLY when the operator
   * changed it — and refuses if it moved meanwhile (a sale) — instead of
   * re-writing the page-load snapshot over every variant on every save.
   */
  origStockQty: number | null;
  origInStock: boolean;
  isDefault: boolean;
  /** Per-variant image media id, edited via the per-row MediaPicker. */
  imageMediaId: string | null;
  /** Attribute value ids — EMPTY for a manual variant (its label is free-text). */
  attributeValueIds: string[];
};

let keyCounter = 0;
const nextKey = () => `v${keyCounter++}`;
const comboKey = (ids: string[]) => [...ids].sort().join("|");
/** Draft stock string → the submitted value ("" = untracked → null). */
const draftQty = (s: string): number | null =>
  s.trim() === "" ? null : Math.max(0, Math.round(Number(s)));

/**
 * Variant editor for a product. Two ways to build the variant set:
 *   - "Générer" — cartesian product of the attribute VALUES the product has
 *     been assigned (Attributs tab). One variant per combination.
 *   - manual edits / deletes on the resulting rows.
 *
 * Saved as part of the SINGLE product save (there is no separate variants
 * button): once the operator edits the set, the editor mirrors it into the main
 * product `<form>` as a hidden `variantsJson` field, so the one "Enregistrer"
 * persists variants too (`updateProductAction` folds them in, id-stable so
 * editing keeps variant ids — see the workflow). The standalone
 * `upsertProductVariantsAction` remains for the decoupled write-API, but the UI
 * no longer calls it.
 *
 * `state` / `pending` are the MAIN product save's, owned by `ProductForm`: a
 * successful save re-baselines each existing variant's stock (so the next
 * compare-and-set save isn't rejected as stale) and clears the dirty flag.
 */
export function ProductVariantsEditor({
  attributes,
  selectedValueIds,
  basePriceCents,
  productName,
  productSku,
  productStockQty,
  initial,
  state,
  pending,
}: {
  attributes: ProductFormAttribute[];
  selectedValueIds: string[];
  basePriceCents: number;
  /** The product's own (Général) data — offered as the first variant when the
   *  product first becomes variable, so its base info isn't lost. */
  productName: string;
  productSku: string | null;
  productStockQty: number | null;
  initial: InitialVariant[];
  /** MAIN product-save state (owned by ProductForm) — drives the post-save
   *  stock re-baseline + dirty reset. */
  state: ActionState | null;
  /** Whether the MAIN product save is in flight (owned by ProductForm). */
  pending: boolean;
}) {
  const selectedSet = useMemo(() => new Set(selectedValueIds), [selectedValueIds]);

  // Variation axes = the product's assigned attributes that have ≥1 value.
  const axes = useMemo(
    () =>
      attributes
        .map((a) => ({ ...a, values: a.values.filter((v) => selectedSet.has(v.id)) }))
        .filter((a) => a.values.length > 0),
    [attributes, selectedSet],
  );

  const valueLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of attributes) for (const v of a.values) m.set(v.id, v.label);
    return m;
  }, [attributes]);

  const [variants, setVariants] = useState<VariantDraft[]>(() =>
    initial.map((v) => ({
      id: v.id,
      key: nextKey(),
      sku: v.sku ?? "",
      gtin: v.gtin ?? "",
      mpn: v.mpn ?? "",
      label: v.label ?? "",
      priceTnd: minorToDinars(v.priceCents).toString(),
      oldPriceTnd: v.oldPriceCents != null ? minorToDinars(v.oldPriceCents).toString() : "",
      stockQty: v.stockQty == null ? "" : String(v.stockQty),
      inStock: v.inStock,
      origStockQty: v.stockQty,
      origInStock: v.inStock,
      isDefault: v.isDefault,
      imageMediaId: v.imageMediaId,
      attributeValueIds: v.attributeValueIds,
    })),
  );
  // The editor mirrors its set into the MAIN product form only ONCE the operator
  // edits it, so an untouched Variantes tab never re-writes variants on an
  // unrelated product save. Every user mutation goes through `mutate` (below),
  // which flips this on; a successful save clears it.
  const [dirty, setDirty] = useState(false);
  /** Wrap a `setVariants` that represents a USER EDIT — marks the set dirty so
   *  it's included in the next product save. (The initial seed + the post-save
   *  re-baseline below use raw `setVariants`, as neither is an edit to persist.) */
  const mutate = (updater: (cur: VariantDraft[]) => VariantDraft[]) => {
    setDirty(true);
    setVariants(updater);
  };

  // After a SUCCESSFUL save the SUBMITTED stock becomes the new baseline, so the
  // next save doesn't mistake an already-saved value for a fresh edit (which the
  // server would then reject as a stale conflict). Snapshotted when the save
  // STARTS (pending false→true), not read back from the drafts, so an edit typed
  // while the save was in flight still counts as a change. Adjusting state while
  // rendering on a prop change is React's sanctioned "previous value" pattern.
  const [submittedStock, setSubmittedStock] = useState<
    Map<string, { qty: number | null; inStock: boolean }>
  >(() => new Map());
  const [wasPending, setWasPending] = useState(pending);
  if (pending !== wasPending) {
    setWasPending(pending);
    // A product save just began — snapshot what we're sending as the baseline
    // to apply if it succeeds.
    if (pending) {
      setSubmittedStock(
        new Map(variants.map((v) => [v.key, { qty: draftQty(v.stockQty), inStock: v.inStock }])),
      );
    }
  }
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state?.ok) {
      setVariants((cur) =>
        cur.map((v) => {
          const s = submittedStock.get(v.key);
          return v.id && s ? { ...v, origStockQty: s.qty, origInStock: s.inStock } : v;
        }),
      );
      // What we sent is now persisted — a later unrelated save shouldn't re-write
      // the (unchanged) variant set. Re-editing flips dirty back on.
      setDirty(false);
    }
  }
  // Shown when adding the FIRST manual variant — asks whether to seed it from
  // the product's own (Général) data.
  const [seedPrompt, setSeedPrompt] = useState(false);

  const ensureDefault = (list: VariantDraft[]): VariantDraft[] => {
    if (list.length === 0 || list.some((v) => v.isDefault)) return list;
    return list.map((v, i) => (i === 0 ? { ...v, isDefault: true } : v));
  };

  const generate = () => {
    if (axes.length === 0) return;
    let combos: string[][] = [[]];
    for (const a of axes) {
      const next: string[][] = [];
      for (const combo of combos) for (const v of a.values) next.push([...combo, v.id]);
      combos = next;
    }
    const have = new Set(variants.map((v) => comboKey(v.attributeValueIds)));
    const additions = combos
      .filter((c) => !have.has(comboKey(c)))
      .map((combo) => ({
        id: null,
        key: nextKey(),
        sku: "",
        gtin: "",
        mpn: "",
        label: "",
        priceTnd: minorToDinars(basePriceCents).toString(),
        oldPriceTnd: "",
        stockQty: "",
        inStock: true,
        origStockQty: null, // new row — no baseline (its stock is always written)
        origInStock: true,
        isDefault: false,
        imageMediaId: null,
        attributeValueIds: combo,
      }));
    if (additions.length) mutate((cur) => ensureDefault([...cur, ...additions]));
  };

  // ─── Manual variant ──────────────────────────────────────────────────
  // A free-form variant NOT derived from attributes: the operator names it
  // ("Édition limitée", "Bracelet cuir"…) and sets its own sku/price/stock.
  // It carries no attributeValueIds, so it persists with its custom label and
  // is offered on the PDP as a direct-select option (see the flat-list picker).
  const makeManualDraft = (seed?: {
    label: string;
    sku: string;
    stockQty: string;
    isDefault: boolean;
  }): VariantDraft => ({
    id: null,
    key: nextKey(),
    sku: seed?.sku ?? "",
    gtin: "",
    mpn: "",
    label: seed?.label ?? "",
    priceTnd: minorToDinars(basePriceCents).toString(),
    oldPriceTnd: "",
    stockQty: seed?.stockQty ?? "",
    inStock: true,
    origStockQty: null, // new row — no baseline (its stock is always written)
    origInStock: true,
    isDefault: seed?.isDefault ?? false,
    imageMediaId: null,
    attributeValueIds: [],
  });

  const addBlankManual = () =>
    mutate((cur) => ensureDefault([...cur, makeManualDraft()]));

  // Seed the FIRST variant from the product's own (Général) data so its base
  // info isn't lost when the product turns variable, then add a blank one to
  // fill. The seeded row becomes the default.
  const seedFromProductThenAdd = () =>
    mutate((cur) =>
      ensureDefault([
        makeManualDraft({
          label: productName.trim() || "Standard",
          sku: productSku?.trim() ?? "",
          stockQty: productStockQty == null ? "" : String(productStockQty),
          isDefault: true,
        }),
        makeManualDraft(),
        ...cur,
      ]),
    );

  // First manual variant on a product with NO variants yet → ask whether to
  // carry the product data over as the first variant. With ≥1 variant it just
  // appends a blank one.
  const addManual = () => {
    if (variants.length === 0) setSeedPrompt(true);
    else addBlankManual();
  };


  const update = (key: string, patch: Partial<VariantDraft>) =>
    mutate((cur) => cur.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  const remove = (key: string) =>
    mutate((cur) => ensureDefault(cur.filter((v) => v.key !== key)));
  const setDefault = (key: string) =>
    mutate((cur) => cur.map((v) => ({ ...v, isDefault: v.key === key })));

  // Serialised payload for the action (TND → integer minor units / millimes).
  const payload = JSON.stringify(
    variants.map((v, i) => ({
      id: v.id,
      // Attribute variant → derive the label from its combo; manual variant →
      // the operator's free-text name.
      label: v.attributeValueIds.length
        ? v.attributeValueIds.map((id) => valueLabel.get(id) ?? id).join(" / ")
        : v.label.trim(),
      sku: v.sku.trim() || null,
      gtin: v.gtin.trim() || null,
      mpn: v.mpn.trim() || null,
      priceCents: dinarsToMinor(Number(v.priceTnd) || 0),
      // Empty / 0 / non-numeric old-price → null (no compare-at). Avoids a
      // round-trip rejection: the server schema requires oldPriceCents be
      // positive-or-null, so a stray "0" must serialise as null, not 0.
      oldPriceCents: Number(v.oldPriceTnd) > 0 ? dinarsToMinor(Number(v.oldPriceTnd)) : null,
      stockQty: draftQty(v.stockQty),
      inStock: v.inStock,
      // Existing rows carry their baseline: the server writes stock only when
      // it differs, and refuses if the DB moved since (compare-and-set).
      ...(v.id ? { origStockQty: v.origStockQty, origInStock: v.origInStock } : {}),
      isDefault: v.isDefault,
      imageMediaId: v.imageMediaId,
      displayOrder: i,
      attributeValueIds: v.attributeValueIds,
    })),
  );

  // A sellable variant needs a positive price; block save on a bad/empty input
  // so the server (priceCents > 0) never rejects the whole set after a round-trip.
  const hasInvalidPrice = variants.length > 0 && variants.some((v) => !(Number(v.priceTnd) > 0));
  // A manual variant must be named (its label is its only identity on the PDP +
  // in the cart). Attribute variants derive their label, so they're exempt.
  const hasUnnamedManual = variants.some(
    (v) => v.attributeValueIds.length === 0 && !v.label.trim(),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface/40 p-3">
        {/* Attribute-driven generation — only when the product has assigned
            attribute values (Attributs tab). */}
        {axes.length > 0 && (
          <button
            type="button"
            onClick={generate}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-xs font-semibold text-background transition hover:opacity-90"
          >
            <Wand2 className="h-3.5 w-3.5" /> Générer depuis les attributs
          </button>
        )}
        {/* Manual variant — always available, incl. on products with no
            attributes (free-form name + price + stock). */}
        <button
          type="button"
          onClick={addManual}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-4 text-xs font-semibold text-foreground transition hover:bg-surface"
        >
          <Plus className="h-3.5 w-3.5" /> Variante manuelle
        </button>
        {axes.length > 0 ? (
          <span className="text-[11px] text-muted-foreground">
            Axes : <span className="font-medium text-foreground">{axes.map((a) => a.name).join(" × ")}</span>
          </span>
        ) : (
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            Aucun attribut assigné — ajoutez des variantes manuelles, ou assignez
            des valeurs d&apos;attributs (onglet{" "}
            <span className="font-semibold text-foreground">Attributs</span>) pour
            générer des combinaisons.
          </span>
        )}
      </div>

      {variants.length > 0 && (
        <div className="space-y-2">
          {variants.map((v) => (
            <div key={v.key} className="rounded-2xl border border-border bg-card p-3 shadow-soft">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-semibold text-foreground">
                  {v.attributeValueIds.length
                    ? v.attributeValueIds.map((id) => valueLabel.get(id) ?? id).join(" / ") ||
                      "Variante"
                    : v.label.trim() || "Variante manuelle"}
                </p>
                <div className="flex shrink-0 items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <input
                      type="radio"
                      name="variant-default"
                      checked={v.isDefault}
                      onChange={() => setDefault(v.key)}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    Par défaut
                  </label>
                  <button
                    type="button"
                    onClick={() => remove(v.key)}
                    aria-label="Supprimer la variante"
                    className="grid h-7 w-7 place-items-center rounded-full text-destructive transition hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {/* Manual variant — its name is free-text (attribute variants
                  derive their label from the combo, so no input is shown). */}
              {v.attributeValueIds.length === 0 && (
                <div className="mt-2.5">
                  <VInput
                    label="Nom de la variante"
                    value={v.label}
                    onChange={(val) => update(v.key, { label: val })}
                    placeholder="ex. Édition limitée, Bracelet cuir…"
                  />
                </div>
              )}
              <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
                <VInput
                  label="SKU (child)"
                  value={v.sku}
                  onChange={(val) => update(v.key, { sku: val })}
                  placeholder="ex. TK-CASIO-001"
                />
                <VInput
                  label="Prix (TND)"
                  type="number"
                  step="0.001"
                  value={v.priceTnd}
                  onChange={(val) => update(v.key, { priceTnd: val })}
                  placeholder="0"
                />
                <VInput
                  label="Stock"
                  type="number"
                  value={v.stockQty}
                  onChange={(val) => update(v.key, { stockQty: val })}
                  placeholder="vide = illimité"
                />
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <VInput
                  label="GTIN / EAN"
                  value={v.gtin}
                  onChange={(val) => update(v.key, { gtin: val })}
                  placeholder="8–14 chiffres"
                />
                <VInput
                  label="MPN"
                  value={v.mpn}
                  onChange={(val) => update(v.key, { mpn: val })}
                  placeholder="réf. fabricant"
                />
                <VInput
                  label="Ancien prix (TND)"
                  type="number"
                  step="0.001"
                  value={v.oldPriceTnd}
                  onChange={(val) => update(v.key, { oldPriceTnd: val })}
                  placeholder="optionnel"
                />
              </div>
              <div className="mt-2.5">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  Image de la variante{" "}
                  <span className="font-normal">(optionnelle — sinon la galerie du produit)</span>
                </p>
                {/* Single-mode picker. The editor serialises `variants` to the
                    hidden variantsJson field, so this picker's own hidden input
                    is NOT read — onChange writes imageMediaId into the draft,
                    which the payload serialises. `name` is therefore a throwaway. */}
                <MediaPicker
                  name={`variant-image-${v.key}`}
                  scope="products"
                  value={v.imageMediaId}
                  emptyLabel="Choisir une image"
                  onChange={(id) => update(v.key, { imageMediaId: id })}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* NO separate save button — variants are persisted by the ONE product
          "Enregistrer". Once edited, mirror the set into the MAIN product form as
          a hidden `variantsJson` field (associated via the HTML `form` attribute,
          so no invalid nested <form>); `updateProductAction` folds it in. Emitted
          only when dirty, so an untouched Variantes tab never re-writes variants
          on an unrelated product save. The inline hints below still warn about a
          bad price / unnamed manual variant before the operator saves. */}
      {dirty && (
        <input type="hidden" form={PRODUCT_FORM_ID} name="variantsJson" value={payload} />
      )}
      {(hasInvalidPrice || hasUnnamedManual) && (
        <div className="flex flex-wrap items-center gap-3">
          {hasInvalidPrice && (
            <span className="text-[11px] font-medium text-destructive">
              Chaque variante doit avoir un prix &gt; 0.
            </span>
          )}
          {hasUnnamedManual && !hasInvalidPrice && (
            <span className="text-[11px] font-medium text-destructive">
              Chaque variante manuelle doit avoir un nom.
            </span>
          )}
        </div>
      )}

      {/* First-manual-variant prompt — offer to carry the product's own data over
          as the first variant so it isn't lost when the product turns variable. */}
      {seedPrompt && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Première variante"
        >
          <div className="absolute inset-0 bg-slate-950/50" onClick={() => setSeedPrompt(false)} />
          <div className="relative w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-lift">
            <h3 className="text-[14.5px] font-semibold text-foreground">Première variante</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Reprendre les données du produit (nom, SKU, prix, stock) comme{" "}
              <span className="font-medium text-foreground">première variante</span> ? Une seconde
              variante vide sera ajoutée à remplir. Sinon, une seule variante vide est créée.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setSeedPrompt(false)}
                className="inline-flex h-10 items-center rounded-full border border-border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => {
                  addBlankManual();
                  setSeedPrompt(false);
                }}
                className="inline-flex h-10 items-center rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground transition hover:bg-surface"
              >
                Variante vide
              </button>
              <button
                type="button"
                onClick={() => {
                  seedFromProductThenAdd();
                  setSeedPrompt(false);
                }}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lift"
              >
                <Plus className="h-4 w-4" /> Reprendre le produit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function VInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number";
  placeholder?: string;
  /** Number-input step. Pass "0.001" for TND prices so millimes can be typed. */
  step?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <input
        type={type}
        inputMode={type === "number" ? (step ? "decimal" : "numeric") : undefined}
        min={type === "number" ? 0 : undefined}
        step={type === "number" ? step : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );
}
