"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Loader2, Plus, X } from "lucide-react";

import { addToCartBySlugAction, removeCartItemBySlugAction } from "@/lib/actions/cart";
import { useMoney } from "@/components/money-provider";
import { track, itemFromProduct, type FunnelItem } from "@/lib/tracking/funnel";
import { imageUrl } from "@/types/catalog";
import type { Product } from "@/types/catalog";

/** Build a GA4 funnel item from a storefront Product (list = "complementary"). */
function productToItem(product: Product): FunnelItem {
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
    item_list_name: "complementary",
  };
}

/**
 * "Accessoires Supplémentaires" — the PDP cross-sell row that lets a customer
 * complete their purchase with curated accessories. Distinct from the
 * "Vous aimerez aussi" rail: this is a MANUAL-only relation (resolved through
 * the `listComplementaryProducts` facade), shown as small horizontal cards with
 * a "+" quick-add. Renders null when empty so the PDP never shows an empty row.
 *
 * Presentational: the RSC parent passes médiathèque-resolved `Product[]`; each
 * card owns its own add-to-cart transition (via `<AccessoryCard>`) so money
 * formatting, cart wiring and funnel tracking match the rest of the storefront.
 */
export function ComplementaryProducts({ products }: { products: Product[] }) {
  if (products.length === 0) return null;

  return (
    <section className="mx-auto max-w-[1400px] px-5 pb-14 sm:pb-20 md:px-8 lg:px-12">
      {/* Subtle top separation from the section above. */}
      <div className="border-t border-border/40 pt-10 sm:pt-16">
        {/* Centered luxury header — same voice as the "Vous aimerez aussi" rail. */}
        <div className="tk-fade-in-up flex flex-col items-center text-center">
          <p className="mb-2 font-body text-[0.5rem] uppercase tracking-[0.35em] text-olive/70 md:mb-3 md:text-[0.6rem]">
            Complétez votre achat
          </p>
          <h2 className="font-serif text-2xl text-foreground md:text-3xl lg:text-4xl">
            Produits <span className="font-normal italic">Supplémentaires</span>
          </h2>
          <div className="luxury-divider mt-4 max-w-[60px] md:mt-5" />
        </div>

        {products.length > 4 ? (
          <ComplementaryCarousel products={products} />
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-4 sm:mt-12 sm:grid-cols-2 md:gap-5 lg:grid-cols-4">
            {products.map((p) => (
              <AccessoryCard key={p.slug} product={p} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Autoplay cadence for the accessories carousel. */
const AUTOPLAY_MS = 4000;

/**
 * Scroll-snap carousel used when there are more than 4 accessories — the same
 * free-scroll/swipe track pattern as the home ProductRail. AUTOPLAYS (advances
 * one card every {@link AUTOPLAY_MS}, looping back at the end), PAUSES while the
 * pointer is over the rail, and respects `prefers-reduced-motion`. Arrow
 * controls are overlaid on the rail's SIDES (vertically centred) and fade out at
 * the track ends. Each card is the same {@link AccessoryCard} (~1 on mobile, 2
 * on sm, 4 on lg).
 */
function ComplementaryCarousel({ products }: { products: Product[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const [edges, setEdges] = useState({ start: true, end: false });

  const cardStep = useCallback(() => {
    const el = trackRef.current;
    if (!el) return 0;
    const first = el.querySelector<HTMLElement>("[data-rail-item]");
    return first ? first.offsetWidth + 16 : el.clientWidth * 0.8;
  }, []);

  const scrollByCard = useCallback(
    (dir: 1 | -1) => {
      trackRef.current?.scrollBy({ left: dir * cardStep(), behavior: "smooth" });
    },
    [cardStep],
  );

  const updateEdges = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft >= el.scrollWidth - el.clientWidth - 2;
    setEdges((p) => (p.start === start && p.end === end ? p : { start, end }));
  }, []);

  // Edge tracking (arrow fade) + re-measure on resize.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    updateEdges();
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateEdges, products.length]);

  // Autoplay — paused on hover, skipped for reduced-motion users.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => {
      if (pausedRef.current) return;
      const atEnd = el.scrollLeft >= el.scrollWidth - el.clientWidth - 2;
      el.scrollBy({ left: atEnd ? -el.scrollLeft : cardStep(), behavior: "smooth" });
    }, AUTOPLAY_MS);
    return () => clearInterval(id);
  }, [cardStep, products.length]);

  // Arrows sit in SIDE LANES beside the cards (never overlapping them): the
  // track reserves `md:mx-14` of room and each arrow parks at the wrapper edge.
  // Below md there's no room for lanes, so the rail is swipe-only (arrows hidden).
  const arrowBase =
    "absolute top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-border/60 bg-card text-foreground shadow-lift transition-all duration-300 hover:border-primary/40 hover:text-primary md:grid";

  return (
    <div
      className="relative mt-8 sm:mt-12"
      onMouseEnter={() => {
        pausedRef.current = true;
      }}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
    >
      <div
        ref={trackRef}
        onScroll={updateEdges}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none] md:mx-14 [&::-webkit-scrollbar]:hidden"
      >
        {products.map((p) => (
          <div
            key={p.slug}
            data-rail-item
            className="w-[82%] shrink-0 snap-start sm:w-[calc((100%-1rem)/2)] lg:w-[calc((100%-3rem)/4)]"
          >
            <AccessoryCard product={p} />
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => scrollByCard(-1)}
        aria-label="Précédent"
        className={`${arrowBase} left-0 ${edges.start ? "pointer-events-none opacity-0" : "opacity-100"}`}
      >
        <ChevronLeft className="h-5 w-5" strokeWidth={1.7} />
      </button>
      <button
        type="button"
        onClick={() => scrollByCard(1)}
        aria-label="Suivant"
        className={`${arrowBase} right-0 ${edges.end ? "pointer-events-none opacity-0" : "opacity-100"}`}
      >
        <ChevronRight className="h-5 w-5" strokeWidth={1.7} />
      </button>
    </div>
  );
}

/**
 * A single accessory card. The absolute button is a QUICK-ADD TOGGLE: it shows
 * "+" until clicked (adds to cart), then "✕" so the shopper can REMOVE it in the
 * same spot (both wired through the slug cart actions). `h-full` + the flex/grid
 * parent's stretch keep every card the SAME height regardless of name length.
 * The card body links to the PDP; the button stops propagation.
 */
function AccessoryCard({ product: p }: { product: Product }) {
  const money = useMoney();
  const [pending, startTransition] = useTransition();
  const [added, setAdded] = useState(false);
  const [errored, setErrored] = useState(false);
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashError = () => {
    setErrored(true);
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setErrored(false), 2000);
  };

  return (
    <div className="group relative flex h-full items-center gap-3.5 rounded-2xl border border-border/50 bg-card/40 p-3 transition-all duration-300 hover:border-primary/25 hover:bg-card/70 md:gap-4 md:p-3.5">
      <Link href={`/${p.slug}`} className="flex min-w-0 flex-1 items-center gap-3.5 md:gap-4">
        <div className="grid h-[4.25rem] w-[4.25rem] shrink-0 place-items-center overflow-hidden rounded-xl border border-border/40 bg-muted p-1.5">
          <Image
            src={imageUrl(p.image)}
            alt={p.imageAlt ?? p.name}
            width={80}
            height={80}
            className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-105"
          />
        </div>
        <div className="min-w-0 flex-1 pr-6">
          {p.brand && (
            <p className="mb-1 line-clamp-1 font-body text-[0.55rem] uppercase tracking-[0.18em] text-olive/80">
              {p.brand}
            </p>
          )}
          <h4 className="mb-1.5 line-clamp-2 font-serif text-[0.9rem] leading-snug text-foreground md:text-[0.95rem]">
            {p.name}
          </h4>
          <p className="font-body text-sm font-semibold tabular-nums text-primary">
            {money.fromMinor(p.priceCents)}
          </p>
        </div>
      </Link>

      <button
        type="button"
        disabled={pending}
        aria-label={added ? "Retirer du panier" : "Ajouter au panier"}
        aria-pressed={added}
        title={errored ? "Échec — réessayez" : added ? "Retirer du panier" : "Ajouter au panier"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          startTransition(async () => {
            if (added) {
              const res = await removeCartItemBySlugAction(p.slug);
              if (res.ok) setAdded(false);
              else flashError();
              return;
            }
            const res = await addToCartBySlugAction(p.slug);
            if (res.ok) {
              setAdded(true);
              track("add_to_cart", {
                value_cents: p.priceCents,
                items: [{ ...productToItem(p), quantity: 1 }],
              });
            } else {
              flashError();
            }
          });
        }}
        className={`absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full border transition-all duration-300 ${
          errored
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : added
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border/50 text-muted-foreground/55 hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
        }`}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
        ) : added || errored ? (
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
        )}
      </button>
    </div>
  );
}
