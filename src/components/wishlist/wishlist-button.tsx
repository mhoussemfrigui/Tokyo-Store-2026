"use client";

import { Heart } from "lucide-react";

import { cn } from "@/lib/utils";
import { track } from "@/lib/tracking/funnel";
import { useWishlist } from "./wishlist-provider";

/**
 * A heart toggle bound to the WishlistProvider. On the server and the first
 * client render the provider's set is empty, so the button starts inactive and
 * the server/client markup match (no hydration flash); it reflects real
 * membership once the provider hydrates its set on the client.
 */
export function WishlistButton({
  slug,
  variant = "overlay",
  className,
  product,
}: {
  slug: string;
  /** "overlay" = floating chip on a card image; "inline" = bordered button (PDP). */
  variant?: "overlay" | "inline";
  className?: string;
  /** Optional product detail so the GA4 add_to_wishlist event carries a real
   *  name + price instead of the slug placeholder. */
  product?: { id?: string; name: string; priceCents: number; brand?: string; category?: string };
}) {
  const wl = useWishlist();
  const active = wl?.has(slug) ?? false;

  const base =
    variant === "overlay"
      ? "grid h-9 w-9 place-items-center rounded-full bg-card/90 text-foreground shadow-soft backdrop-blur transition hover:bg-card"
      : "inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground transition hover:bg-surface";

  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={active ? "Retirer des favoris" : "Ajouter aux favoris"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // GA4 add_to_wishlist — only when adding (not on removal). Uses the real
        // product when the caller passes it; falls back to the slug otherwise.
        if (!active) {
          track("add_to_wishlist", {
            value_cents: product?.priceCents,
            items: [
              product
                ? {
                    // Product UUID when known — the GA4 item_id the PDP / cart /
                    // purchase events send; the slug is only a fallback.
                    item_id: product.id ?? slug,
                    item_name: product.name,
                    price_cents: product.priceCents,
                    quantity: 1,
                    item_brand: product.brand,
                    item_category: product.category,
                  }
                : { item_id: slug, item_name: slug, price_cents: 0, quantity: 1 },
            ],
          });
        }
        wl?.toggle(slug);
      }}
      className={cn(base, active && "text-rose-500", className)}
    >
      <Heart className={cn("h-4 w-4 transition", active && "fill-current")} strokeWidth={2} />
      {variant === "inline" && <span>{active ? "Dans vos favoris" : "Ajouter aux favoris"}</span>}
    </button>
  );
}
