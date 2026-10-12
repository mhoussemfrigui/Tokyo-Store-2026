"use client";

import { useEffect, useRef, useState } from "react";
import { Star, Check, Heart } from "lucide-react";
import Link from "next/link";
import type { Product } from "@/storefront/lib/catalog";
import { STOCK_LABEL, productRating, productStrike, fmtPrice, stockState } from "@/storefront/lib/productMeta";
import { addToCart } from "@/storefront/lib/cart";
import { toggleFavorite, useIsFavorite } from "@/storefront/lib/favorites";
import { badge, btn } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

/**
 * Product card — the ONLY product card on the site (listings, home shelves and
 * rails, product-page rails), built in the same language as the nav bloc: an
 * outer 24px card holding an inset white media panel, badge-style facts and a
 * full-width capsule CTA. The media radius is concentric with the card
 * (24 − the 10px inset = 14). The catalogue photos are all white-background
 * pack shots, so the media panel is plain white with no effects.
 */
export function CatalogProductCard({ product }: { product: Product }) {
  const strike = productStrike(product);
  const { rating, reviews } = productRating(product);
  const discountPct = strike ? strike.pct : 0;
  const stock = stockState(product);
  const oos = stock === "out_of_stock";
  const preorder = stock === "backorder";
  const [added, setAdded] = useState(false);
  const wished = useIsFavorite(product.slug);

  /* The photos are hot-linked from tokyostores.tn and can take seconds to
     arrive: pulse the media box until the image has loaded. An image served
     from cache may already be complete before hydration attaches onLoad, so
     check once on mount too. */
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);

  return (
    /* w-full: in a flex rail the card would otherwise shrink-wrap to its text
       while the image is still loading (an unloaded img has no width).
       @container/card: the CTA label is sized against the card's own width. */
    <div className="group @container/card relative flex h-full w-full flex-col rounded-card border border-border bg-background p-2.5 shadow-island transition-colors duration-200 hover:border-primary/40">
      {/* Favourite heart — a sibling of the Link (not inside it) with a higher
          stacking context, so tapping it toggles the wishlist instead of opening
          the product. Backed by the real backend wishlist store. */}
      <button
        type="button"
        onClick={() => toggleFavorite(product.slug)}
        aria-pressed={wished}
        aria-label={wished ? "Retirer des favoris" : "Ajouter aux favoris"}
        className={cn(
          "absolute right-[18px] top-[18px] z-10 grid size-9 place-items-center rounded-full border border-border bg-background/90 backdrop-blur transition-colors duration-200 hover:border-primary/40",
          wished ? "text-primary" : "text-foreground hover:text-primary",
        )}
      >
        <Heart aria-hidden className={cn("size-4", wished && "fill-current")} strokeWidth={2} />
      </button>
      <Link href={`/${product.slug}`} className="flex flex-1 flex-col">
        {/* Inset white media panel */}
        <div className="relative overflow-hidden rounded-media bg-product-media p-3">
          <div className={cn("aspect-square", !loaded && "animate-pulse bg-secondary")}>
            <img
              ref={imgRef}
              src={product.image}
              alt=""
              width={600}
              height={600}
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setLoaded(true)}
              className="h-full w-full object-contain"
            />
          </div>
          {discountPct > 0 && (
            /* U+2212 minus, not a hyphen: the badge reads as a signed number. */
            <span className={cn(badge.base, badge.discount, "absolute left-2.5 top-2.5")}>
              −{discountPct}%
            </span>
          )}
        </div>

        {/* @container: the stock dot below is sized against the CARD, not the viewport. */}
        <div className="@container flex flex-1 flex-col gap-1.5 px-1.5 pt-3">
          {/* truncate: a long brand must not wrap and push this card's title
              below its neighbours'. */}
          <p className="eyebrow truncate text-muted-foreground">{product.brand || "Tokyo Store"}</p>

          {/* 2.5em = two lines at leading-tight, so one- and two-line titles
              take the same height and the rows below line up across a grid row. */}
          <h3 className="line-clamp-2 min-h-[2.5em] font-display text-[13px] font-semibold leading-tight text-foreground sm:text-sm">
            {product.title}
          </h3>

          {/* Facts as badges. Never a content-dependent wrap: when a narrow
              card's two badges didn't fit ("Précommande" 108px beside a rated
              badge in a 192px column at 1280), that card alone went 30px
              taller and a shelf's height changed as its tabs were switched.
              Below 13rem of column the two badges always stack, so every card
              at that width has the same height; from 13rem they always fit on
              one line (Aucun avis 90 + Précommande 108 + gap 6 = 204). */}
          <div className="flex flex-col items-start gap-1.5 @[13rem]:flex-row @[13rem]:items-center">
            {rating ? (
              <span className={cn(badge.base, badge.neutral)}>
                <Star aria-hidden className="size-3 fill-rating text-rating" />
                {rating}
                {/* The count only where it still fits beside the widest stock
                    badge on one line (rated ~95 + 108 + 6 = 209px). */}
                <span className="hidden text-muted-foreground @[15rem]:inline">({reviews})</span>
              </span>
            ) : (
              /* Not yet rated: keep the row's shape with a neutral badge rather
                 than leaving a gap or implying a score of zero. "Aucun avis"
                 rather than "Pas encore d'avis": at the 12px badge size the
                 longer label (128px) overflowed a 142px card at 320. */
              <span className={cn(badge.base, badge.muted)}>
                <Star aria-hidden className="size-3" />
                Aucun avis
              </span>
            )}
            <span
              className={cn(
                badge.base,
                oos ? badge.muted : preorder ? badge.accent : badge.success,
              )}
            >
              {/* The dot only shows when the card has room for it: "Précommande"
                  with its dot is 108px, exactly the text column of a 142px card
                  at 320. The badge's tint already carries the state. */}
              <span
                aria-hidden
                className={cn(
                  "hidden size-1.5 rounded-full @[7rem]:block",
                  oos ? "bg-muted-foreground" : preorder ? "bg-primary" : "bg-success",
                )}
              />
              {STOCK_LABEL[stock]}
            </span>
          </div>

          {/* Price + reduction */}
          <div className="mt-auto flex flex-wrap items-baseline gap-x-2 pt-2">
            <span className="text-lg font-bold leading-none tabular-nums text-primary">
              {fmtPrice(product.price)}
            </span>
            <span className="text-xs font-bold text-primary">TND</span>
            {strike && (
              <span className="text-[12px] leading-none text-muted-foreground line-through tabular-nums">
                {fmtPrice(strike.strike)}
              </span>
            )}
          </div>
        </div>
      </Link>

      {/* Full-width capsule CTA */}
      <button
        type="button"
        onClick={() => {
          if (oos) return;
          addToCart(product.slug, 1);
          setAdded(true);
          setTimeout(() => setAdded(false), 1500);
        }}
        disabled={oos}
        className={cn(
          btn.base,
          btn.sm,
          "relative mt-3 w-full overflow-hidden",
          /* Out of stock keeps full opacity: "Indisponible" is information, not a faded control. */
          oos
            ? "bg-muted text-muted-foreground disabled:opacity-100"
            : added
              ? "bg-success text-success-foreground"
              : btn.ink,
        )}
      >
        {/* Gloss: a soft, blurred highlight — diffused rather than a hard
            bevel, so the pill reads glassy instead of 3D. */}
        {!oos && (
          <>
            <span className="pointer-events-none absolute -top-5 left-1/2 h-9 w-[85%] -translate-x-1/2 rounded-[50%] bg-white/35 blur-lg" />
            <span className="pointer-events-none absolute -bottom-6 left-1/2 h-8 w-[60%] -translate-x-1/2 rounded-[50%] bg-white/10 blur-xl" />
          </>
        )}
        <span className="relative">
          {oos ? (
            "Indisponible"
          ) : added ? (
            <span className="inline-flex items-center justify-center gap-1.5">
              <Check aria-hidden className="size-4" /> Ajouté
            </span>
          ) : preorder ? (
            /* "Précommander" (89px) filled a 108px button at 320 (a 9px
               inset). Below the same 132px as "Ajouter" the whole rail
               switches to one-word labels together. A swap (display: none),
               not sr-only: the accessible name must contain the visible
               label (WCAG 2.5.3), and the card's "Précommande" badge already
               says what is being reserved. */
            <>
              <span className="@max-[8.25rem]/card:hidden">Précommander</span>
              <span className="hidden @max-[8.25rem]/card:inline">Réserver</span>
            </>
          ) : (
            /* The full label (101px) needs a 132px button (the card's content
               box, which the /card query measures) to sit inside its 16px
               padding. Narrower (the 44% phone rails up to 360, the 2-up grid
               at 320) it overran it: show "Ajouter" and keep the rest for
               screen readers, so the name stays "Ajouter au panier". */
            <>
              Ajouter
              <span className="@max-[8.25rem]/card:sr-only"> au panier</span>
            </>
          )}
        </span>
      </button>
    </div>
  );
}
