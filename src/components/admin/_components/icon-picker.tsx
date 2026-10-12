"use client";

import { useState } from "react";
import { Ban } from "lucide-react";

import { CHIP_ICON_OPTIONS } from "@/lib/catalog/chip-icons";
import { MediaPicker } from "@/components/admin/media-picker";

/**
 * Reusable editor for an entity's listing chip-icon (the storefront "thumbs"
 * strip / CategoryNavBar). Two ways to set it, in priority order at render:
 *
 *   1. a CUSTOM médiathèque image (`iconMediaId`) — wins when set;
 *   2. a curated lucide icon picked from {@link CHIP_ICON_OPTIONS} (`icon`);
 *   3. else the per-type default glyph (handled storefront-side).
 *
 * Like the rest of the admin forms it owns no submit logic — it renders a
 * hidden `<input name="icon">` (the chosen key, or "" for none) plus a
 * single-image `MediaPicker` named `iconMediaId`, so the parent <form> picks
 * both up natively in its Server Action.
 *
 * Dropped into the "Image" / identity section of the category, brand and
 * collection editors.
 */
export function IconPicker({
  icon,
  iconMediaId,
  scope = "uploads",
}: {
  /** Initial lucide icon key (edit mode); null/empty = none chosen. */
  icon?: string | null;
  /** Initial custom-image media id (edit mode). */
  iconMediaId?: string | null;
  /** Upload bucket for new custom images — matches the form's other pickers. */
  scope?: "products" | "categories" | "brands" | "cms" | "uploads";
}) {
  // Controlled selection (radio behaviour) emitted via the hidden `icon` input.
  // "" = none → the action's nullable() reads present-but-empty as null and
  // clears the column, so the storefront falls back to the per-type default.
  const [selected, setSelected] = useState<string>(icon ?? "");

  const tile =
    "grid aspect-square place-items-center rounded-2xl border bg-background text-muted-foreground transition hover:border-primary/40 hover:text-foreground";
  const tileSelected = "border-primary bg-primary/10 text-primary ring-2 ring-primary/20";

  return (
    <div className="space-y-5">
      {/* Hidden source of truth for the form action. */}
      <input type="hidden" name="icon" value={selected} />

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Icône de la pastille
        </p>
        <p className="mb-2.5 mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
          Choisissez l&apos;icône affichée dans la barre de navigation du listing.
          Laissez « Aucune » pour utiliser l&apos;icône par défaut du type. Une image
          personnalisée (ci-dessous) a la priorité sur l&apos;icône choisie.
        </p>
        <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 md:grid-cols-10">
          {/* "Aucune" — clears the key → storefront uses the per-type default. */}
          <button
            type="button"
            onClick={() => setSelected("")}
            aria-pressed={selected === ""}
            title="Aucune (icône par défaut)"
            className={`${tile} ${selected === "" ? tileSelected : "border-border"}`}
          >
            <Ban className="h-5 w-5" strokeWidth={1.5} />
          </button>
          {CHIP_ICON_OPTIONS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setSelected(key)}
              aria-pressed={selected === key}
              title={label}
              className={`${tile} ${selected === key ? tileSelected : "border-border"}`}
            >
              <Icon className="h-5 w-5" strokeWidth={1.5} />
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Image personnalisée
        </p>
        <p className="mb-2.5 mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
          Optionnel. Format carré recommandé (~96×96 à 256×256 px), PNG ou SVG à
          fond transparent. Si définie, elle remplace l&apos;icône choisie ci-dessus.
        </p>
        <MediaPicker name="iconMediaId" value={iconMediaId ?? null} scope={scope} />
      </div>
    </div>
  );
}
