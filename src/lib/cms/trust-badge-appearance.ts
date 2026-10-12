/**
 * Appearance + placement config for the admin-managed trust-badge reassurance
 * strip. Backed by `storefront.trust_badges.*` rows in `site_settings`, read
 * with the shared coercers so a hand-edited / unknown value can never select an
 * invalid variant. Isomorphic + client-safe (pure string logic over a settings
 * map) so the shop layout (read) and the admin panel (edit) share one contract.
 *
 * ONE style applies to the whole strip (not per-badge) — the operator picks a
 * layout + icon treatment, and the per-surface toggles decide WHERE it renders.
 */
import { asBool, asEnum } from "@/lib/cms/setting-coerce";

export const TRUST_STRIP_STYLES = ["list", "inline", "grid"] as const;
export type TrustStripStyle = (typeof TRUST_STRIP_STYLES)[number];

export const TRUST_ICON_STYLES = ["circle", "plain", "square"] as const;
export type TrustIconStyle = (typeof TRUST_ICON_STYLES)[number];

/** The surfaces the strip can render on (each a `show_on_*` boolean setting). */
export const TRUST_SURFACES = ["product", "cart", "checkout"] as const;
export type TrustSurface = (typeof TRUST_SURFACES)[number];

export type TrustBadgeAppearance = {
  style: TrustStripStyle;
  iconStyle: TrustIconStyle;
  /** Per-surface placement. Product + cart default ON (cart replaces the former
   *  hardcoded strip); checkout is opt-in (its payment-security footer stays). */
  showOnProduct: boolean;
  showOnCart: boolean;
  showOnCheckout: boolean;
};

export const TRUST_BADGE_APPEARANCE_DEFAULTS: TrustBadgeAppearance = {
  style: "list",
  iconStyle: "circle",
  showOnProduct: true,
  showOnCart: true,
  showOnCheckout: false,
};

const KEY = (field: string) => `storefront.trust_badges.${field}`;

/** Settings keys this config owns — the admin save loop writes exactly these. */
export const TRUST_BADGE_SETTING_KEYS = {
  style: KEY("style"),
  iconStyle: KEY("icon_style"),
  showOnProduct: KEY("show_on_product"),
  showOnCart: KEY("show_on_cart"),
  showOnCheckout: KEY("show_on_checkout"),
} as const;

/** Resolve the appearance/placement config from a loaded settings map. */
export function getTrustBadgeAppearance(
  settings: Record<string, string | null>,
): TrustBadgeAppearance {
  const d = TRUST_BADGE_APPEARANCE_DEFAULTS;
  return {
    style: asEnum(settings[TRUST_BADGE_SETTING_KEYS.style], TRUST_STRIP_STYLES, d.style),
    iconStyle: asEnum(settings[TRUST_BADGE_SETTING_KEYS.iconStyle], TRUST_ICON_STYLES, d.iconStyle),
    showOnProduct: asBool(settings[TRUST_BADGE_SETTING_KEYS.showOnProduct], d.showOnProduct),
    showOnCart: asBool(settings[TRUST_BADGE_SETTING_KEYS.showOnCart], d.showOnCart),
    showOnCheckout: asBool(settings[TRUST_BADGE_SETTING_KEYS.showOnCheckout], d.showOnCheckout),
  };
}

/** True when the strip is enabled for the given surface. */
export function isSurfaceEnabled(cfg: TrustBadgeAppearance, surface: TrustSurface): boolean {
  return surface === "product"
    ? cfg.showOnProduct
    : surface === "cart"
      ? cfg.showOnCart
      : cfg.showOnCheckout;
}
