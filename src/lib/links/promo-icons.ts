import {
  Tag,
  Sparkles,
  Globe2,
  Flame,
  Truck,
  LifeBuoy,
  Smartphone,
  Phone,
  Tablet,
  Laptop,
  Monitor,
  Gamepad2,
  Headphones,
  Tv,
  Home,
  LayoutGrid,
  Watch,
  Camera,
  Gift,
  Package,
  ShoppingBag,
  Star,
  Zap,
  Music,
  Clapperboard,
  Cpu,
  type LucideIcon,
} from "lucide-react";

/**
 * Curated icon set for link chips + nav entries — the SINGLE source shared by the
 * admin navigation icon picker (/admin/cms/nav-menu + /admin/cms/footer), the
 * storefront footer renderer AND the crimson header (universe rail + shortcut
 * pills resolve their icon through `promoIcon`), mirroring
 * src/lib/home/trust-icons.ts. One map means adding an icon to the picker can't
 * silently fall back on the storefront. The tech/universe icons below cover the
 * mega-menu universes (Téléphonie, Gaming, Audiovisuel…) so operators can pick a
 * fitting glyph for each.
 */
export const PROMO_ICON_MAP: Record<string, LucideIcon> = {
  // Promo / utility chips.
  Tag,
  Sparkles,
  Globe2,
  Flame,
  Truck,
  LifeBuoy,
  // Universe / tech-store glyphs (mega-menu rail + shortcut pills).
  Smartphone,
  Phone,
  Tablet,
  Laptop,
  Monitor,
  Gamepad2,
  Headphones,
  Tv,
  Home,
  LayoutGrid,
  Watch,
  Camera,
  Gift,
  Package,
  ShoppingBag,
  Star,
  Zap,
  Music,
  Clapperboard,
  Cpu,
};

export const PROMO_ICON_NAMES: string[] = Object.keys(PROMO_ICON_MAP);

/** True only for an OWN, curated key — never an inherited `Object.prototype`
 *  member ("constructor", "toString", …). A bare `PROMO_ICON_MAP[name]` would
 *  return the Object constructor for `name==="constructor"`, and rendering that
 *  as a component crashes the whole chrome (same class as the trust-icon fix). */
export function isPromoIconName(name: string | null | undefined): name is string {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(PROMO_ICON_MAP, name);
}

/** Safe lookup for a stored/admin-picked icon name → its component, or null. */
export function promoIcon(name: string | null | undefined): LucideIcon | null {
  return isPromoIconName(name) ? PROMO_ICON_MAP[name] : null;
}
