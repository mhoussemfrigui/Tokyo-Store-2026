import {
  FileText,
  HelpCircle,
  Image as ImageIcon,
  Layers,
  type LucideIcon,
  Menu,
  Package,
  Settings,
  Tag,
  FolderTree,
} from "lucide-react";

// Import from the schema submodule, NOT the @/modules/import barrel: the barrel
// re-exports the server-only importJobService, so a VALUE import like
// DATA_SEGMENTS would drag the DB client into this client bundle (build fails
// with a "server-only" chunk error). schema.ts is pure table/const defs.
import { DATA_SEGMENTS, type DataSegment } from "@/modules/import/schema";

/**
 * Shared client metadata for the data-jobs UI (segmented import + cleanup).
 *
 * ONE place for the FR label + lucide icon of every content segment, consumed
 * by `DataJobsPanel` (segmented button grid + job-list titles) on the import-demo
 * page.
 *
 * `DATA_SEGMENTS` is the canonical list from the backend module; `"all"` is the
 * fan-out pseudo-segment (every segment at once) and is handled here too.
 */

export type SegmentMeta = { label: string; icon: LucideIcon };

/** FR label + icon per segment, plus the `"all"` fan-out. */
export const SEGMENT_META: Record<DataSegment, SegmentMeta> = {
  products: { label: "Produits", icon: Package },
  categories: { label: "Catégories", icon: FolderTree },
  brands: { label: "Marques", icon: Tag },
  banners: { label: "Bannières", icon: ImageIcon },
  navigation: { label: "Navigation", icon: Menu },
  settings: { label: "Réglages", icon: Settings },
  faqs: { label: "FAQ", icon: HelpCircle },
  all: { label: "Tout", icon: Layers },
  // Import-only composite (the site content snapshot); never in the grid array.
  content: { label: "Contenu", icon: FileText },
};

/** Convenience label-only map (kept in sync with `SEGMENT_META`). */
export const SEGMENT_LABELS: Record<DataSegment, string> = {
  products: SEGMENT_META.products.label,
  categories: SEGMENT_META.categories.label,
  brands: SEGMENT_META.brands.label,
  banners: SEGMENT_META.banners.label,
  navigation: SEGMENT_META.navigation.label,
  settings: SEGMENT_META.settings.label,
  faqs: SEGMENT_META.faqs.label,
  all: SEGMENT_META.all.label,
  content: SEGMENT_META.content.label,
};

/** The real segments, in display order (excludes the `"all"`/`"content"`
 *  composite targets, which the dedicated Import-data tab drives). */
export const SEGMENTS: readonly DataSegment[] = DATA_SEGMENTS;

/**
 * Destructive cleanup copy per segment — names exactly what gets deleted so the
 * confirm step reads as a real consequence (French, danger zone). Used only for
 * `operation="clean"`. MUST mirror what the clean segment functions actually do
 * (`workflows/data/segments.ts` + CLEAN_ALL_ORDER in run-data-job.ts): images
 * are only removed from the médiathèque once nothing else uses them, and
 * « Réglages » only resets values still identical to the demo's.
 */
export const CLEAN_DESCRIPTIONS: Record<DataSegment, string> = {
  products:
    "Supprime TOUS les produits du catalogue, avec leurs avis clients, favoris, variantes et stocks, ainsi que leurs images de la médiathèque qui ne servent nulle part ailleurs. Action irréversible.",
  categories:
    "Supprime toute l'arborescence de catégories (et leurs visuels non utilisés ailleurs). Les produits rattachés perdent leur catégorie. Action irréversible.",
  brands:
    "Supprime toutes les marques (et leurs logos et visuels non utilisés ailleurs). Les produits rattachés perdent leur marque. Action irréversible.",
  banners:
    "Supprime toutes les bannières (hero, en-tête, pied de page, cartes catégorie, menus) et leurs images non utilisées ailleurs. Action irréversible.",
  navigation: "Supprime tous les menus de navigation et leurs éléments. Action irréversible.",
  settings:
    "Réinitialise les réglages de démo qui ont encore leur valeur d'origine (identité, contact, réseaux sociaux, logo, blocs d'accueil). Toute valeur que vous avez modifiée — et toute image que vous avez choisie — est conservée.",
  faqs: "Supprime toutes les catégories de FAQ et leurs questions. Action irréversible.",
  all: "Vide TOUT le catalogue et le contenu : produits (avec leurs avis clients, favoris, variantes et stocks), catégories, marques, attributs, bannières, navigation, FAQ et les images de la médiathèque devenues inutilisées. ARCHIVE TOUS LES PROFILS CLIENTS (les fiches deviennent inaccessibles) et réinitialise les réglages de démo non modifiés. Les commandes sont conservées. Action irréversible.",
  // Import-only; never surfaced as a clean button (not in SEGMENTS).
  content: "Le contenu n'est pas un segment de nettoyage.",
};
