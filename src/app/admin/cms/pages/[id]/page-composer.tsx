"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronUp, Copy, Eye, EyeOff, GripVertical, Plus, Save, Trash2 } from "lucide-react";

import { MediaPicker } from "@/components/admin/media-picker";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { RichTextField } from "@/components/admin/_components/rich-text-field";
import { SelectField as UiSelect } from "@/components/ui/select-field";
import { savePageBlocksAction } from "@/lib/actions/cms";
import { type ActionState } from "@/lib/actions/types";
import { VALUE_PROP_ICONS } from "@/lib/catalog/value-prop-icons";
import {
  BLOCK_ALIGNS,
  BLOCK_BACKGROUNDS,
  CONTACT_CHANNEL_KEYS,
  CONTACT_CHANNEL_LABELS,
  coerceAnchor,
  DEFAULT_PRESENTATION,
  IMAGE_RECO,
  PAGE_BLOCK_LAYOUTS,
  PAGE_BLOCK_META,
  PAGE_BLOCK_TYPES,
  PRODUCT_SOURCE_MODES,
  newBlockId,
  parsePageBlockConfig,
  parsePageBlocks,
  type BlockImage,
  type BlockPresentation,
  type ChipItem,
  type ContactChannel,
  type ImageFit,
  type JobItem,
  type ChecklistColumn,
  type CookieCategory,
  type FactItem,
  type LegalSection,
  type PageBlock,
  type PageBlockConfig,
  type PageBlockType,
  type PageFaqItem,
  type PointItem,
  type StatItem,
  type StepItem,
  type StoreItem,
  type TierItem,
  TIER_TONES,
} from "@/lib/pages/page-blocks";
import { BLOCK_LIST_CAP, type BlockCard, type ProductSource } from "@/lib/pages/block-model";

type Choice = { slug: string; name: string };
type PickupChoice = { id: string; name: string; enabled: boolean };
const GROUPS: { key: string; label: string }[] = [
  { key: "contenu", label: "Contenu" },
  { key: "média", label: "Média" },
  { key: "éditorial", label: "Éditorial" },
  { key: "pratique", label: "Pratique" },
  { key: "catalogue", label: "Catalogue" },
];
const EMPTY_HEADER = { eyebrow: "", title: "", subtitle: "", ctaLabel: "", ctaHref: "" };
const DEFAULT_SOURCE: ProductSource = { mode: "new", ref: "", productIds: [], windowDays: 30, promoStrategy: "both" };
const BG_LABELS: Record<BlockPresentation["background"], string> = {
  default: "Ivoire (par défaut)",
  surface: "Greige doux",
  muted: "Gris chaud",
  olive: "Teinte olive",
  dark: "Onyx (sombre)",
};

/**
 * Which HEADER fields each block renders (mirrors page-blocks-render.tsx) — a field the
 * renderer ignores is hidden so an operator never fills something that silently does
 * nothing. Some depend on the layout (steps: CTA only on the vertical path).
 */
function headerFields(type: PageBlockType, layout: string | undefined) {
  const all = { eyebrow: true, title: true, subtitle: true, cta: false, accent: false };
  switch (type) {
    case "hero":
      return { ...all, cta: true, accent: true };
    case "rich_text":
      return { ...all, subtitle: false, accent: true };
    case "editorial":
      return { ...all, subtitle: false, cta: true, accent: true };
    case "quote":
      return { ...all, title: false, subtitle: false };
    case "cta_band":
      return { ...all, cta: true, accent: true };
    case "banner":
      return { ...all, cta: true };
    case "timeline":
      return { ...all, subtitle: false };
    case "steps":
      return { ...all, cta: layout === "vertical", accent: true };
    case "contact_channels":
    case "stores":
    case "jobs":
    case "tiers":
      return { ...all, accent: true };
    case "legal_doc":
      // The hero (title + lede) comes from the page meta; the article has no section head.
      return { eyebrow: false, title: false, subtitle: false, cta: false, accent: false };
    case "checklist":
    case "contact_form":
    case "apply_form":
      return { ...all };
    case "brands":
      // The « voir tout » aside is operator-editable (label + target), defaulting to « Toutes
      // les marques » / /marques when left blank.
      return { ...all, cta: true };
    default:
      return all;
  }
}

/** Types whose renderer honours `presentation.align` for its section head — minus the
 *  layouts that pin the head in a left column (vertical timeline / vertical steps). */
const ALIGN_AWARE = new Set<PageBlockType>([
  "banner", "cta_band", "gallery", "fifty_fifty", "feature_cards", "trust", "stats", "timeline", "steps",
  "product_grid", "categories", "brands",
]);
function alignAware(type: PageBlockType, layout: string | undefined): boolean {
  if (!ALIGN_AWARE.has(type)) return false;
  if ((type === "timeline" || type === "steps") && (layout ?? (type === "steps" ? "cards" : "vertical")) === "vertical") return false;
  return true;
}

/**
 * The page block composer — an instance-based block builder (same model as the home
 * composer). The operator adds blocks from a grouped palette, reorders / toggles / removes
 * them, picks each block's LAYOUT and edits its content. State lives here as a PageBlock[];
 * on save it is serialised to JSON and posted to savePageBlocksAction, which re-validates
 * every field. Images go through the médiathèque; catalogue targets come from the live
 * catalog; contact blocks read « Identité & contact »; stores can link a pickup location.
 */
export function PageComposer({
  pageId,
  initialBlocks,
  usingLegacy,
  categories,
  brands,
  pickups,
}: {
  pageId: string;
  initialBlocks: PageBlock[];
  usingLegacy: boolean;
  categories: Choice[];
  brands: Choice[];
  pickups: PickupChoice[];
}) {
  const [blocks, setBlocks] = useState<PageBlock[]>(initialBlocks);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(initialBlocks));
  const submittedRef = useRef<string | null>(null);
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(savePageBlocksAction, null);

  // Unsaved-changes tracking: all edits live in local state, so warn before a navigation that
  // would discard them. The snapshot is re-baselined to the submitted blocks ONLY after a
  // CONFIRMED successful save (below), so a failed save keeps the dirty state + beforeunload guard.
  const dirty = JSON.stringify(blocks) !== savedSnapshot;
  const atCap = blocks.length >= BLOCK_LIST_CAP;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (state?.ok && submittedRef.current !== null) {
      setSavedSnapshot(submittedRef.current);
      submittedRef.current = null;
    }
  }, [state]);

  const add = (type: PageBlockType) => {
    if (blocks.length >= BLOCK_LIST_CAP) return; // mirror the server parser cap
    const block: PageBlock = { id: newBlockId(), type, visible: true, config: parsePageBlockConfig(type, {}) };
    setBlocks((b) => [...b, block]);
    setOpen((o) => ({ ...o, [block.id]: true }));
  };
  const duplicate = (id: string) => {
    if (blocks.length >= BLOCK_LIST_CAP) return;
    setBlocks((b) => {
      const i = b.findIndex((x) => x.id === id);
      if (i < 0) return b;
      const copy: PageBlock = { ...b[i], id: newBlockId(), config: structuredClone(b[i].config) };
      return [...b.slice(0, i + 1), copy, ...b.slice(i + 1)];
    });
  };
  const patch = (id: string, fn: (b: PageBlock) => PageBlock) => setBlocks((b) => b.map((x) => (x.id === id ? fn(x) : x)));
  const setConfig = (id: string, c: Partial<PageBlockConfig>) => patch(id, (b) => ({ ...b, config: { ...b.config, ...c } }));
  const setHeader = (id: string, hh: Partial<PageBlockConfig["header"]>) =>
    patch(id, (b) => ({ ...b, config: { ...b.config, header: { ...(b.config.header ?? EMPTY_HEADER), ...hh } } }));
  const setPres = (id: string, pp: Partial<BlockPresentation>) =>
    patch(id, (b) => ({ ...b, config: { ...b.config, presentation: { ...(b.config.presentation ?? DEFAULT_PRESENTATION), ...pp } } }));
  const move = (i: number, dir: -1 | 1) =>
    setBlocks((b) => {
      const j = i + dir;
      if (j < 0 || j >= b.length) return b;
      const next = [...b];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (id: string) => setBlocks((b) => b.filter((x) => x.id !== id));

  return (
    <form
      action={(fd) => {
        // Re-validate through the SAME parser the server runs and adopt the cleaned result so
        // the panels show exactly what is stored (trimmed values, dropped empties). Stash the
        // submitted serialization; the snapshot is only re-baselined to it once the server
        // confirms success (the effect above), so a failed save stays « non enregistré ».
        const clean = parsePageBlocks(JSON.stringify(blocks));
        const serialized = JSON.stringify(clean);
        setBlocks(clean);
        submittedRef.current = serialized;
        fd.set("blocks", serialized);
        return formAction(fd);
      }}
      className="space-y-4"
    >
      <input type="hidden" name="pageId" value={pageId} />
      <input type="hidden" name="blocks" value={JSON.stringify(blocks)} />

      {usingLegacy && (
        <AdminCallout tone="warning" icon={AlertTriangle}>
          Cette page utilise encore son ancien contenu (sections). Les blocs ci-dessous en sont une
          reprise fidèle — <strong>enregistrez</strong> pour basculer définitivement sur le nouveau
          système de blocs (l&apos;ancien contenu reste intact tant que vous n&apos;enregistrez pas).
        </AdminCallout>
      )}

      <div className="space-y-2">
        {blocks.map((b, i) => {
          const layoutLabel = PAGE_BLOCK_LAYOUTS[b.type]?.find((o) => o.v === b.config.layout)?.l;
          const panelId = `page-block-${b.id}`;
          const isOpen = Boolean(open[b.id]);
          return (
            <div key={b.id} className="rounded-[22px] border border-border bg-card">
              <div className="flex items-center gap-2 px-3 py-2">
                <GripVertical className="h-4 w-4 text-muted-foreground/40" aria-hidden />
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [b.id]: !o[b.id] }))}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  className="flex-1 text-left text-[14px] font-bold"
                >
                  {PAGE_BLOCK_META[b.type].label}
                  {layoutLabel && <span className="ml-2 text-[11px] font-normal text-muted-foreground">· {layoutLabel}</span>}
                  {b.config.header?.title && <span className="ml-2 text-[11px] font-normal text-muted-foreground">« {b.config.header.title.slice(0, 40)} »</span>}
                  {!b.visible && <span className="ml-2 text-[11px] font-normal text-muted-foreground">(masqué)</span>}
                </button>
                <IconBtn title="Monter" onClick={() => move(i, -1)}><ChevronUp className="h-4 w-4" /></IconBtn>
                <IconBtn title="Descendre" onClick={() => move(i, 1)}><ChevronDown className="h-4 w-4" /></IconBtn>
                <IconBtn title={b.visible ? "Masquer" : "Afficher"} onClick={() => patch(b.id, (x) => ({ ...x, visible: !x.visible }))}>
                  {b.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-muted-foreground" />}
                </IconBtn>
                <IconBtn title={atCap ? `Nombre maximal de blocs atteint (${BLOCK_LIST_CAP})` : "Dupliquer"} onClick={() => duplicate(b.id)} disabled={atCap}><Copy className="h-4 w-4" /></IconBtn>
                <IconBtn title="Supprimer" onClick={() => remove(b.id)}><Trash2 className="h-4 w-4 text-destructive" /></IconBtn>
              </div>
              {isOpen && (
                <div id={panelId} className="space-y-3 border-t border-border p-3">
                  <BlockConfigEditor
                    block={b}
                    onSetConfig={(c) => setConfig(b.id, c)}
                    onSetHeader={(hh) => setHeader(b.id, hh)}
                    onSetPres={(pp) => setPres(b.id, pp)}
                    categories={categories}
                    brands={brands}
                    pickups={pickups}
                  />
                </div>
              )}
            </div>
          );
        })}
        {blocks.length === 0 && (
          <p className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-6 text-center text-[14px] text-muted-foreground">
            Aucun bloc. Ajoutez-en depuis la palette ci-dessous.
          </p>
        )}
      </div>

      <div className="rounded-[28px] border border-border bg-card p-3">
        <p className="mb-2 text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Ajouter un bloc</p>
        {atCap && (
          <AdminCallout tone="warning" icon={AlertTriangle} className="mb-2">
            Nombre maximal de blocs atteint ({BLOCK_LIST_CAP}). Supprimez-en un pour en ajouter un autre.
          </AdminCallout>
        )}
        <div className="space-y-2">
          {GROUPS.map((g) => (
            <div key={g.key} className="flex flex-wrap items-center gap-1.5">
              <span className="w-20 shrink-0 text-[12px] font-bold text-[#8a857f]">{g.label}</span>
              {PAGE_BLOCK_TYPES.filter((t) => PAGE_BLOCK_META[t].group === g.key).map((t) => (
                <button key={t} type="button" onClick={() => add(t)} disabled={atCap} title={PAGE_BLOCK_META[t].hint} className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-2.5 py-1.5 text-[13px] font-bold hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card">
                  <Plus className="h-3 w-3" /> {PAGE_BLOCK_META[t].label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Sticky action bar — save is always reachable on a long page, and the dirty state +
          save result are visible without scrolling to the bottom. */}
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[22px] bg-[#0e1218] px-3 py-2.5 text-white">
        <button type="submit" disabled={isPending} className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60">
          <Save className="h-4 w-4" />
          {isPending ? "Enregistrement…" : `Enregistrer (${blocks.length} blocs)`}
        </button>
        {dirty && !isPending && <span className="text-[12px] font-semibold text-[#f0b968]">Modifications non enregistrées</span>}
        {state && !state.ok && <p role="alert" className="text-[13px] font-semibold text-[#fca5a5]">{state.message}</p>}
        <p role="status" aria-live="polite" className="sr-only">
          {isPending ? "Enregistrement en cours" : state?.ok && !dirty ? state.message : ""}
        </p>
        {state?.ok && !dirty && <p className="text-[13px] font-semibold text-[#4ade80]">{state.message}</p>}
      </div>
    </form>
  );
}

function BlockConfigEditor({
  block,
  onSetConfig,
  onSetHeader,
  onSetPres,
  categories,
  brands,
  pickups,
}: {
  block: PageBlock;
  onSetConfig: (c: Partial<PageBlockConfig>) => void;
  onSetHeader: (h: Partial<PageBlockConfig["header"]>) => void;
  onSetPres: (p: Partial<BlockPresentation>) => void;
  categories: Choice[];
  brands: Choice[];
  pickups: PickupChoice[];
}) {
  const { type, config: c } = block;
  const h = c.header ?? EMPTY_HEADER;
  const layout = c.layout;
  const hf = headerFields(type, layout);
  const layouts = PAGE_BLOCK_LAYOUTS[type];
  // Per-type média recommendations — matched to the aspect the RENDERER actually crops to:
  // a non-split hero frame is a wide 21:9 band at lg (split uses a 4:5 side image); the
  // editorial media box is a 4:5 portrait at every breakpoint.
  const recoDesktop =
    type === "hero"
      ? layout === "split" ? IMAGE_RECO.editorial_desktop : IMAGE_RECO.banner_desktop
      : type === "editorial" ? IMAGE_RECO.editorial_desktop : IMAGE_RECO.banner_desktop;
  const recoMobile =
    type === "hero"
      ? layout === "compact" ? "Paysage 16:9 — 1600×900 px"
        : layout === "centered" ? "Paysage 4:3 — 1600×1200 px"
        : IMAGE_RECO.hero_mobile // statement / split → 4:5 portrait
      : type === "editorial" ? "Portrait 4:5 — 1080×1350 px"
      : IMAGE_RECO.banner_mobile;
  // Keep the alt text only when the SAME image is re-picked — a new image needs its own.
  const img = (im: BlockImage | null | undefined, id: string | null): BlockImage | null =>
    id ? { mediaId: id, alt: im?.mediaId === id ? im.alt : "" } : null;
  // rich_text « auto » resolves like the renderer: split with a title, centred without.
  const rtLayout = type === "rich_text" ? (layout === "split" || (layout !== "centered" && h.title) ? "split" : "centered") : null;

  return (
    <>
      {layouts && (
        <Select label="Mise en page" value={layout ?? layouts[0].v} options={layouts} onChange={(v) => onSetConfig({ layout: v })} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {hf.eyebrow && <Field label="Surtitre (eyebrow)" value={h.eyebrow} onChange={(v) => onSetHeader({ eyebrow: v })} />}
        {hf.title && <Field label="Titre" value={h.title} onChange={(v) => onSetHeader({ title: v })} />}
        {hf.accent && (
          <Field label="Accent du titre (2ᵉ ligne en italique doré)" value={c.accent ?? ""} onChange={(v) => onSetConfig({ accent: v })} placeholder="est un souvenir." />
        )}
        {hf.subtitle && <Field label={type === "hero" ? "Sous-titre (italique)" : "Sous-titre / introduction"} value={h.subtitle} onChange={(v) => onSetHeader({ subtitle: v })} multiline={type !== "hero"} />}
        {hf.cta && (
          <div className="grid grid-cols-2 gap-2 sm:col-span-2">
            <Field label="Bouton — libellé" value={h.ctaLabel} onChange={(v) => onSetHeader({ ctaLabel: v })} />
            <Field label="Bouton — lien" value={h.ctaHref} onChange={(v) => onSetHeader({ ctaHref: v })} placeholder="/boutique ou #ancre" />
          </div>
        )}
      </div>

      {/* ── Images (hero / editorial / cta_band / banner / quote) ── */}
      {(type === "hero" || type === "editorial" || type === "cta_band" || type === "banner") && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ImageField label="Image (bureau)" reco={recoDesktop} value={c.image?.mediaId ?? null} onChange={(id) => onSetConfig({ image: img(c.image, id) })} />
          <ImageField label="Image (mobile, optionnelle)" reco={recoMobile} value={c.imageMobile?.mediaId ?? null} onChange={(id) => onSetConfig({ imageMobile: img(c.imageMobile, id) })} />
          {c.image && <Field label="Texte alternatif de l'image" value={c.image.alt} onChange={(v) => onSetConfig({ image: { ...c.image!, alt: v } })} placeholder="Décrivez l'image" />}
          {(type === "hero" || type === "editorial") && c.image && (
            <Select
              label="Cadrage"
              value={c.imageFit ?? "auto"}
              options={[
                { v: "auto", l: "Automatique (packshot → vitrine)" },
                { v: "cover", l: "Photo plein cadre" },
                { v: "contain", l: "Produit sur vitrine (sans recadrage)" },
              ]}
              onChange={(v) => onSetConfig({ imageFit: v as ImageFit })}
            />
          )}
        </div>
      )}

      {(type === "hero" || type === "editorial") && (
        <Field label={type === "hero" ? "Texte d'introduction" : "Texte"} value={c.body ?? ""} onChange={(v) => onSetConfig({ body: v })} multiline />
      )}
      {type === "hero" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Bouton secondaire — libellé" value={c.secondaryCtaLabel ?? ""} onChange={(v) => onSetConfig({ secondaryCtaLabel: v })} />
            <Field label="Bouton secondaire — lien" value={c.secondaryCtaHref ?? ""} onChange={(v) => onSetConfig({ secondaryCtaHref: v })} />
          </div>
          {layout === "statement" && (
            <Field label="Filigrane (grand chiffre en fond)" value={c.watermark ?? ""} onChange={(v) => onSetConfig({ watermark: v })} placeholder="1950" />
          )}
          {layout !== "centered" && layout !== undefined && (
            <ChipsEditor
              label={layout === "statement" ? "Sommaire (liens vers les ancres de la page)" : "Repères (puces)"}
              items={c.chips ?? []}
              onChange={(chips) => onSetConfig({ chips })}
            />
          )}
        </>
      )}

      {type === "editorial" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Côté de l'image" value={c.imageSide === "left" ? "left" : "right"} options={[{ v: "right", l: "Droite" }, { v: "left", l: "Gauche" }]} onChange={(v) => onSetConfig({ imageSide: v as "left" | "right" })} />
            <Field label="Chapitre (ex. III)" value={c.chapter ?? ""} onChange={(v) => onSetConfig({ chapter: v })} />
          </div>
          <PointsEditor items={c.points ?? []} onChange={(points) => onSetConfig({ points })} />
        </>
      )}

      {type === "quote" && (
        <>
          <Field label="Citation" value={c.body ?? ""} onChange={(v) => onSetConfig({ body: v })} multiline />
          <Field label="Signature" value={c.attribution ?? ""} onChange={(v) => onSetConfig({ attribution: v })} placeholder="La famille Tokyo · depuis 1950" />
          <ImageField label="Image de fond (optionnelle, assombrie)" reco={IMAGE_RECO.banner_desktop} value={c.image?.mediaId ?? null} onChange={(id) => onSetConfig({ image: img(c.image, id) })} />
        </>
      )}

      {type === "cta_band" && (
        <>
          <Select label="Style (sans image : barre)" value={c.style ?? "dark"} options={[{ v: "dark", l: "Onyx" }, { v: "light", l: "Greige clair" }, { v: "brand", l: "Olive (marque)" }]} onChange={(v) => onSetConfig({ style: v as "dark" | "light" | "brand" })} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Bouton secondaire — libellé" value={c.secondaryCtaLabel ?? ""} onChange={(v) => onSetConfig({ secondaryCtaLabel: v })} />
            <Field label="Bouton secondaire — lien" value={c.secondaryCtaHref ?? ""} onChange={(v) => onSetConfig({ secondaryCtaHref: v })} />
          </div>
        </>
      )}

      {type === "rich_text" && (
        <>
          {rtLayout === "split" && <Field label="Chapitre (ex. I) — grand chiffre doré au-dessus du titre" value={c.chapter ?? ""} onChange={(v) => onSetConfig({ chapter: v })} />}
          {/* submit={false}: the HTML is carried in the blocks JSON via onChange; don't POST it
              a second time as its own textarea field (payload bloat for large rich_text). */}
          <RichTextField name={`rt_${block.id}`} rows={8} label="Contenu" defaultValue={c.body ?? ""} onChange={(html) => onSetConfig({ body: html })} submit={false} />
          {rtLayout === "centered" && (
            <Select label="Alignement du texte" value={c.alignment ?? "left"} options={[{ v: "left", l: "Gauche" }, { v: "center", l: "Centré" }, { v: "right", l: "Droite" }]} onChange={(v) => onSetConfig({ alignment: v as "left" | "center" | "right" })} />
          )}
          <p className="text-[12px] leading-relaxed text-muted-foreground/80">
            Mises en forme disponibles dans le HTML : <code>&lt;p class=&quot;tk-lead&quot;&gt;</code> (lettrine),
            <code> tk-note</code> / <code>tk-note tk-note--warn</code> (encadré), <code>tk-key</code> (mise en avant),
            <code> &lt;dl class=&quot;tk-facts&quot;&gt;</code> (fiche), <code>tk-pullquote</code> (citation).
          </p>
        </>
      )}

      {(type === "timeline" || type === "trust") && (
        <Field label="Chapitre (ex. II) — grand chiffre doré au-dessus du titre" value={c.chapter ?? ""} onChange={(v) => onSetConfig({ chapter: v })} />
      )}
      {type === "stats" && <StatsEditor items={c.stats ?? []} onChange={(stats) => onSetConfig({ stats })} />}
      {type === "timeline" && <TimelineEditor items={c.timeline ?? []} onChange={(timeline) => onSetConfig({ timeline })} />}
      {type === "gallery" && <GalleryEditor images={c.images ?? []} onChange={(images) => onSetConfig({ images })} />}
      {(type === "fifty_fifty" || type === "feature_cards" || type === "trust") && (
        <CardsEditor type={type} layout={layout} cards={c.cards ?? []} onChange={(cards) => onSetConfig({ cards })} />
      )}
      {type === "steps" && <StepsEditor steps={c.steps ?? []} onChange={(steps) => onSetConfig({ steps })} />}
      {type === "faq" && (
        <>
          <Toggle label="Afficher la recherche + les filtres par thème (page Aide)" checked={c.faqSearch === true} onChange={(v) => onSetConfig({ faqSearch: v })} />
          <FaqEditor faq={c.faq ?? []} onChange={(faq) => onSetConfig({ faq })} />
        </>
      )}
      {type === "tiers" && <TiersEditor tiers={c.tiers ?? []} onChange={(tiers) => onSetConfig({ tiers })} />}
      {type === "checklist" && <ChecklistEditor columns={c.columns ?? []} onChange={(columns) => onSetConfig({ columns })} />}
      {type === "legal_doc" && <LegalDocEditor config={c} onSet={onSetConfig} />}
      {type === "contact_form" && <ContactFormEditor config={c} onSet={onSetConfig} />}
      {type === "apply_form" && <ApplyFormEditor config={c} onSet={onSetConfig} />}

      {type === "contact_channels" && (
        <>
          {(layout ?? "concierge") === "concierge" && (
            <Toggle label="Afficher les horaires et l'adresse sous l'introduction" checked={c.showMeta !== false} onChange={(v) => onSetConfig({ showMeta: v })} />
          )}
          <ChannelsEditor strip={layout === "strip"} channels={c.channels ?? []} onChange={(channels) => onSetConfig({ channels })} />
        </>
      )}
      {type === "stores" && (
        <>
          <Toggle label="Afficher la carte (Google Maps, d'après l'adresse)" checked={c.showMap !== false} onChange={(v) => onSetConfig({ showMap: v })} />
          <StoresEditor stores={c.stores ?? []} pickups={pickups} onChange={(stores) => onSetConfig({ stores })} />
        </>
      )}
      {type === "jobs" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="E-mail de candidature (vide = e-mail de contact du site)" value={c.applyEmail ?? ""} onChange={(v) => onSetConfig({ applyEmail: v })} placeholder="recrutement@…" />
            <Field label="Texte si aucun poste ouvert" value={c.emptyText ?? ""} onChange={(v) => onSetConfig({ emptyText: v })} />
          </div>
          <JobsEditor jobs={c.jobs ?? []} onChange={(jobs) => onSetConfig({ jobs })} />
          <div className="space-y-2 rounded-[16px] border border-border bg-[#fbf9f8] p-3">
            <Toggle label="Afficher l'encart « Candidature spontanée »" checked={c.spontaneousEnabled !== false} onChange={(v) => onSetConfig({ spontaneousEnabled: v })} />
            {c.spontaneousEnabled !== false && (
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label="Titre" value={c.spontaneousTitle ?? ""} onChange={(v) => onSetConfig({ spontaneousTitle: v })} placeholder="Candidature spontanée" />
                <Field label="Texte" value={c.spontaneousBody ?? ""} onChange={(v) => onSetConfig({ spontaneousBody: v })} placeholder="Votre profil ne correspond à aucun poste ?…" />
                <Field label="Bouton" value={c.spontaneousCtaLabel ?? ""} onChange={(v) => onSetConfig({ spontaneousCtaLabel: v })} placeholder="Envoyer ma candidature" />
              </div>
            )}
          </div>
        </>
      )}

      {type === "product_grid" && (
        <SourceEditor source={c.source ?? DEFAULT_SOURCE} count={c.count ?? 8} onSource={(source) => onSetConfig({ source })} onCount={(count) => onSetConfig({ count })} categories={categories} brands={brands} />
      )}
      {(type === "categories" || type === "brands") && (
        <RefsEditor
          label={type === "brands" ? "Marques" : "Catégories"}
          choices={type === "brands" ? brands : categories}
          selected={c.refs ?? []}
          onChange={(refs) => onSetConfig({ refs })}
          // parse always pre-fills count; the fallback matches the model default (categories/brands 12).
          count={c.count ?? 12}
          onCount={(count) => onSetConfig({ count })}
        />
      )}

      <PresentationEditor
        type={type}
        layout={layout}
        presentation={c.presentation ?? DEFAULT_PRESENTATION}
        anchor={c.anchor ?? ""}
        onChange={onSetPres}
        onAnchor={(anchor) => onSetConfig({ anchor })}
      />
    </>
  );
}

// ── Editors ────────────────────────────────────────────────────────────────────
// Width, spacing and separators are STANDARDISED site-wide (one 1400 column + rhythm;
// sections are separated by their background TONE, not hairlines), so the composer only
// exposes the tone, the head alignment (where honoured) and an optional anchor.
function PresentationEditor({
  type,
  layout,
  presentation,
  anchor,
  onChange,
  onAnchor,
}: {
  type: PageBlockType;
  layout: string | undefined;
  presentation: BlockPresentation;
  anchor: string;
  onChange: (p: Partial<BlockPresentation>) => void;
  onAnchor: (a: string) => void;
}) {
  return (
    <details className="rounded-[18px] border border-border bg-[#fbf9f8]">
      <summary className="cursor-pointer px-3 py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Présentation</summary>
      <div className="grid gap-3 p-3 sm:grid-cols-3">
        <Select label="Fond de la section" value={presentation.background} options={BLOCK_BACKGROUNDS.map((v) => ({ v, l: BG_LABELS[v] }))} onChange={(v) => onChange({ background: v as BlockPresentation["background"] })} />
        {alignAware(type, layout) && (
          <Select label="Alignement du titre" value={presentation.align} options={BLOCK_ALIGNS.map((v) => ({ v, l: v === "center" ? "Centré" : "Gauche" }))} onChange={(v) => onChange({ align: v as BlockPresentation["align"] })} />
        )}
        <div>
          <Field label="Ancre (#) — pour y faire un lien" value={anchor} onChange={onAnchor} placeholder="sav" />
          {anchor.trim() && (
            <p className="mt-1 text-[12px] text-muted-foreground">
              {coerceAnchor(anchor) ? <>Lien vers cette section : <code>#{coerceAnchor(anchor)}</code></> : "Ancre invalide — utilisez lettres, chiffres et tirets."}
            </p>
          )}
        </div>
      </div>
      <p className="px-3 pb-3 text-[12px] leading-relaxed text-muted-foreground/70">
        La largeur et l&apos;espacement sont standardisés (même colonne que l&apos;en-tête du site) —
        distinguez les sections en alternant leur <strong>fond</strong>. Une ancre « sav » permet un
        lien <code>#sav</code> depuis un bouton, une tuile ou le sommaire de l&apos;en-tête.
      </p>
    </details>
  );
}

function ChipsEditor({ label, items, onChange }: { label: string; items: ChipItem[]; onChange: (i: ChipItem[]) => void }) {
  const upd = (i: number, p: Partial<ChipItem>) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label={label} count={items.length} max={6} onAdd={() => onChange([...items, { label: "", href: "" }])}>
      {items.map((it, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(items.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(items, i, d))}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Libellé" value={it.label} onChange={(v) => upd(i, { label: v })} />
            <Field label="Lien (optionnel)" value={it.href} onChange={(v) => upd(i, { href: v })} placeholder="#heritage" />
          </div>
        </Row>
      ))}
    </ListEditor>
  );
}

function PointsEditor({ items, onChange }: { items: PointItem[]; onChange: (i: PointItem[]) => void }) {
  const upd = (i: number, p: Partial<PointItem>) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Points clés (numérotés)" count={items.length} max={6} onAdd={() => onChange([...items, { title: "", body: "" }])}>
      {items.map((it, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(items.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(items, i, d))}>
          <Field label="Titre" value={it.title} onChange={(v) => upd(i, { title: v })} />
          <Field label="Texte" value={it.body} onChange={(v) => upd(i, { body: v })} multiline />
        </Row>
      ))}
    </ListEditor>
  );
}

function StatsEditor({ items, onChange }: { items: StatItem[]; onChange: (i: StatItem[]) => void }) {
  const upd = (i: number, p: Partial<StatItem>) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Chiffres" count={items.length} max={8} onAdd={() => onChange([...items, { label: "", value: "", caption: "", source: "manual", since: "" }])}>
      {items.map((it, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(items.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(items, i, d))}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select
              label="Source de la valeur"
              value={it.source}
              options={[
                { v: "manual", l: "Saisie manuelle" },
                { v: "brands", l: "En direct — nombre de marques actives" },
                { v: "years_since", l: "En direct — années depuis une date" },
              ]}
              onChange={(v) => upd(i, { source: v as StatItem["source"] })}
            />
            {it.source === "years_since" && <Field label="Année de départ" value={it.since} onChange={(v) => upd(i, { since: v })} placeholder="1950" />}
            <Field label={it.source === "manual" ? "Valeur" : "Valeur de secours"} value={it.value} onChange={(v) => upd(i, { value: v })} placeholder="1950" />
            <Field label="Libellé" value={it.label} onChange={(v) => upd(i, { label: v })} placeholder="de savoir-faire" />
            <Field label="Légende" value={it.caption} onChange={(v) => upd(i, { caption: v })} />
          </div>
        </Row>
      ))}
    </ListEditor>
  );
}

function TimelineEditor({ items, onChange }: { items: { year: string; title: string; description: string }[]; onChange: (i: { year: string; title: string; description: string }[]) => void }) {
  const upd = (i: number, p: Partial<{ year: string; title: string; description: string }>) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Étapes" count={items.length} max={20} onAdd={() => onChange([...items, { year: "", title: "", description: "" }])}>
      {items.map((it, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(items.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(items, i, d))}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Année" value={it.year} onChange={(v) => upd(i, { year: v })} placeholder="1950" />
            <Field label="Titre" value={it.title} onChange={(v) => upd(i, { title: v })} />
          </div>
          <Field label="Description" value={it.description} onChange={(v) => upd(i, { description: v })} multiline />
        </Row>
      ))}
    </ListEditor>
  );
}

function GalleryEditor({ images, onChange }: { images: BlockImage[]; onChange: (i: BlockImage[]) => void }) {
  return (
    <ListEditor label="Images" count={images.length} max={24} onAdd={() => onChange([...images, { mediaId: "", alt: "" }])}>
      {images.map((im, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(images.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(images, i, d))}>
          <ImageField label="Image" reco={IMAGE_RECO.square} value={im.mediaId || null} onChange={(id) => onChange(images.map((x, j) => (j === i ? { ...x, mediaId: id ?? "" } : x)))} />
          <Field label="Texte alternatif" value={im.alt} onChange={(v) => onChange(images.map((x, j) => (j === i ? { ...x, alt: v } : x)))} />
        </Row>
      ))}
    </ListEditor>
  );
}

function CardsEditor({ type, layout, cards, onChange }: { type: PageBlockType; layout: string | undefined; cards: BlockCard[]; onChange: (c: BlockCard[]) => void }) {
  const max = type === "fifty_fifty" ? 3 : type === "feature_cards" ? 4 : 8;
  const upd = (i: number, p: Partial<BlockCard>) => onChange(cards.map((x, j) => (j === i ? { ...x, ...p } : x)));
  // Only expose the fields each card variant renders (page-blocks-render.tsx):
  //   fifty_fifty  → eyebrow, title, body, CTA link, image
  //   feature_cards → eyebrow, title, body, meta (price/badge)
  //   trust        → title, body, icon (+ link & link label for « tuiles », no icon for « numérotées »)
  const isTrust = type === "trust";
  const showEyebrow = !isTrust;
  const showMeta = type === "feature_cards";
  const showCta = type === "fifty_fifty" || (isTrust && layout === "tiles");
  const showCtaLabel = isTrust && layout === "tiles";
  const showImage = type === "fifty_fifty";
  const showIcon = isTrust && layout !== "numbered";
  return (
    <ListEditor label="Cartes" count={cards.length} max={max} onAdd={() => onChange([...cards, EMPTY_CARD()])}>
      {cards.map((card, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(cards.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(cards, i, d))}>
          <div className="grid gap-2 sm:grid-cols-2">
            {showEyebrow && <Field label="Surtitre / tag" value={card.eyebrow} onChange={(v) => upd(i, { eyebrow: v })} />}
            <Field label="Titre" value={card.title} onChange={(v) => upd(i, { title: v })} />
            <Field label="Texte" value={card.body} onChange={(v) => upd(i, { body: v })} multiline />
            {showMeta && <Field label="Mention dorée (prix / badge)" value={card.meta} onChange={(v) => upd(i, { meta: v })} />}
            {showCta && <Field label="Lien" value={card.ctaHref} onChange={(v) => upd(i, { ctaHref: v })} placeholder="/suivi-de-commande ou #sav" />}
            {showCtaLabel && <Field label="Libellé du lien" value={card.ctaLabel} onChange={(v) => upd(i, { ctaLabel: v })} placeholder="Accéder" />}
            {showIcon && (
              <Select
                label="Icône"
                value={card.icon || "Sparkles"}
                options={VALUE_PROP_ICONS.map((o) => ({ v: o.key, l: o.label }))}
                onChange={(v) => upd(i, { icon: v })}
              />
            )}
          </div>
          {showImage && (
            <ImageField label="Image" reco="Paysage 4:3 — 1200×900 px" value={card.image?.mediaId ?? null} onChange={(id) => upd(i, { image: id ? { mediaId: id, alt: card.image?.mediaId === id ? card.image.alt : "" } : null })} />
          )}
        </Row>
      ))}
    </ListEditor>
  );
}

function StepsEditor({ steps, onChange }: { steps: StepItem[]; onChange: (s: StepItem[]) => void }) {
  const upd = (i: number, p: Partial<StepItem>) => onChange(steps.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Étapes" count={steps.length} max={8} onAdd={() => onChange([...steps, { title: "", body: "", meta: "" }])}>
      {steps.map((s, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(steps.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(steps, i, d))}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Titre" value={s.title} onChange={(v) => upd(i, { title: v })} />
            <Field label="Repère (pastille, optionnel)" value={s.meta} onChange={(v) => upd(i, { meta: v })} placeholder="En boutique" />
          </div>
          <Field label="Texte" value={s.body} onChange={(v) => upd(i, { body: v })} multiline />
        </Row>
      ))}
    </ListEditor>
  );
}

const EMPTY_FAQ = (): PageFaqItem => ({ question: "", answer: "", topic: "", linkLabel: "", linkHref: "" });
function FaqEditor({ faq, onChange }: { faq: PageFaqItem[]; onChange: (f: PageFaqItem[]) => void }) {
  const upd = (i: number, p: Partial<PageFaqItem>) => onChange(faq.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Questions" count={faq.length} max={30} onAdd={() => onChange([...faq, EMPTY_FAQ()])}>
      {faq.map((q, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(faq.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(faq, i, d))}>
          <Field label="Question" value={q.question} onChange={(v) => upd(i, { question: v })} />
          <Field label="Réponse" value={q.answer} onChange={(v) => upd(i, { answer: v })} multiline />
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Thème (filtre)" value={q.topic} onChange={(v) => upd(i, { topic: v })} placeholder="livraison" />
            <Field label="Lien — libellé (optionnel)" value={q.linkLabel} onChange={(v) => upd(i, { linkLabel: v })} placeholder="En savoir plus" />
            <Field label="Lien — URL (optionnel)" value={q.linkHref} onChange={(v) => upd(i, { linkHref: v })} placeholder="/livraison" />
          </div>
        </Row>
      ))}
    </ListEditor>
  );
}

// ── tiers / checklist / legal_doc / contact_form / apply_form editors ────────────
function TiersEditor({ tiers, onChange }: { tiers: TierItem[]; onChange: (t: TierItem[]) => void }) {
  const upd = (i: number, p: Partial<TierItem>) => onChange(tiers.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const EMPTY: TierItem = { eyebrow: "", value: "", unit: "", body: "", tone: "light", icon: "ShieldCheck" };
  return (
    <ListEditor label="Paliers" count={tiers.length} max={4} onAdd={() => onChange([...tiers, { ...EMPTY }])}>
      {tiers.map((t, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(tiers.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(tiers, i, d))}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Surtitre" value={t.eyebrow} onChange={(v) => upd(i, { eyebrow: v })} placeholder="Produits neufs" />
            <Field label="Valeur (grand chiffre ou mot)" value={t.value} onChange={(v) => upd(i, { value: v })} placeholder="12" />
            <Field label="Unité (ex. mois — vide pour un mot)" value={t.unit} onChange={(v) => upd(i, { unit: v })} placeholder="mois" />
            <Select label="Ton" value={t.tone} options={TIER_TONES.map((v) => ({ v, l: v === "light" ? "Clair" : v === "dark" ? "Sombre" : "Marque" }))} onChange={(v) => upd(i, { tone: v as TierItem["tone"] })} />
            <Select label="Icône" value={t.icon || "ShieldCheck"} options={VALUE_PROP_ICONS.map((o) => ({ v: o.key, l: o.label }))} onChange={(v) => upd(i, { icon: v })} />
          </div>
          <Field label="Texte" value={t.body} onChange={(v) => upd(i, { body: v })} multiline />
        </Row>
      ))}
    </ListEditor>
  );
}

function ChecklistEditor({ columns, onChange }: { columns: ChecklistColumn[]; onChange: (c: ChecklistColumn[]) => void }) {
  const upd = (i: number, p: Partial<ChecklistColumn>) => onChange(columns.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const EMPTY: ChecklistColumn = { title: "", variant: "include", items: [] };
  return (
    <ListEditor label="Colonnes" count={columns.length} max={3} onAdd={() => onChange([...columns, { ...EMPTY }])}>
      {columns.map((col, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(columns.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(columns, i, d))}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Titre" value={col.title} onChange={(v) => upd(i, { title: v })} placeholder="Conditions" />
            <Select label="Type" value={col.variant} options={[{ v: "include", l: "Inclus ✓" }, { v: "exclude", l: "Exclus ✗" }]} onChange={(v) => upd(i, { variant: v as ChecklistColumn["variant"] })} />
          </div>
          <LinesField label="Points (un par ligne)" values={col.items} onChange={(items) => upd(i, { items })} max={12} />
        </Row>
      ))}
    </ListEditor>
  );
}

function FactsEditor({ facts, onChange }: { facts: FactItem[]; onChange: (f: FactItem[]) => void }) {
  const upd = (i: number, p: Partial<FactItem>) => onChange(facts.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Identité (table des mentions)" count={facts.length} max={16} onAdd={() => onChange([...facts, { label: "", value: "", pending: false }])}>
      {facts.map((f, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(facts.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(facts, i, d))}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Libellé" value={f.label} onChange={(v) => upd(i, { label: v })} placeholder="Matricule fiscal" />
            <Field label="Valeur" value={f.value} onChange={(v) => upd(i, { value: v })} placeholder="À compléter" />
          </div>
          <Toggle label="À compléter (surligné en ambre)" checked={f.pending} onChange={(v) => upd(i, { pending: v })} />
        </Row>
      ))}
    </ListEditor>
  );
}

function LegalSectionsEditor({ sections, onChange }: { sections: LegalSection[]; onChange: (s: LegalSection[]) => void }) {
  const upd = (i: number, p: Partial<LegalSection>) => onChange(sections.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Sections (numérotées)" count={sections.length} max={30} onAdd={() => onChange([...sections, { heading: "", body: [] }])}>
      {sections.map((s, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(sections.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(sections, i, d))}>
          <Field label="Titre de la section" value={s.heading} onChange={(v) => upd(i, { heading: v })} />
          <LinesField label="Paragraphes (un par ligne)" values={s.body} onChange={(body) => upd(i, { body })} max={12} />
        </Row>
      ))}
    </ListEditor>
  );
}

function CookiePrefsEditor({ prefs, onChange }: { prefs: CookieCategory[]; onChange: (c: CookieCategory[]) => void }) {
  const upd = (i: number, p: Partial<CookieCategory>) => onChange(prefs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const slugify = (s: string) => coerceAnchor(s) || "cat";
  return (
    <ListEditor label="Préférences cookies" count={prefs.length} max={8} onAdd={() => onChange([...prefs, { key: "", label: "", description: "", locked: false }])}>
      {prefs.map((c, i) => (
        <Row key={i} n={i + 1} onDel={() => onChange(prefs.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(prefs, i, d))}>
          <Field label="Nom" value={c.label} onChange={(v) => upd(i, { label: v, key: c.key || slugify(v) })} placeholder="Mesure d'audience" />
          <Field label="Description" value={c.description} onChange={(v) => upd(i, { description: v })} multiline />
          <Toggle label="Toujours actif (non désactivable)" checked={c.locked} onChange={(v) => upd(i, { locked: v })} />
        </Row>
      ))}
    </ListEditor>
  );
}

function LegalDocEditor({ config, onSet }: { config: PageBlockConfig; onSet: (c: Partial<PageBlockConfig>) => void }) {
  return (
    <div className="space-y-3">
      <Toggle label="Afficher le sommaire (table des matières)" checked={config.showToc !== false} onChange={(v) => onSet({ showToc: v })} />
      <Field label="Note de rédaction (ambre « à compléter », optionnelle)" value={config.draftNote ?? ""} onChange={(v) => onSet({ draftNote: v })} multiline />
      <FactsEditor facts={config.facts ?? []} onChange={(facts) => onSet({ facts })} />
      <LegalSectionsEditor sections={config.sections ?? []} onChange={(sections) => onSet({ sections })} />
      <CookiePrefsEditor prefs={config.cookiePrefs ?? []} onChange={(cookiePrefs) => onSet({ cookiePrefs })} />
    </div>
  );
}

function ContactFormEditor({ config, onSet }: { config: PageBlockConfig; onSet: (c: Partial<PageBlockConfig>) => void }) {
  return (
    <div className="space-y-3">
      <CsvField label="Sujets (séparés par des virgules)" values={config.subjects ?? []} onChange={(subjects) => onSet({ subjects })} placeholder="Commande, Retour, SAV, Produit, Autre" />
      <Toggle label="Afficher le champ « N° de commande »" checked={config.showOrderField !== false} onChange={(v) => onSet({ showOrderField: v })} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Confirmation — titre" value={config.successTitle ?? ""} onChange={(v) => onSet({ successTitle: v })} placeholder="Message envoyé" />
        <Field label="Confirmation — texte" value={config.successBody ?? ""} onChange={(v) => onSet({ successBody: v })} placeholder="Nous vous répondons sous 24h ouvrées." />
      </div>
    </div>
  );
}

function ApplyFormEditor({ config, onSet }: { config: PageBlockConfig; onSet: (c: Partial<PageBlockConfig>) => void }) {
  return (
    <div className="space-y-3">
      <CsvField label="Postes proposés (« Candidature spontanée » ajoutée automatiquement)" values={config.jobOptions ?? []} onChange={(jobOptions) => onSet({ jobOptions })} placeholder="Conseiller, Technicien, …" max={20} />
      <Field label="Mention de consentement (RGPD)" value={config.consentText ?? ""} onChange={(v) => onSet({ consentText: v })} multiline />
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Confirmation — titre" value={config.successTitle ?? ""} onChange={(v) => onSet({ successTitle: v })} placeholder="Candidature envoyée" />
        <Field label="Confirmation — texte" value={config.successBody ?? ""} onChange={(v) => onSet({ successBody: v })} placeholder="Merci ! Un e-mail de confirmation vient de vous être envoyé." />
      </div>
    </div>
  );
}

function ChannelsEditor({ channels, onChange, strip }: { channels: ContactChannel[]; onChange: (c: ContactChannel[]) => void; strip: boolean }) {
  // Show every channel (append the ones missing from a stored list, disabled) so the
  // operator can switch any of them on and reorder freely.
  const present = new Set(channels.map((c) => c.key));
  const list: ContactChannel[] = [
    ...channels,
    ...CONTACT_CHANNEL_KEYS.filter((k) => !present.has(k)).map((key) => ({ key, enabled: false, label: "", note: "", href: "" })),
  ];
  const upd = (i: number, p: Partial<ContactChannel>) => onChange(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Canaux</p>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Le numéro, le WhatsApp, l&apos;e-mail, les horaires et l&apos;adresse viennent de{" "}
        <a href="/admin/cms/settings" className="underline">Identité &amp; contact</a> — un canal dont la valeur
        n&apos;est pas renseignée n&apos;est pas affiché.
      </p>
      {list.map((ch, i) => (
        <Row key={ch.key} n={i + 1} title={CONTACT_CHANNEL_LABELS[ch.key]} onMove={(d) => onChange(moveItem(list, i, d))}>
          <Toggle label="Afficher ce canal" checked={ch.enabled} onChange={(v) => upd(i, { enabled: v })} />
          {ch.enabled && (
            <div className="grid gap-2 sm:grid-cols-3">
              <Field
                label={strip ? "Texte du bouton (optionnel)" : "Libellé (optionnel)"}
                value={ch.label}
                onChange={(v) => upd(i, { label: v })}
                placeholder={strip ? (ch.key === "phone" ? "Par défaut : le numéro" : ch.key === "email" ? "Nous écrire" : CONTACT_CHANNEL_LABELS[ch.key]) : CONTACT_CHANNEL_LABELS[ch.key]}
              />
              {!strip && (
                <Field
                  label={ch.key === "stores" || ch.key === "help" ? "Texte affiché" : "Ligne d'aide (optionnelle)"}
                  value={ch.note}
                  onChange={(v) => upd(i, { note: v })}
                  placeholder={ch.key === "phone" ? "Par défaut : les horaires" : ch.key === "stores" ? "3 adresses à Sfax" : ""}
                />
              )}
              {(ch.key === "stores" || ch.key === "help") && (
                <Field label="Lien" value={ch.href} onChange={(v) => upd(i, { href: v })} placeholder={ch.key === "stores" ? "/nos-boutiques" : "/help"} />
              )}
            </div>
          )}
        </Row>
      ))}
    </div>
  );
}

const EMPTY_STORE = (): StoreItem => ({
  name: "", badge: "", address: "", city: "", phone: "", email: "", hours: [], services: [], note: "", mapEmbedUrl: "", image: null, pickupLocationId: "",
});

function StoresEditor({ stores, pickups, onChange }: { stores: StoreItem[]; pickups: PickupChoice[]; onChange: (s: StoreItem[]) => void }) {
  const upd = (i: number, p: Partial<StoreItem>) => onChange(stores.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Boutiques" count={stores.length} max={12} onAdd={() => onChange([...stores, EMPTY_STORE()])}>
      {stores.map((s, i) => (
        <Row key={i} n={i + 1} title={s.name || undefined} onDel={() => onChange(stores.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(stores, i, d))}>
          {/* Show the picker whenever a link is set (even if no pickups exist any more) so a
              stale id stays visible/clearable, with a « introuvable » option for a missing one. */}
          {(pickups.length > 0 || s.pickupLocationId) && (
            <Select
              label="Lier à un point de retrait (Livraison) — ses nom, adresse, téléphone et horaires priment"
              value={s.pickupLocationId}
              options={[
                { v: "", l: "— Aucun (saisie libre ci-dessous) —" },
                ...pickups.map((p) => ({ v: p.id, l: p.enabled ? p.name : `${p.name} (désactivé)` })),
                ...(s.pickupLocationId && !pickups.some((p) => p.id === s.pickupLocationId)
                  ? [{ v: s.pickupLocationId, l: "Point de retrait introuvable" }]
                  : []),
              ]}
              onChange={(v) => upd(i, { pickupLocationId: v })}
            />
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Nom" value={s.name} onChange={(v) => upd(i, { name: v })} />
            <Field label="Mention (ex. Boutique principale)" value={s.badge} onChange={(v) => upd(i, { badge: v })} />
            <Field label="Adresse" value={s.address} onChange={(v) => upd(i, { address: v })} />
            <Field label="Ville" value={s.city} onChange={(v) => upd(i, { city: v })} placeholder="Sfax" />
            <Field label="Téléphone (vide = celui du site)" value={s.phone} onChange={(v) => upd(i, { phone: v })} />
            <Field label="E-mail (optionnel)" value={s.email} onChange={(v) => upd(i, { email: v })} placeholder="boutique@…" />
            <CsvField label="Services (séparés par des virgules)" values={s.services} max={8} onChange={(services) => upd(i, { services })} placeholder="Essai & conseil, Réparation & accessoires" />
          </div>
          <HoursEditor hours={s.hours} onChange={(hours) => upd(i, { hours })} />
          <Field label="Note (optionnelle)" value={s.note} onChange={(v) => upd(i, { note: v })} multiline />
          <Field
            label="URL d'intégration Google Maps (optionnelle — sinon carte d'après l'adresse)"
            value={s.mapEmbedUrl}
            onChange={(v) => upd(i, { mapEmbedUrl: v })}
            placeholder="https://www.google.com/maps/embed?pb=…"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <ImageField label="Photo de la boutique (optionnelle)" reco="Paysage 16:9 — 2400×1350 px (recadrée en 4:3 dans la disposition « Salons »)" value={s.image?.mediaId ?? null} onChange={(id) => upd(i, { image: id ? { mediaId: id, alt: s.image?.mediaId === id ? s.image.alt : "" } : null })} />
            {s.image && <Field label="Texte alternatif de la photo" value={s.image.alt} onChange={(v) => upd(i, { image: { ...s.image!, alt: v } })} placeholder={`Boutique ${s.name}`} />}
          </div>
        </Row>
      ))}
    </ListEditor>
  );
}

function HoursEditor({ hours, onChange }: { hours: { label: string; value: string }[]; onChange: (h: { label: string; value: string }[]) => void }) {
  const upd = (i: number, p: Partial<{ label: string; value: string }>) => onChange(hours.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-1.5 rounded-[14px] border border-input bg-[#fbf9f8] p-2">
      <p className="text-[12px] text-muted-foreground">Horaires (vide = ceux du site)</p>
      {hours.map((hh, i) => (
        <div key={i} className="flex items-end gap-2">
          <Field label="Jours" value={hh.label} onChange={(v) => upd(i, { label: v })} placeholder="Lundi – Samedi" />
          <Field label="Heures" value={hh.value} onChange={(v) => upd(i, { value: v })} placeholder="9h – 18h" />
          <IconBtn title="Supprimer" onClick={() => onChange(hours.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5 text-destructive" /></IconBtn>
        </div>
      ))}
      {hours.length < 8 && (
        <button type="button" onClick={() => onChange([...hours, { label: "", value: "" }])} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
          <Plus className="h-3 w-3" /> Ajouter une ligne
        </button>
      )}
    </div>
  );
}

const EMPTY_JOB = (): JobItem => ({ title: "", team: "", location: "", contract: "", summary: "", missions: "", profile: "", applyHref: "", active: true });

function JobsEditor({ jobs, onChange }: { jobs: JobItem[]; onChange: (j: JobItem[]) => void }) {
  const upd = (i: number, p: Partial<JobItem>) => onChange(jobs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <ListEditor label="Postes" count={jobs.length} max={20} onAdd={() => onChange([...jobs, EMPTY_JOB()])}>
      {jobs.map((job, i) => (
        <Row key={i} n={i + 1} title={job.title || undefined} onDel={() => onChange(jobs.filter((_, j) => j !== i))} onMove={(d) => onChange(moveItem(jobs, i, d))}>
          <Toggle label="Poste ouvert (visible sur le site)" checked={job.active} onChange={(v) => upd(i, { active: v })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Intitulé" value={job.title} onChange={(v) => upd(i, { title: v })} />
            <Field label="Équipe (sert de filtre)" value={job.team} onChange={(v) => upd(i, { team: v })} placeholder="Boutique" />
            <Field label="Lieu" value={job.location} onChange={(v) => upd(i, { location: v })} placeholder="Sfax" />
            <Field label="Contrat (optionnel)" value={job.contract} onChange={(v) => upd(i, { contract: v })} placeholder="CDI · temps plein" />
          </div>
          <Field label="Résumé" value={job.summary} onChange={(v) => upd(i, { summary: v })} multiline />
          <Field
            label="Lien de candidature (optionnel — sinon l'e-mail ci-dessus)"
            value={job.applyHref}
            onChange={(v) => upd(i, { applyHref: v })}
            placeholder="https://… (offre externe / formulaire) ou mailto:recrutement@…"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Missions (détail)" value={job.missions} onChange={(v) => upd(i, { missions: v })} multiline />
            <Field label="Profil recherché (détail)" value={job.profile} onChange={(v) => upd(i, { profile: v })} multiline />
          </div>
        </Row>
      ))}
    </ListEditor>
  );
}

function SourceEditor({ source, count, onSource, onCount, categories, brands }: { source: ProductSource; count: number; onSource: (s: ProductSource) => void; onCount: (n: number) => void; categories: Choice[]; brands: Choice[] }) {
  const modeLabels: Record<string, string> = { new: "Nouveautés", best_sellers: "Meilleures ventes", on_promotion: "En promotion", category: "Catégorie", brand: "Marque", manual: "Sélection manuelle" };
  const refChoices = source.mode === "category" ? categories : source.mode === "brand" ? brands : [];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Select label="Source des produits" value={source.mode} options={PRODUCT_SOURCE_MODES.map((m) => ({ v: m, l: modeLabels[m] }))} onChange={(v) => onSource({ ...source, mode: v as ProductSource["mode"], ref: "" })} />
      <NumberField label="Nombre" value={count} min={2} max={24} onChange={onCount} />
      {source.mode === "best_sellers" && (
        // windowDays IS consumed for best_sellers (getTopSellingProducts) — surface it so the
        // ranking window is operator-controlled instead of pinned to the 30-day default.
        <NumberField label="Période des ventes (jours)" value={source.windowDays} min={1} max={365} onChange={(n) => onSource({ ...source, windowDays: n })} />
      )}
      {(source.mode === "category" || source.mode === "brand") && (
        <Select
          label="Cible"
          value={source.ref}
          // Keep a deactivated/renamed target visible as « … — introuvable » instead of blanking it.
          options={[
            { v: "", l: "— choisir —" },
            ...refChoices.map((x) => ({ v: x.slug, l: x.name })),
            ...(source.ref && !refChoices.some((x) => x.slug === source.ref) ? [{ v: source.ref, l: `${source.ref} — introuvable` }] : []),
          ]}
          onChange={(v) => onSource({ ...source, ref: v })}
        />
      )}
      {/* CsvField keeps the raw text while typing (a plain join/split Field ate commas mid-type
          so you could never enter a second id) and commits the split list on blur/Enter. */}
      {source.mode === "manual" && (
        <CsvField label="IDs produits (séparés par des virgules)" values={source.productIds} max={50} onChange={(productIds) => onSource({ ...source, productIds })} placeholder="uuid, uuid, …" />
      )}
    </div>
  );
}

function RefsEditor({ label, choices, selected, onChange, count, onCount }: { label: string; choices: Choice[]; selected: string[]; onChange: (r: string[]) => void; count: number; onCount: (n: number) => void }) {
  const toggle = (slug: string) => onChange(selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">{label} en vedette</p>
        <NumberField label="Max" value={count} min={2} max={40} onChange={onCount} />
      </div>
      <p className="text-[12px] text-muted-foreground">Laisser vide = tout (automatique).</p>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((ch) => (
          <button key={ch.slug} type="button" onClick={() => toggle(ch.slug)} className={`rounded-full border-[1.5px] px-2.5 py-1 text-[12px] font-semibold ${selected.includes(ch.slug) ? "border-primary bg-[#fdecef] text-[#d40530]" : "border-input bg-card text-muted-foreground hover:bg-surface"}`}>
            {ch.name}
          </button>
        ))}
        {choices.length === 0 && <span className="text-[12px] text-muted-foreground">Aucun élément disponible.</span>}
      </div>
    </div>
  );
}

// ── UI atoms ────────────────────────────────────────────────────────────────────
function moveItem<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function ListEditor({ label, count, max, onAdd, children }: { label: string; count: number; max: number; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">{label} ({count}/{max})</p>
      {children}
      {count < max && (
        <button type="button" onClick={onAdd} className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-2 text-[13px] font-bold hover:bg-surface">
          <Plus className="h-3.5 w-3.5" /> Ajouter
        </button>
      )}
    </div>
  );
}

function Row({ n, title, onDel, onMove, children }: { n: number; title?: string; onDel?: () => void; onMove?: (dir: -1 | 1) => void; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-[16px] border border-border bg-[#fbf9f8] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">#{n}{title ? ` · ${title}` : ""}</span>
        <div className="flex items-center gap-1">
          {onMove && (
            <>
              <IconBtn title="Monter" onClick={() => onMove(-1)}><ArrowUp className="h-3.5 w-3.5" /></IconBtn>
              <IconBtn title="Descendre" onClick={() => onMove(1)}><ArrowDown className="h-3.5 w-3.5" /></IconBtn>
            </>
          )}
          {onDel && <IconBtn title="Supprimer" onClick={onDel}><Trash2 className="h-3.5 w-3.5 text-destructive" /></IconBtn>}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * A comma-separated list input that keeps the RAW text while typing (so commas and
 * spaces aren't eaten mid-word) and commits the cleaned list on blur / Enter. It
 * re-syncs if the list changes from outside (reorder, delete).
 */
function CsvField({ label, values, onChange, placeholder, max = 8 }: { label: string; values: string[]; onChange: (v: string[]) => void; placeholder?: string; max?: number }) {
  const joined = values.join(", ");
  const [raw, setRaw] = useState(joined);
  const [synced, setSynced] = useState(joined);
  if (joined !== synced) {
    setSynced(joined);
    setRaw(joined);
  }
  const commit = () => {
    const next = raw.split(",").map((x) => x.trim()).filter(Boolean).slice(0, max);
    if (next.join(", ") !== joined) onChange(next);
    else setRaw(joined);
  };
  return (
    <label className="block min-w-0 flex-1">
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      <input
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={placeholder}
        className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] outline-none transition focus:border-foreground focus:bg-white"
      />
    </label>
  );
}

/** A multi-line string[] editor (ONE item per line) — for values that contain commas
 *  (legal paragraphs, checklist points), where CsvField's comma split would break them. */
function LinesField({ label, values, onChange, placeholder, max = 20 }: { label: string; values: string[]; onChange: (v: string[]) => void; placeholder?: string; max?: number }) {
  const joined = values.join("\n");
  const [raw, setRaw] = useState(joined);
  const [synced, setSynced] = useState(joined);
  if (joined !== synced) {
    setSynced(joined);
    setRaw(joined);
  }
  const commit = () => {
    const next = raw.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, max);
    if (next.join("\n") !== joined) onChange(next);
    else setRaw(joined);
  };
  return (
    <label className="block min-w-0 flex-1">
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        placeholder={placeholder}
        rows={4}
        className="w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 text-[15px] outline-none transition focus:border-foreground focus:bg-white"
      />
    </label>
  );
}

function IconBtn({ title, onClick, children, disabled }: { title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className="grid h-7 w-7 place-items-center rounded-[10px] border border-input bg-card hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-card">
      {children}
    </button>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded-[4px] border-input accent-[var(--primary)]" />
      {label}
    </label>
  );
}

function Field({ label, value, onChange, placeholder, multiline }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  return (
    <label className="block min-w-0 flex-1">
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={3} className="w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 text-[15px] outline-none transition focus:border-foreground focus:bg-white" />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] outline-none transition focus:border-foreground focus:bg-white" />
      )}
    </label>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  // Hold a transient draft WHILE editing so the field can be cleared/retyped without snapping
  // to min on every keystroke; commit (clamp) on blur AND on Enter — the latter so an implicit
  // form submit (Enter) persists the typed value instead of dropping it — reverting to the last
  // good value if empty.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) {
      const n = Number(draft);
      onChange(draft.trim() !== "" && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : value);
      setDraft(null);
    }
  };
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      <input
        type="number"
        value={draft ?? String(value)}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="h-11 w-20 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] outline-none transition focus:border-foreground focus:bg-white"
      />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: { v: string; l: string }[]; onChange: (v: string) => void }) {
  return <UiSelect label={label} value={value} options={options.map((o) => ({ value: o.v, label: o.l }))} onChange={onChange} />;
}

function ImageField({ label, value, onChange, reco }: { label: string; value: string | null; onChange: (id: string | null) => void; reco?: string }) {
  return (
    <div>
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      <MediaPicker key={value ?? "empty"} name="img" value={value} onChange={onChange} scope="cms" emptyLabel="Choisir une image" />
      {reco && <p className="mt-1 text-[12px] leading-snug text-muted-foreground/70">Recommandé : {reco}</p>}
    </div>
  );
}

function EMPTY_CARD(): BlockCard {
  return { eyebrow: "", title: "", body: "", meta: "", ctaLabel: "", ctaHref: "", image: null, icon: "" };
}
