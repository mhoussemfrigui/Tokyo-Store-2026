import {
  Truck,
  RotateCcw,
  ShieldCheck,
  Headphones,
  Award,
  Sparkles,
  Zap,
  CreditCard,
  Clock,
  Gift,
  Heart,
  Star,
  BadgeCheck,
  Wrench,
  Package,
  Globe2,
  Percent,
  Lock,
  ThumbsUp,
  Phone,
  MapPin,
  Tag,
  type LucideIcon,
} from "lucide-react";

import { TRUST_ICON_NAMES, isTrustIconName } from "./trust-icon-names";

/**
 * Curated icon set for the trust badges (admin picker + storefront render) and
 * the homepage trust strip. Admin picks an icon by NAME (stored in the DB /
 * settings); the storefront maps the name → component via `trustIcon()`.
 * Isomorphic + client-safe — both the admin panel (picker) and the storefront
 * (render) import from here, so the available set can never drift.
 *
 * The NAME list lives in the dependency-free `trust-icon-names.ts` (so the
 * server-only workflow can validate without bundling lucide); this map binds
 * each name to its component. The `satisfies` keeps the two exhaustive: a name
 * added there with no entry here (or vice-versa) is a compile error.
 */
const ICON_COMPONENTS = {
  Truck,
  RotateCcw,
  ShieldCheck,
  Headphones,
  Award,
  Sparkles,
  Zap,
  CreditCard,
  Clock,
  Gift,
  Heart,
  Star,
  BadgeCheck,
  Wrench,
  Package,
  Globe2,
  Percent,
  Lock,
  ThumbsUp,
  Phone,
  MapPin,
  Tag,
} satisfies Record<(typeof TRUST_ICON_NAMES)[number], LucideIcon>;

export const TRUST_ICON_MAP: Record<string, LucideIcon> = ICON_COMPONENTS;

export { TRUST_ICON_NAMES };

/**
 * Resolve a stored icon name to a component, falling back to a safe default.
 * Own-key only (via `isTrustIconName`): a stored value like "constructor" /
 * "toString" / "__proto__" must NOT resolve to an `Object.prototype` member —
 * rendering that non-component as `<Icon/>` would crash the whole surface.
 */
export function trustIcon(name: string | null | undefined): LucideIcon {
  return (isTrustIconName(name) && TRUST_ICON_MAP[name]) || ShieldCheck;
}
