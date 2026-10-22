"use client";

import { type LucideIcon } from "lucide-react";

import { trustIcon } from "@/lib/home/trust-icons";
import { resolveBuyBoxBadges, type ResolvedBadge } from "@/lib/storefront/trust-badges";
import {
  type TrustIconStyle,
  type TrustSurface,
  isSurfaceEnabled,
} from "@/lib/cms/trust-badge-appearance";
import { useTrustCopy } from "@/components/storefront/trust-copy-provider";

/**
 * The admin-managed reassurance strip for the LIVE Tokyo (crimson) storefront —
 * ONE component for every surface it renders on (PDP buy-box, cart, checkout).
 * Reads the active badges + appearance config from `TrustCopyProvider` and
 * honours BOTH admin controls that used to be dead (Badges de confiance →
 * Apparence): the layout `style` (list / inline / grid) AND the `iconStyle`
 * (circle / plain / square). Per-surface `show_on_*` toggles decide WHERE it
 * renders — the PDP, the cart, the checkout — all three previously ignored
 * (only the PDP showed a fixed dark band; cart/checkout showed nothing).
 *
 * Crimson-native (accent = `var(--primary)`), so a brand-colour change re-skins
 * it. Renders nothing when the surface is disabled or no badge resolves, so an
 * unconfigured store shows no band rather than a fabricated one.
 */
export function TrustBand({
  surface,
  inStock = true,
  warranty,
  className = "",
}: {
  surface: TrustSurface;
  /** PDP passes the product's stock; cart/checkout default to true. */
  inStock?: boolean;
  /** Warranty copy for a warranty-kind badge. PDP → the product's own coverage;
   *  omitted on cart/checkout → the generic admin checkout warranty line. */
  warranty?: string | null;
  className?: string;
}) {
  const trust = useTrustCopy();
  if (!isSurfaceEnabled(trust.config, surface)) return null;

  const { security, list } = resolveBuyBoxBadges(trust.badges, {
    inStock,
    warranty: warranty !== undefined ? warranty : trust.warranty || null,
    etaCopy: trust.eta,
    returnsCopy: trust.returns,
  });
  const items = [...list, ...security];
  if (items.length === 0) return null;

  const { style, iconStyle } = trust.config;
  if (style === "grid") return <GridBand items={items} iconStyle={iconStyle} className={className} />;
  if (style === "inline") return <InlineRow items={items} iconStyle={iconStyle} className={className} />;
  return <HairlineList items={items} iconStyle={iconStyle} className={className} />;
}

/** Icon treatment — crimson round chip (default), crimson rounded-square chip, or
 *  a bare crimson glyph. `dark` picks white-on-crimson vs crimson-on-tint. */
function IconChip({
  Icon,
  iconStyle,
  dark = false,
  size = 20,
  chip = 46,
}: {
  Icon: LucideIcon;
  iconStyle: TrustIconStyle;
  dark?: boolean;
  size?: number;
  chip?: number;
}) {
  if (iconStyle === "plain") {
    return <Icon size={size} style={{ color: dark ? "#fff" : "var(--primary)" }} aria-hidden />;
  }
  const radius = iconStyle === "square" ? "rounded-[14px]" : "rounded-full";
  return (
    <span
      className={`flex flex-[0_0_auto] items-center justify-center ${radius}`}
      style={{
        width: chip,
        height: chip,
        background: dark ? "var(--primary)" : "color-mix(in oklab, var(--primary) 12%, transparent)",
        color: dark ? "#fff" : "var(--primary)",
      }}
    >
      <Icon size={size} aria-hidden />
    </span>
  );
}

/** `grid` — the rich dark service band (auto-fit tiles), the store's signature
 *  reassurance block. White-on-ink with crimson icon chips. */
function GridBand({ items, iconStyle, className }: { items: ResolvedBadge[]; iconStyle: TrustIconStyle; className: string }) {
  return (
    <section
      className={`grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-6 rounded-[36px] p-[clamp(22px,3vw,36px)] text-white ${className}`}
      style={{ background: "#0e1218" }}
    >
      {items.map((b, i) => {
        const Icon = trustIcon(b.icon);
        return (
          <div key={i} className="flex items-center gap-3.5">
            <IconChip Icon={Icon} iconStyle={iconStyle} dark size={20} chip={46} />
            <div className="text-[16px] font-extrabold leading-snug [text-wrap:balance]">{b.label}</div>
          </div>
        );
      })}
    </section>
  );
}

/** `list` — a quiet vertical list of reassurance rows in a self-contained card. */
function HairlineList({ items, iconStyle, className }: { items: ResolvedBadge[]; iconStyle: TrustIconStyle; className: string }) {
  return (
    <ul className={`flex flex-col gap-3.5 rounded-[clamp(20px,3vw,28px)] bg-white p-[clamp(18px,2.5vw,24px)] ${className}`}>
      {items.map((b, i) => {
        const Icon = trustIcon(b.icon);
        return (
          <li key={i} className="flex items-center gap-3 text-[14px] font-semibold" style={{ color: "#3d4046" }}>
            <IconChip Icon={Icon} iconStyle={iconStyle} size={16} chip={34} />
            <span>{b.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** `inline` — a compact horizontal wrapped row of reassurance chips, carded. */
function InlineRow({ items, iconStyle, className }: { items: ResolvedBadge[]; iconStyle: TrustIconStyle; className: string }) {
  return (
    <ul className={`flex flex-wrap items-center gap-x-5 gap-y-3 rounded-[clamp(20px,3vw,28px)] bg-white p-[clamp(16px,2.5vw,22px)] ${className}`}>
      {items.map((b, i) => {
        const Icon = trustIcon(b.icon);
        return (
          <li key={i} className="inline-flex items-center gap-2 text-[13.5px] font-semibold" style={{ color: "#3d4046" }}>
            <IconChip Icon={Icon} iconStyle={iconStyle} size={15} chip={30} />
            <span>{b.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
