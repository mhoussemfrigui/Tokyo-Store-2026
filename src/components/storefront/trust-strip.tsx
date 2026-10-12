"use client";

import { type LucideIcon } from "lucide-react";

import { trustIcon } from "@/lib/home/trust-icons";
import { resolveBuyBoxBadges, type ResolvedBadge } from "@/lib/storefront/trust-badges";
import {
  type TrustIconStyle,
  type TrustSurface,
  isSurfaceEnabled,
} from "@/lib/cms/trust-badge-appearance";
import { useTrustCopy } from "./trust-copy-provider";

/**
 * The admin-managed trust / reassurance strip — ONE component for every surface
 * it renders on (product buy-box, cart, checkout). Reads the active badges +
 * appearance config from `TrustCopyProvider`, resolves them with the shared pure
 * helper for the given surface state, and renders the chosen layout/icon style.
 *
 * Self-gating: renders nothing when the surface is disabled in the admin
 * (Badges de confiance → Apparence) or when no badge resolves for this surface.
 * The `list` + `circle` defaults reproduce the original hairline buy-box strip,
 * so an existing store sees no visual change until it opts into a new style.
 */
export function TrustStrip({
  surface,
  inStock = true,
  warranty,
  className = "",
}: {
  surface: TrustSurface;
  /** PDP passes the product's stock; cart/checkout default to true. */
  inStock?: boolean;
  /** Warranty copy for a warranty-kind badge. PDP → the product's own coverage;
   *  omitted on cart/checkout → the generic checkout warranty line. */
  warranty?: string | null;
  className?: string;
}) {
  const trust = useTrustCopy();
  if (!isSurfaceEnabled(trust.config, surface)) return null;

  const { security, list } = resolveBuyBoxBadges(trust.badges, {
    inStock,
    // On cart/checkout there is no single product, so a warranty badge falls
    // back to the generic admin checkout warranty line.
    warranty: warranty !== undefined ? warranty : trust.warranty || null,
    etaCopy: trust.eta,
    returnsCopy: trust.returns,
  });
  if (security.length === 0 && list.length === 0) return null;

  const { style, iconStyle } = trust.config;
  return (
    <div className={className}>
      {list.length > 0 &&
        (style === "inline" ? (
          <InlineList badges={list} iconStyle={iconStyle} />
        ) : style === "grid" ? (
          <GridList badges={list} iconStyle={iconStyle} />
        ) : (
          <HairlineList badges={list} iconStyle={iconStyle} />
        ))}
      {security.length > 0 && (
        <SecurityRow badges={security} hasList={list.length > 0} />
      )}
    </div>
  );
}

/** Icon treatment for a `list`/`grid` row — circle chip (default), plain glyph,
 *  or square chip. Kept in one place so every style stays consistent. */
function IconChip({ Icon, iconStyle }: { Icon: LucideIcon; iconStyle: TrustIconStyle }) {
  if (iconStyle === "plain") {
    return <Icon className="h-4 w-4 shrink-0 text-olive" strokeWidth={1.75} aria-hidden />;
  }
  const shape = iconStyle === "square" ? "rounded-lg" : "rounded-full";
  return (
    <span className={`grid h-7 w-7 shrink-0 place-items-center ${shape} bg-olive/10 text-olive`}>
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
    </span>
  );
}

/** Default style — the original buy-box hairline list (vertical rows). */
function HairlineList({ badges, iconStyle }: { badges: ResolvedBadge[]; iconStyle: TrustIconStyle }) {
  return (
    <ul className="space-y-3">
      {badges.map((badge, i) => {
        const Icon = trustIcon(badge.icon);
        return (
          <li
            key={`b-${i}`}
            className="flex items-center gap-3 font-body text-[0.82rem] tracking-wide text-foreground/75 md:text-[0.86rem]"
          >
            <IconChip Icon={Icon} iconStyle={iconStyle} />
            <span>{badge.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Compact style — a wrapped inline row of small reassurance items. */
function InlineList({ badges, iconStyle }: { badges: ResolvedBadge[]; iconStyle: TrustIconStyle }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
      {badges.map((badge, i) => {
        const Icon = trustIcon(badge.icon);
        return (
          <li
            key={`b-${i}`}
            className="inline-flex items-center gap-2 font-body text-[0.8rem] tracking-wide text-foreground/75"
          >
            <IconChip Icon={Icon} iconStyle={iconStyle} />
            <span>{badge.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Card style — a responsive 2-column grid of icon + label tiles. */
function GridList({ badges, iconStyle }: { badges: ResolvedBadge[]; iconStyle: TrustIconStyle }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {badges.map((badge, i) => {
        const Icon = trustIcon(badge.icon);
        return (
          <li
            key={`b-${i}`}
            className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/40 px-4 py-3 font-body text-[0.82rem] tracking-wide text-foreground/80"
          >
            <IconChip Icon={Icon} iconStyle={iconStyle} />
            <span>{badge.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The security group — a quiet uppercase caption row, always below the list. */
function SecurityRow({ badges, hasList }: { badges: ResolvedBadge[]; hasList: boolean }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.6rem] uppercase tracking-[0.16em] text-muted-foreground/70 ${
        hasList ? "mt-4 border-t border-border/40 pt-4" : ""
      }`}
    >
      {badges.map((badge, i) => {
        const Icon = trustIcon(badge.icon);
        return (
          <span key={`sec-${i}`} className="inline-flex items-center gap-1.5">
            <Icon className="h-3 w-3 shrink-0 text-olive" strokeWidth={2} aria-hidden />
            {badge.label}
          </span>
        );
      })}
    </div>
  );
}
