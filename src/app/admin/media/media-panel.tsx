"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  CheckCircle2,
  Copy,
  ImageIcon,
  Loader2,
  Save,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from "lucide-react";

import {
  bulkDeleteMediaAction,
  deleteMediaAction,
  importMediaFromUrlAction,
  listMediaInUseAction,
  mediaUsageCountAction,
  updateMediaAction,
  uploadMediaAction,
} from "@/lib/actions/catalog";
import { type ActionState } from "@/lib/actions/types";
import { BULK_MEDIA_MAX, MAX_UPLOAD_BYTES_FALLBACK } from "@/modules/media/limits";
import { type MediaUploadScope } from "@/modules/media/validation";
import { ConfirmDeleteModal as SharedConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { AdminCallout, AdminNote, AdminSearch } from "@/components/admin/_components/filter-bar";
import { SelectField } from "@/components/ui/select-field";

type Media = {
  id: string;
  url: string;
  thumbUrl: string;
  filename: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  altText: string | null;
  urlOverride: string | null;
  /**
   * Each variant carries its absolute URL (null when not generated). The
   * card renders one chip per variant; the chip links to the variant URL
   * in a new tab so admins can preview / download each format.
   */
  variants: {
    webp: string | null;
    avif: string | null;
    original: string | null;
  };
  createdAt: string;
};

// The allow-list itself lives in modules/media/validation (the server actions
// validate against it); this is just the labelled picker over the same values.
type Scope = MediaUploadScope;
const SCOPES: { value: Scope; label: string }[] = [
  { value: "uploads", label: "Général" },
  { value: "products", label: "Produit" },
  { value: "categories", label: "Catégorie" },
  { value: "brands", label: "Marque" },
  { value: "cms", label: "CMS" },
];

const ACCEPTED = "image/jpeg,image/png,image/webp,image/avif,image/gif";
const ACCEPTED_EXT = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/**
 * Message for a Server Action call that THREW (vs. returning an ActionState):
 * the request body exceeded Next's Server Action limit (413 — surfaces as
 * "Body exceeded …" in dev, a redacted/generic error in prod, or a reverse
 * proxy's 413 page), or the network dropped. Per-file, so one failure never
 * escapes the transition into the admin error boundary.
 */
function uploadThrowMessage(err: unknown, file: File): string {
  const msg = err instanceof Error ? err.message : "";
  if (/body exceeded|413|too large|payload/i.test(msg)) {
    return `Fichier trop volumineux pour le serveur (${fmtBytes(file.size)}).`;
  }
  return "Échec du téléversement — fichier trop volumineux pour le serveur ou erreur réseau.";
}

/** « Charger plus » batch: the rows older than `cursor` from the admin media
 *  API (same keyset + server search as the page's first batch). */
async function fetchMediaPage(
  cursor: string,
  q: string,
  limit: number,
): Promise<{ items: Media[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ cursor, limit: String(limit) });
  if (q) params.set("q", q);
  const res = await fetch(`/api/admin/media?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /api/admin/media → ${res.status}`);
  const data = (await res.json()) as { items: Media[]; nextCursor: string | null };
  return {
    // Pick the card fields (the API also carries picker-only extras).
    items: data.items.map((m) => ({
      id: m.id,
      url: m.url,
      thumbUrl: m.thumbUrl,
      filename: m.filename,
      width: m.width,
      height: m.height,
      sizeBytes: m.sizeBytes,
      altText: m.altText,
      urlOverride: m.urlOverride,
      variants: m.variants,
      createdAt: m.createdAt,
    })),
    nextCursor: data.nextCursor ?? null,
  };
}

/** Rows loaded by « Charger plus », tied to the server search they continue. */
type MorePages = { q: string; rows: Media[]; cursor: string | null };

export function MediaPanel({
  items,
  orphansMode,
  initialSearch = "",
  maxUploadMb,
  cdnBase = "",
  total,
  nextCursor = null,
  pageSize = 100,
  canCreate,
  canUpdate,
  canDelete,
}: {
  items: Media[];
  orphansMode?: boolean;
  /** Active server search term (library view). Seeds the input; the search is
   *  applied server-side (see page.tsx) so it spans the whole library. */
  initialSearch?: string;
  /** Live upload ceiling (MB) from media_settings. Falls back to the shared
   *  default when the prop is absent (e.g. a stale caller). */
  maxUploadMb?: number;
  /** Effective CDN base resolved server-side. When set, the copy-URL button
   *  yields `<base>/<key>` instead of a window.location.origin path. */
  cdnBase?: string;
  /** Library: total live media; orphans view: total orphans. The grid starts
   *  with only the newest `items`, so when this exceeds what's shown the gap is
   *  surfaced below instead of passing the capped page off as everything. */
  total?: number;
  /** Library view: keyset cursor after `items` (null = nothing older). Drives
   *  « Charger plus », which appends older batches from /api/admin/media. */
  nextCursor?: string | null;
  /** « Charger plus » batch size (the API caps it at 100). */
  pageSize?: number;
  /** media:create → the upload / import-by-URL dropzone. */
  canCreate: boolean;
  /** media:update → clicking a card opens the alt/filename/CDN edit form. */
  canUpdate: boolean;
  /** media:delete → per-card delete + the selection / bulk-delete bar. */
  canDelete: boolean;
}) {
  // Controls the viewer's role can't use are hidden (their actions would 404
  // the page); this names what's missing so the library doesn't look broken.
  const missingVerbs = [
    !canCreate && "téléverser",
    !canUpdate && "modifier",
    !canDelete && "supprimer",
  ].filter((v): v is string => Boolean(v));
  const readOnlyNotice =
    missingVerbs.length === 0
      ? null
      : `${missingVerbs.length === 3 ? "Lecture seule" : "Accès limité"} — votre rôle ne permet pas de ${
          missingVerbs.length > 1
            ? `${missingVerbs.slice(0, -1).join(", ")} ou ${missingVerbs[missingVerbs.length - 1]}`
            : missingVerbs[0]
        } des images (permissions « Médiathèque »).`;
  // Resolve the client-side size ceiling from the configured value, guarding a
  // wiped/garbled setting so the gate never compares against NaN/0.
  const maxBytes =
    typeof maxUploadMb === "number" && Number.isFinite(maxUploadMb) && maxUploadMb > 0
      ? maxUploadMb * 1024 * 1024
      : MAX_UPLOAD_BYTES_FALLBACK;

  const router = useRouter();
  const isLibrary = !orphansMode;
  const [scope, setScope] = useState<Scope>("uploads");
  const [search, setSearch] = useState(initialSearch);
  const [searchPending, startSearchNav] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Media | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkFeedback, setBulkFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  // « Charger plus » (library view): older batches appended below the server
  // page. Only rows loaded for the CURRENT server search count — a new search
  // starts again from the page's own first batch.
  const [more, setMore] = useState<MorePages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  const activeMore =
    isLibrary && more && more.q === initialSearch && more.rows.length > 0 ? more : null;
  const moreCursor = activeMore ? activeMore.cursor : isLibrary ? nextCursor : null;
  const libraryItems = useMemo(() => {
    if (!activeMore) return items;
    // Dedupe: after a delete the fresh first batch can pull in a row already
    // loaded (and a click racing the re-fetch below can append one twice).
    const seen = new Set(items.map((m) => m.id));
    const out = [...items];
    for (const m of activeMore.rows) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }, [items, activeMore]);

  const loadMore = async () => {
    if (!moreCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchMediaPage(moreCursor, initialSearch, pageSize);
      setMore((prev) => ({
        q: initialSearch,
        rows: [...(prev && prev.q === initialSearch ? prev.rows : []), ...page.items],
        cursor: page.nextCursor,
      }));
    } catch {
      setMoreError("Chargement impossible — erreur réseau ou serveur, réessayez.");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  // A save / delete / upload revalidates the page → a fresh server batch. The
  // rows loaded by « Charger plus » would then be stale (an edited alt text, a
  // deleted image still shown), so re-fetch them to the same depth from the
  // new cursor; on failure fall back to the server batch alone.
  const moreRef = useRef(more);
  useEffect(() => {
    moreRef.current = more;
  }, [more]);
  useEffect(() => {
    const prev = moreRef.current;
    if (!prev || prev.q !== initialSearch || prev.rows.length === 0) return;
    let alive = true;
    void (async () => {
      try {
        const targetDepth = prev.rows.length;
        const rows: Media[] = [];
        let cursor = nextCursor;
        // Re-fetch the loaded depth in as FEW round-trips as possible: request up
        // to the service's 200-row cap per call instead of one `pageSize` batch
        // per call, so restoring N loaded pages after a mutation is usually a
        // single request (only >200 rows needs a second).
        while (cursor && rows.length < targetDepth) {
          const want = Math.min(targetDepth - rows.length, 200);
          const page = await fetchMediaPage(cursor, initialSearch, want);
          rows.push(...page.items);
          cursor = page.nextCursor;
          if (page.items.length === 0) break;
        }
        if (alive) setMore(rows.length > 0 ? { q: initialSearch, rows, cursor } : null);
      } catch {
        if (alive) setMore(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [items, nextCursor, initialSearch, pageSize]);

  // Library search is server-side (spans the whole library): debounce the input
  // into the URL and let the page re-query. Orphans view has no server search,
  // so it falls back to the in-memory filter below.
  useEffect(() => {
    if (!isLibrary) return;
    if (search === initialSearch) return; // no-op on mount / post-navigation
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      const qs = params.toString();
      startSearchNav(() =>
        router.replace(qs ? `/admin/media?${qs}` : "/admin/media", { scroll: false }),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [search, isLibrary, initialSearch, router]);

  const filtered = useMemo(() => {
    // Library results are already server-filtered (first batch + « Charger
    // plus » batches); only the orphans view filters its (capped) in-memory
    // list here.
    if (isLibrary) return libraryItems;
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (m) =>
        m.filename.toLowerCase().includes(q) ||
        (m.altText ?? "").toLowerCase().includes(q),
    );
  }, [items, libraryItems, search, isLibrary]);

  // Reset copy-feedback after a beat so the icon flips back.
  useEffect(() => {
    if (!copiedId) return;
    const t = setTimeout(() => setCopiedId(null), 1400);
    return () => clearTimeout(t);
  }, [copiedId]);

  const copyUrl = useCallback(
    async (url: string, id: string) => {
      try {
        // The page already resolves URLs through `normalizePublicUrl(.., cdnBase)`,
        // so when a CDN base is configured `url` is already absolute (`<base>/<key>`)
        // and copied verbatim. For a relative `/cdn/<key>` path (no CDN base, or a
        // base that didn't apply), prefer the configured CDN base over
        // window.location.origin so the copied URL matches what the storefront serves.
        let absolute = url;
        if (url.startsWith("/")) {
          if (cdnBase && url.startsWith("/cdn/")) {
            absolute = `${cdnBase.replace(/\/+$/, "")}/${url.slice("/cdn/".length)}`;
          } else {
            absolute = `${window.location.origin}${url}`;
          }
        }
        await navigator.clipboard.writeText(absolute);
        setCopiedId(id);
      } catch {
        /* silent — user can right-click the image instead */
      }
    },
    [cdnBase],
  );

  const filteredIds = useMemo(() => new Set(filtered.map((m) => m.id)), [filtered]);
  const visibleSelected = useMemo(
    () => Array.from(selectedIds).filter((id) => filteredIds.has(id)),
    [selectedIds, filteredIds],
  );
  const allVisibleSelected =
    filtered.length > 0 && visibleSelected.length === filtered.length;

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllVisible = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of filteredIds) next.delete(id);
      } else {
        for (const id of filteredIds) next.add(id);
      }
      return next;
    });

  // Bulk delete is irreversible (S3 bytes purged) → never fire it straight from
  // the bar: open the confirm dialog (count + in-use check + explicit second
  // confirmation when any selected image is still used).
  // « Charger plus » can put more than BULK_MEDIA_MAX cards on the grid (and
  // « Tout sélectionner » selects them all); the bulk actions refuse such a list,
  // so say so here rather than open a confirm whose usage check cannot run.
  const overBulkMax = visibleSelected.length - BULK_MEDIA_MAX;
  const openBulkDelete = () => {
    if (visibleSelected.length === 0) return;
    if (overBulkMax > 0) {
      setBulkFeedback({
        kind: "err",
        msg: `Sélection trop grande (${BULK_MEDIA_MAX} images maximum à la fois) — désélectionnez-en ${overBulkMax}.`,
      });
      return;
    }
    setBulkFeedback(null);
    setConfirmBulk(true);
  };
  const selectedMedia = useMemo(
    () => filtered.filter((m) => selectedIds.has(m.id)),
    [filtered, selectedIds],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-2xl">
          Images optimisées (WebP / AVIF selon vos réglages) servies via le
          proxy <code className="rounded bg-surface px-1 text-[11px]">/cdn</code>.
          Le pipeline est piloté depuis les{" "}
          <Link href="/admin/media/settings" className="text-primary underline">
            réglages
          </Link>
          .
        </AdminNote>
        <div className="flex items-center gap-2">
          <Link
            href={orphansMode ? "/admin/media" : "/admin/media?view=orphans"}
            className={`inline-flex h-11 items-center gap-2 rounded-full px-4 text-[14px] font-bold transition ${
              orphansMode
                ? "bg-primary text-primary-foreground hover:bg-[#b8042a]"
                : "border-[1.5px] border-input bg-card text-foreground hover:bg-surface"
            }`}
          >
            <ImageIcon className="h-4 w-4" />
            {orphansMode ? "Toutes les images" : "Trouver les orphelins"}
          </Link>
        </div>
      </div>

      {orphansMode && (
        <AdminCallout tone="info" icon={ImageIcon} title="Images orphelines">
          Aucune référence trouvée dans le catalogue, le CMS, le blog ou le centre d&apos;aide.
          Vous pouvez les supprimer en toute sécurité.
        </AdminCallout>
      )}

      {readOnlyNotice && (
        <AdminCallout tone="warning">{readOnlyNotice}</AdminCallout>
      )}

      {!orphansMode && canCreate && (
        <UploadDropzone scope={scope} onScopeChange={setScope} maxBytes={maxBytes} />
      )}

      {/* Search + counts */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full max-w-md items-center gap-2">
          <AdminSearch
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher par nom ou alt…"
            aria-label="Rechercher un média par nom ou texte alternatif"
            className="flex-1"
          />
          {searchPending && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Effacer"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Selection only feeds the bulk delete → hidden without media:delete. */}
          {canDelete && (
            <label className="inline-flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
                className="h-4 w-4 accent-[var(--primary)]"
              />
              Tout sélectionner
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            {filtered.length}{" "}
            {isLibrary && search.trim()
              ? filtered.length === 1
                ? "résultat"
                : "résultats"
              : filtered.length === 1
                ? "fichier"
                : "fichiers"}
            {!isLibrary && search && ` · sur ${items.length} chargés`}
          </p>
        </div>
      </div>

      {/* Browse-cap notice: the grid starts with the newest batch only. Search
          spans the WHOLE library server-side, so this only shows when idle (no
          query) — `total` is the unfiltered count. */}
      {isLibrary && !search.trim() && typeof total === "number" && total > libraryItems.length && (
        <AdminCallout tone="info">
          {libraryItems.length} médias les plus récents affichés sur {total}. « Charger
          plus » (en bas de la grille) affiche les suivants ; pour retrouver un média
          précis, recherchez-le par nom ou texte alt ci-dessus (la recherche couvre toute
          la médiathèque).
        </AdminCallout>
      )}
      {/* Orphans cap notice: listOrphans returns the newest 200 only, and the
          search above filters just those — say so instead of letting « 200
          fichiers » read as every orphan. */}
      {!isLibrary && typeof total === "number" && total > items.length && (
        <AdminCallout tone="info">
          {items.length} orphelins les plus récents affichés sur {total}. La recherche ne
          porte que sur ceux affichés : supprimez-les puis rechargez la page pour voir les
          suivants.
        </AdminCallout>
      )}

      {/* Bulk actions */}
      {canDelete && visibleSelected.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-full bg-[#0e1218] px-4 py-3 text-white">
          <p className="text-sm font-semibold">
            {visibleSelected.length} image{visibleSelected.length > 1 ? "s" : ""} sélectionnée
            {visibleSelected.length > 1 ? "s" : ""}
            {overBulkMax > 0 && (
              <span className="ml-2 text-xs font-normal text-white/60">
                (maximum {BULK_MEDIA_MAX} par suppression)
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openBulkDelete}
              disabled={confirmBulk}
              className="inline-flex h-9 items-center gap-1 rounded-full bg-primary px-4 text-[13px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
            >
              <Trash2 className="h-3 w-3" />
              Supprimer la sélection
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              disabled={confirmBulk}
              className="text-[13px] font-semibold text-white/70 transition hover:text-white disabled:opacity-60"
            >
              Désélectionner
            </button>
          </div>
        </div>
      )}
      {/* Outside the selection bar: a successful delete clears the selection
          (which hides the bar), and the result must stay visible. */}
      {bulkFeedback && (
        <p
          role="status"
          className={`rounded-[14px] border px-4 py-2 text-xs ${
            bulkFeedback.kind === "ok"
              ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
              : "border-destructive/30 bg-destructive/5 text-destructive"
          }`}
        >
          {bulkFeedback.msg}
        </p>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          <ImageIcon className="mx-auto mb-2 h-6 w-6" />
          {/* A server search with no match also yields no `items` — that's « aucun
              résultat », not an empty library. */}
          {items.length === 0 && !initialSearch
            ? canCreate
              ? "Médiathèque vide. Téléversez votre première image."
              : "Médiathèque vide."
            : "Aucun résultat pour cette recherche."}
        </div>
      ) : (
        // items-start so an expanded card (edit mode) doesn't stretch
        // its row-mates to match its taller form height.
        <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((m) => (
            <MediaCard
              key={m.id}
              media={m}
              expanded={canUpdate && editing === m.id}
              copied={copiedId === m.id}
              selected={selectedIds.has(m.id)}
              canUpdate={canUpdate}
              canDelete={canDelete}
              onSelectToggle={() => toggleOne(m.id)}
              onToggle={() => setEditing(editing === m.id ? null : m.id)}
              onCopyUrl={() => copyUrl(m.url, m.id)}
              onAskDelete={() => setConfirmDelete(m)}
            />
          ))}
        </div>
      )}

      {/* Older batches from /api/admin/media (keyset cursor, current search). The
          selection above spans every loaded batch, so a bulk delete can mix them
          (BULK_MEDIA_MAX images per delete — see openBulkDelete). */}
      {moreCursor && filtered.length > 0 && (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-5 text-[14px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            {loadingMore ? "Chargement…" : "Charger plus"}
          </button>
          {moreError && (
            <p role="alert" className="text-xs text-destructive">
              {moreError}
            </p>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          media={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirmed={() => setConfirmDelete(null)}
        />
      )}

      {confirmBulk && selectedMedia.length > 0 && (
        <BulkDeleteDialog
          items={selectedMedia}
          onCancel={() => setConfirmBulk(false)}
          onDeleted={(res) => {
            setBulkFeedback({
              kind: res.failCount ? "err" : "ok",
              msg: res.message ?? "Images supprimées.",
            });
            setSelectedIds(new Set());
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────── Upload dropzone ── */

function UploadDropzone({
  scope,
  onScopeChange,
  maxBytes,
}: {
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  /** Live upload ceiling (bytes) from media_settings — gate + helper text. */
  maxBytes: number;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [altText, setAltText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const [results, setResults] = useState<Array<{ name: string; ok: boolean; message: string }>>([]);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);

  // Build object-URL previews lazily; revoke on unmount / change.
  useEffect(() => {
    const map: Record<string, string> = {};
    for (const f of files) map[f.name + f.size] = URL.createObjectURL(f);
    setPreviews(map);
    return () => {
      for (const url of Object.values(map)) URL.revokeObjectURL(url);
    };
  }, [files]);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const valid: File[] = [];
    const errors: Array<{ name: string; ok: false; message: string }> = [];
    for (const f of Array.from(incoming)) {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      if (!ACCEPTED_EXT.has(ext)) {
        errors.push({ name: f.name, ok: false, message: "Format non supporté" });
        continue;
      }
      if (f.size > maxBytes) {
        errors.push({
          name: f.name,
          ok: false,
          message: `Trop volumineux (${fmtBytes(f.size)} > ${fmtBytes(maxBytes)})`,
        });
        continue;
      }
      valid.push(f);
    }
    if (errors.length) setResults((r) => [...errors, ...r]);
    setFiles((prev) => [...prev, ...valid]);
  }, [maxBytes]);

  const removeAt = (i: number) =>
    setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const submitUrl = useCallback(() => {
    const url = importUrl.trim();
    if (!url || importing) return;
    setImporting(true);
    startTransition(async () => {
      const fd = new FormData();
      fd.append("scope", scope);
      fd.append("url", url);
      if (altText.trim()) fd.append("altText", altText.trim());
      try {
        const res = await importMediaFromUrlAction(null, fd);
        setResults((r) => [
          { name: url, ok: res?.ok ?? false, message: res?.message ?? "Erreur inconnue" },
          ...r,
        ]);
        if (res?.ok) setImportUrl("");
      } catch {
        setResults((r) => [
          { name: url, ok: false, message: "Import impossible — erreur réseau ou serveur, réessayez." },
          ...r,
        ]);
      } finally {
        setImporting(false);
      }
    });
  }, [importUrl, importing, scope, altText]);

  const submit = useCallback(() => {
    if (files.length === 0) return;
    setResults([]);
    setUploadingIdx(0);
    startTransition(async () => {
      const out: Array<{ name: string; ok: boolean; message: string }> = [];
      for (let i = 0; i < files.length; i++) {
        setUploadingIdx(i);
        const fd = new FormData();
        fd.append("scope", scope);
        fd.append("file", files[i]);
        if (altText.trim()) fd.append("altText", altText.trim());
        try {
          const res = await uploadMediaAction(null, fd);
          out.push({
            name: files[i].name,
            ok: res?.ok ?? false,
            message: res?.message ?? "Erreur inconnue",
          });
        } catch (err) {
          // A thrown call (body limit / network) is recorded per file and the
          // batch continues, instead of crashing the page.
          out.push({ name: files[i].name, ok: false, message: uploadThrowMessage(err, files[i]) });
        }
      }
      setResults(out);
      setUploadingIdx(null);
      setFiles([]);
      setAltText("");
    });
  }, [files, scope, altText]);

  return (
    <section className="space-y-3 rounded-[28px] border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[18px] font-black text-foreground">Téléverser</h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Dossier :</span>
          <SelectField
            size="sm"
            value={scope}
            onChange={(v) => onScopeChange(v as Scope)}
            options={SCOPES}
            className="w-40"
          />
        </div>
      </div>

      {/* Import from URL — server downloads + processes (webp/avif) like an upload */}
      <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-dashed border-border bg-[#fbf9f8] p-3">
        <input
          type="url"
          inputMode="url"
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitUrl();
            }
          }}
          placeholder="https://exemple.com/image.jpg — importer depuis une URL"
          aria-label="Importer une image depuis une URL"
          className="h-10 min-w-[200px] flex-1 rounded-[14px] border-[1.5px] border-input bg-white px-4 text-[15px] focus:border-foreground focus:outline-none"
        />
        <button
          type="button"
          onClick={submitUrl}
          disabled={importing || !importUrl.trim()}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-50"
        >
          {importing ? "Import…" : "Importer l'URL"}
        </button>
      </div>

      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-[18px] border-2 border-dashed p-8 text-center transition ${
          dragOver
            ? "border-primary bg-primary/5"
            : "border-border bg-[#fbf9f8] hover:border-primary/40 hover:bg-surface"
        }`}
      >
        <UploadCloud
          className={`h-10 w-10 transition ${dragOver ? "text-primary" : "text-muted-foreground"}`}
          strokeWidth={1.6}
        />
        <p className="text-sm font-medium text-foreground">
          {dragOver ? "Relâchez pour ajouter" : "Glissez vos images ici ou cliquez pour parcourir"}
        </p>
        <p className="text-[11px] text-muted-foreground">
          JPG, PNG, WebP, AVIF, GIF · jusqu&apos;à {fmtBytes(maxBytes)} par fichier
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            // Allow re-selecting the same file after removal.
            e.target.value = "";
          }}
          className="hidden"
        />
      </div>

      {/* Queue */}
      {files.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-bold text-foreground">
              File d&apos;attente ({files.length})
            </p>
            <button
              type="button"
              onClick={() => setFiles([])}
              className="text-[11px] text-muted-foreground hover:text-destructive"
              disabled={uploadingIdx !== null}
            >
              Tout retirer
            </button>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {files.map((f, i) => (
              <li
                key={f.name + f.size + i}
                className="flex items-center gap-3 rounded-[14px] border border-border bg-[#fbf9f8] p-2"
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[12px] bg-[var(--background)]">
                  <img
                    src={previews[f.name + f.size]}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">{f.name}</p>
                  <p className="text-[10px] text-muted-foreground">{fmtBytes(f.size)}</p>
                </div>
                {uploadingIdx === i ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    disabled={uploadingIdx !== null}
                    aria-label="Retirer"
                    className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition hover:bg-[#fdecef] hover:text-[#d40530] disabled:opacity-30"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-end justify-between gap-3 pt-1">
            <label className="block min-w-[260px] flex-1">
              <span className="block text-[13px] font-bold text-foreground">
                Texte alternatif (appliqué à tous)
              </span>
              <input
                value={altText}
                onChange={(e) => setAltText(e.target.value)}
                placeholder="Montre Festina acier bracelet cuir…"
                className="mt-1 h-10 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={submit}
              disabled={uploadingIdx !== null || files.length === 0}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
            >
              {uploadingIdx !== null ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Envoi… ({uploadingIdx + 1}/{files.length})
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Téléverser {files.length}
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Results summary */}
      {results.length > 0 && (
        <ul className="space-y-1 border-t border-border pt-3">
          {results.map((r, i) => (
            <li
              key={i}
              className={`flex items-center gap-2 text-[11px] ${
                r.ok ? "text-[#15803d]" : "text-destructive"
              }`}
            >
              {r.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
              <span className="truncate font-medium">{r.name}</span>
              <span className="text-muted-foreground">— {r.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────── MediaCard ── */

function MediaCard({
  media,
  expanded,
  copied,
  selected,
  canUpdate,
  canDelete,
  onSelectToggle,
  onToggle,
  onCopyUrl,
  onAskDelete,
}: {
  media: Media;
  expanded: boolean;
  copied: boolean;
  selected: boolean;
  /** media:update — the card opens the edit form on click. */
  canUpdate: boolean;
  /** media:delete — selection checkbox + delete button. */
  canDelete: boolean;
  onSelectToggle: () => void;
  onToggle: () => void;
  onCopyUrl: () => void;
  onAskDelete: () => void;
}) {
  const [editState, editAction, editPending] = useActionState<ActionState | null, FormData>(
    updateMediaAction,
    null,
  );

  // Auto-close after a successful save (the action revalidates the
  // /admin/media path → fresh data, no need to keep the form open).
  useEffect(() => {
    if (editState?.ok) onToggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editState]);

  // Edit mode REPLACES the card content rather than appending below it.
  // The card box keeps the same width; its height adjusts to the form,
  // but neighbour cards in the row aren't pushed around because we use
  // `items-start` on the grid (set in the parent).
  if (expanded) {
    return (
      <div className="group relative overflow-hidden rounded-[18px] border-2 border-primary/40 bg-card shadow-soft transition">
        <form action={editAction} className="space-y-3 p-3 text-xs">
          <input type="hidden" name="mediaId" value={media.id} />
          <div className="flex items-center justify-between gap-2 pb-1">
            <p className="text-[12px] font-bold text-foreground">
              Modifier · partagé entre toutes les variantes
            </p>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Fermer"
              className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition hover:bg-secondary"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <Field
            name="altText"
            label="Texte alternatif"
            multiline
            defaultValue={media.altText ?? ""}
          />
          <Field
            name="filename"
            label="Nom du fichier"
            defaultValue={media.filename}
          />
          <Field
            name="urlOverride"
            label="URL externe (CDN — remplace l'URL générée)"
            defaultValue={media.urlOverride ?? ""}
            placeholder="https://cdn.tokyostore.tn/…"
            error={editState && !editState.ok ? editState.fieldErrors?.urlOverride : undefined}
          />
          <div className="flex items-center gap-1.5 pt-1">
            <button
              type="submit"
              disabled={editPending}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-50"
            >
              {editPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Enregistrer
            </button>
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex h-8 items-center rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground transition hover:bg-surface"
            >
              Annuler
            </button>
          </div>
          {editState && !editState.ok && (
            <p className="rounded-[10px] bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {editState.message}
            </p>
          )}
        </form>
      </div>
    );
  }

  return (
    <div
      className={`group relative overflow-hidden rounded-[18px] border bg-card transition ${
        selected ? "border-primary shadow-soft" : "border-border hover:border-primary/40"
      }`}
    >
      {/* Selection checkbox — fixed top-left, doesn't trigger card edit. Only
          feeds the bulk delete, so it needs media:delete. */}
      {canDelete && (
        <label
          onClick={(e) => e.stopPropagation()}
          className="absolute left-2 top-2 z-10 grid h-6 w-6 cursor-pointer place-items-center rounded-full bg-white/90 shadow-sm"
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelectToggle}
            aria-label={`Sélectionner ${media.filename}`}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
        </label>
      )}
      {/* Without media:update the card is not an edit trigger (the copy-URL
          overlay stays available). */}
      <button
        type="button"
        onClick={canUpdate ? onToggle : undefined}
        className={`relative block aspect-square w-full bg-[var(--background)] ${canUpdate ? "" : "cursor-default"}`}
        aria-label={canUpdate ? `Éditer ${media.filename}` : media.filename}
      >
        <Image
          src={media.thumbUrl}
          alt={media.altText ?? media.filename}
          fill
          sizes="(max-width: 640px) 50vw, 200px"
          className="object-cover"
        />
        {/* Hover overlay actions */}
        <span className="absolute inset-x-0 top-0 flex items-start justify-end gap-1 bg-gradient-to-b from-black/40 to-transparent p-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onCopyUrl();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                onCopyUrl();
              }
            }}
            title="Copier l'URL"
            aria-label="Copier l'URL"
            className="grid h-7 w-7 cursor-pointer place-items-center rounded-full bg-white/90 text-foreground shadow-sm hover:bg-white"
          >
            {copied ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-[#15803d]" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </span>
          {canDelete && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onAskDelete();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  onAskDelete();
                }
              }}
              title="Supprimer"
              aria-label="Supprimer"
              className="grid h-7 w-7 cursor-pointer place-items-center rounded-full bg-white/90 text-destructive shadow-sm hover:bg-white"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </span>
          )}
        </span>
      </button>
      {/* Metadata block — centered. Each variant chip is a real link to
          its asset so admins can preview / download each format. */}
      <div className="space-y-1.5 px-2.5 py-2.5 text-center">
        <p
          className="truncate text-xs font-medium text-foreground"
          title={media.filename}
        >
          {media.filename}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {media.width && media.height ? `${media.width}×${media.height} · ` : ""}
          {fmtBytes(media.sizeBytes)}
        </p>
        <p className="flex flex-wrap items-center justify-center gap-1 pt-0.5">
          {media.variants.avif && (
            <VariantChip tone="green" href={media.variants.avif}>
              AVIF
            </VariantChip>
          )}
          {media.variants.webp && (
            <VariantChip tone="green" href={media.variants.webp}>
              WebP
            </VariantChip>
          )}
          {media.variants.original && (
            <VariantChip tone="amber" href={media.variants.original}>
              Orig.
            </VariantChip>
          )}
          {media.urlOverride && (
            <VariantChip tone="blue" href={media.urlOverride}>
              CDN ext.
            </VariantChip>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Variant badge — opens the variant URL in a new tab. Click bubbling is
 * stopped so the parent card's edit-toggle doesn't fire when the admin
 * just wants to peek at the file.
 */
function VariantChip({
  href,
  tone,
  children,
}: {
  href: string;
  tone: "green" | "amber" | "blue";
  children: React.ReactNode;
}) {
  const cls =
    tone === "green"
      ? "bg-[#eaf7ee] text-[#15803d] hover:bg-[#d8efe0]"
      : tone === "amber"
        ? "bg-[#fff4e0] text-[#b45309] hover:bg-[#fce7c4]"
        : "bg-[#eef2ff] text-[#3730a3] hover:bg-[#e0e7ff]";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`rounded-full px-2 py-0.5 text-[10px] font-bold transition ${cls}`}
    >
      {children}
    </a>
  );
}

function Field({
  name,
  label,
  defaultValue,
  placeholder,
  multiline,
  error,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  /** Server field error (e.g. a rejected url_override host) shown under the input. */
  error?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-bold text-foreground">
        {label}
      </span>
      {multiline ? (
        <textarea
          name={name}
          rows={2}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="mt-1 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] p-2 text-xs focus:border-foreground focus:bg-white focus:outline-none"
        />
      ) : (
        <input
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          className={`mt-1 h-10 w-full rounded-[12px] border-[1.5px] bg-[#fbf9f8] px-3 text-xs focus:bg-white focus:outline-none ${
            error ? "border-destructive" : "border-input focus:border-foreground"
          }`}
        />
      )}
      {error && <span className="mt-1 block text-[11px] text-destructive">{error}</span>}
    </label>
  );
}

/* ─────────────────────────────────────────── Confirm modal ── */

function ConfirmDeleteModal({
  media,
  onCancel,
  onConfirmed,
}: {
  media: Media;
  onCancel: () => void;
  onConfirmed: () => void;
}) {
  // In-use count — warns before deleting an asset the storefront still renders.
  const [usage, setUsage] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    mediaUsageCountAction(media.id)
      .then((n) => {
        if (alive) setUsage(n);
      })
      .catch(() => {
        if (alive) setUsage(null);
      });
    return () => {
      alive = false;
    };
  }, [media.id]);

  // Thumbnail + filename preview, plus the in-use warning — fed to the shared
  // modal's `preview` slot (mirrors BulkDeleteDialog, which renders its in-use
  // lookup the same way).
  const preview = (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-[14px] border border-border bg-[#fbf9f8] p-2">
        <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[12px] bg-[var(--background)]">
          <img src={media.thumbUrl} alt="" className="h-full w-full object-cover" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{media.filename}</p>
          <p className="text-[10px] text-muted-foreground">{fmtBytes(media.sizeBytes)}</p>
        </div>
      </div>
      {usage !== null && usage > 0 && (
        <p className="rounded-[12px] border border-[#f3e3bd] bg-[#fff4e0] px-3 py-2 text-xs font-medium text-[#b45309]">
          ⚠ Utilisée par {usage} élément{usage > 1 ? "s" : ""} (produit, catégorie,
          marque, bannière…). La suppression retirera l&apos;image de ces emplacements.
        </p>
      )}
    </div>
  );

  return (
    <SharedConfirmDeleteModal
      title="Supprimer cette image ?"
      description="Cette action est irréversible. Les pages qui référencent cette image afficheront un placeholder."
      preview={preview}
      onCancel={onCancel}
      onConfirm={async () => {
        // try/catch so a thrown action (413 / network) surfaces inline instead
        // of crashing to the admin error boundary (mirrors bulk).
        try {
          const res = await deleteMediaAction(media.id);
          if (res && !res.ok) return res.message;
          onConfirmed();
          return null;
        } catch {
          return "Échec de la suppression. Réessayez.";
        }
      }}
    />
  );
}

/* ─────────────────────────────────────────── Bulk delete confirm ── */

/** How many in-use filenames the bulk confirm lists before collapsing to "+N". */
const IN_USE_LIST_MAX = 8;

/**
 * Bulk-delete confirmation. Shows the selection count, fetches which selected
 * images are still referenced (same sources as the single-delete usage count)
 * and, when any are, lists them and requires an explicit second confirmation
 * (checkbox) before the purge. The server re-checks independently: without
 * `confirmInUse` it refuses an in-use selection and returns the ids, which this
 * dialog then displays — so a stale/failed usage lookup never deletes blind.
 */
function BulkDeleteDialog({
  items,
  onCancel,
  onDeleted,
}: {
  items: Media[];
  onCancel: () => void;
  onDeleted: (res: { message?: string; failCount?: number }) => void;
}) {
  const ids = useMemo(() => items.map((m) => m.id), [items]);
  // null = still checking (or the lookup failed — see `checkFailed`).
  const [inUseIds, setInUseIds] = useState<string[] | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    let alive = true;
    listMediaInUseAction(ids)
      .then((used) => {
        if (alive) setInUseIds(used);
      })
      .catch(() => {
        if (alive) setCheckFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [ids]);

  const n = items.length;
  const inUse = useMemo(
    () => (inUseIds ? items.filter((m) => inUseIds.includes(m.id)) : []),
    [items, inUseIds],
  );

  const preview = (
    <div className="space-y-2">
      {inUseIds === null && !checkFailed && (
        <p className="flex items-center gap-2 rounded-[12px] border border-border bg-[#fbf9f8] px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Vérification des usages…
        </p>
      )}
      {checkFailed && inUseIds === null && (
        <p className="rounded-[12px] border border-border bg-[#fbf9f8] px-3 py-2 text-xs text-muted-foreground">
          Impossible de vérifier les usages. La suppression sera refusée si une image est
          encore utilisée.
        </p>
      )}
      {inUseIds !== null && inUse.length === 0 && (
        <p className="rounded-[12px] border border-border bg-[#fbf9f8] px-3 py-2 text-xs text-muted-foreground">
          Aucune de ces images n&apos;est utilisée (catalogue, CMS, blog, aide, réglages).
        </p>
      )}
      {inUse.length > 0 && (
        <div className="space-y-2 rounded-[12px] border border-[#f3e3bd] bg-[#fff4e0] px-3 py-2 text-xs text-[#b45309]">
          <p className="font-medium">
            ⚠ {inUse.length} image{inUse.length > 1 ? "s" : ""} sur {n}{" "}
            {inUse.length > 1 ? "sont encore utilisées" : "est encore utilisée"} (produit,
            catégorie, marque, bannière…). La suppression les retirera de ces emplacements.
          </p>
          <ul className="space-y-0.5">
            {inUse.slice(0, IN_USE_LIST_MAX).map((m) => (
              <li key={m.id} className="truncate" title={m.filename}>
                • {m.filename}
              </li>
            ))}
            {inUse.length > IN_USE_LIST_MAX && (
              <li>+ {inUse.length - IN_USE_LIST_MAX} autre(s)</li>
            )}
          </ul>
          <label className="flex items-start gap-2 pt-1 font-medium text-foreground">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
            />
            Je confirme supprimer aussi {inUse.length > 1 ? "les images utilisées" : "l'image utilisée"}.
          </label>
        </div>
      )}
    </div>
  );

  return (
    <SharedConfirmDeleteModal
      title={`Supprimer ${n} image${n > 1 ? "s" : ""} ?`}
      description="Cette action est irréversible : les fichiers sont purgés du stockage. Les pages qui référencent ces images afficheront un placeholder."
      preview={preview}
      confirmLabel={n > 1 ? `Supprimer les ${n} images` : "Supprimer l'image"}
      onCancel={onCancel}
      onConfirm={async () => {
        if (inUse.length > 0 && !ack) {
          return "Cochez la case pour confirmer la suppression des images utilisées.";
        }
        try {
          const res = await bulkDeleteMediaAction({
            mediaIds: ids,
            confirmInUse: inUse.length > 0 && ack,
          });
          if (!res.ok) {
            // Server-side in-use re-check (lookup failed or a new reference
            // appeared): surface the list and require the explicit ack.
            if (res.inUseIds?.length) {
              setInUseIds(res.inUseIds);
              setCheckFailed(false);
              setAck(false);
            }
            return res.message;
          }
          onDeleted(res);
          return null;
        } catch {
          return "Suppression impossible — erreur réseau ou serveur, réessayez.";
        }
      }}
    />
  );
}
