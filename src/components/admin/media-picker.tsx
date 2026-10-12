"use client";

import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { updateMediaAction } from "@/lib/actions/catalog";
import { MAX_UPLOAD_MB_CEILING } from "@/modules/media/limits";

/**
 * Central media picker used by every admin form that owns image fields.
 *
 *   <MediaPicker name="heroMediaId" value={initial} onChange={(id) => …} />
 *
 *   <MediaPicker
 *     name="mediaIds"
 *     multi
 *     value={initialIds}
 *     onChange={(ids) => …}
 *     label="Galerie"
 *   />
 *
 * The component itself doesn't post to any endpoint — it manages the
 * selection state and renders one or more hidden `<input name="…">` so
 * the parent <form> picks the IDs up natively. This means it drops cleanly
 * into Server Action forms without a JS round-trip.
 *
 * The browse drawer fetches from `/api/admin/media` and supports:
 *   - search by filename (typed into the search box, debounced 250ms)
 *   - cursor pagination (« Charger plus » button appends the next page)
 *   - inline upload (POST as multipart/form-data, then reload the first page)
 *   - import-from-URL (POST to `/api/admin/media/import-url`; the server
 *     SSRF-checks the host, downloads, and re-encodes to webp/avif)
 *
 * Single-mode: clicking a tile replaces the current selection.
 * Multi-mode: clicking toggles, the order of selection is preserved.
 */

export type MediaItem = {
  id: string;
  url: string;
  thumbUrl: string;
  filename: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  altText: string | null;
  /** External CDN override — when set it replaces the generated URL. */
  urlOverride: string | null;
  mimeType: string;
  hasWebp: boolean;
  hasAvif: boolean;
  hasOriginal: boolean;
};

type SingleProps = {
  name: string;
  multi?: false;
  value: string | null;
  onChange?: (value: string | null) => void;
  label?: string;
  scope?: "products" | "categories" | "brands" | "cms" | "uploads";
  emptyLabel?: string;
};

type MultiProps = {
  name: string;
  multi: true;
  value: string[];
  onChange?: (value: string[]) => void;
  label?: string;
  scope?: "products" | "categories" | "brands" | "cms" | "uploads";
  emptyLabel?: string;
};

type Props = SingleProps | MultiProps;

/**
 * The media API denies with an EMPTY 404 (`requirePermission` → notFound) — or
 * a 403 — when the signed-in user lacks the Médiathèque grant (browse = `media:
 * view`, upload / import = `media:create`). This picker is embedded in forms of
 * OTHER modules (produits, marques, bannières, blog, thème…) whose editors may
 * hold no media grant, so name the missing permission instead of a raw
 * « HTTP 404 ». The same empty 404 is also returned when the staff session
 * expired / was revoked while the form stayed open (`getSession()` null →
 * notFound), so the copy names both causes. Returns null for any other status.
 */
function mediaAccessDeniedMessage(status: number, op: "view" | "create"): string | null {
  if (status !== 403 && status !== 404) return null;
  return op === "view"
    ? "Accès à la médiathèque refusé — session expirée (reconnectez-vous) ou permission « Médiathèque : voir » manquante (demandez-la à un administrateur)."
    : "Ajout à la médiathèque refusé — session expirée (reconnectez-vous) ou permission « Médiathèque : créer » manquante (demandez-la à un administrateur).";
}

export function MediaPicker(props: Props) {
  const isMulti = props.multi === true;
  const [selected, setSelected] = useState<string[]>(
    isMulti ? (props.value as string[]) : props.value ? [props.value as string] : [],
  );
  const [details, setDetails] = useState<Record<string, MediaItem>>({});
  const [open, setOpen] = useState(false);
  // Which selected item's inline metadata editor (alt / filename / CDN URL)
  // is currently open. Null = none.
  const [editingId, setEditingId] = useState<string | null>(null);
  // The selection's metadata fetch was DENIED (no Médiathèque grant): the tiles
  // explain it instead of staying blank skeletons. The hidden inputs still carry
  // the ids, so saving the form keeps the existing images.
  const [previewDenied, setPreviewDenied] = useState(false);
  // Bumped to re-run the metadata fetch (auto-retry after a transient failure, or
  // the manual « Recharger les aperçus » button) so previews for a large gallery
  // hydrate reliably.
  const [reloadTick, setReloadTick] = useState(0);
  const retriesRef = useRef(0);

  // Merge a patched MediaItem back into the local detail cache so the tile +
  // thumbnail refresh immediately after an edit saves.
  const patchDetail = useCallback((id: string, patch: Partial<MediaItem>) => {
    setDetails((d) => (d[id] ? { ...d, [id]: { ...d[id], ...patch } } : d));
  }, []);

  // Fetch metadata for any selection we don't already have details for.
  // This survives the case where the parent passes IDs we haven't browsed yet.
  //
  // `requestedRef` tracks ids we've already asked the API for, so an id the API
  // never returns (deleted media, an id from elsewhere, …) is not re-fetched
  // forever. Without it this would loop: `setDetails` always returns a NEW
  // object reference even when nothing matched, and `details` is a dependency,
  // so the effect would re-run and re-fetch the still-missing id every render.
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = selected.filter(
      (id) => !details[id] && !requestedRef.current.has(id),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      // The API caps ids-mode at 50 per call. Chunk so a selection larger than 50 still hydrates.
      const CHUNK = 50;
      let failed = false;
      for (let i = 0; i < missing.length && !cancelled; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK);
        try {
          const res = await fetch(
            `/api/admin/media?ids=${encodeURIComponent(chunk.join(","))}`,
            { credentials: "same-origin" },
          );
          if (cancelled) return;
          if (!res.ok) {
            if (mediaAccessDeniedMessage(res.status, "view")) {
              // Permission/session denial — retrying can't help, so mark the chunk
              // requested (stop the effect from re-running forever) and let the tiles
              // show the « accès refusé » message instead of blank skeletons.
              setPreviewDenied(true);
              for (const id of chunk) requestedRef.current.add(id);
            } else {
              // A TRANSIENT failure must NOT mark the ids as requested — otherwise a
              // product with many images leaves the failed ones as PERMANENT skeletons.
              // Leave them unmarked so the auto-retry / « Recharger » re-attempts them.
              failed = true;
            }
            continue;
          }
          const data = (await res.json()) as { items: MediaItem[] };
          if (cancelled) return;
          // Definitive answer received — mark the WHOLE chunk requested: found ids hydrate
          // below; ids the API omits are deleted media, marked so they don't re-fetch forever
          // (the loop the requestedRef guard exists to prevent). Marking here — AFTER a real
          // response, not before the fetch — is what lets React 19 StrictMode's dev double-mount
          // re-fetch on the second mount instead of skipping (the cancelled first fetch leaves
          // requestedRef empty), so existing gallery thumbnails actually hydrate in dev.
          for (const id of chunk) requestedRef.current.add(id);
          const found = data.items.filter((m) => chunk.includes(m.id));
          if (found.length > 0) {
            setDetails((d) => {
              const next = { ...d };
              for (const m of found) next[m.id] = m;
              return next;
            });
          }
        } catch {
          failed = true;
        }
      }
      // Auto-retry transient failures a few times (backoff) so previews hydrate without the
      // user having to reorder or click « Recharger ».
      if (!cancelled && failed && retriesRef.current < 3) {
        retriesRef.current += 1;
        setTimeout(() => {
          if (!cancelled) setReloadTick((t) => t + 1);
        }, 500 * retriesRef.current);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, details, reloadTick]);

  const commit = useCallback(
    (next: string[]) => {
      setSelected(next);
      if (isMulti) {
        (props as MultiProps).onChange?.(next);
      } else {
        (props as SingleProps).onChange?.(next[0] ?? null);
      }
    },
    [isMulti, props],
  );

  const toggle = useCallback(
    (item: MediaItem) => {
      setDetails((d) => ({ ...d, [item.id]: item }));
      if (!isMulti) {
        commit([item.id]);
        setOpen(false);
        return;
      }
      const exists = selected.includes(item.id);
      commit(exists ? selected.filter((x) => x !== item.id) : [...selected, item.id]);
    },
    [commit, isMulti, selected],
  );

  const remove = useCallback(
    (id: string) => commit(selected.filter((x) => x !== id)),
    [commit, selected],
  );

  const move = useCallback(
    (id: string, direction: -1 | 1) => {
      const idx = selected.indexOf(id);
      if (idx < 0) return;
      const target = idx + direction;
      if (target < 0 || target >= selected.length) return;
      const next = [...selected];
      [next[idx], next[target]] = [next[target], next[idx]];
      commit(next);
    },
    [commit, selected],
  );

  // Promote an image to FIRST = the main product image, in one click (the arrows still work for
  // fine reordering; this is the direct « définir comme principale » shortcut).
  const setMain = useCallback(
    (id: string) => {
      if (selected[0] === id || !selected.includes(id)) return;
      commit([id, ...selected.filter((x) => x !== id)]);
    },
    [commit, selected],
  );

  // Force a re-fetch of previews still missing after a transient failure. Clears them from the
  // « already requested » set so the effect re-attempts them (deleted media simply stay blank,
  // and can be removed with the tile's Trash control).
  const reloadPreviews = useCallback(() => {
    for (const id of selected) if (!details[id]) requestedRef.current.delete(id);
    retriesRef.current = 0;
    setReloadTick((t) => t + 1);
  }, [selected, details]);

  return (
    <div>
      {props.label && (
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {props.label}
        </label>
      )}

      {/* Hidden inputs for the form action — one per selection. */}
      {isMulti ? (
        selected.map((id) => <input key={id} type="hidden" name={props.name} value={id} />)
      ) : (
        <input type="hidden" name={props.name} value={selected[0] ?? ""} />
      )}

      <div className="mt-2 space-y-3">
        {selected.length === 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex h-32 w-full items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-border bg-card text-sm text-muted-foreground transition hover:border-primary/40 hover:bg-surface hover:text-foreground"
          >
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface">
              <ImageIcon className="h-5 w-5" />
            </span>
            <span className="text-left">
              <span className="block font-semibold text-foreground">
                {props.emptyLabel ?? "Choisir un média"}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Sélectionnez depuis la bibliothèque ou importez un nouveau fichier.
              </span>
            </span>
          </button>
        ) : (
          <div className="space-y-3">
            {isMulti && (
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-2.5">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {selected.length} média{selected.length > 1 ? "s" : ""}{" "}
                  sélectionné{selected.length > 1 ? "s" : ""} ·{" "}
                  <span className="text-foreground">le premier sert d&apos;image principale</span>
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Shown only while some tiles are still un-hydrated — force-refetch their previews
                      (covers a transient load failure on a large gallery). */}
                  {!previewDenied && selected.some((id) => !details[id]) && (
                    <button
                      type="button"
                      onClick={reloadPreviews}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-500/20 dark:text-amber-300"
                    >
                      <RefreshCw className="h-3 w-3" /> Recharger les aperçus
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-[11px] font-semibold transition hover:bg-surface"
                  >
                    <Upload className="h-3 w-3" /> Ajouter / parcourir
                  </button>
                </div>
              </div>
            )}
            <div
              className={
                isMulti
                  ? "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
                  : // Single-image mode: cap so the card doesn't inflate
                    // to the full form width. The action chips hang below.
                    "max-w-xs"
              }
            >
              {selected.map((id, idx) => {
                const item = details[id];
                return (
                  <SelectedTile
                    key={id}
                    item={item}
                    previewDenied={previewDenied}
                    multi={isMulti}
                    isFirst={idx === 0}
                    isLast={idx === selected.length - 1}
                    isEditing={editingId === id}
                    onRemove={() => remove(id)}
                    onEdit={() => setEditingId((cur) => (cur === id ? null : id))}
                    onMoveLeft={isMulti && idx > 0 ? () => move(id, -1) : undefined}
                    onMoveRight={
                      isMulti && idx < selected.length - 1 ? () => move(id, 1) : undefined
                    }
                    onSetMain={isMulti && idx > 0 ? () => setMain(id) : undefined}
                  />
                );
              })}
            </div>

            {/* Inline metadata editor — alt text, filename, external CDN
                URL — for the currently-editing selection. Mirrors the
                Médiathèque edit panel and persists via updateMediaAction. */}
            {editingId && details[editingId] && (
              <MediaEditPanel
                item={details[editingId]}
                onClose={() => setEditingId(null)}
                onSaved={(patch) => patchDetail(editingId, patch)}
              />
            )}
            {!isMulti && (
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-4 text-xs font-semibold transition hover:bg-surface"
              >
                <Pencil className="h-3 w-3" /> Remplacer le média
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <PickerDialog
          multi={isMulti}
          scope={props.scope ?? "uploads"}
          selectedIds={selected}
          onClose={() => setOpen(false)}
          onPick={toggle}
        />
      )}
    </div>
  );
}

/**
 * Selected-media card. Visual rhythm matches the Médiathèque grid card:
 *   - rounded image at top with hover overlay
 *   - "Primaire" badge on the first multi-selection
 *   - metadata row: filename · dimensions · weight
 *   - format chips (WebP / AVIF / Original) — link to each variant
 *   - hover actions: reorder, copy URL, remove
 */
function SelectedTile({
  item,
  previewDenied,
  multi,
  isFirst,
  isLast,
  isEditing,
  onRemove,
  onEdit,
  onMoveLeft,
  onMoveRight,
  onSetMain,
}: {
  item: MediaItem | undefined;
  /** The metadata fetch was denied (no `media:view`) — explain the empty tile. */
  previewDenied: boolean;
  multi: boolean;
  isFirst: boolean;
  isLast: boolean;
  isEditing: boolean;
  onRemove: () => void;
  onEdit: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  /** Promote to first = main image. Undefined for the first tile (already main). */
  onSetMain?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!item) {
    // Permission/session denial: the fetch will never succeed — say so plainly.
    if (previewDenied) {
      return (
        <div className="grid aspect-square place-items-center rounded-2xl border border-border bg-surface p-3 text-center text-[11px] text-muted-foreground">
          Aperçu indisponible (session expirée ou permission « Médiathèque : voir » requise)
        </div>
      );
    }
    // Metadata not loaded yet (large gallery still hydrating, or a transient failure).
    // Render a placeholder that STILL carries the positioning controls, so the image can be
    // set-as-main / reordered / removed even before its thumbnail hydrates.
    return (
      <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="relative aspect-square bg-surface">
          <div className="absolute inset-0 grid place-items-center">
            <ImageIcon className="h-6 w-6 text-muted-foreground/40" />
          </div>
          {multi && isFirst && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground shadow-soft">
              <Star className="h-2.5 w-2.5 fill-current" /> Principale
            </span>
          )}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-2 opacity-0 transition group-hover:opacity-100">
            <div className="flex items-center gap-1">
              {onSetMain && (
                <button
                  type="button"
                  onClick={onSetMain}
                  className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-foreground transition hover:bg-white"
                  aria-label="Définir comme image principale"
                  title="Définir comme image principale"
                >
                  <Star className="h-3.5 w-3.5" />
                </button>
              )}
              {onMoveLeft && (
                <button
                  type="button"
                  onClick={onMoveLeft}
                  className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-foreground transition hover:bg-white"
                  aria-label="Déplacer vers la gauche"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
              )}
              {onMoveRight && (
                <button
                  type="button"
                  onClick={onMoveRight}
                  className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-foreground transition hover:bg-white"
                  aria-label="Déplacer vers la droite"
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onRemove}
              className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-destructive transition hover:bg-white"
              aria-label="Retirer la sélection"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="p-3">
          <p className="truncate text-[11px] text-muted-foreground">Aperçu en cours de chargement…</p>
        </div>
      </div>
    );
  }

  const dims =
    item.width && item.height ? `${item.width} × ${item.height}` : null;
  const weight =
    item.sizeBytes < 1024
      ? `${item.sizeBytes} B`
      : item.sizeBytes < 1024 * 1024
        ? `${Math.round(item.sizeBytes / 1024)} KB`
        : `${(item.sizeBytes / 1024 / 1024).toFixed(1)} MB`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(item.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-card shadow-soft transition ${
        isEditing
          ? "border-primary ring-2 ring-primary/20"
          : "border-border hover:border-primary/40"
      }`}
    >
      {/* Image + hover overlay */}
      <div className="relative aspect-square bg-surface">
        <Image
          src={item.thumbUrl}
          alt={item.altText ?? item.filename}
          fill
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
          className="object-cover"
        />
        {multi && isFirst && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground shadow-soft">
            <Star className="h-2.5 w-2.5 fill-current" /> Principale
          </span>
        )}
        {/* Hover overlay with actions */}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-2 opacity-0 transition group-hover:opacity-100">
          <div className="flex items-center gap-1">
            {/* « Définir comme principale » — one click promotes this image to first (the arrows
                still work for fine reordering). Undefined on the first tile (already main). */}
            {onSetMain && (
              <button
                type="button"
                onClick={onSetMain}
                className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-foreground transition hover:bg-white"
                aria-label="Définir comme image principale"
                title="Définir comme image principale"
              >
                <Star className="h-3.5 w-3.5" />
              </button>
            )}
            {onMoveLeft && (
              <button
                type="button"
                onClick={onMoveLeft}
                disabled={isFirst}
                className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-foreground transition hover:bg-white disabled:opacity-30"
                aria-label="Déplacer vers la gauche"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
            {onMoveRight && (
              <button
                type="button"
                onClick={onMoveRight}
                disabled={isLast}
                className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-foreground transition hover:bg-white disabled:opacity-30"
                aria-label="Déplacer vers la droite"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onEdit}
              className={`grid h-7 w-7 place-items-center rounded-full transition hover:bg-white ${
                isEditing ? "bg-primary text-primary-foreground" : "bg-white/90 text-foreground"
              }`}
              aria-label="Modifier les métadonnées"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-foreground transition hover:bg-white"
              aria-label="Copier l'URL"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-destructive transition hover:bg-white"
              aria-label="Retirer la sélection"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Metadata footer */}
      <div className="space-y-1.5 p-3">
        <p className="truncate text-[12px] font-medium text-foreground" title={item.filename}>
          {item.filename}
        </p>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {dims ? `${dims} · ` : ""}
          {weight}
        </p>
        {/* Variant chips — non-clickable badges marking which derived variants
            exist for this media (webp / avif / kept original). */}
        <div className="flex flex-wrap items-center gap-1">
          {item.hasWebp && (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-emerald-700 dark:text-emerald-300">
              WebP
            </span>
          )}
          {item.hasAvif && (
            <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-violet-700 dark:text-violet-300">
              AVIF
            </span>
          )}
          {item.hasOriginal && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">
              Original
            </span>
          )}
        </div>
        {/* Always-visible « Définir comme principale » — same reasoning as the metadata toggle
            below (the hover Star is undiscoverable on touch + easy to miss). One click promotes
            this image to first = main; the arrows still handle fine reordering. Absent on the
            first tile, which already carries the « Principale » badge. */}
        {onSetMain && (
          <button
            type="button"
            onClick={onSetMain}
            className="inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 text-[11px] font-semibold text-primary transition hover:bg-primary/10"
          >
            <Star className="h-3 w-3" /> Définir comme principale
          </button>
        )}
        {/* Always-visible metadata editor toggle. The Pencil in the hover
            overlay above is undiscoverable on touch (no hover) and easy to
            miss on desktop — this button gives the alt / filename / CDN
            controls a permanent, tappable entry point, matching the
            Médiathèque's edit affordance. */}
        <button
          type="button"
          onClick={onEdit}
          aria-expanded={isEditing}
          className={`inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-full border text-[11px] font-semibold transition ${
            isEditing
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-surface text-muted-foreground hover:border-primary/40 hover:text-foreground"
          }`}
        >
          <Pencil className="h-3 w-3" />
          {isEditing ? "Fermer" : "Alt · nom · CDN"}
        </button>
      </div>
    </div>
  );
}

/**
 * Inline metadata editor for a selected media item — the same controls the
 * Médiathèque exposes (alt text, filename, external CDN URL override).
 * Persists through `updateMediaAction` (shared with the Médiathèque) and
 * reports the patch back so the picker's thumbnail/alt refresh immediately.
 *
 * `urlOverride` is the escape hatch that swaps the generated URL for an
 * external CDN — handy when serving product images from a CDN domain.
 */
function MediaEditPanel({
  item,
  onClose,
  onSaved,
}: {
  item: MediaItem;
  onClose: () => void;
  onSaved: (patch: Partial<MediaItem>) => void;
}) {
  const [altText, setAltText] = useState(item.altText ?? "");
  const [filename, setFilename] = useState(item.filename);
  const [urlOverride, setUrlOverride] = useState(item.urlOverride ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const onSave = () => {
    setError(null);
    setSaved(false);
    const fd = new FormData();
    fd.set("mediaId", item.id);
    fd.set("altText", altText.trim());
    if (filename.trim()) fd.set("filename", filename.trim());
    fd.set("urlOverride", urlOverride.trim());
    startTransition(async () => {
      const res = await updateMediaAction(null, fd);
      if (!res.ok) {
        setError(res.message ?? "Échec de l'enregistrement.");
        return;
      }
      onSaved({
        altText: altText.trim() || null,
        filename: filename.trim() || item.filename,
        urlOverride: urlOverride.trim() || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  };

  return (
    <div className="space-y-3 rounded-2xl border border-primary/30 bg-surface/40 p-4 shadow-soft">
      <header className="flex items-center justify-between gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Modifier · partagé entre toutes les variantes
        </h4>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Texte alternatif
        </span>
        <input
          type="text"
          value={altText}
          onChange={(e) => setAltText(e.target.value)}
          placeholder="Décrivez l'image (SEO + accessibilité)"
          className="mt-1.5 h-10 w-full rounded-2xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Nom du fichier
        </span>
        <input
          type="text"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          className="mt-1.5 h-10 w-full rounded-2xl border border-border bg-background px-3 font-mono text-[12px] focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          URL externe (CDN — remplace l&apos;URL générée)
        </span>
        <input
          type="url"
          value={urlOverride}
          onChange={(e) => setUrlOverride(e.target.value)}
          placeholder="https://cdn.tokyostore.tn/…"
          className="mt-1.5 h-10 w-full rounded-2xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <span className="mt-1.5 block text-[10px] leading-relaxed text-muted-foreground">
          Laisser vide pour utiliser l&apos;image stockée (servie via le CDN
          configuré dans Réglages média, sinon en same-origin). Ce champ force
          une URL externe verbatim pour cette image uniquement ; son domaine
          doit être autorisé dans <code className="rounded bg-card px-1">remotePatterns</code>{" "}
          (variable d&apos;env <code className="rounded bg-card px-1">MEDIA_CDN_URL</code>) pour
          s&apos;afficher côté boutique.
        </span>
      </label>

      {error && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {pending ? "Enregistrement…" : "Enregistrer"}
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
            <Check className="h-3.5 w-3.5" /> Enregistré
          </span>
        )}
      </div>
    </div>
  );
}

export function PickerDialog({
  multi,
  scope,
  selectedIds,
  onClose,
  onPick,
}: {
  multi: boolean;
  scope: "products" | "categories" | "brands" | "cms" | "uploads";
  selectedIds: string[];
  onClose: () => void;
  onPick: (item: MediaItem) => void;
}) {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, startUpload] = useTransition();
  const [importUrl, setImportUrl] = useState("");

  const fetchPage = useCallback(
    async (opts: { append?: boolean; q?: string; cursor?: string | null }) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (opts.q) params.set("q", opts.q);
        if (opts.cursor) params.set("cursor", opts.cursor);
        params.set("limit", "24");
        const res = await fetch(`/api/admin/media?${params.toString()}`, {
          credentials: "same-origin",
        });
        if (!res.ok) {
          throw new Error(
            mediaAccessDeniedMessage(res.status, "view") ?? `Erreur de chargement (HTTP ${res.status})`,
          );
        }
        const data = (await res.json()) as { items: MediaItem[]; nextCursor: string | null };
        setItems((prev) => (opts.append ? [...prev, ...data.items] : data.items));
        setCursor(data.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Erreur de chargement");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Initial load AND search share one debounced effect: on mount `search` is
  // "" so this fetches page 1, and every keystroke re-fetches 250ms later.
  // Deliberately NO separate mount effect — that would fire a second page-1
  // fetch on open; this single effect owns the first load.
  useEffect(() => {
    const t = setTimeout(() => {
      void fetchPage({ q: search });
    }, 250);
    return () => clearTimeout(t);
  }, [search, fetchPage]);

  const onUpload = (file: File) => {
    // Client-side hard-ceiling pre-check: a file over the Next body limit (16 MB)
    // is truncated server-side and 413s AFTER a full upload. Reject it up-front so
    // the operator gets instant feedback instead of waiting for a doomed upload.
    // Uses the absolute ceiling (not the live max_upload_mb, which the picker
    // doesn't hold) so it never rejects a file the server would actually accept.
    if (file.size > MAX_UPLOAD_MB_CEILING * 1024 * 1024) {
      setError(`Fichier trop volumineux (max ${MAX_UPLOAD_MB_CEILING} MB).`);
      return;
    }
    startUpload(async () => {
      try {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("scope", scope);
        const res = await fetch("/api/admin/media/upload", { method: "POST", body: fd });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(
            body.error ??
              mediaAccessDeniedMessage(res.status, "create") ??
              `Échec du téléversement (HTTP ${res.status})`,
          );
          return;
        }
        await fetchPage({});
      } catch (e) {
        setError(e instanceof Error ? e.message : "Échec du téléversement");
      }
    });
  };

  const onImportUrl = () => {
    const url = importUrl.trim();
    if (!url) return;
    setError(null);
    startUpload(async () => {
      try {
        const res = await fetch("/api/admin/media/import-url", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, scope }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(
            body.error ??
              mediaAccessDeniedMessage(res.status, "create") ??
              `Échec de l'import (HTTP ${res.status})`,
          );
          return;
        }
        setImportUrl("");
        await fetchPage({});
      } catch (e) {
        setError(e instanceof Error ? e.message : "Échec de l'import depuis l'URL");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-4xl overflow-hidden rounded-3xl border border-border bg-background shadow-2xl">
        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-5 py-4">
          <h2 className="font-display text-lg font-semibold text-foreground">Médiathèque</h2>
          <input
            id={searchId}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher par nom…"
            className="h-9 flex-1 rounded-full border border-border bg-background px-4 text-sm focus:outline-none"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-xs font-semibold text-background disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            {uploading ? "Envoi…" : "Téléverser"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-surface"
            aria-label="Fermer"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Import from URL — server downloads + processes (webp/avif) securely */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/40 px-5 py-2.5">
          <input
            type="url"
            inputMode="url"
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onImportUrl();
              }
            }}
            placeholder="…ou collez une URL d'image (https://…)"
            className="h-8 min-w-[180px] flex-1 rounded-full border border-border bg-background px-3 text-xs focus:outline-none"
          />
          <button
            type="button"
            onClick={onImportUrl}
            disabled={uploading || !importUrl.trim()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-[11px] font-semibold text-foreground hover:bg-surface disabled:opacity-50"
          >
            {uploading ? "Import…" : "Importer l'URL"}
          </button>
        </div>

        {error && (
          <div className="border-b border-border bg-destructive/10 px-5 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="max-h-[60vh] overflow-y-auto p-5">
          {items.length === 0 && !loading ? (
            <div className="grid place-items-center py-16 text-sm text-muted-foreground">
              Aucune image. Téléversez la première.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {items.map((it) => {
                const isSelected = selectedIds.includes(it.id);
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onPick(it)}
                    className="group relative overflow-hidden rounded-2xl border border-border bg-card text-left transition hover:border-primary"
                  >
                    <div className="relative aspect-square bg-surface">
                      <Image
                        src={it.thumbUrl}
                        alt={it.altText ?? it.filename}
                        fill
                        sizes="200px"
                        className="object-cover"
                      />
                      {isSelected && (
                        <span className="absolute inset-0 flex items-center justify-center bg-primary/20">
                          <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-4 w-4" />
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="p-2 text-[10px]">
                      <p className="truncate font-medium">{it.filename}</p>
                      <p className="text-muted-foreground">
                        {it.width}×{it.height} · {(it.sizeBytes / 1024).toFixed(0)} KB
                        {it.hasAvif ? " · AVIF" : ""}
                        {it.hasWebp ? " · WebP" : ""}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {cursor && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => fetchPage({ append: true, q: search, cursor })}
                disabled={loading}
                className="inline-flex h-9 items-center rounded-full border border-border bg-card px-4 text-xs font-medium"
              >
                {loading ? "Chargement…" : "Charger plus"}
              </button>
            </div>
          )}
        </div>

        {multi && (
          <footer className="flex items-center justify-between gap-3 border-t border-border bg-card px-5 py-3 text-xs">
            <span className="text-muted-foreground">
              {selectedIds.length} sélectionnée{selectedIds.length > 1 ? "s" : ""}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 items-center rounded-full bg-primary px-5 text-xs font-semibold text-primary-foreground"
            >
              Valider la sélection
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

