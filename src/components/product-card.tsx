"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, ShoppingBag, X } from "lucide-react";

import { addToCartBySlugAction } from "@/lib/actions/cart";
import { WishlistButton } from "@/components/wishlist/wishlist-button";
import { useTrustCopy } from "@/components/storefront/trust-copy-provider";
import { useMoney } from "@/components/money-provider";
import { discountPercent } from "@/lib/promotions/discount";
import { hasVisibleCompareAt } from "@/lib/listing/display-pricing";
import { track, itemFromProduct, type FunnelItem } from "@/lib/tracking/funnel";
import type { Product } from "@/types/catalog";

/** Build a GA4 funnel item from a storefront Product (+ optional list attribution).
 *  item_id = the product UUID, the id the PDP / cart / purchase events send. */
function productToItem(product: Product, listName?: string): FunnelItem {
  return {
    ...itemFromProduct({
      id: product.id,
      slug: product.slug,
      name: product.name,
      price: product.price,
      priceCents: product.priceCents,
      brand: product.brand,
      category: product.categoryName ?? product.category,
    }),
    item_list_name: listName,
  };
}

/**
 * Storefront product card — Tokyo Store luxury "floating watch" design.
 *
 * The product image floats above a rounded card panel (a negative margin pulls
 * the panel up beneath it); at REST the watch gently floats (`.watch-bob` —
 * up/down + a slight side-to-side rotation) and on hover the float pauses while
 * it smoothly LIFTS (`.watch-float`); `.ink-track` paints the olive cursor glow,
 * and the price row cross-fades into the
 * add-to-cart / wishlist actions on hover (no layout shift). The whole card is a
 * stretched link to the PDP; the favourite + add-to-cart buttons sit above it
 * (z-10) so they stay independently clickable. Quick-add only applies to simple,
 * in-stock products — variable / sold-out route to the PDP.
 *
 * All data flows from the médiathèque-resolved `Product` DTO + `useMoney`
 * (millimes) + the existing server actions; nothing is hardcoded.
 */
export function ProductCard({
  product,
  listName,
  variant = "grid",
  priority = false,
}: {
  product: Product;
  listName?: string;
  /** "grid" = page grid sizing; "carousel" = slightly tighter for scroll-snap rails. */
  variant?: "grid" | "carousel";
  /**
   * Eager-load this card's image (next/image `priority`). Listing pages have no
   * hero above the grid, so the FIRST row of product images is the LCP element;
   * the caller sets this true for the first few above-fold cards and leaves the
   * rest lazy. One priority image per viewport is the target — don't set it on
   * every card or it defeats the purpose.
   */
  priority?: boolean;
}) {
  const money = useMoney();

  const isCarousel = variant === "carousel";
  // A « was » price is struck (and a −X% shown) only when the compare-at is
  // STRICTLY above the price as displayed — the PDP guard and the « En promotion
  // uniquement » filter use the same rule, so a stale compare-at at or below the
  // price never renders a misleading strike-through.
  const compareAtCents =
    product.oldPriceCents != null && hasVisibleCompareAt(product, money.decimals)
      ? product.oldPriceCents
      : null;
  const discount =
    compareAtCents != null ? discountPercent(product.priceCents, compareAtCents) : 0;

  const ratingRow =
    product.reviews > 0 && product.rating > 0 ? (
      <div className="relative z-10 mt-1 flex items-center justify-center gap-1 md:mt-1.5">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 text-gold">
          <path d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" />
        </svg>
        <span className="font-body text-[0.55rem] text-muted-foreground/60 tabular-nums">
          {product.rating.toFixed(1)}
          {product.reviews ? ` · ${product.reviews}` : ""}
        </span>
      </div>
    ) : null;

  return (
    <div className="flex justify-center tk-fade-in-up">
      {/* The global InkTrackProvider feeds --ink-x/--ink-y to the .ink-track panel. */}
      <div className="group block w-full">
        <div className="relative flex flex-col">
          {/* Whole-card link overlay — the ENTIRE card (floating watch image +
              panel) navigates to the PDP, so users never have to click the name
              precisely. The interactive controls (Panier / favori / quick-view)
              sit at z-30 above this z-20 overlay and stopPropagation, so they
              stay independently clickable. */}
          <Link
            href={`/${product.slug}`}
            onClick={() => track("select_item", { items: [productToItem(product, listName)] })}
            className="absolute inset-0 z-20 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {/* Real (visually-hidden) anchor text so the PDP internal link carries
                descriptive text for crawlers + the accessible name for SR users,
                without disturbing the whole-card overlay visuals. */}
            <span className="sr-only">{product.name}</span>
          </Link>
          {/* Floating watch */}
          <div
            className={`relative z-10 flex items-end justify-center ${
              isCarousel ? "h-36 -mb-3 md:h-56 md:-mb-4" : "h-40 -mb-4 md:h-60 md:-mb-6 lg:h-64"
            }`}
          >
            {/* At REST the watch gently floats — `.watch-bob` runs continuously
                (translateY up/down + a slight side-to-side rotation, the
                reference's lwcFloat). On hover the float PAUSES (globals.css) and
                `.watch-float` lifts the watch up in one clean, smooth motion — no
                cursor tilt. */}
            <div className="watch-float relative px-2">
              <Image
                src={product.image}
                alt={product.imageAlt ?? product.name}
                width={240}
                height={240}
                sizes="(max-width: 640px) 40vw, (max-width: 1024px) 25vw, 220px"
                quality={70}
                priority={priority}
                // priority already fetches high; only mark below-fold cards lazy.
                loading={priority ? undefined : "lazy"}
                className={`watch-bob w-auto object-contain drop-shadow-[0_14px_22px_color-mix(in_oklab,var(--foreground)_22%,transparent)] transition-[filter] duration-500 group-hover:drop-shadow-[0_22px_30px_color-mix(in_oklab,var(--foreground)_28%,transparent)] ${
                  isCarousel ? "max-h-32 md:max-h-52" : "max-h-36 md:max-h-56 lg:max-h-64"
                }`}
              />
              {/* Soft contact shadow — the `.watch-shadow` class tightens + softens
                  it on card hover, in sync with the lift above. */}
              <div className="watch-shadow absolute -bottom-2 left-1/2 h-3 w-[55%] -translate-x-1/2 rounded-[50%] bg-black/15 opacity-100 blur-md" />
            </div>
          </div>

          {/* Panel — two zones: a quiet info block and a tinted price footer,
              split by a full-width hairline. `overflow-hidden` clips the footer
              tint + the sliding action bar to the rounded corners. */}
          <div className="relative flex flex-col overflow-hidden rounded-xl border border-border/30 bg-card/40 text-center transition-[border-color,box-shadow] duration-500 md:group-hover:border-primary/15 md:group-hover:shadow-[0_6px_24px_-8px_color-mix(in_oklab,var(--primary)_8%,transparent)]">
            {/* Info zone — carries the olive cursor "ink-drop" (name/category/brand).
                Its own `ink-track` scope means the glow follows the cursor across this
                block; text sits at z-10 above the ::before glow. */}
            <div
              className={`ink-track ink-track-card flex flex-col items-center px-3 ${
                isCarousel ? "pt-4 pb-3" : "pt-5 pb-4 md:pt-6"
              }`}
            >
              {/* Brand eyebrow */}
              {product.brand && (
                <p className="relative z-10 mb-0.5 font-body text-[0.5rem] font-medium uppercase tracking-[0.22em] text-foreground/75 md:text-[0.55rem]">
                  {product.brand}
                </p>
              )}
              {/* Category */}
              {(product.categoryName || product.category) && (
                <p className="relative z-10 mb-1.5 font-body text-[0.5rem] uppercase tracking-[0.18em] text-muted-foreground/50 md:mb-2 md:text-[0.55rem] md:tracking-[0.2em]">
                  {product.categoryName ?? product.category}
                </p>
              )}

              {/* Product name — plain heading; the whole-card overlay link below
                  (image + panel) carries the navigation, so a click ANYWHERE on
                  the card opens the PDP (no need to hit the name precisely). */}
              {/* Name — vertically CENTRED in a fixed two-line box: a 1-line title
                  sits balanced in the middle and a long 2-line title (clamped +
                  ellipsis) fills it, so either way the footer bar stays aligned
                  across a grid row and long names never shift the layout. The em
                  min-heights track the name's own font-size/leading per breakpoint. */}
              <div className="relative z-10 flex min-h-[2.75em] items-center justify-center text-xs leading-snug md:min-h-[2.5em] md:text-base md:leading-tight">
                <p className="line-clamp-2 font-serif text-foreground">{product.name}</p>
              </div>

              {/* SKU reference (hide-when-unset) */}
              {product.sku && (
                <p className="relative z-10 mt-1 font-body text-[0.5rem] uppercase tracking-[0.12em] text-muted-foreground/40 md:mt-1.5 md:text-[0.55rem]">
                  Réf. {product.sku}
                </p>
              )}

              {ratingRow}
            </div>

            {/* Price footer — full-width, tinted, split from the info by a hairline.
                Holds the price at rest and the full-cover action bar on hover. */}
            <PriceActions
              product={product}
              listName={listName}
              money={money}
              compareAtCents={compareAtCents}
              discount={discount}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Price ⇄ actions swap zone. On DESKTOP the price shows by default and a
 * Panier + favori bar slides up on card hover. On TOUCH there is no hover, so
 * the bar stays hidden (`hidden md:flex`) and the whole card is a tap target to
 * the PDP, where the shopper adds to cart / favourites — the standard mobile
 * pattern (a variable/sold-out product routes to the PDP on desktop too). Same
 * footer height in both states → no layout shift.
 */
function PriceActions({
  product,
  listName,
  money,
  compareAtCents,
  discount,
}: {
  product: Product;
  listName?: string;
  money: ReturnType<typeof useMoney>;
  /** The struck « was » price, or null when none is shown (see ProductCard). */
  compareAtCents: number | null;
  /** Whole-percent discount vs the compare-at, shown as a chip by the price. */
  discount: number;
}) {
  const { eta } = useTrustCopy();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "done" | "error">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const needsOptions = product.productType === "variable";
  const soldOut = !product.inStock;
  const routeToPdp = needsOptions || soldOut;

  const flash = (next: "done" | "error") => {
    setStatus(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus("idle"), next === "done" ? 1500 : 2000);
  };

  const priceBlock = (
    <div className="flex h-full flex-col items-center justify-center">
      {compareAtCents != null ? (
        // On promo: a single clean « now · was » line — the effective price leads
        // (olive, the sale accent), the original trails struck + muted, and the
        // −X% chip rides beside the « was » price. One line keeps the height in
        // step with a normal price card.
        <div className="flex flex-col items-center justify-center gap-0.5 md:flex-row md:items-baseline md:gap-1">
          <span className="whitespace-nowrap font-body text-sm font-semibold tracking-wide text-olive tabular-nums md:text-base">
            {money.fromMinor(product.priceCents)}
          </span>
          {/* was + −X% share a row; on the narrow mobile card they wrap to a second
              line under the effective price (footer is fixed-height, so this never
              overflows even for 4–5 digit promos); one line from md up. */}
          <span className="flex items-baseline gap-1">
            <span className="whitespace-nowrap font-body text-[0.6rem] text-muted-foreground/50 line-through tabular-nums md:text-[0.62rem]">
              {money.fromMinor(compareAtCents)}
            </span>
            {discount > 0 && (
              <span className="rounded bg-olive/15 px-1 py-px font-body text-[0.5rem] font-semibold leading-none text-olive tabular-nums">
                −{discount}%
              </span>
            )}
          </span>
        </div>
      ) : (
        <p className="font-body text-sm font-semibold tracking-wide text-foreground tabular-nums md:text-base">
          {money.fromMinor(product.priceCents)}
        </p>
      )}
    </div>
  );

  // Status / stock micro-line (accessible tooltip: sold-out hint).
  const stockHint = !product.inStock
    ? "Bientôt disponible"
    : eta
      ? `En stock · ${eta}`
      : "En stock";

  // The footer is the price ZONE: the price sits centred at rest, and on desktop
  // hover a solid Panier + favori bar SLIDES UP to cover the whole footer.
  // Stacking: the footer is `relative` with NO z-index (so it never becomes a
  // stacking context that would trap the bar). The action bar keeps z-30 → it
  // paints above the card's z-20 whole-card link → stays clickable; the price
  // layer carries no z-index → it stays under the link → the price area still
  // opens the PDP. `overflow-hidden` hides the bar below the footer until hover.
  return (
    <div className="relative h-11 w-full overflow-hidden border-t border-border/40 bg-muted/25 md:h-12">
      {/* Price at rest — fades out as the bar rises over it (desktop only). */}
      <div className="absolute inset-0 flex items-center justify-center px-3 transition-opacity duration-300 ease-out md:group-hover:opacity-0">
        {priceBlock}
      </div>

      {/* Action bar — slides UP from below to cover the whole footer on hover.
          Hidden on touch (`md:flex`): the card itself routes to the PDP and the
          mobile bar carries Panier / Favoris, so the footer just shows the price.
          `translate-y-full → translate-y-0` (Tailwind v4 emits the individual
          `translate` property, so the transition names `translate`, not
          `transform`, or the slide would jump). */}
      <div className="pointer-events-none absolute inset-0 z-30 hidden translate-y-full opacity-0 transition-[opacity,translate] duration-300 ease-out md:invisible md:flex md:group-hover:visible md:group-hover:translate-y-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100">
        {routeToPdp ? (
          <Link
            href={`/${product.slug}`}
            aria-label={soldOut ? "Voir le produit" : "Choisir les options"}
            title={stockHint}
            onClick={(e) => e.stopPropagation()}
            className="ink-track ink-track-btn relative z-10 flex flex-1 items-center justify-center bg-foreground font-body text-[0.6rem] uppercase tracking-[0.14em] text-background transition-colors duration-200 [&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg]:scale-110"
          >
            <span className="relative z-10 flex items-center gap-2">
              <ShoppingBag className="h-3.5 w-3.5" />
              <span>Voir</span>
            </span>
          </Link>
        ) : (
          <button
            type="button"
            disabled={pending}
            aria-label="Ajouter au panier"
            title={status === "error" ? "Échec — réessayez" : stockHint}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startTransition(async () => {
                const res = await addToCartBySlugAction(product.slug);
                if (res.ok) {
                  track("add_to_cart", {
                    value_cents: product.priceCents,
                    items: [{ ...productToItem(product, listName), quantity: 1 }],
                  });
                }
                flash(res.ok ? "done" : "error");
              });
            }}
            style={{ WebkitTapHighlightColor: "transparent" }}
            className={`ink-track ink-track-btn relative z-10 flex flex-1 items-center justify-center font-body text-[0.6rem] uppercase tracking-[0.14em] transition-colors duration-200 disabled:opacity-70 [&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg]:scale-110 ${
              status === "error"
                ? "bg-destructive text-white"
                : "bg-foreground text-background"
            }`}
          >
            <span className="relative z-10 flex items-center gap-2">
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : status === "done" ? (
                <Check className="h-3.5 w-3.5" strokeWidth={2.6} />
              ) : status === "error" ? (
                <X className="h-3.5 w-3.5" strokeWidth={2.6} />
              ) : (
                <ShoppingBag className="h-3.5 w-3.5" />
              )}
              <span>
                {status === "done" ? "Ajouté" : status === "error" ? "Erreur" : "Panier"}
              </span>
            </span>
          </button>
        )}
        {/* Wishlist heart — a segment on the right of the cover bar, divided by a
            hairline. Always reachable on touch. */}
        <WishlistButton
          slug={product.slug}
          product={{
            id: product.id,
            name: product.name,
            priceCents: product.priceCents,
            brand: product.brand,
            category: product.categoryName ?? product.category,
          }}
          className="ink-track ink-track-btn relative z-10 flex h-full w-11 shrink-0 items-center justify-center rounded-none border-l border-background/15 bg-foreground text-background/70 shadow-none backdrop-blur-none transition-colors duration-200 hover:bg-foreground hover:text-background [&_svg]:relative [&_svg]:z-10 [&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg]:scale-110 md:w-12"
        />
      </div>
    </div>
  );
}
