"use client";

import { useActionState, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Image as ImageIcon,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

import { MediaPicker } from "@/components/admin/media-picker";
import { SelectField } from "@/components/ui/select-field";
import { ToggleField } from "@/components/admin/_components/setting-fields";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import { useNoResetSubmit } from "@/components/admin/_components/form-tabs";
import { LINK_KINDS, type LinkKind } from "@/lib/links/link-target";
import { PROMO_ICON_NAMES } from "@/lib/links/promo-icons";
import { saveHeaderNavAction } from "@/lib/actions/nav-builder";
import {
  BRAND_DISPLAYS,
  DEFAULT_NAV_IMAGE_ASPECT,
  DEFAULT_NAV_BLOCK_SIZE,
  DEFAULT_NAV_SLOT,
  MAX_NAV_COLUMNS,
  NAV_BLOCK_TYPES,
  NAV_BLOCK_SIZES,
  NAV_BLOCK_SIZE_META,
  NAV_IMAGE_ASPECTS,
  NAV_IMAGE_ASPECT_META,
  NAV_PRODUCTS_MAX,
  NAV_SLOTS,
  NAV_SLOT_META,
  PRODUCT_SOURCES,
  isListBlockType,
  navUid,
  type NavBlockType,
  type NavImageAspect,
  type NavSlot,
} from "@/lib/cms/nav-composer-model";
import { type ActionState } from "@/lib/actions/types";
import { type NavTargets } from "../_components/nav-menu-editor";

// ─── Editable shapes (client state) ──────────────────────────────────────────
type ELink = { label: string; kind: LinkKind; value: string; icon: string | null; newTab: boolean };
type EBlock = {
  _id: string;
  type: NavBlockType;
  title: string;
  // links
  links: ELink[];
  // categories/brands/products
  display: string;
  limit: string;
  maxPerColumn: string;
  source: string;
  count: string;
  pins: string[];
  // taxonomy (auto sub-categories) + products category source
  categorySlug: string;
  categoryRef: string;
  // image
  mediaId: string | null;
  mediaMobileId: string | null;
  eyebrow: string;
  aspect: string;
  // Visual SIZE scale (products / brand logos / collection cards / image width).
  size: string;
  linkKind: LinkKind;
  linkValue: string;
  showOnMobile: boolean;
};
type EColumn = { _id: string; blocks: EBlock[] };
type ERoot = {
  _id: string;
  label: string;
  linkKind: LinkKind;
  linkValue: string;
  icon: string | null;
  isVisible: boolean;
  newTab: boolean;
  /** Header placement (universe / shortcut pill / mobile service link). */
  slot: NavSlot;
  /** A universe's one-line tagline (mega slot). */
  blurb: string;
  /** A shortcut pill's crimson accent flag (shortcut slot). */
  accent: boolean;
  hasDropdown: boolean;
  mobileVisible: boolean;
  columns: EColumn[];
};

export type NavBuilderProps = {
  initialRoots: ERoot[];
  targets: NavTargets;
  productOptions: { id: string; name: string }[];
  /** Pre-resolved thumbnail URLs for média ids already in the config. */
  mediaThumbs: Record<string, string>;
};

const BLOCK_LABEL: Record<NavBlockType, string> = {
  taxonomy: "Sous-catégories (auto)",
  links: "Liens",
  categories: "Catégories (auto)",
  brands: "Marques (auto)",
  products: "Produits (aperçu)",
  image: "Image / bannière",
};
const BRAND_DISPLAY_LABEL: Record<string, string> = { titles: "Titres", logos: "Logos", both: "Logos + titres" };
const SOURCE_LABEL: Record<string, string> = {
  category: "Produits de l'univers",
  new_arrivals: "Nouveautés",
  best_sellers: "Meilleures ventes",
  on_promotion: "En promotion",
  pins: "Sélection manuelle",
};
const SLOT_LABEL: Record<NavSlot, string> = {
  mega: NAV_SLOT_META.mega.label,
  shortcut: NAV_SLOT_META.shortcut.label,
  service: NAV_SLOT_META.service.label,
};
const SLOT_BADGE: Record<NavSlot, string> = { mega: "Univers", shortcut: "Raccourci", service: "Service" };

function blankBlock(type: NavBlockType): EBlock {
  return {
    _id: navUid(),
    type,
    title: "",
    links: type === "links" ? [{ label: "", kind: "url", value: "", icon: null, newTab: false }] : [],
    display: type === "brands" ? "titles" : "",
    limit: "",
    maxPerColumn: "",
    source: type === "products" ? "new_arrivals" : "",
    count: type === "products" ? "4" : "",
    pins: [],
    categorySlug: "",
    categoryRef: "",
    mediaId: null,
    mediaMobileId: null,
    eyebrow: "",
    aspect: DEFAULT_NAV_IMAGE_ASPECT,
    size: DEFAULT_NAV_BLOCK_SIZE,
    linkKind: "url",
    linkValue: "",
    showOnMobile: type !== "image",
  };
}

function blankColumn(type?: NavBlockType): EColumn {
  return { _id: navUid(), blocks: type ? [blankBlock(type)] : [] };
}

/** Serialize the editable state → the stored `nav` JSON for the action. */
function serialize(roots: ERoot[]) {
  return roots.map((r) => ({
    label: r.label,
    linkKind: r.linkKind,
    linkValue: r.linkValue,
    icon: r.icon,
    isVisible: r.isVisible,
    newTab: r.newTab,
    slot: r.slot,
    blurb: r.slot === "mega" ? r.blurb : "",
    accent: r.slot === "shortcut" ? r.accent : false,
    dropdown: r.hasDropdown
      ? {
          mobileVisible: r.mobileVisible,
          columns: r.columns
            .map((col) => ({ blocks: col.blocks.map(blockToConfig).filter(Boolean) }))
            .filter((col) => col.blocks.length > 0),
        }
      : null,
  }));
}

function blockToConfig(b: EBlock): Record<string, unknown> | null {
  const title = b.title.trim() || undefined;
  const limit = b.limit.trim() ? Number(b.limit) : undefined;
  const maxPerColumn = b.maxPerColumn.trim() ? Number(b.maxPerColumn) : undefined;
  switch (b.type) {
    case "taxonomy":
      return { type: "taxonomy", title, categorySlug: b.categorySlug.trim() || undefined, maxPerColumn };
    case "links": {
      const links = b.links
        .filter((l) => l.label.trim() && l.value.trim())
        .map((l) => ({
          label: l.label.trim(),
          icon: l.icon || undefined,
          ...(l.kind === "url" ? { href: l.value.trim() } : { kind: l.kind, ref: l.value.trim() }),
          newTab: l.newTab || undefined,
        }));
      return links.length ? { type: "links", title, links, maxPerColumn } : null;
    }
    case "categories":
      return { type: "categories", title, limit, maxPerColumn };
    case "brands":
      return { type: "brands", title, display: b.display || "titles", limit, maxPerColumn, size: b.size || DEFAULT_NAV_BLOCK_SIZE };
    case "products":
      return {
        type: "products",
        title,
        source: b.source || "new_arrivals",
        count: Number(b.count) || 4,
        pins: b.source === "pins" ? b.pins : undefined,
        categoryRef: b.source === "category" ? b.categoryRef.trim() || undefined : undefined,
        size: b.size || DEFAULT_NAV_BLOCK_SIZE,
      };
    case "image":
      return b.mediaId
        ? {
            type: "image",
            mediaId: b.mediaId,
            mediaMobileId: b.mediaMobileId || undefined,
            eyebrow: b.eyebrow.trim() || undefined,
            title,
            aspect: b.aspect || DEFAULT_NAV_IMAGE_ASPECT,
            size: b.size || DEFAULT_NAV_BLOCK_SIZE,
            ...(b.linkKind === "url"
              ? { href: b.linkValue.trim() }
              : { kind: b.linkKind, ref: b.linkValue.trim() }),
            showOnMobile: b.showOnMobile,
          }
        : null;
    default:
      return null;
  }
}

const LINK_KIND_OPTS = LINK_KINDS.map((k) => ({
  value: k,
  label: { url: "URL / chemin", system: "Page vitrine", category: "Catégorie", brand: "Marque", page: "Page CMS" }[k] ?? k,
}));

const inputCls =
  "h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none";

export function NavBuilder({ initialRoots, targets, productOptions, mediaThumbs }: NavBuilderProps) {
  const [roots, setRoots] = useState<ERoot[]>(initialRoots);
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    async (prev, fd) => saveHeaderNavAction(prev, fd),
    null,
  );
  const onSubmit = useNoResetSubmit(formAction, state);

  const patchRoot = (i: number, patch: Partial<ERoot>) =>
    setRoots((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const moveRoot = (i: number, dir: -1 | 1) =>
    setRoots((rs) => {
      const j = i + dir;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const removeRoot = (i: number) => {
    // Confirm before removing a whole top-level nav entry — an accidental click
    // would otherwise drop it from the menu the moment the operator next saves.
    const label = roots[i]?.label?.trim() || "cet onglet";
    if (
      !window.confirm(
        `Supprimer « ${label} » du menu ?\n\nN'oubliez pas d'enregistrer pour appliquer la suppression.`,
      )
    )
      return;
    setRoots((rs) => rs.filter((_, j) => j !== i));
  };
  const addRoot = () =>
    setRoots((rs) => [
      ...rs,
      {
        _id: navUid(),
        label: "Nouvel onglet",
        linkKind: "url",
        linkValue: "/",
        icon: null,
        isVisible: true,
        newTab: false,
        slot: DEFAULT_NAV_SLOT,
        blurb: "",
        accent: false,
        hasDropdown: false,
        mobileVisible: true,
        columns: [],
      },
    ]);

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-6">
      <input type="hidden" name="nav" value={JSON.stringify(serialize(roots))} />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Le menu du header, entièrement composable. Chaque onglet a son lien, son icône, sa
          visibilité (desktop + mobile) et un menu déroulant construit en <strong>colonnes</strong> :
          vous choisissez le nombre de colonnes et ce que chacune affiche (catégories, marques,
          collections, aperçu produits, image(s), liens libres), avec un maximum d’articles par
          colonne avant débordement.
        </AdminNote>
        <button
          type="button"
          onClick={addRoot}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
        >
          <Plus className="h-4 w-4" /> Nouvel onglet
        </button>
      </div>

      <div className="space-y-4">
        {roots.map((root, i) => (
          <RootCard
            key={root._id}
            root={root}
            index={i}
            total={roots.length}
            targets={targets}
            productOptions={productOptions}
            mediaThumbs={mediaThumbs}
            onPatch={(patch) => patchRoot(i, patch)}
            onMove={(dir) => moveRoot(i, dir)}
            onRemove={() => removeRoot(i)}
          />
        ))}
        {roots.length === 0 && (
          <div className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-10 text-center text-[14px] text-muted-foreground">
            Aucun onglet. Ajoutez-en un — ou enregistrez vide pour revenir au menu par défaut.
          </div>
        )}
      </div>

      <div className="sticky bottom-4 z-10 flex items-center justify-end gap-3 rounded-full bg-[#0e1218] px-4 py-3 text-white shadow-lift">
        {state && (
          <span className={`text-[13px] font-semibold ${state.ok ? "text-[#4ade80]" : "text-[#fca5a5]"}`}>
            {state.message}
          </span>
        )}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-6 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {pending ? "Enregistrement…" : "Enregistrer le menu"}
        </button>
      </div>
    </form>
  );
}

function RootCard({
  root,
  index,
  total,
  targets,
  productOptions,
  mediaThumbs,
  onPatch,
  onMove,
  onRemove,
}: {
  root: ERoot;
  index: number;
  total: number;
  targets: NavTargets;
  productOptions: { id: string; name: string }[];
  mediaThumbs: Record<string, string>;
  onPatch: (patch: Partial<ERoot>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  const patchColumn = (ci: number, patch: Partial<EColumn>) =>
    onPatch({ columns: root.columns.map((c, j) => (j === ci ? { ...c, ...patch } : c)) });
  const addColumn = () => {
    if (root.columns.length >= MAX_NAV_COLUMNS) return;
    onPatch({ columns: [...root.columns, blankColumn()] });
  };
  const removeColumn = (ci: number) => {
    if (!window.confirm("Supprimer cette colonne du menu déroulant ?")) return;
    onPatch({ columns: root.columns.filter((_, j) => j !== ci) });
  };
  const moveColumn = (ci: number, dir: -1 | 1) => {
    const j = ci + dir;
    if (j < 0 || j >= root.columns.length) return;
    const next = [...root.columns];
    [next[ci], next[j]] = [next[j], next[ci]];
    onPatch({ columns: next });
  };

  const patchBlock = (ci: number, bi: number, patch: Partial<EBlock>) =>
    patchColumn(ci, { blocks: root.columns[ci].blocks.map((b, j) => (j === bi ? { ...b, ...patch } : b)) });
  const moveBlock = (ci: number, bi: number, dir: -1 | 1) => {
    const j = bi + dir;
    const blocks = root.columns[ci].blocks;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[bi], next[j]] = [next[j], next[bi]];
    patchColumn(ci, { blocks: next });
  };
  const removeBlock = (ci: number, bi: number) => {
    if (!window.confirm("Supprimer ce bloc du menu ?")) return;
    patchColumn(ci, { blocks: root.columns[ci].blocks.filter((_, j) => j !== bi) });
  };
  const addBlock = (ci: number, type: NavBlockType) =>
    patchColumn(ci, { blocks: [...root.columns[ci].blocks, blankBlock(type)] });
  const moveBlockAcross = (ci: number, bi: number, dir: -1 | 1) => {
    const tj = ci + dir;
    if (tj < 0 || tj >= root.columns.length) return;
    const cols = root.columns.map((c) => ({ ...c, blocks: [...c.blocks] }));
    const [blk] = cols[ci].blocks.splice(bi, 1);
    cols[tj].blocks.push(blk);
    onPatch({ columns: cols });
  };

  return (
    <div className="overflow-hidden rounded-[28px] border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-[#fbf9f8] px-4 py-3">
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/50" />
        <input
          value={root.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder="Libellé de l'onglet"
          className="h-9 flex-1 rounded-[10px] border border-transparent bg-transparent px-2 text-[14px] font-bold text-foreground hover:border-border focus:border-border focus:bg-card focus:outline-none"
        />
        <span className="shrink-0 rounded-full bg-[#fdecef] px-2 py-0.5 text-[10px] font-bold uppercase text-[#d40530]">
          {SLOT_BADGE[root.slot]}
        </span>
        {!root.isVisible && (
          <span className="rounded-full bg-[#f6f2ed] px-2 py-0.5 text-[10px] font-bold uppercase text-[#5b5d62]">
            masqué
          </span>
        )}
        <button type="button" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Monter" className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30">
          <ChevronUp className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => onMove(1)} disabled={index === total - 1} aria-label="Descendre" className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30">
          <ChevronDown className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-full px-3 py-1.5 text-[13px] font-bold text-foreground hover:bg-surface hover:text-foreground">
          {open ? "Replier" : "Configurer"}
        </button>
        <button type="button" onClick={onRemove} aria-label="Supprimer l'onglet" className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div className="space-y-5 p-4">
          {/* Placement — where this root renders in the header. */}
          <SlotField value={root.slot} onChange={(slot) => onPatch({ slot })} />

          {/* Root link + icon + flags */}
          <div className="grid gap-4 sm:grid-cols-2">
            <LinkField
              label={
                root.slot === "mega"
                  ? "Lien de l'univers (« Voir tout » + source des sous-catégories)"
                  : "Lien de l'onglet"
              }
              kind={root.linkKind}
              value={root.linkValue}
              targets={targets}
              onChange={(kind, value) => onPatch({ linkKind: kind, linkValue: value })}
            />
            <IconField
              label="Icône (optionnel)"
              value={root.icon}
              onChange={(icon) => onPatch({ icon })}
            />
          </div>
          {root.slot === "mega" && (
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-bold text-foreground">Accroche de l'univers (optionnel)</span>
              <input
                value={root.blurb}
                onChange={(e) => onPatch({ blurb: e.target.value })}
                placeholder="Une ligne sous le nom de l'univers dans le méga-menu"
                className={inputCls}
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <ToggleField name={`vis-${root._id}`} label="Visible" defaultChecked={root.isVisible} onChange={(v) => onPatch({ isVisible: v })} />
            {root.slot === "shortcut" ? (
              <ToggleField name={`acc-${root._id}`} label="Pastille accentuée (crimson)" defaultChecked={root.accent} onChange={(v) => onPatch({ accent: v })} />
            ) : (
              <ToggleField name={`tab-${root._id}`} label="Ouvrir dans un nouvel onglet" defaultChecked={root.newTab} onChange={(v) => onPatch({ newTab: v })} />
            )}
          </div>

          {/* Dropdown — only a mega-menu universe has a panel; shortcut + service
              roots are plain links. */}
          {root.slot === "mega" && (
          <div className="rounded-[18px] border border-border bg-[#fbf9f8] p-4">
            <ToggleField
              name={`dd-${root._id}`}
              label="Menu déroulant"
              description="Si désactivé, l'onglet est un simple lien."
              defaultChecked={root.hasDropdown}
              onChange={(v) => onPatch({ hasDropdown: v })}
            />
            {root.hasDropdown && (
              <div className="mt-4 space-y-4">
                <ToggleField name={`mob-${root._id}`} label="Afficher le déroulant sur mobile" defaultChecked={root.mobileVisible} onChange={(v) => onPatch({ mobileVisible: v })} />

                {/* Columns */}
                <div className="flex flex-wrap items-start gap-3">
                  {root.columns.map((col, ci) => (
                    <ColumnEditor
                      key={col._id}
                      column={col}
                      index={ci}
                      total={root.columns.length}
                      targets={targets}
                      productOptions={productOptions}
                      mediaThumbs={mediaThumbs}
                      onMoveColumn={(dir) => moveColumn(ci, dir)}
                      onRemoveColumn={() => removeColumn(ci)}
                      onAddBlock={(type) => addBlock(ci, type)}
                      onPatchBlock={(bi, patch) => patchBlock(ci, bi, patch)}
                      onMoveBlock={(bi, dir) => moveBlock(ci, bi, dir)}
                      onMoveBlockAcross={(bi, dir) => moveBlockAcross(ci, bi, dir)}
                      onRemoveBlock={(bi) => removeBlock(ci, bi)}
                    />
                  ))}
                  {root.columns.length < MAX_NAV_COLUMNS && (
                    <button
                      type="button"
                      onClick={addColumn}
                      className="flex h-28 w-40 shrink-0 flex-col items-center justify-center gap-1.5 rounded-[18px] border border-dashed border-border text-[13px] font-bold text-foreground hover:border-primary/50 hover:text-foreground"
                    >
                      <Plus className="h-4 w-4" /> Ajouter une colonne
                    </button>
                  )}
                </div>
                {root.columns.length === 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    Ajoutez une colonne pour composer le déroulant.
                  </p>
                )}
              </div>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}

function ColumnEditor({
  column,
  index,
  total,
  targets,
  productOptions,
  mediaThumbs,
  onMoveColumn,
  onRemoveColumn,
  onAddBlock,
  onPatchBlock,
  onMoveBlock,
  onMoveBlockAcross,
  onRemoveBlock,
}: {
  column: EColumn;
  index: number;
  total: number;
  targets: NavTargets;
  productOptions: { id: string; name: string }[];
  mediaThumbs: Record<string, string>;
  onMoveColumn: (dir: -1 | 1) => void;
  onRemoveColumn: () => void;
  onAddBlock: (type: NavBlockType) => void;
  onPatchBlock: (bi: number, patch: Partial<EBlock>) => void;
  onMoveBlock: (bi: number, dir: -1 | 1) => void;
  onMoveBlockAcross: (bi: number, dir: -1 | 1) => void;
  onRemoveBlock: (bi: number) => void;
}) {
  return (
    <div className="min-w-[240px] max-w-[720px] flex-1 basis-0 rounded-[18px] border border-border bg-[#fbf9f8] p-3">
      <div className="mb-3 flex items-center gap-1.5">
        <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
          Colonne {index + 1}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => onMoveColumn(-1)} disabled={index === 0} aria-label="Colonne vers la gauche" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => onMoveColumn(1)} disabled={index === total - 1} aria-label="Colonne vers la droite" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onRemoveColumn} aria-label="Supprimer la colonne" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {column.blocks.map((block, bi) => (
          <BlockEditor
            key={block._id}
            block={block}
            index={bi}
            total={column.blocks.length}
            colIndex={index}
            colTotal={total}
            targets={targets}
            productOptions={productOptions}
            mediaThumbs={mediaThumbs}
            onPatch={(patch) => onPatchBlock(bi, patch)}
            onMove={(dir) => onMoveBlock(bi, dir)}
            onMoveAcross={(dir) => onMoveBlockAcross(bi, dir)}
            onRemove={() => onRemoveBlock(bi)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {NAV_BLOCK_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onAddBlock(t)}
            className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-2.5 py-1 text-[11px] font-bold text-foreground hover:bg-surface"
          >
            <Plus className="h-3 w-3" /> {BLOCK_LABEL[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

function BlockEditor({
  block,
  index,
  total,
  colIndex,
  colTotal,
  targets,
  productOptions,
  mediaThumbs,
  onPatch,
  onMove,
  onMoveAcross,
  onRemove,
}: {
  block: EBlock;
  index: number;
  total: number;
  colIndex: number;
  colTotal: number;
  targets: NavTargets;
  productOptions: { id: string; name: string }[];
  mediaThumbs: Record<string, string>;
  onPatch: (patch: Partial<EBlock>) => void;
  onMove: (dir: -1 | 1) => void;
  onMoveAcross: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-[18px] border border-border bg-card p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-full bg-[#fdecef] px-2.5 py-1 text-[11px] font-bold text-[#d40530]">
          {BLOCK_LABEL[block.type]}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => onMoveAcross(-1)} disabled={colIndex === 0} aria-label="Déplacer vers la colonne de gauche" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => onMoveAcross(1)} disabled={colIndex === colTotal - 1} aria-label="Déplacer vers la colonne de droite" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Monter" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={index === total - 1} aria-label="Descendre" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-surface disabled:opacity-30">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onRemove} aria-label="Supprimer le bloc" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {block.type !== "image" && (
        <input
          value={block.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder="Titre du bloc (optionnel)"
          className={`${inputCls} mb-3`}
        />
      )}

      {block.type === "taxonomy" && <TaxonomyEditor block={block} targets={targets} onPatch={onPatch} />}

      {block.type === "links" && <LinksEditor block={block} targets={targets} onPatch={onPatch} />}

      {block.type === "categories" && (
        <LimitField value={block.limit} onChange={(v) => onPatch({ limit: v })} label="Nombre max de catégories" />
      )}

      {block.type === "brands" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <DisplayField value={block.display || "titles"} options={BRAND_DISPLAYS} labels={BRAND_DISPLAY_LABEL} onChange={(v) => onPatch({ display: v })} />
            <LimitField value={block.limit} onChange={(v) => onPatch({ limit: v })} label="Nombre max de marques" />
          </div>
          {/* Logo size — only meaningful when logos are shown (titles-only ignores it). */}
          {(block.display || "titles") !== "titles" && (
            <div className="mt-3">
              <SizeField value={block.size} onChange={(v) => onPatch({ size: v })} label="Taille des logos" />
            </div>
          )}
        </>
      )}

      {block.type === "products" && (
        <ProductsEditor block={block} targets={targets} productOptions={productOptions} onPatch={onPatch} />
      )}

      {block.type === "image" && (
        <ImageBlockEditor block={block} targets={targets} mediaThumbs={mediaThumbs} onPatch={onPatch} />
      )}

      {/* Max items per sub-column before overflow — only the TEXT-list blocks use
          it (brand logos/cards render as a grid and ignore it, so hide it there). */}
      {isListBlockType(block.type) &&
        !(block.type === "brands" && (block.display || "titles") !== "titles") && (
          <div className="mt-3">
            <MaxPerColumnField value={block.maxPerColumn} onChange={(v) => onPatch({ maxPerColumn: v })} />
          </div>
        )}
    </div>
  );
}

function LinksEditor({ block, targets, onPatch }: { block: EBlock; targets: NavTargets; onPatch: (p: Partial<EBlock>) => void }) {
  const setLink = (i: number, patch: Partial<ELink>) =>
    onPatch({ links: block.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  return (
    <div className="space-y-3">
      {block.links.map((l, i) => (
        <div key={i} className="rounded-[14px] border border-input bg-[#fbf9f8] p-2.5">
          <div className="mb-2 flex items-center gap-2">
            <input
              value={l.label}
              onChange={(e) => setLink(i, { label: e.target.value })}
              placeholder="Libellé du lien"
              className="h-10 flex-1 rounded-[12px] border-[1.5px] border-input bg-white px-3 text-[14px] transition focus:border-foreground focus:outline-none"
            />
            <button type="button" onClick={() => { if (window.confirm("Supprimer ce lien ?")) onPatch({ links: block.links.filter((_, j) => j !== i) }); }} aria-label="Supprimer le lien" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
          <LinkField kind={l.kind} value={l.value} targets={targets} onChange={(kind, value) => setLink(i, { kind, value })} />
          <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={l.newTab} onChange={(e) => setLink(i, { newTab: e.target.checked })} className="h-3.5 w-3.5 rounded-[4px] border-input accent-[var(--primary)]" />
            Ouvrir dans un nouvel onglet
          </label>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onPatch({ links: [...block.links, { label: "", kind: "url", value: "", icon: null, newTab: false }] })}
        className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-1.5 text-[13px] font-bold hover:bg-surface"
      >
        <Plus className="h-3.5 w-3.5" /> Ajouter un lien
      </button>
    </div>
  );
}

function ProductsEditor({ block, targets, productOptions, onPatch }: { block: EBlock; targets: NavTargets; productOptions: { id: string; name: string }[]; onPatch: (p: Partial<EBlock>) => void }) {
  const nameById = new Map(productOptions.map((p) => [p.id, p.name]));
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-bold text-foreground">Source</span>
          <SelectField
            name="src"
            ariaLabel="Source produits"
            value={block.source || "new_arrivals"}
            onChange={(v) => onPatch({ source: v })}
            options={PRODUCT_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-bold text-foreground">Nombre (1–{NAV_PRODUCTS_MAX})</span>
          {/* No HTML min/max: a native constraint failure here would abort the
              WHOLE menu save (one field blocks the form). The model clamps 1..6. */}
          <input
            type="number"
            value={block.count}
            onChange={(e) => onPatch({ count: e.target.value })}
            placeholder="4"
            className={inputCls}
          />
        </div>
      </div>
      {/* « Produits de l'univers » (category source): pick a category, or leave
          auto to use the category linked to the universe tab. */}
      {block.source === "category" && (
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-bold text-foreground">Catégorie</span>
          <SelectField
            name="prodcat"
            ariaLabel="Catégorie des produits"
            value={block.categoryRef}
            onChange={(v) => onPatch({ categoryRef: v })}
            options={[{ value: "", label: "— Univers de l'onglet (auto) —" }, ...targets.categories.map((o) => ({ value: o.value, label: o.label }))]}
          />
          <p className="text-[12px] text-muted-foreground">Laissez « auto » pour afficher les produits de l&apos;univers lié à l&apos;onglet.</p>
        </div>
      )}
      {/* Tile size — Petit (3/ligne) · Moyen (2/ligne) · Grand (1/ligne). */}
      <SizeField value={block.size} onChange={(v) => onPatch({ size: v })} label="Taille des vignettes" />
      {block.source === "pins" && (
        <div className="space-y-2">
          <SelectField
            name="addpin"
            ariaLabel="Ajouter un produit"
            value=""
            onChange={(id) => id && !block.pins.includes(id) && onPatch({ pins: [...block.pins, id].slice(0, NAV_PRODUCTS_MAX) })}
            options={[{ value: "", label: "+ Ajouter un produit" }, ...productOptions.map((p) => ({ value: p.id, label: p.name }))]}
          />
          <div className="flex flex-wrap gap-2">
            {block.pins.map((id) => (
              <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[#f6f2ed] px-2.5 py-1 text-[12px]">
                {nameById.get(id) ?? "(produit)"}
                <button type="button" onClick={() => onPatch({ pins: block.pins.filter((p) => p !== id) })} aria-label="Retirer" className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ImageBlockEditor({ block, targets, mediaThumbs, onPatch }: { block: EBlock; targets: NavTargets; mediaThumbs: Record<string, string>; onPatch: (p: Partial<EBlock>) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 flex items-center gap-1.5 text-[13px] font-bold text-foreground">
          <ImageIcon className="h-3.5 w-3.5" /> Image (desktop)
        </p>
        <MediaPicker name="img" value={block.mediaId} onChange={(id) => onPatch({ mediaId: id })} scope="cms" emptyLabel="Choisir l'image" />
        {block.mediaId && mediaThumbs[block.mediaId] && (
          <img src={mediaThumbs[block.mediaId]} alt="" className="mt-2 h-20 w-16 rounded-[10px] object-cover" />
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-bold text-foreground">Format de l'image</span>
          <SelectField
            name="imgaspect"
            ariaLabel="Format de l'image"
            value={block.aspect || DEFAULT_NAV_IMAGE_ASPECT}
            onChange={(v) => onPatch({ aspect: v })}
            options={NAV_IMAGE_ASPECTS.map((a) => ({ value: a, label: NAV_IMAGE_ASPECT_META[a].label }))}
          />
          {/* Upload a source matching the chosen format so it fills without cropping. */}
          <p className="text-[12px] text-muted-foreground">
            {NAV_IMAGE_ASPECT_META[(block.aspect as NavImageAspect) || DEFAULT_NAV_IMAGE_ASPECT].reco}
          </p>
        </div>
        {/* Panel WIDTH — the format fixes the shape, this fixes how wide the panel is. */}
        <SizeField value={block.size} onChange={(v) => onPatch({ size: v })} label="Largeur du panneau" />
      </div>
      <div>
        <p className="mb-1 text-[13px] font-bold text-foreground">Image mobile (optionnel)</p>
        <MediaPicker name="imgm" value={block.mediaMobileId} onChange={(id) => onPatch({ mediaMobileId: id })} scope="cms" emptyLabel="Image mobile" />
        <p className="mt-1 text-[12px] text-muted-foreground">
          Crop mobile alternatif (sinon l&apos;image ci-dessus est réutilisée) — visez le même format que celui choisi au-dessus.
        </p>
      </div>
      <input value={block.eyebrow} onChange={(e) => onPatch({ eyebrow: e.target.value })} placeholder="Surtitre (optionnel)" className={inputCls} />
      <input value={block.title} onChange={(e) => onPatch({ title: e.target.value })} placeholder="Titre (optionnel)" className={inputCls} />
      <LinkField label="Lien de l'image" kind={block.linkKind} value={block.linkValue} targets={targets} onChange={(kind, value) => onPatch({ linkKind: kind, linkValue: value })} />
      <ToggleField name={`imgmob-${block._id}`} label="Afficher sur mobile" defaultChecked={block.showOnMobile} onChange={(v) => onPatch({ showOnMobile: v })} />
    </div>
  );
}

// ─── Small controlled fields ─────────────────────────────────────────────────
function LinkField({ label, kind, value, targets, onChange }: { label?: string; kind: LinkKind; value: string; targets: NavTargets; onChange: (kind: LinkKind, value: string) => void }) {
  const entityOptions =
    kind === "system" ? targets.systemPages
    : kind === "category" ? targets.categories
    : kind === "brand" ? targets.brands
    : kind === "page" ? targets.pages
    : [];
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-[13px] font-bold text-foreground">{label}</span>}
      <div className="grid gap-2 sm:grid-cols-2">
        <SelectField
          name="lk"
          ariaLabel="Type de lien"
          value={kind}
          // Clear the value on ANY real kind change: a slug/ref is specific to its
          // kind (a category slug is not a valid brand ref), so keeping
          // it across kinds would silently store a dead/mis-link. Only a no-op
          // (same kind) preserves the typed value.
          onChange={(v) => onChange(v as LinkKind, v === kind ? value : "")}
          options={LINK_KIND_OPTS}
        />
        {kind === "url" ? (
          <input value={value} onChange={(e) => onChange(kind, e.target.value)} placeholder="/chemin ou https://…" className={inputCls} />
        ) : (
          <SelectField
            name="lv"
            ariaLabel="Cible"
            value={value}
            onChange={(v) => onChange(kind, v)}
            options={[{ value: "", label: "— Choisir —" }, ...entityOptions.map((o) => ({ value: o.value, label: o.label }))]}
          />
        )}
      </div>
    </div>
  );
}

function IconField({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">{label}</span>
      <SelectField
        name="ic"
        ariaLabel="Icône"
        value={value ?? ""}
        onChange={(v) => onChange(v || null)}
        options={[{ value: "", label: "— Aucune —" }, ...PROMO_ICON_NAMES.map((n) => ({ value: n, label: n }))]}
      />
    </div>
  );
}

function DisplayField({ value, options, labels, onChange }: { value: string; options: readonly string[]; labels: Record<string, string>; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">Affichage</span>
      <SelectField name="disp" ariaLabel="Affichage" value={value} onChange={onChange} options={options.map((o) => ({ value: o, label: labels[o] ?? o }))} />
    </div>
  );
}

/** Visual SIZE scale (Petit / Moyen / Grand) — the analogue of the image
 *  « Format », reused by the products preview, brand logos, collection cards and
 *  the image panel width. `label` lets each surface name what it scales. */
/** Where a root renders in the header (universe / shortcut pill / service link). */
function SlotField({ value, onChange }: { value: NavSlot; onChange: (v: NavSlot) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">Emplacement dans l&apos;en-tête</span>
      <SelectField
        name="slot"
        ariaLabel="Emplacement"
        value={value}
        onChange={(v) => onChange(v as NavSlot)}
        options={NAV_SLOTS.map((s) => ({ value: s, label: SLOT_LABEL[s] }))}
      />
      <p className="text-[12px] text-muted-foreground">{NAV_SLOT_META[value].hint}</p>
    </div>
  );
}

/** The auto sub-category block — pick which universe to expand, or inherit the
 *  tab's own category. The sub-categories themselves come live from the catalog. */
function TaxonomyEditor({ block, targets, onPatch }: { block: EBlock; targets: NavTargets; onPatch: (p: Partial<EBlock>) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">Univers (catégorie source)</span>
      <SelectField
        name="taxocat"
        ariaLabel="Catégorie source"
        value={block.categorySlug}
        onChange={(v) => onPatch({ categorySlug: v })}
        options={[{ value: "", label: "— Catégorie de l'onglet (auto) —" }, ...targets.categories.map((o) => ({ value: o.value, label: o.label }))]}
      />
      <p className="text-[12px] text-muted-foreground">
        Les sous-catégories sont générées automatiquement depuis le catalogue (toujours à jour). Laissez
        « auto » pour utiliser la catégorie liée à l&apos;onglet.
      </p>
    </div>
  );
}

function SizeField({ value, onChange, label = "Taille" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">{label}</span>
      <SelectField
        name="size"
        ariaLabel={label}
        value={value || DEFAULT_NAV_BLOCK_SIZE}
        onChange={onChange}
        options={NAV_BLOCK_SIZES.map((s) => ({ value: s, label: NAV_BLOCK_SIZE_META[s].label }))}
      />
    </div>
  );
}

function LimitField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">{label} (optionnel)</span>
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Tous" className={inputCls} />
    </div>
  );
}

function MaxPerColumnField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">Max par colonne (débordement)</span>
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Illimité" className={inputCls} />
    </div>
  );
}
