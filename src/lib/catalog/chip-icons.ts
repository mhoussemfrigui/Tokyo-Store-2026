import {
  Award,
  Cog,
  Crown,
  Diamond,
  Flame,
  Footprints,
  Gem,
  Gift,
  Glasses,
  Heart,
  Layers,
  Mountain,
  Package,
  Shapes,
  Shield,
  ShoppingBag,
  Sparkle,
  Sparkles,
  Star,
  Tag,
  Timer,
  Watch,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Curated chip-icon registry for the storefront listing "thumbs" strip
 * (`CategoryNavBar` in the category client). Each category / brand / collection
 * can pick ONE of these lucide icons by `key`, or set a custom médiathèque image
 * (`icon_media_id`) that wins over the key. This module is intentionally
 * CLIENT-SAFE (no `server-only`, no DB) so both the admin IconPicker and the
 * storefront chip renderer can import it.
 *
 * At render the chosen icon key is resolved to its component by `promoIcon`
 * (lib/links/promo-icons.ts); a custom image (iconUrl) wins over the key.
 */
export type ChipIconOption = { key: string; label: string; Icon: LucideIcon };

/**
 * The ~24 selectable icons, French-labelled (the admin UI is French-locked).
 * The `key` is the stable string persisted in the `icon` column — never rename
 * a key, or saved selections would silently fall back to the default.
 */
export const CHIP_ICON_OPTIONS: ChipIconOption[] = [
  { key: "Watch", label: "Montre", Icon: Watch },
  { key: "Gem", label: "Pierre précieuse", Icon: Gem },
  { key: "Diamond", label: "Diamant", Icon: Diamond },
  { key: "Crown", label: "Couronne", Icon: Crown },
  { key: "Timer", label: "Chronomètre", Icon: Timer },
  { key: "Sparkles", label: "Éclat", Icon: Sparkles },
  { key: "Sparkle", label: "Étincelle", Icon: Sparkle },
  { key: "Star", label: "Étoile", Icon: Star },
  { key: "Award", label: "Récompense", Icon: Award },
  { key: "Shield", label: "Garantie", Icon: Shield },
  { key: "Tag", label: "Étiquette", Icon: Tag },
  { key: "Gift", label: "Cadeau", Icon: Gift },
  { key: "Heart", label: "Cœur", Icon: Heart },
  { key: "Flame", label: "Flamme", Icon: Flame },
  { key: "Zap", label: "Éclair", Icon: Zap },
  { key: "Layers", label: "Collection", Icon: Layers },
  { key: "Shapes", label: "Catégories", Icon: Shapes },
  { key: "Mountain", label: "Aventure", Icon: Mountain },
  { key: "Wrench", label: "Outillage", Icon: Wrench },
  { key: "Cog", label: "Mécanisme", Icon: Cog },
  { key: "Glasses", label: "Lunettes", Icon: Glasses },
  { key: "Footprints", label: "Chaussures", Icon: Footprints },
  { key: "ShoppingBag", label: "Sac", Icon: ShoppingBag },
  { key: "Package", label: "Colis", Icon: Package },
];

