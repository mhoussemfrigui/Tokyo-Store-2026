"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  Save,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
  GripVertical,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";

import { MediaPicker } from "@/components/admin/media-picker";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { SelectField as UiSelectField } from "@/components/ui/select-field";
import { saveHomeBlocksAction } from "@/lib/actions/home";
import { type ActionState } from "@/lib/actions/types";
import { VALUE_PROP_ICONS } from "@/lib/catalog/value-prop-icons";
import { safeHref } from "@/lib/utils/safe-href";
import { realHref } from "@/lib/pages/page-blocks";
import {
  HOME_BLOCK_TYPES,
  HOME_BLOCK_META,
  HOME_BLOCK_SEED,
  EMPTY_HEADER,
  PRODUCT_SOURCE_MODES,
  BLOCK_ALIGNS,
  BLOCK_LIST_CAP,
  FULL_BLEED_CAPABLE,
  DEFAULT_PRESENTATION,
  IMAGE_RECO,
  heading,
  parseBlockConfig,
  parseHomeBlocks,
  newBlockId,
  type HomeBlock,
  type HomeBlockType,
  type HomeBlockConfig,
  type BlockCard,
  type BlockPresentation,
  type ProductSource,
  type AccentStyle,
  type Testimonial,
  type HomeStat,
  type SpacerHeight,
  type SpacerOrnament,
} from "@/lib/pages/home-blocks";

type Choice = { slug: string; name: string };

/** Mirror of the server parser's block cap, so the composer stops adding at the same limit. */
const HOME_BLOCK_CAP = BLOCK_LIST_CAP;

/**
 * The HOME page composer — an instance-based block builder. The operator adds blocks
 * from a grouped palette, reorders / toggles / removes them, and edits each block's
 * config (copy, médiathèque images, filterable product source, curated refs, cards,
 * FAQ, steps). State lives here as a HomeBlock[]; on save it is serialised to JSON and
 * posted to saveHomeBlocksAction, which re-validates every field. Every image goes
 * through the médiathèque MediaPicker and category/brand targets are picked
 * from the live catalog choices. The one free-text id field is a product rail/grid's
 * MANUAL pins (comma-separated ids); those are UUID-gated at parse (parseSource), so a
 * malformed token is dropped rather than persisted or blanking the rail.
 */
export function HomeComposer({
  initialBlocks,
  categories,
  brands,
  usingLegacy,
  description,
}: {
  initialBlocks: HomeBlock[];
  categories: Choice[];
  brands: Choice[];
  usingLegacy: boolean;
  /** Page intro — shown on the left of the save bar's header card. */
  description?: string;
}) {
  const [blocks, setBlocks] = useState<HomeBlock[]>(initialBlocks);
  const [openId, setOpenId] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveHomeBlocksAction,
    null,
  );

  const patch = (id: string, fn: (b: HomeBlock) => HomeBlock) =>
    setBlocks((bs) => bs.map((b) => (b.id === id ? fn(b) : b)));
  const setConfig = (id: string, cfg: Partial<HomeBlockConfig>) =>
    patch(id, (b) => ({ ...b, config: { ...b.config, ...cfg } }));
  const setHeader = (id: string, hdr: Partial<HomeBlockConfig["header"]>) =>
    patch(id, (b) => ({
      ...b,
      config: { ...b.config, header: { ...(b.config.header ?? EMPTY_HEADER), ...hdr } },
    }));
  const setPresentation = (id: string, pr: Partial<BlockPresentation>) =>
    patch(id, (b) => ({
      ...b,
      config: { ...b.config, presentation: { ...(b.config.presentation ?? DEFAULT_PRESENTATION), ...pr } },
    }));

  const move = (id: string, dir: -1 | 1) =>
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= bs.length) return bs;
      const next = [...bs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (id: string) => setBlocks((bs) => bs.filter((b) => b.id !== id));
  const addBlock = (type: HomeBlockType) => {
    // The server parser caps the list at HOME_BLOCK_CAP and silently drops the overflow on
    // save; mirror it here so a block never looks added then vanishes.
    if (blocks.length >= HOME_BLOCK_CAP) return;
    // Seeded with the title the storefront used to hard-code — now a real, clearable value.
    const b: HomeBlock = { id: newBlockId(), type, visible: true, config: parseBlockConfig(type, HOME_BLOCK_SEED[type] ?? {}) };
    setBlocks((bs) => [...bs, b]);
    setOpenId(b.id);
  };
  const atBlockCap = blocks.length >= HOME_BLOCK_CAP;

  return (
    <div className="space-y-5">
      {usingLegacy && (
        <AdminCallout tone="warning" icon={AlertTriangle}>
          Point de départ reconstitué à partir de l&apos;ancienne configuration. L&apos;accueil
          en ligne affiche encore ses sections Tokyo par défaut : réorganisez, modifiez ou
          ajoutez des blocs, puis <strong>Enregistrez</strong> pour que cette composition les
          remplace.
        </AdminCallout>
      )}

      {/* Save bar — the list is normalised through the SAME parser the server applies, and
          the editor adopts it, so after « Enregistrer » the panels show exactly what is live
          (trimmed values, dropped empty items, normalised presentation). Ids are kept. The
          page intro + the save action share one header card (description left, action right). */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        {description && (
          <p className="min-w-0 flex-1 max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        <form
          action={(fd) => {
            const clean = parseHomeBlocks(JSON.stringify(blocks));
            setBlocks(clean);
            fd.set("blocks", JSON.stringify(clean));
            return formAction(fd);
          }}
          className="flex flex-wrap items-center gap-3"
        >
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Enregistrer ({blocks.length} blocs)
            </button>
            <Link
              href="/"
              target="_blank"
              className="inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-4 text-[13px] font-bold text-foreground hover:bg-surface"
            >
              Aperçu <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
          {state?.message && (
            <span
              role="status"
              className={`text-[12px] font-semibold ${state.ok ? "text-[#15803d]" : "text-destructive"}`}
            >
              {state.message}
            </span>
          )}
        </form>
      </div>

      {/* Block list */}
      <div className="space-y-3">
        {blocks.map((b, i) => (
          <BlockCard
            key={b.id}
            block={b}
            index={i}
            total={blocks.length}
            open={openId === b.id}
            onToggleOpen={() => setOpenId((o) => (o === b.id ? null : b.id))}
            onMove={move}
            onRemove={remove}
            onToggleVisible={() => patch(b.id, (x) => ({ ...x, visible: !x.visible }))}
            onSetConfig={(cfg) => setConfig(b.id, cfg)}
            onSetHeader={(hdr) => setHeader(b.id, hdr)}
            onSetPresentation={(pr) => setPresentation(b.id, pr)}
            categories={categories}
            brands={brands}
          />
        ))}
        {blocks.length === 0 && (
          <p className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-8 text-center text-[14px] text-muted-foreground">
            Aucun bloc. Ajoutez-en un ci-dessous.
          </p>
        )}
      </div>

      {/* Add palette */}
      <AddPalette onAdd={addBlock} atCap={atBlockCap} />
    </div>
  );
}


function AddPalette({ onAdd, atCap }: { onAdd: (t: HomeBlockType) => void; atCap: boolean }) {
  const groups = ["produits", "média", "catalogue", "éditorial"] as const;
  return (
    <div className="rounded-[28px] border border-border bg-card p-4">
      <p className="mb-3 text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
        Ajouter un bloc
      </p>
      {atCap && (
        <AdminCallout tone="warning" icon={AlertTriangle} className="mb-3">
          Nombre maximal de blocs atteint ({HOME_BLOCK_CAP}). Supprimez-en un pour en ajouter un autre.
        </AdminCallout>
      )}
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g}>
            <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">{g}</p>
            <div className="flex flex-wrap gap-2">
              {HOME_BLOCK_TYPES.filter((t) => HOME_BLOCK_META[t].group === g).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onAdd(t)}
                  disabled={atCap}
                  title={HOME_BLOCK_META[t].hint}
                  className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-2 text-[13px] font-bold text-foreground transition-colors hover:border-primary/40 hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input disabled:hover:bg-card"
                >
                  <Plus className="h-3.5 w-3.5 text-primary" /> {HOME_BLOCK_META[t].label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BlockCard({
  block,
  index,
  total,
  open,
  onToggleOpen,
  onMove,
  onRemove,
  onToggleVisible,
  onSetConfig,
  onSetHeader,
  onSetPresentation,
  categories,
  brands,
}: {
  block: HomeBlock;
  index: number;
  total: number;
  open: boolean;
  onToggleOpen: () => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
  onToggleVisible: () => void;
  onSetConfig: (cfg: Partial<HomeBlockConfig>) => void;
  onSetHeader: (hdr: Partial<HomeBlockConfig["header"]>) => void;
  onSetPresentation: (pr: Partial<BlockPresentation>) => void;
  categories: Choice[];
  brands: Choice[];
}) {
  const meta = HOME_BLOCK_META[block.type];
  return (
    <div className={`rounded-[22px] border bg-card ${block.visible ? "border-border" : "border-border/50 opacity-70"}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/40" />
        <button type="button" onClick={onToggleOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="truncate text-[14px] font-bold text-foreground">
            {meta.label}
            {block.config.header?.title ? (
              <span className="font-normal text-muted-foreground"> — {block.config.header.title.split("\n")[0]}</span>
            ) : null}
          </span>
          {!block.visible && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">masqué</span>}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <IconBtn title="Monter" disabled={index === 0} onClick={() => onMove(block.id, -1)}>
            <ChevronUp className="h-4 w-4" />
          </IconBtn>
          <IconBtn title="Descendre" disabled={index === total - 1} onClick={() => onMove(block.id, 1)}>
            <ChevronDown className="h-4 w-4" />
          </IconBtn>
          <IconBtn title={block.visible ? "Masquer" : "Afficher"} onClick={onToggleVisible}>
            {block.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </IconBtn>
          <IconBtn title="Supprimer" onClick={() => onRemove(block.id)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </IconBtn>
        </div>
      </div>
      {open && (
        <div className="space-y-4 border-t border-border p-4">
          <BlockConfigEditor
            block={block}
            onSetConfig={onSetConfig}
            onSetHeader={onSetHeader}
            onSetPresentation={onSetPresentation}
            categories={categories}
            brands={brands}
          />
        </div>
      )}
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-surface hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// ── Per-type config editor ─────────────────────────────────────────────────────
function BlockConfigEditor({
  block,
  onSetConfig,
  onSetHeader,
  onSetPresentation,
  categories,
  brands,
}: {
  block: HomeBlock;
  onSetConfig: (cfg: Partial<HomeBlockConfig>) => void;
  onSetHeader: (hdr: Partial<HomeBlockConfig["header"]>) => void;
  onSetPresentation: (pr: Partial<BlockPresentation>) => void;
  categories: Choice[];
  brands: Choice[];
}) {
  const { type, config: c } = block;
  const h = c.header ?? EMPTY_HEADER;
  const showHeader = type !== "banner_duo" && type !== "spacer";

  return (
    <>
      {type === "hero" && (
        <p className="text-[12px] text-muted-foreground">
          Les diapositives du carrousel se gèrent dans la section «&nbsp;Carrousel
          d&apos;accueil&nbsp;» en haut de cette page (image bureau + mobile, lien,
          programmation, ordre). Ce bloc contrôle l&apos;emplacement du carrousel dans la
          page (un seul carrousel s&apos;affiche).
        </p>
      )}

      {showHeader && type !== "hero" && (() => {
        const hd = heading(h.title, c.accent);
        return (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Eyebrow (petit texte)" value={h.eyebrow} onChange={(v) => onSetHeader({ eyebrow: v })} />
              <Field label="Titre" value={h.title} onChange={(v) => onSetHeader({ title: v })} multiline={type === "editorial"} />
              <Field
                label="Accent — 2ᵉ ligne du titre"
                value={c.accent ?? ""}
                onChange={(v) => onSetConfig({ accent: v })}
                placeholder="ex. est un souvenir."
                hint="Affiché sous le titre dans une couleur distincte. Vide : si le Titre tient sur plusieurs lignes, sa dernière ligne devient l'accent."
              />
              {/* A banner/cta_band WITH an image (desktop OR mobile — the renderer bases on
                  `desktop ?? mobileImg`) paints its accent in a fixed on-photo palette and
                  ignores the gold/ink choice — so only offer « Style de l'accent » where the
                  renderer actually honours it. */}
              {hd.accent && !((type === "cta_band" || type === "banner") && (c.image?.mediaId || c.imageMobile?.mediaId)) && (
                <SelectField
                  label="Style de l'accent"
                  value={c.accentStyle ?? "gold"}
                  options={[
                    { v: "gold", l: "Doré (signature)" },
                    { v: "ink", l: "Même couleur que le titre" },
                  ]}
                  onChange={(v) => onSetConfig({ accentStyle: v as AccentStyle })}
                />
              )}
              <Field label="Sous-titre" value={h.subtitle} onChange={(v) => onSetHeader({ subtitle: v })} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="CTA libellé" value={h.ctaLabel} onChange={(v) => onSetHeader({ ctaLabel: v })} />
                <LinkField
                  label="CTA lien"
                  value={h.ctaHref}
                  onChange={(v) => onSetHeader({ ctaHref: v })}
                  placeholder="/nouveautes"
                  hint={
                    // banner/cta_band make the whole PHOTO the link (no label needed) ONLY when
                    // they have an image (desktop OR mobile, matching the renderer's `desktop ??
                    // mobileImg`); the no-image panel renders a CtaPair that needs a label.
                    !h.ctaLabel &&
                    realHref(safeHref(h.ctaHref)) &&
                    !(LINK_WITHOUT_LABEL.has(type) && !((type === "cta_band" || type === "banner") && !(c.image?.mediaId || c.imageMobile?.mediaId)))
                      ? "Sans libellé, le lien n'est pas affiché."
                      : undefined
                  }
                />
              </div>
            </div>
            {(hd.text || hd.accent) && (
              // Live preview of the two-tone title. Scoped `.storefront` so `var(--gold)`
              // + the serif resolve to the STOREFRONT theme (buildThemeCss) — not the
              // admin `.admin` tokens — matching the live heading's accent colour.
              <div className="storefront rounded-[14px] border border-border bg-[#fbf9f8] px-3 py-2.5">
                <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Aperçu du titre</span>
                <p className="font-serif text-xl leading-snug text-foreground">
                  {hd.text}
                  {hd.accent && (
                    <span className={`italic ${(c.accentStyle ?? "gold") === "ink" ? "text-foreground" : "text-[color:var(--gold)]"}`}>
                      {hd.text ? " " : ""}
                      {hd.accent}
                    </span>
                  )}
                </p>
              </div>
            )}
          </div>
        );
      })()}

      {(type === "product_rail" || type === "product_grid") && (
        <SourceEditor
          source={c.source ?? DEFAULT_SOURCE}
          count={c.count ?? 8}
          onSource={(source) => onSetConfig({ source })}
          onCount={(count) => onSetConfig({ count })}
          categories={categories}
          brands={brands}
        />
      )}

      {(type === "cta_band" || type === "banner" || type === "editorial") && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ImageField
            label="Image (bureau)"
            reco={
              type === "editorial"
                ? IMAGE_RECO.editorial_desktop
                : c.presentation?.width === "full"
                  ? IMAGE_RECO.banner_fullbleed
                  : IMAGE_RECO.banner_desktop
            }
            value={c.image?.mediaId ?? null}
            alt={c.image?.alt ?? ""}
            onChange={(id) => onSetConfig({ image: id ? { mediaId: id, alt: "" } : null })}
            onAlt={(alt) => c.image && onSetConfig({ image: { mediaId: c.image.mediaId, alt } })}
          />
          <ImageField
            label="Image (mobile)"
            reco={type === "editorial" ? IMAGE_RECO.editorial_mobile : IMAGE_RECO.banner_mobile}
            value={c.imageMobile?.mediaId ?? null}
            alt={c.imageMobile?.alt ?? ""}
            onChange={(id) => onSetConfig({ imageMobile: id ? { mediaId: id, alt: "" } : null })}
            onAlt={(alt) => c.imageMobile && onSetConfig({ imageMobile: { mediaId: c.imageMobile.mediaId, alt } })}
          />
        </div>
      )}

      {type === "editorial" && (
        <>
          <Field label="Description" value={c.body ?? ""} onChange={(v) => onSetConfig({ body: v })} multiline />
          <SelectField
            label="Côté de l'image"
            value={c.imageSide === "left" ? "left" : "right"}
            options={[{ v: "right", l: "Droite" }, { v: "left", l: "Gauche" }]}
            onChange={(v) => onSetConfig({ imageSide: v as "left" | "right" })}
          />
        </>
      )}

      {type === "banner_duo" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <ImageField label="Bannière 1" reco={IMAGE_RECO.card_landscape} value={c.bannerId ?? null} onChange={(id) => onSetConfig({ bannerId: id ?? "" })} />
            <LinkField label="Lien (optionnel)" value={c.bannerHref ?? ""} onChange={(v) => onSetConfig({ bannerHref: v })} placeholder="/homme" />
          </div>
          <div className="space-y-2">
            <ImageField label="Bannière 2" reco={IMAGE_RECO.card_landscape} value={c.bannerId2 ?? null} onChange={(id) => onSetConfig({ bannerId2: id ?? "" })} />
            <LinkField label="Lien (optionnel)" value={c.bannerHref2 ?? ""} onChange={(v) => onSetConfig({ bannerHref2: v })} placeholder="/femme" />
          </div>
        </div>
      )}

      {(type === "fifty_fifty" || type === "feature_cards" || type === "trust") && (
        <CardsEditor type={type} cards={c.cards ?? []} onChange={(cards) => onSetConfig({ cards })} />
      )}

      {type === "rich_text" && (
        <Field label="Texte" value={c.body ?? ""} onChange={(v) => onSetConfig({ body: v })} multiline />
      )}

      {type === "steps" && (
        <StepsEditor steps={c.steps ?? []} onChange={(steps) => onSetConfig({ steps })} />
      )}

      {type === "faq" && <FaqEditor faq={c.faq ?? []} onChange={(faq) => onSetConfig({ faq })} />}

      {type === "testimonials" && (
        <TestimonialsEditor items={c.testimonials ?? []} onChange={(testimonials) => onSetConfig({ testimonials })} />
      )}

      {type === "stats" && <StatsEditor items={c.stats ?? []} onChange={(stats) => onSetConfig({ stats })} />}

      {type === "spacer" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Hauteur"
            value={c.spacerHeight ?? "md"}
            options={[
              { v: "sm", l: "Petit" },
              { v: "md", l: "Moyen" },
              { v: "lg", l: "Grand" },
              { v: "xl", l: "Très grand" },
            ]}
            onChange={(v) => onSetConfig({ spacerHeight: v as SpacerHeight })}
          />
          <SelectField
            label="Ornement"
            value={c.spacerOrnament ?? "none"}
            options={[
              { v: "none", l: "Aucun (espace vide)" },
              { v: "rule", l: "Filet fin" },
              { v: "mark", l: "Ornement ✦" },
            ]}
            onChange={(v) => onSetConfig({ spacerOrnament: v as SpacerOrnament })}
          />
        </div>
      )}

      {(type === "categories" || type === "brands") && (
        <RefsEditor
          label={type === "brands" ? "Marques mises en avant" : "Catégories"}
          hint="Laisser vide = toutes (sélection automatique)."
          extraHint={
            type === "categories"
              ? "Image de la tuile = « Image boutique » de la fiche catégorie (Catalogue → Catégories)."
              : undefined
          }
          choices={type === "brands" ? brands : categories}
          selected={c.refs ?? []}
          onChange={(refs) => onSetConfig({ refs })}
          // parseBlockConfig always sets count; the fallback only guards the (unreached)
          // undefined case and matches the model default (categories/brands 12).
          count={c.count ?? 12}
          onCount={(count) => onSetConfig({ count })}
        />
      )}

      <PresentationEditor
        type={type}
        presentation={c.presentation ?? DEFAULT_PRESENTATION}
        separator={c.separator}
        onChange={onSetPresentation}
        onSeparator={(separator) => onSetConfig({ separator })}
      />
    </>
  );
}

const SEPARATOR_OPTS = [
  { v: "auto", l: "Automatique — filet très doux" },
  { v: "rule", l: "Toujours un filet (même près d'une photo)" },
  { v: "join", l: "Enchaîner avec la section au-dessus" },
];
const SEPARATOR_SHORT: Record<string, string> = { auto: "filet auto", rule: "filet toujours", join: "enchaîné" };
const PADDING_OPTS = [
  { v: "default", l: "Standard" },
  { v: "tight", l: "Resserré" },
  { v: "spacious", l: "Aéré" },
];
const PADDING_NONE_OPT = { v: "none", l: "Aucun — collé aux bords" };
const WIDTH_OPTS = [
  { v: "default", l: "Dans la colonne" },
  { v: "full", l: "Pleine largeur (bord à bord)" },
];
const WIDTH_SHORT: Record<string, string> = { default: "colonne", full: "pleine largeur" };
/** Types whose renderer honours presentation.align (kit HeadRow / CTA copy). */
const ALIGN_AWARE = new Set<HomeBlockType>([
  "product_rail", "product_grid", "fifty_fifty", "feature_cards", "cta_band", "banner",
  "categories", "brands", "trust", "steps", "rich_text",
  "testimonials", "stats",
]);

/** Per-block presentation. The home has ONE page ground (no background choice): sections
 *  are separated by a very soft hairline; the operator picks the seam with the section
 *  above, the vertical spacing and (where it applies) the title alignment. The hero is
 *  full-bleed and first, so it gets none. */
function PresentationEditor({
  type,
  presentation,
  separator,
  onChange,
  onSeparator,
}: {
  type: HomeBlockType;
  presentation: BlockPresentation;
  separator?: "rule" | "join";
  onChange: (p: Partial<BlockPresentation>) => void;
  onSeparator: (s: "rule" | "join" | undefined) => void;
}) {
  if (type === "hero") return null;
  const canBleed = FULL_BLEED_CAPABLE.has(type);
  const isFull = canBleed && presentation.width === "full";
  // « Aucun » (collé aux bords) only makes sense for a full-bleed band; the model drops it
  // back to "default" for any other block, so only surface it when it can take effect.
  const paddingOpts = isFull ? [...PADDING_OPTS, PADDING_NONE_OPT] : PADDING_OPTS;
  const pad = paddingOpts.some((o) => o.v === presentation.padding) ? presentation.padding : "default";
  const padLabel = paddingOpts.find((o) => o.v === pad)?.l.toLowerCase() ?? "standard";
  return (
    <details className="rounded-[18px] border border-border bg-[#fbf9f8]">
      <summary className="cursor-pointer px-3 py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
        Présentation{" "}
        <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
          — {SEPARATOR_SHORT[separator ?? "auto"]} · {padLabel}
          {isFull ? ` · ${WIDTH_SHORT.full}` : ""}
        </span>
      </summary>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <SelectField
          label="Séparation avec la section au-dessus"
          value={separator ?? "auto"}
          options={SEPARATOR_OPTS}
          onChange={(v) => onSeparator(v === "rule" || v === "join" ? v : undefined)}
        />
        <SelectField
          label="Espacement vertical"
          value={pad}
          options={paddingOpts}
          onChange={(v) => onChange({ padding: v as BlockPresentation["padding"] })}
        />
        {canBleed && (
          <SelectField
            label="Largeur"
            value={presentation.width === "full" ? "full" : "default"}
            options={WIDTH_OPTS}
            onChange={(v) => onChange({ width: (v === "full" ? "full" : "default") as BlockPresentation["width"] })}
          />
        )}
        {ALIGN_AWARE.has(type) && (
          <SelectField
            label="Alignement du titre"
            value={presentation.align}
            options={BLOCK_ALIGNS.map((v) => ({ v, l: v === "center" ? "Centré" : "Gauche" }))}
            onChange={(v) => onChange({ align: v as BlockPresentation["align"] })}
          />
        )}
      </div>
      <p className="px-3 pb-3 text-[12px] leading-relaxed text-muted-foreground/70">
        Toutes les sections partagent le même fond ivoire et sont séparées par un filet très doux.
        Automatique : aucun filet sous le carrousel ni autour d&apos;une bannière. « Enchaîner »
        colle ce bloc au précédent, sans filet ni marge haute (ex. les chiffres clés sous
        un éditorial) — sans effet sous le carrousel ; les blocs masqués ou vides sont
        ignorés. L&apos;espacement règle l&apos;air autour du bloc.
        {canBleed && " « Pleine largeur » fait déborder la photo d'un bord à l'autre de l'écran ; le texte reste dans la colonne. Choisissez « Aucun » pour la coller aux sections voisines."}
      </p>
    </details>
  );
}

/** Header CTA links these types honour WITHOUT a label (a derived « Voir tout » / the
 *  whole photo frame); every other type needs a label for the link to show. */
const LINK_WITHOUT_LABEL = new Set<HomeBlockType>([
  "product_rail", "product_grid", "categories", "brands", "cta_band", "banner",
]);

/**
 * A link input. A blank stored link parses to « # »; it is SHOWN empty, but the field keeps
 * its own draft so an operator can still type an anchor character by character (« #… »).
 */
function LinkField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  const [draft, setDraft] = useState(value === "#" ? "" : value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    // Follow external changes (save normalisation, reorder) — but never wipe a « # » the
    // operator is in the middle of typing.
    if (!(value === "#" && draft === "#")) setDraft(value === "#" ? "" : value);
  }
  return (
    <Field
      label={label}
      value={draft}
      onChange={(v) => {
        setDraft(v);
        onChange(v);
      }}
      placeholder={placeholder}
      hint={hint}
      error={linkError(draft)}
    />
  );
}

/** A link the storefront would silently drop (unsafe / malformed) — flagged inline. */
function linkError(v: string): string | undefined {
  const s = (v ?? "").trim();
  return s && s !== "#" && safeHref(s) === "#" ? "Lien invalide — commencez par / (ex. /homme) ou https://" : undefined;
}

const DEFAULT_SOURCE: ProductSource = { mode: "new", ref: "", productIds: [], windowDays: 30, promoStrategy: "both" };

function SourceEditor({
  source,
  count,
  onSource,
  onCount,
  categories,
  brands,
}: {
  source: ProductSource;
  count: number;
  onSource: (s: ProductSource) => void;
  onCount: (n: number) => void;
  categories: Choice[];
  brands: Choice[];
}) {
  const modeLabels: Record<(typeof PRODUCT_SOURCE_MODES)[number], string> = {
    new: "Nouveautés",
    best_sellers: "Meilleures ventes",
    on_promotion: "En promotion",
    preorder: "Précommandes",
    category: "Catégorie",
    brand: "Marque",
    manual: "Sélection manuelle",
  };
  const refChoices = source.mode === "category" ? categories : source.mode === "brand" ? brands : [];
  return (
    <div className="grid gap-3 rounded-[16px] border border-border bg-[#fbf9f8] p-3 sm:grid-cols-2">
      <SelectField
        label="Source des produits"
        value={source.mode}
        options={PRODUCT_SOURCE_MODES.map((m) => ({ v: m, l: modeLabels[m] }))}
        onChange={(v) => onSource({ ...source, mode: v as ProductSource["mode"], ref: "" })}
      />
      <NumberField label="Nombre de produits" value={count} min={2} max={24} onChange={onCount} />
      {source.mode === "best_sellers" && (
        <NumberField
          label="Période (jours)"
          value={source.windowDays}
          min={1}
          max={365}
          onChange={(n) => onSource({ ...source, windowDays: n })}
        />
      )}
      {(source.mode === "category" || source.mode === "brand") && (
        <SelectField
          label="Cible"
          value={source.ref}
          // Keep a deactivated/renamed target VISIBLE (as « … — introuvable ») instead of
          // silently resetting the picker to « — choisir — », mirroring RefsEditor.
          options={[
            { v: "", l: "— choisir —" },
            ...refChoices.map((x) => ({ v: x.slug, l: x.name })),
            ...(source.ref && !refChoices.some((x) => x.slug === source.ref)
              ? [{ v: source.ref, l: `${source.ref} — introuvable` }]
              : []),
          ]}
          onChange={(v) => onSource({ ...source, ref: v })}
        />
      )}
      {source.mode === "manual" && (
        // Remounted when the stored list changes; edits are typed freely (a trailing comma
        // survives) and committed on blur.
        <PinsField
          key={source.productIds.join(",")}
          ids={source.productIds}
          onCommit={(productIds) => onSource({ ...source, productIds })}
        />
      )}
    </div>
  );
}

function PinsField({ ids, onCommit }: { ids: string[]; onCommit: (ids: string[]) => void }) {
  const [draft, setDraft] = useState(ids.join(", "));
  return (
    <Field
      label="IDs produits (séparés par des virgules)"
      value={draft}
      onChange={setDraft}
      onBlur={() => onCommit(draft.split(",").map((x) => x.trim()).filter(Boolean))}
      hint="Validé à la sortie du champ ; les identifiants invalides sont ignorés."
    />
  );
}

function CardsEditor({ type, cards, onChange }: { type: HomeBlockType; cards: BlockCard[]; onChange: (c: BlockCard[]) => void }) {
  const max = type === "fifty_fifty" ? 3 : type === "feature_cards" ? 4 : 6;
  const update = (i: number, p: Partial<BlockCard>) => onChange(cards.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const add = () => onChange([...cards, EMPTY_CARD()]);
  const del = (i: number) => onChange(cards.filter((_, j) => j !== i));
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Cartes ({cards.length}/{max})</p>
      {cards.map((card, i) => (
        <div key={i} className="space-y-2 rounded-[16px] border border-border bg-[#fbf9f8] p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Carte {i + 1}</span>
            <IconBtn title="Supprimer" onClick={() => del(i)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></IconBtn>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Eyebrow / tag" value={card.eyebrow} onChange={(v) => update(i, { eyebrow: v })} />
            <Field label="Titre" value={card.title} onChange={(v) => update(i, { title: v })} />
            <Field label="Texte" value={card.body} onChange={(v) => update(i, { body: v })} multiline />
            {(type === "feature_cards" || type === "fifty_fifty") && (
              <Field
                label={type === "feature_cards" ? "Prix / badge" : "Mention (prix, disponibilité…)"}
                value={card.meta}
                onChange={(v) => update(i, { meta: v })}
              />
            )}
            <LinkField label="Lien (CTA)" value={card.ctaHref} onChange={(v) => update(i, { ctaHref: v })} placeholder="/nouveautes" />
            {(type === "fifty_fifty" || type === "feature_cards") && (
              <Field
                label="Libellé CTA (optionnel)"
                value={card.ctaLabel}
                onChange={(v) => update(i, { ctaLabel: v })}
                placeholder="Vide = toute la carte est le lien"
                hint={card.ctaLabel && !realHref(safeHref(card.ctaHref)) ? "Sans lien, le libellé n'est pas affiché." : undefined}
              />
            )}
            {type === "trust" && (
              <SelectField
                label="Icône"
                value={VALUE_PROP_ICONS.some((o) => o.key === card.icon) ? card.icon : "Sparkles"}
                options={VALUE_PROP_ICONS.map((o) => ({ v: o.key, l: o.label }))}
                onChange={(v) => update(i, { icon: v })}
              />
            )}
          </div>
          <ImageField
            label={type === "trust" ? "Image (remplace l'icône)" : "Image"}
            reco={
              type === "trust"
                ? IMAGE_RECO.square
                : type === "feature_cards"
                  ? "Packshot détouré (-nobg) ou sur fond blanc, carré — 1200×1200 px"
                  : cards.length <= 1
                    ? // A lone fifty_fifty card renders as a wide hero band (21:9).
                      "Packshot détouré (-nobg) ou bannière large 21:9 — 2400×1030 px"
                    : "Packshot détouré (-nobg) ou photo 5:4 — 1500×1200 px"
            }
            value={card.image?.mediaId ?? null}
            alt={card.image?.alt ?? ""}
            onChange={(id) => update(i, { image: id ? { mediaId: id, alt: "" } : null })}
            onAlt={(alt) => card.image && update(i, { image: { mediaId: card.image.mediaId, alt } })}
          />
        </div>
      ))}
      {cards.length < max && (
        <button type="button" onClick={add} className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-2 text-[13px] font-bold hover:bg-surface">
          <Plus className="h-3.5 w-3.5" /> Ajouter une carte
        </button>
      )}
    </div>
  );
}

function StepsEditor({ steps, onChange }: { steps: { title: string; body: string }[]; onChange: (s: { title: string; body: string }[]) => void }) {
  const update = (i: number, p: Partial<{ title: string; body: string }>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Étapes ({steps.length}/8)</p>
      {steps.map((s, i) => (
        <div key={i} className="grid gap-2 rounded-[16px] border border-border bg-[#fbf9f8] p-3 sm:grid-cols-[1fr_2fr_auto]">
          <Field label={`Étape ${i + 1} — titre`} value={s.title} onChange={(v) => update(i, { title: v })} />
          <Field label="Texte" value={s.body} onChange={(v) => update(i, { body: v })} />
          <div className="flex items-end">
            <IconBtn title="Supprimer" onClick={() => onChange(steps.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-destructive" /></IconBtn>
          </div>
        </div>
      ))}
      {steps.length < 8 && (
        <button type="button" onClick={() => onChange([...steps, { title: "", body: "" }])} className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-2 text-[13px] font-bold hover:bg-surface">
          <Plus className="h-3.5 w-3.5" /> Ajouter une étape
        </button>
      )}
    </div>
  );
}

function FaqEditor({ faq, onChange }: { faq: { question: string; answer: string }[]; onChange: (f: { question: string; answer: string }[]) => void }) {
  const update = (i: number, p: Partial<{ question: string; answer: string }>) => onChange(faq.map((q, j) => (j === i ? { ...q, ...p } : q)));
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Questions ({faq.length})</p>
      {faq.map((q, i) => (
        <div key={i} className="space-y-2 rounded-[16px] border border-border bg-[#fbf9f8] p-3">
          <div className="flex items-center justify-between">
            <Field label="Question" value={q.question} onChange={(v) => update(i, { question: v })} />
            <IconBtn title="Supprimer" onClick={() => onChange(faq.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5 text-destructive" /></IconBtn>
          </div>
          <Field label="Réponse" value={q.answer} onChange={(v) => update(i, { answer: v })} multiline />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...faq, { question: "", answer: "" }])} className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-2 text-[13px] font-bold hover:bg-surface">
        <Plus className="h-3.5 w-3.5" /> Ajouter une question
      </button>
    </div>
  );
}

function TestimonialsEditor({ items, onChange }: { items: Testimonial[]; onChange: (t: Testimonial[]) => void }) {
  const update = (i: number, p: Partial<Testimonial>) => onChange(items.map((t, j) => (j === i ? { ...t, ...p } : t)));
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Témoignages ({items.length}/6)</p>
      {items.map((t, i) => (
        <div key={i} className="space-y-2 rounded-[16px] border border-border bg-[#fbf9f8] p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Avis {i + 1}</span>
            <IconBtn title="Supprimer" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5 text-destructive" /></IconBtn>
          </div>
          <Field label="Citation" value={t.quote} onChange={(v) => update(i, { quote: v })} multiline />
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Auteur" value={t.author} onChange={(v) => update(i, { author: v })} placeholder="Ex. Leïla B." />
            <Field label="Contexte (optionnel)" value={t.meta} onChange={(v) => update(i, { meta: v })} placeholder="Ex. Cliente depuis 2019" />
          </div>
          <ImageField
            label="Portrait (optionnel)"
            reco={IMAGE_RECO.square}
            value={t.image?.mediaId ?? null}
            alt={t.image?.alt ?? ""}
            onChange={(id) => update(i, { image: id ? { mediaId: id, alt: "" } : null })}
            onAlt={(alt) => t.image && update(i, { image: { mediaId: t.image.mediaId, alt } })}
          />
        </div>
      ))}
      {items.length < 6 && (
        <button type="button" onClick={() => onChange([...items, { quote: "", author: "", meta: "", image: null }])} className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-2 text-[13px] font-bold hover:bg-surface">
          <Plus className="h-3.5 w-3.5" /> Ajouter un avis
        </button>
      )}
    </div>
  );
}

function StatsEditor({ items, onChange }: { items: HomeStat[]; onChange: (s: HomeStat[]) => void }) {
  const update = (i: number, p: Partial<HomeStat>) => onChange(items.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Chiffres ({items.length}/4)</p>
      {items.map((s, i) => (
        <div key={i} className="grid gap-2 rounded-[16px] border border-border bg-[#fbf9f8] p-3 sm:grid-cols-[1fr_2fr_auto]">
          <Field label={`Chiffre ${i + 1}`} value={s.value} onChange={(v) => update(i, { value: v })} placeholder="1950" />
          <Field label="Libellé" value={s.label} onChange={(v) => update(i, { label: v })} placeholder="Année de fondation" />
          <div className="flex items-end">
            <IconBtn title="Supprimer" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-destructive" /></IconBtn>
          </div>
        </div>
      ))}
      {items.length < 4 && (
        <button type="button" onClick={() => onChange([...items, { value: "", label: "" }])} className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-2 text-[13px] font-bold hover:bg-surface">
          <Plus className="h-3.5 w-3.5" /> Ajouter un chiffre
        </button>
      )}
    </div>
  );
}

function moveItem<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function RefsEditor({
  label,
  hint,
  extraHint,
  choices,
  selected,
  onChange,
  count,
  onCount,
}: {
  label: string;
  hint: string;
  extraHint?: string;
  choices: Choice[];
  selected: string[];
  onChange: (refs: string[]) => void;
  count: number;
  onCount: (n: number) => void;
}) {
  const sel = new Set(selected);
  const toggle = (slug: string) =>
    onChange(sel.has(slug) ? selected.filter((s) => s !== slug) : [...selected, slug]);
  const nameOf = (slug: string) => choices.find((c) => c.slug === slug)?.name;
  // A ref whose item was deactivated / renamed no longer resolves on the storefront: it is
  // flagged, removable, and not counted toward « Max affichés ».
  const resolvable = selected.filter((s) => choices.some((c) => c.slug === s));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">{label}</p>
        <div className="w-32"><NumberField label="Max affichés" value={count} min={2} max={40} onChange={onCount} /></div>
      </div>
      <p className="text-[12px] text-muted-foreground">
        {hint}
        {extraHint ? ` ${extraHint}` : ""}
      </p>
      <div className="max-h-44 space-y-1 overflow-y-auto rounded-[16px] border border-border bg-[#fbf9f8] p-2">
        {choices.length === 0 && <p className="p-2 text-[12px] text-muted-foreground">Aucun élément.</p>}
        {choices.map((c) => (
          <label key={c.slug} className="flex items-center gap-2 rounded-[8px] px-1.5 py-1 text-[12px] hover:bg-surface">
            <input type="checkbox" checked={sel.has(c.slug)} onChange={() => toggle(c.slug)} className="h-3.5 w-3.5 rounded-[4px] border-input accent-[var(--primary)]" />
            <span className="truncate">{c.name}</span>
          </label>
        ))}
      </div>
      {selected.length > 0 && (
        // The storefront shows the selection IN THIS ORDER — reorder it here.
        <div className="rounded-[16px] border border-border bg-[#fbf9f8] p-2">
          <p className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">Ordre d&apos;affichage</p>
          <ol className="space-y-0.5">
            {selected.map((slug, i) => {
              const name = nameOf(slug);
              const shownRank = name ? resolvable.indexOf(slug) : -1;
              return (
                <li
                  key={slug}
                  className={`flex items-center gap-2 rounded-lg px-1.5 py-0.5 text-[12px] ${!name || shownRank >= count ? "opacity-50" : ""}`}
                >
                  <span className="w-5 text-right tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {name ?? slug}
                    {!name && <span className="ml-1.5 text-[10px] text-destructive">introuvable (masqué)</span>}
                  </span>
                  <IconBtn title="Monter" disabled={i === 0} onClick={() => onChange(moveItem(selected, i, -1))}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn title="Descendre" disabled={i === selected.length - 1} onClick={() => onChange(moveItem(selected, i, 1))}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn title="Retirer" onClick={() => onChange(selected.filter((s) => s !== slug))}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </IconBtn>
                </li>
              );
            })}
          </ol>
          {resolvable.length > count && (
            <p className="px-1.5 pt-1 text-[10px] text-muted-foreground">Seules les {count} premières s&apos;affichent.</p>
          )}
          {resolvable.length === 0 && (
            <p className="px-1.5 pt-1 text-[10px] text-destructive">
              Aucun élément sélectionné n&apos;existe encore — la page affiche la sélection automatique.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small controlled field primitives ──────────────────────────────────────────
function Field({
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  multiline,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  multiline?: boolean;
  /** A short helper line under the field. */
  hint?: string;
  /** An inline validation message (e.g. a link the storefront would drop). */
  error?: string;
}) {
  const cls = `w-full rounded-[14px] border-[1.5px] bg-[#fbf9f8] px-4 py-2.5 text-[15px] text-foreground outline-none transition focus:border-foreground focus:bg-white ${
    error ? "border-destructive/60" : "border-input"
  }`;
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          rows={3}
          aria-invalid={error ? true : undefined}
          className={cls}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          className={cls}
        />
      )}
      {error ? (
        <span className="mt-1 block text-[10px] text-destructive">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[10px] leading-snug text-muted-foreground/80">{hint}</span>
      ) : null}
    </label>
  );
}

/** A number input you can actually TYPE into: the draft is free text while editing (no
 *  per-keystroke clamping — typing « 12 » with min 2 used to become « 22 »); an in-range
 *  integer commits immediately, anything else is clamped on blur / Enter. */
function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  // Follow an external change (another control, a reset) — synced during render.
  if (value !== seen) {
    setSeen(value);
    setDraft(String(value));
  }
  const commit = () => {
    const n = Number(draft);
    const next = draft.trim() !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={draft}
        min={min}
        max={max}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          const n = Number(v);
          if (v !== "" && Number.isInteger(n) && n >= min && n <= max) onChange(n);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 py-2.5 text-[15px] text-foreground outline-none transition focus:border-foreground focus:bg-white"
      />
    </label>
  );
}

// The composer's dropdowns delegate to the shared, themed portaled listbox (same control
// the rest of the admin + the page composer use) instead of a raw native <select>, so
// every dropdown looks consistent (rounded pill, olive highlight, keyboard nav) and never
// falls back to the OS option list.
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: { v: string; l: string }[]; onChange: (v: string) => void }) {
  return (
    <UiSelectField
      label={label}
      value={value}
      options={options.map((o) => ({ value: o.v, label: o.l }))}
      onChange={onChange}
      size="sm"
      labelClassName="mb-1 block text-[13px] font-bold text-foreground"
    />
  );
}

function ImageField({
  label,
  value,
  onChange,
  reco,
  alt,
  onAlt,
}: {
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  reco?: string;
  /** When onAlt is supplied, a per-placement ALT override is editable; blank = inherit
   *  the médiathèque's alt (pickImage precedence: block alt → média alt → fallback). */
  alt?: string;
  onAlt?: (alt: string) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      {/* key by the current value so the picker re-mounts (and shows the right thumbnail)
          when the SAME slot receives a different value — e.g. after a card is deleted or
          reordered and this position now holds another card's image. */}
      <MediaPicker key={value ?? "empty"} name="img" value={value} onChange={onChange} scope="cms" emptyLabel="Choisir une image" />
      {reco && <p className="mt-1 text-[12px] leading-snug text-muted-foreground/70">Recommandé : {reco}</p>}
      {onAlt && value ? (
        <input
          type="text"
          value={alt ?? ""}
          onChange={(e) => onAlt(e.target.value)}
          placeholder="Texte alternatif (vide = médiathèque)"
          className="mt-1.5 w-full rounded-[10px] border-[1.5px] border-input bg-[#fbf9f8] px-3 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none"
        />
      ) : (
        <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground/60">Texte alternatif : celui de la médiathèque.</p>
      )}
    </div>
  );
}

function EMPTY_CARD(): BlockCard {
  return { eyebrow: "", title: "", body: "", meta: "", ctaLabel: "", ctaHref: "", image: null, icon: "" };
}
