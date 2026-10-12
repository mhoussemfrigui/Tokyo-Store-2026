"use client";

import { useState } from "react";
import { Ban, Plus, Trash2 } from "lucide-react";

import { VALUE_PROP_ICONS } from "@/lib/catalog/value-prop-icons";
import { MediaPicker } from "@/components/admin/media-picker";

/**
 * Shared editor for the "value-prop cards" rendered on category / brand landing
 * pages ({ icon, iconMediaId, title, body } each). DYNAMIC: add/remove up to
 * `max` cards (default 8, matching the workflow schema's `.max(8)`).
 *
 * Icons are EDITABLE two ways (same contract as the listing IconPicker): pick a
 * curated lucide icon from a visual grid, OR set a CUSTOM médiathèque image
 * (which wins at render). No more typing a lucide key by hand.
 *
 * Emits a hidden `<input name>` carrying the trimmed JSON array (incl.
 * iconMediaId), read by the create/update actions via `parseValueProps`. Empty
 * cards are stripped at serialise time. Lives inside its tab panel — hidden
 * panels still submit.
 */

type ValueProp = { icon: string; iconMediaId: string | null; title: string; body: string };

const MAX_DEFAULT = 8;

export function ValuePropsEditor({
  name = "valuePropsJson",
  initial,
  max = MAX_DEFAULT,
  scope = "categories",
}: {
  name?: string;
  initial?: Array<{ icon: string; iconMediaId?: string | null; title: string; body: string }> | null;
  max?: number;
  /** Upload bucket for custom icon images. */
  scope?: "products" | "categories" | "brands" | "cms" | "uploads";
}) {
  const [items, setItems] = useState<ValueProp[]>(
    initial && initial.length > 0
      ? initial.map((v) => ({
          icon: v.icon ?? "",
          iconMediaId: v.iconMediaId ?? null,
          title: v.title ?? "",
          body: v.body ?? "",
        }))
      : [{ icon: "", iconMediaId: null, title: "", body: "" }],
  );

  const update = (idx: number, patch: Partial<ValueProp>) =>
    setItems((prev) => prev.map((vp, i) => (i === idx ? { ...vp, ...patch } : vp)));
  const remove = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));
  const add = () =>
    setItems((prev) =>
      prev.length >= max ? prev : [...prev, { icon: "", iconMediaId: null, title: "", body: "" }],
    );

  // Strip rows where every field is blank before serialising.
  const trimmed = items
    .map((vp) => ({
      icon: vp.icon.trim(),
      iconMediaId: vp.iconMediaId,
      title: vp.title.trim(),
      body: vp.body.trim(),
    }))
    .filter((vp) => vp.title.length > 0 || vp.body.length > 0 || vp.icon.length > 0 || vp.iconMediaId);

  const iconTile =
    "grid h-8 w-8 place-items-center rounded-lg border text-muted-foreground transition hover:border-primary/40 hover:text-foreground";
  const iconTileOn = "border-primary bg-primary/10 text-primary";

  return (
    <div className="border-t border-border pt-4">
      <input type="hidden" name={name} value={JSON.stringify(trimmed)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Cartes de valeur ({max} max)
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Cartes affichées sous le bloc éditorial. Choisissez une icône (ou une image
            personnalisée, prioritaire). Les cartes vides sont ignorées.
          </p>
        </div>
        <button
          type="button"
          onClick={add}
          disabled={items.length >= max}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Ajouter une carte
        </button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {items.map((vp, idx) => (
          <div key={idx} className="rounded-2xl border border-border bg-background p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Carte {idx + 1}
              </p>
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label="Supprimer cette carte"
                className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 space-y-2.5">
              {/* Visual icon picker — a wrapped grid of the curated lucide set
                  plus "Aucune". Disabled-looking when a custom image is set
                  (the image wins), but still selectable as the fallback. */}
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  Icône
                </p>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => update(idx, { icon: "" })}
                    aria-pressed={vp.icon === ""}
                    title="Aucune"
                    className={`${iconTile} ${vp.icon === "" ? iconTileOn : "border-border"}`}
                  >
                    <Ban className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                  {VALUE_PROP_ICONS.map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => update(idx, { icon: key })}
                      aria-pressed={vp.icon === key}
                      title={label}
                      className={`${iconTile} ${vp.icon === key ? iconTileOn : "border-border"}`}
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                  ))}
                </div>
              </div>
              {/* Custom image — wins over the icon above when set. */}
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  Image personnalisée (optionnel, prioritaire)
                </p>
                <MediaPicker
                  name={`__vpIcon_${idx}`}
                  value={vp.iconMediaId}
                  onChange={(id) => update(idx, { iconMediaId: (id as string | null) ?? null })}
                  scope={scope}
                />
              </div>
              <input
                type="text"
                value={vp.title}
                onChange={(e) => update(idx, { title: e.target.value })}
                placeholder="Titre"
                className="h-9 w-full rounded-xl border border-border bg-card px-3 text-xs focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <textarea
                value={vp.body}
                onChange={(e) => update(idx, { body: e.target.value })}
                placeholder="Texte (1-2 phrases)"
                rows={3}
                className="w-full rounded-xl border border-border bg-card p-3 text-xs focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
