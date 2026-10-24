"use client";

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Film,
  Heart,
  Home,
  Loader2,
  MapPin,
  Phone,
  Play,
  Share2,
  ShieldCheck,
  ShoppingBag,
  Star,
  Store,
  Truck,
  Undo2,
  Zap,
} from "lucide-react";

import { CatalogProductCard } from "@/storefront/components/storefront/product-card";
import { QuickBuyForm, type QuickBuyPrefill } from "@/storefront/components/storefront/quick-buy-form";
import { submitReviewAction } from "@/lib/actions/reviews";
import type { ActionState } from "@/lib/actions/types";
import { SelectField } from "@/components/ui/select-field";
import { addToCart, planById, protectionPlans, useShippingConfig } from "@/storefront/lib/cart";
import { useTaxMode, taxCaption } from "@/storefront/lib/tax-config";
import { categoryTrail, taxonomyLabel } from "@/storefront/lib/categoryNav";
import { toggleFavorite, useIsFavorite } from "@/storefront/lib/favorites";
import {
  conditionLabel,
  fmtPrice,
  isOrderable,
  productSpecs,
  productStrike,
  productWarranty,
  stockState,
  STOCK_LABEL,
} from "@/storefront/lib/productMeta";
import { TrustBand } from "./trust-band";
import type { Product, ProductReview, ProductReviewSummary, ProductSpec } from "@/storefront/types/catalog";

/* The design palette (matches the Tokyo tokens) — kept as explicit values so the
   PDP renders pixel-faithfully to the approved mockup. */
const INK = "#0e1218";
// Brand accent routes through the theme token so an admin brand-color change
// (buildThemeCss → .tokyo{--primary}) re-skins the PDP. Used in `style={{}}`
// (CSS vars resolve) — SVG `fill=`/`stroke=` ATTRIBUTES can't resolve a var(),
// so those spots use `currentColor` against a var-driven `color` instead.
const CRIMSON = "var(--primary)";
const PAPER = "#f6f2ed";

/* ───────────────────────────────────────────────── helpers */

/** Last-resort slug → human label, used only when the live taxonomy
 *  (`taxonomyLabel`) carries no name for a category slug. "iphones-neufs" →
 *  "Iphones Neufs". Pure; no catalogue dependency. */
function prettySlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Flatten a characteristic to a single display string (all attribute kinds). */
function specValue(s: ProductSpec): string {
  if (s.text != null && s.text !== "") return s.text;
  return s.values.map((v) => v.label).join(", ");
}

/** The "Caractéristiques clés" bullet cards — BACKEND ONLY, in priority order:
 *   1. the operator-curated highlights (Catalogue → Produits → Caractéristiques clés) —
 *      ordered and VARIABLE count, rendered in full (no cap);
 *   2. else the product's real characteristics (Catalogue → Attributs), first few.
 *   Neither present ⇒ EMPTY (the feature-card grid is hidden; no invented bullets). */
function keyFeatures(product: Product): { label: string; swatch: string | null }[] {
  const highlights = product.highlights ?? [];
  if (highlights.length > 0) {
    return highlights.map((label) => ({ label, swatch: null }));
  }
  const specs = product.specs ?? [];
  if (specs.length > 0) {
    return specs.slice(0, 4).map((s) => ({
      label: `${s.name} : ${specValue(s)}`,
      swatch: s.kind === "color" ? (s.values[0]?.colorHex ?? null) : null,
    }));
  }
  return [];
}

/** Full "Descriptif technique" rows — standard product facts + every characteristic. */
function techSpecs(product: Product): { label: string; value: string; swatch?: string | null }[] {
  const base = productSpecs(product);
  const attrs = (product.specs ?? []).map((s) => ({
    label: s.name,
    value: specValue(s),
    swatch: s.kind === "color" ? (s.values[0]?.colorHex ?? null) : null,
  }));
  return [...base, ...attrs];
}

/** A physical in-store pickup point (delivery backend → Commandes → Livraison). */
type PickupPoint = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  hours: string | null;
  /** Pickup fee in dinars (0 = free). */
  fee: number;
};

/** A home-delivery carrier (transporteur). `fee` is null when it inherits the global rate. */
type Carrier = { id: string; name: string; zone: string | null; fee: number | null };

/** Who-can-review context (resolved server-side from the session + review policy). */
type ReviewAuth = {
  enabled: boolean;
  signedIn: boolean;
  /** Viewer already has a live (pending/approved) review → form hidden. */
  alreadyReviewed: boolean;
  /** Viewer's previous review was rejected → form shown again with a notice. */
  previouslyRejected: boolean;
  policy: "all" | "buyers_only";
  requireApproval: boolean;
};

/* ───────────────────────────────────────────────── main view */

export function ProductView({
  product,
  related,
  alsoViewed,
  complementary = [],
  phone = null,
  pickups = [],
  carriers = [],
  reviews = [],
  reviewSummary,
  reviewAuth,
  prefill = null,
}: {
  product: Product;
  related: Product[];
  alsoViewed: Product[];
  /** Curated "Complétez votre achat" accessories (admin Produits → Produits
   *  supplémentaires). Backend-only; empty ⇒ the rail is hidden. */
  complementary?: Product[];
  phone?: string | null;
  pickups?: PickupPoint[];
  carriers?: Carrier[];
  reviews?: ProductReview[];
  reviewSummary?: ProductReviewSummary;
  reviewAuth?: ReviewAuth;
  /** Signed-in customer's details to pre-fill « Achat rapide ». */
  prefill?: QuickBuyPrefill | null;
}) {
  const axes = product.variantAxes ?? [];
  const combos = product.variantCombos ?? [];
  const colorAxis = axes.find((a) => a.kind === "color");

  /* Default selection: the admin default (if in stock) → first in-stock → first. */
  const defaultCombo = useMemo(
    () => combos.find((c) => c.isDefault && c.inStock) ?? combos.find((c) => c.inStock) ?? combos[0],
    [combos],
  );
  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (defaultCombo) {
      for (const ax of axes) {
        const v = ax.values.find((val) => defaultCombo.optionValueIds.includes(val.id));
        if (v) init[ax.attributeId] = v.id;
      }
    }
    return init;
  });

  const currentCombo = useMemo(
    () =>
      axes.length === 0
        ? undefined
        : combos.find((c) => axes.every((ax) => c.optionValueIds.includes(selected[ax.attributeId] ?? ""))),
    [axes, combos, selected],
  );

  /** A value is selectable when some in-stock combo carries it alongside the other
   *  currently-selected axis values. */
  const valueAvailable = useCallback(
    (axisId: string, valueId: string) =>
      combos.some(
        (c) =>
          c.inStock &&
          c.optionValueIds.includes(valueId) &&
          axes.every((o) => o.attributeId === axisId || c.optionValueIds.includes(selected[o.attributeId] ?? "")),
      ),
    [axes, combos, selected],
  );

  /* Gallery — product images, with any per-variant images merged in. */
  const baseImages = useMemo(() => {
    const imgs = product.images && product.images.length > 0 ? product.images : [product.image];
    const extra = combos.map((c) => c.image).filter((u): u is string => !!u);
    return Array.from(new Set([...imgs, ...extra])).filter(Boolean);
  }, [product.images, product.image, combos]);

  const [img, setImg] = useState(0);
  const gallery = baseImages.length > 0 ? baseImages : [product.image];
  const n = gallery.length;

  const selectValue = (axisId: string, valueId: string) => {
    setSelected((s) => ({ ...s, [axisId]: valueId }));
    // Jump the gallery to the newly-selected combo's image, when it has one.
    const nextSel = { ...selected, [axisId]: valueId };
    const combo = combos.find((c) => axes.every((ax) => c.optionValueIds.includes(nextSel[ax.attributeId] ?? "")));
    if (combo?.image) {
      const idx = gallery.indexOf(combo.image);
      if (idx >= 0) setImg(idx);
    }
  };

  const step = (d: number) => setImg((i) => (n > 0 ? (i + d + n) % n : 0));

  /* Mobile gallery swipe — natural left/right flick swaps the image (40px
     threshold so taps on the arrows/thumbs still register). Refs hold the
     per-gesture delta so dragging doesn't thrash React state. */
  const touchStartX = useRef<number | null>(null);
  const touchDeltaX = useRef(0);
  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchDeltaX.current = 0;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    touchDeltaX.current = (e.touches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
  };
  const onTouchEnd = () => {
    const d = touchDeltaX.current;
    touchStartX.current = null;
    touchDeltaX.current = 0;
    if (Math.abs(d) <= 40 || n <= 1) return;
    step(d < 0 ? 1 : -1);
  };

  /* Price / availability — variant overrides product when a combo is resolved. */
  const price = currentCombo?.price ?? product.price;
  const strike = productStrike({ price, oldPrice: product.oldPrice });
  // Précommande: "backorder" is Tokyo's active-preorder state — orderable, but the
  // CTA + a release note signal that it ships later (units are reserved, not sold now).
  // It is a PRODUCT-level policy (the backend reserves at product level whatever
  // variant is chosen), so a resolved combo must NOT collapse it to plain in/out —
  // otherwise selecting a variant silently dropped the "Précommander" CTA + release
  // note while checkout still reserved the line.
  const productStock = stockState(product);
  const stock =
    productStock === "backorder"
      ? "backorder"
      : currentCombo
        ? currentCombo.inStock
          ? "in_stock"
          : "out_of_stock"
        : productStock;
  const preorder = stock === "backorder";
  const orderable = preorder ? true : currentCombo ? currentCombo.inStock : isOrderable(product);
  const preorderReleaseLabel = product.preorderReleasesAt
    ? new Date(product.preorderReleasesAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" })
    : null;

  /* Quantity (respects the backend min/max). */
  const minQty = Math.max(1, product.minPurchaseQty ?? 1);
  const maxQty = Math.max(minQty, product.maxPurchaseQty ?? 10);
  const [qty, setQty] = useState(minQty);

  /* Care (preserved — only shown when the backend offers plans for this product). */
  const plans = useMemo(() => protectionPlans(product), [product]);
  const [planId, setPlanId] = useState<string | null>(null);
  const selectedPlan = planById(product, planId);

  /* Global home-delivery rate — shown on the carrier card in « Retrait & livraison ». */
  const shipping = useShippingConfig();
  /* Honest TVA caption — only when the store actually runs tax-inclusive/HT, never
     in the default disabled mode (no VAT ⇒ no "TVA incluse" claim). */
  const taxNote = taxCaption(useTaxMode());

  /* Wishlist + add-to-cart feedback + quick-buy + toast + sticky bar. */
  const fav = useIsFavorite(product.slug);
  const [added, setAdded] = useState(false);
  const [quickBuy, setQuickBuy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sticky, setSticky] = useState(false);
  // Mobile/tablet switchable buy bar: user can PEEK it down to reveal the normal
  // bottom nav, and restore it via a chip (Game-Zone structure, Tokyo design).
  const [barPeeked, setBarPeeked] = useState(false);
  const addTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buyRef = useRef<HTMLDivElement | null>(null);
  const descRef = useRef<HTMLElement | null>(null);
  const storesRef = useRef<HTMLElement | null>(null);

  const doAdd = () => {
    if (!orderable) return;
    addToCart(product.slug, qty, planId);
    setAdded(true);
    setToast(`${qty} × ${product.title}`);
    if (addTimer.current) clearTimeout(addTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    addTimer.current = setTimeout(() => setAdded(false), 2200);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  useEffect(() => {
    const onScroll = () => {
      const el = buyRef.current;
      if (el) setSticky(el.getBoundingClientRect().bottom < 0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(
    () => () => {
      if (addTimer.current) clearTimeout(addTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  /* Lock body scroll while the MOBILE quick-buy sheet is open (desktop morphs
     the buy box in place and keeps its page scroll, so this is gated to < lg).
     The form owns its own Escape-to-close, so only the scroll lock lives here. */
  useEffect(() => {
    if (!quickBuy || typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [quickBuy]);

  const scrollTo = (ref: React.RefObject<HTMLElement | null>) => {
    const el = ref.current;
    // Offset clears the fixed top-nav pill so the target heading isn't hidden under it.
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 96, behavior: "smooth" });
  };

  /* Breadcrumb — full category chain (Accueil › universe › … › LEAF). `categoryTrail`
     returns the ancestors WITHOUT the leaf (chain.slice(0,-1)), so append the product's
     own leaf category as the final (highlighted) crumb. Products with NO category (or an
     unknown slug) yield an empty trail — the breadcrumb then shows just the Accueil home
     icon, never a dangling empty pill. */
  const trail = [
    ...categoryTrail(product.category),
    ...(product.category
      ? [{ slug: product.category, label: taxonomyLabel(product.category) ?? prettySlug(product.category) }]
      : []),
  ].filter((c) => c.slug && c.label);
  const cond = conditionLabel(product.condition);
  // Backend-only: null when the product has no resolved warranty ⇒ the badge + the
  // service-band warranty tile are omitted (no fabricated guarantee).
  const warranty = productWarranty(product);
  // Backend-only per-product FAQ (admin Catalogue → Produits → FAQ). Empty ⇒ the FAQ
  // section is hidden entirely (no templated fallback, no fabricated FAQPage schema).
  const faqs = product.faq ?? [];
  const features = keyFeatures(product);
  const specs = techSpecs(product);
  const longParas = (product.description ?? product.shortDesc ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const [descOpen, setDescOpen] = useState(false);

  const addLabel = added
    ? "Ajouté au panier"
    : !orderable
      ? "Indisponible"
      : preorder
        ? "Précommander"
        : "Ajouter au panier";
  const curImg = gallery[img] ?? product.image;

  return (
    <div className="w-full" style={{ background: PAPER, color: INK }}>
      {/* The floating buy bar's footer clearance is handled by the global
          data-buy-bar rule; <main>'s pb is the single content→footer gap. */}
      {/* One uniform vertical rhythm between ALL top-level sections (no per-section
          pt-* ad-hoc gaps — see the sections below), so the page reads evenly. */}
      <div className="page-container flex w-full flex-col gap-8 pt-3 lg:gap-12">
        {/* Breadcrumb pill — MOBILE/TABLET only, its own pill above the image
            (desktop keeps the breadcrumb inside the buy-box card). */}
        {trail.length > 0 && (
          <nav
            aria-label="Fil d'Ariane"
            className="flex min-w-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap rounded-full bg-white px-3 py-2 text-[12px] [scrollbar-width:none] lg:hidden"
          >
            <Link
              href="/"
              aria-label="Accueil"
              className="flex h-[26px] w-[26px] flex-[0_0_26px] items-center justify-center rounded-full text-[#0e1218] hover:text-primary"
              style={{ background: PAPER }}
            >
              <Home size={13} />
            </Link>
            {trail.map((c, i) => {
              const last = i === trail.length - 1;
              return (
                <span key={c.slug} className="flex min-w-0 items-center gap-1.5">
                  <ChevronRight size={11} className="flex-[0_0_11px] text-[#c9c2ba]" />
                  <Link
                    href={`/${c.slug}`}
                    className={
                      last
                        ? "flex-[0_0_auto] rounded-full bg-[color-mix(in_oklab,var(--primary)_14%,transparent)] px-2.5 py-1 font-semibold text-primary"
                        : "flex-[0_1_auto] px-0.5 py-1 text-[#5b5d62] hover:text-primary"
                    }
                  >
                    {taxonomyLabel(c.slug) ?? c.label ?? prettySlug(c.slug)}
                  </Link>
                </span>
              );
            })}
          </nav>
        )}

        {/* 1 ─ PRODUCT STAGE */}
        <section className="flex flex-wrap items-stretch gap-5">
          {/* Gallery */}
          <div
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            className="relative flex min-h-[58vh] flex-[1.4_1_560px] touch-pan-y flex-col justify-between overflow-hidden rounded-[28px] bg-white p-4 sm:rounded-[36px] sm:p-7 lg:min-h-[min(78vh,760px)]"
          >
            <div className="relative z-[2] flex items-start justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-[#0e1218] px-[13px] py-[7px] text-[12px] font-bold text-white">
                  {cond}
                </span>
                {warranty && (
                  <span className="rounded-full px-[13px] py-[7px] text-[12px] font-bold" style={{ background: PAPER }}>
                    {warranty.title}
                  </span>
                )}
              </div>
              <div className="flex gap-2.5">
                <button
                  onClick={() => toggleFavorite(product.slug)}
                  aria-label="Ajouter aux favoris"
                  aria-pressed={fav}
                  className="flex h-[46px] w-[46px] items-center justify-center rounded-full border border-[#ece6df] bg-white transition-transform hover:scale-105"
                  style={{ color: fav ? CRIMSON : INK }}
                >
                  <Heart size={18} fill={fav ? "currentColor" : "none"} />
                </button>
                <button
                  aria-label="Partager"
                  onClick={() => {
                    if (typeof navigator !== "undefined" && navigator.share) {
                      void navigator.share({ title: product.title, url: `/${product.slug}` }).catch(() => {});
                    }
                  }}
                  className="flex h-[46px] w-[46px] items-center justify-center rounded-full border border-[#ece6df] bg-white text-[#0e1218]"
                >
                  <Share2 size={17} />
                </button>
              </div>
            </div>

            {/* Colour spine — vertical labels of the colour axis (if any). */}
            {colorAxis && colorAxis.values.length > 1 && (
              <div className="absolute bottom-28 left-1.5 top-24 z-[3] flex w-7 flex-col items-center justify-center gap-3 overflow-y-auto [scrollbar-width:none] sm:bottom-[118px] sm:left-[22px] sm:top-[128px] sm:w-9 sm:gap-3.5">
                {colorAxis.values.map((v) => {
                  const on = selected[colorAxis.attributeId] === v.id;
                  const avail = valueAvailable(colorAxis.attributeId, v.id);
                  return (
                    <button
                      key={v.id}
                      onClick={() => avail && selectValue(colorAxis.attributeId, v.id)}
                      disabled={!avail}
                      className="shrink-0 whitespace-nowrap border-none bg-transparent p-0 text-[15px] font-black leading-none tracking-[-.03em] transition-colors hover:text-[#0e1218] [writing-mode:vertical-rl]"
                      style={{
                        transform: "rotate(180deg)",
                        color: on ? INK : avail ? "#e4ddd5" : "#efebe6",
                        textDecoration: avail ? "none" : "line-through",
                      }}
                    >
                      {v.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Image */}
            <div className="absolute inset-x-12 bottom-28 top-16 flex items-center justify-center sm:inset-x-[72px] sm:bottom-[118px] sm:top-20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={curImg}
                alt={product.imageAlt ?? product.title}
                draggable={false}
                className="max-h-full max-w-[min(78%,560px)] select-none object-contain"
              />
            </div>

            {n > 1 && (
              <>
                <button
                  onClick={() => step(-1)}
                  aria-label="Image précédente"
                  className="absolute left-2 top-1/2 z-[4] flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[#ece6df] bg-white text-[20px] text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white sm:left-[72px] sm:h-[46px] sm:w-[46px]"
                >
                  ‹
                </button>
                <button
                  onClick={() => step(1)}
                  aria-label="Image suivante"
                  className="absolute right-2 top-1/2 z-[4] flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[#ece6df] bg-white text-[20px] text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white sm:right-[18px] sm:h-[46px] sm:w-[46px]"
                >
                  ›
                </button>
              </>
            )}

            {/* Counter + thumbs — DESKTOP/tablet (lg); mobile uses dots below. */}
            <div className="relative z-[2] hidden min-w-0 items-center gap-3 lg:flex">
              <span
                className="shrink-0 rounded-full px-3 py-[7px] text-[13px] font-bold tabular-nums text-[#0e1218]"
                style={{ background: PAPER }}
              >
                {img + 1} / {n}
              </span>
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto px-0.5 py-[3px] [scrollbar-width:none]">
                {gallery.map((src, i) => (
                  <button
                    key={src + i}
                    onClick={() => setImg(i)}
                    aria-label={`Image ${i + 1}`}
                    className="h-[68px] flex-[0_0_68px] rounded-[18px] border-2 bg-white p-[5px] transition-opacity"
                    style={{ borderColor: i === img ? INK : "#ece6df", opacity: i === img ? 1 : 0.7 }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="" className="h-full w-full object-contain" />
                  </button>
                ))}
              </div>
            </div>

            {/* Dot indicators — MOBILE only (the swipe-friendly pattern; the
                active dot stretches into a pill). */}
            {n > 1 && (
              <div className="relative z-[2] flex items-center justify-center gap-2 lg:hidden">
                {gallery.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setImg(i)}
                    aria-label={`Image ${i + 1}`}
                    aria-current={i === img}
                    className="h-2 rounded-full transition-all duration-300"
                    style={{ width: i === img ? 24 : 8, background: i === img ? INK : "#d8cfc4" }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Buy box — on mobile/tablet it is a TRANSPARENT column of separate
              "pills" (each group gets its own white card via lg:contents wrappers
              below); on desktop (lg) it collapses back into ONE white card. */}
          <aside className="flex min-w-0 flex-[1_1_400px] flex-col gap-4 lg:gap-[22px] lg:rounded-[36px] lg:bg-white lg:p-[clamp(22px,3vw,36px)]">
            {/* Breadcrumb — DESKTOP only here (mobile shows a breadcrumb pill above
                the image). */}
            <nav
              aria-label="Fil d'Ariane"
              className="hidden min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap border-b border-[#efe9e3] pb-[18px] text-[13px] lg:flex"
            >
              <Link
                href="/"
                aria-label="Accueil"
                className="flex h-[30px] w-[30px] flex-[0_0_30px] items-center justify-center rounded-full text-[#0e1218] hover:text-primary"
                style={{ background: PAPER }}
              >
                <Home size={14} />
              </Link>
              {trail.map((c, i) => {
                const last = i === trail.length - 1;
                return (
                  <span key={c.slug} className="flex min-w-0 items-center gap-1.5">
                    <ChevronRight size={12} className="flex-[0_0_12px] text-[#c9c2ba]" />
                    <Link
                      href={`/${c.slug}`}
                      className={
                        last
                          ? "flex-[0_0_auto] rounded-full bg-[color-mix(in_oklab,var(--primary)_14%,transparent)] px-3 py-[5px] font-semibold text-primary"
                          : "min-w-0 flex-[0_1_auto] overflow-hidden text-ellipsis px-0.5 py-1 text-[#5b5d62] hover:text-primary"
                      }
                    >
                      {taxonomyLabel(c.slug) ?? c.label ?? prettySlug(c.slug)}
                    </Link>
                  </span>
                );
              })}
            </nav>

            {/* Quick-buy on DESKTOP morphs the buy box in place; on MOBILE the
                buy box stays put and the form opens as a bottom sheet (below),
                so the page never jumps the shopper down to a detached form. */}
            {quickBuy && (
              <div className="hidden lg:block">
                <QuickBuyForm
                  product={product}
                  qty={qty}
                  carePlanId={planId}
                  variantId={currentCombo?.id ?? null}
                  unitPrice={price}
                  onClose={() => setQuickBuy(false)}
                  initial={prefill}
                />
              </div>
            )}
            {/* Buy box — always shown on mobile; hidden on desktop while the
                inline quick-buy form is open. `contents` keeps the inner pills
                as direct flex children of the <aside> (desktop layout intact). */}
            <div className={quickBuy ? "contents lg:hidden" : "contents"}>
            {/* ── Pill: title + rating + price. White card on mobile; on desktop
                `lg:contents` dissolves this wrapper so the buy-box <aside> card
                layout is unchanged. Every mobile restyle is paired with an lg:
                restore, and the price is split into a mobile hero (lg:hidden) +
                the byte-for-byte original desktop block (hidden lg:flex) so
                desktop stays pixel-identical. ── */}
            <div className="flex flex-col gap-4 rounded-[28px] bg-white p-5 lg:contents">
              {/* Brand + title + rating group — keeps `flex flex-col gap-3` on
                  both viewports so the desktop child order/rhythm is identical. */}
              <div className="flex flex-col gap-3">
                {/* Eyebrow (brand ↔ stock). On MOBILE it renders ONLY when a brand
                    exists; with no brand it is `hidden lg:flex`, so the card no
                    longer opens on an empty span + a lone far-right badge. DESKTOP
                    unchanged — brand left, stock right, justify-between. */}
                <div className={`${product.brand ? "flex" : "hidden lg:flex"} items-center justify-between gap-2.5`}>
                  {product.brand ? (
                    product.brandSlug ? (
                      <Link
                        href={`/${product.brandSlug}`}
                        className="text-[12px] font-extrabold uppercase tracking-[.16em] hover:text-primary"
                      >
                        {product.brand}
                      </Link>
                    ) : (
                      <span className="text-[12px] font-extrabold uppercase tracking-[.16em]">{product.brand}</span>
                    )
                  ) : (
                    <span />
                  )}
                  <StockBadge state={stock} />
                </div>
                <h1 className="m-0 text-[22px] font-extrabold leading-[1.2] tracking-[-.02em] [text-wrap:balance] lg:text-[clamp(30px,3.2vw,44px)] lg:leading-[1.04] lg:tracking-[-.03em]">
                  {product.title}
                </h1>
                {/* Meta line: rating, plus the stock badge on MOBILE only when
                    there's no brand (so availability is never lost). DESKTOP shows
                    just the rating — the badge lives in the eyebrow above. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <RatingLine product={product} />
                  {!product.brand && (
                    <span className="lg:hidden">
                      <StockBadge state={stock} />
                    </span>
                  )}
                </div>
                {longParas.length > 0 && (
                  <p className="m-0 text-[13.5px] leading-[1.55] text-[#5b5d62] [text-wrap:pretty] lg:mt-1 lg:text-[15px] lg:leading-[1.6] lg:text-[#3d4046]">
                    {product.shortDesc || longParas[0]}{" "}
                    <button
                      onClick={() => scrollTo(descRef)}
                      className="border-none bg-transparent p-0 text-[13.5px] font-bold text-[#0e1218] underline underline-offset-[3px] lg:text-[15px]"
                    >
                      Voir la description
                    </button>
                  </p>
                )}
              </div>

              {/* ── Price — MOBILE hero (lg:hidden). A hairline above sets it apart
                  as THE decision point. On sale: struck old price + a tasteful
                  "-pct%" pill on a quiet row above; then the big crimson number
                  with "TND" beside it; then "TVA incluse" as a small caption. ── */}
              <div className="flex flex-col gap-1.5 border-t border-[#efe9e3] pt-4 lg:hidden">
                {strike ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] text-[#9a938a] line-through">{fmtPrice(strike.strike)} TND</span>
                    <span
                      className="rounded-full px-2 py-[3px] text-[12px] font-extrabold leading-none"
                      style={{ background: "color-mix(in oklab, var(--primary) 14%, transparent)", color: CRIMSON }}
                    >
                      -{strike.pct}%
                    </span>
                  </div>
                ) : null}
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[42px] font-black leading-[0.95] tracking-[-.03em] tabular-nums" style={{ color: CRIMSON }}>
                    {fmtPrice(price)}
                  </span>
                  <span className="text-[17px] font-extrabold" style={{ color: CRIMSON }}>
                    TND
                  </span>
                </div>
                {taxNote && <span className="text-[11.5px] font-medium text-[#9a938a]">{taxNote}</span>}
              </div>

              {/* ── Price — DESKTOP (hidden lg:flex): byte-for-byte the original
                  inline block, so desktop stays pixel-identical. ── */}
              <div className="hidden flex-wrap items-baseline gap-x-2 gap-y-1 lg:flex">
                <span className="text-[34px] font-black leading-none tracking-[-.03em] lg:text-[56px] lg:tracking-[-.04em]" style={{ color: CRIMSON }}>
                  {fmtPrice(price)}
                </span>
                <span className="text-[15px] font-extrabold lg:text-[18px]" style={{ color: CRIMSON }}>
                  TND
                </span>
                {strike ? (
                  <span className="ml-1 text-[13px] text-[#9a938a] line-through lg:ml-1.5 lg:text-[15px]">{fmtPrice(strike.strike)} TND</span>
                ) : null}
                {taxNote && <span className="ml-1 text-[12px] text-[#5b5d62] lg:ml-1.5 lg:text-[13px]">{taxNote}</span>}
              </div>
            </div>
            {/* ── end title+price pill ── */}

            {/* Variant axes — wrapped as their own mobile pill (dissolves on lg). */}
            {axes.length > 0 && (
            <div className="flex flex-col gap-5 rounded-[28px] bg-white p-5 lg:contents">
            {axes.map((ax) => {
              const selId = selected[ax.attributeId];
              const selLabel = ax.values.find((v) => v.id === selId)?.label ?? "—";
              const availCount = ax.values.filter((v) => valueAvailable(ax.attributeId, v.id)).length;
              return (
                <div key={ax.attributeId} className="flex flex-col gap-3">
                  <div className="flex items-baseline justify-between gap-2.5">
                    <span className="text-[14px]">
                      <span className="text-[#5b5d62]">{ax.name} :</span> <strong>{selLabel}</strong>
                    </span>
                    <span className="text-[13px] text-[#5b5d62]">
                      {ax.values.length} {ax.values.length > 1 ? "options" : "option"}
                      {availCount < ax.values.length ? ` · ${availCount} disponibles` : ""}
                    </span>
                  </div>
                  {ax.kind === "color" ? (
                    <div className="grid max-w-[440px] grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-2">
                      {ax.values.map((v) => {
                        const on = selId === v.id;
                        const avail = valueAvailable(ax.attributeId, v.id);
                        return (
                          <button
                            key={v.id}
                            onClick={() => avail && selectValue(ax.attributeId, v.id)}
                            disabled={!avail}
                            title={avail ? v.label : `${v.label} — indisponible`}
                            aria-label={v.label}
                            className="relative aspect-square w-full max-w-[52px] rounded-full border-2 bg-white p-1 transition-transform hover:scale-105"
                            style={{ borderColor: on ? INK : "#ece6df", cursor: avail ? "pointer" : "not-allowed" }}
                          >
                            <span
                              className="block h-full w-full rounded-full"
                              style={{
                                background: v.colorHex ?? "#d9d9de",
                                boxShadow: "inset 0 0 0 1px rgba(0,0,0,.1)",
                                opacity: avail ? 1 : 0.45,
                              }}
                            />
                            {!avail && (
                              <span
                                className="absolute left-1/2 top-1/2 h-0.5 w-[120%] bg-[#5b5d62]"
                                style={{ transform: "translate(-50%,-50%) rotate(-45deg)" }}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {ax.values.map((v) => {
                        const on = selId === v.id;
                        const avail = valueAvailable(ax.attributeId, v.id);
                        return (
                          <button
                            key={v.id}
                            onClick={() => avail && selectValue(ax.attributeId, v.id)}
                            disabled={!avail}
                            className="flex h-10 items-center rounded-full border px-4 text-[14px] font-semibold transition-colors disabled:cursor-not-allowed"
                            style={{
                              borderColor: on ? INK : "#e6dfd7",
                              background: on ? INK : "#fff",
                              color: on ? "#fff" : avail ? INK : "#b7b0a7",
                              textDecoration: avail ? "none" : "line-through",
                            }}
                          >
                            {v.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            </div>
            )}
            {/* ── end variants pill ── */}

            {/* Care (preserved — only when the backend offers plans here) */}
            {plans.length > 0 && (
              <div className="flex flex-col gap-2 rounded-[20px] p-4" style={{ background: PAPER }}>
                <span className="flex items-center gap-2 text-[14px] font-bold">
                  <ShieldCheck size={16} style={{ color: CRIMSON }} /> Protégez votre achat
                </span>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setPlanId(null)}
                    className="rounded-full border px-3 py-2 text-[13px] font-semibold transition-colors"
                    style={{
                      borderColor: planId === null ? INK : "#e6dfd7",
                      background: planId === null ? INK : "#fff",
                      color: planId === null ? "#fff" : INK,
                    }}
                  >
                    Sans protection
                  </button>
                  {plans.map((pl) => (
                    <button
                      key={pl.id}
                      onClick={() => setPlanId(pl.id)}
                      className="rounded-full border px-3 py-2 text-[13px] font-semibold transition-colors"
                      style={{
                        borderColor: planId === pl.id ? INK : "#e6dfd7",
                        background: planId === pl.id ? INK : "#fff",
                        color: planId === pl.id ? "#fff" : INK,
                      }}
                    >
                      {pl.label} · +{fmtPrice(pl.total)} TND
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Buy row — its own mobile pill (dissolves to transparent on lg). */}
            <div ref={buyRef} className="flex flex-col gap-2.5 rounded-[28px] bg-white p-5 lg:rounded-none lg:bg-transparent lg:p-0">
              <div className="flex flex-wrap gap-2.5">
                {/* Qty stepper: full-width row on mobile (− / + pinned to the
                    edges, number fills the centre); compact natural width on
                    desktop (lg) so it sits inline beside « Ajouter au panier ». */}
                <div className="flex h-[58px] w-full items-center justify-between rounded-full border border-[#e6dfd7] bg-[#fbf9f7] lg:w-auto lg:justify-start">
                  <button
                    onClick={() => setQty((q) => Math.max(minQty, q - 1))}
                    aria-label="Moins"
                    className="h-full w-[52px] shrink-0 border-none bg-transparent text-[20px] text-[#5b5d62]"
                  >
                    −
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Quantité"
                    value={qty || ""}
                    onChange={(e) => {
                      const d = e.target.value.replace(/[^\d]/g, "").slice(0, 4);
                      setQty(d === "" ? 0 : parseInt(d, 10));
                    }}
                    onBlur={() => setQty((q) => Math.min(maxQty, Math.max(minQty, q || minQty)))}
                    className="min-w-0 flex-1 border-none bg-transparent text-center text-[16px] font-extrabold tabular-nums text-[#0e1218] outline-none lg:w-10 lg:flex-none"
                  />
                  <button
                    onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
                    aria-label="Plus"
                    className="h-full w-[52px] shrink-0 border-none bg-transparent text-[20px] text-[#0e1218]"
                  >
                    +
                  </button>
                </div>
                <button
                  onClick={doAdd}
                  disabled={!orderable}
                  className="flex h-[58px] flex-[1_1_200px] items-center justify-center gap-2.5 rounded-full border-none text-[16px] font-bold text-white transition-[background,transform] hover:brightness-95 active:scale-[.98] disabled:opacity-60"
                  style={{ background: added ? "#16a34a" : orderable ? CRIMSON : "#9a938a" }}
                >
                  {added ? <Check size={18} /> : <ShoppingBag size={18} />}
                  {addLabel}
                </button>
              </div>
              <button
                onClick={() => setQuickBuy(true)}
                disabled={!orderable}
                className="flex h-[54px] items-center justify-center gap-2 rounded-full border-[1.5px] border-[#0e1218] bg-white text-[15px] font-bold text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white disabled:opacity-60"
              >
                <Zap size={16} /> Achat rapide
              </button>
            </div>

            {/* Précommande note — only for an active-preorder product. Signals the
                deferred ship date + any operator message right under the CTA. */}
            {preorder && (
              <div className="rounded-[20px] border border-[#f0d9a8] bg-[#fdf6e9] px-4 py-3 text-[13px] leading-relaxed text-[#7a5a1a]">
                <span className="font-bold">Précommande</span>
                {preorderReleaseLabel ? ` — expédié à partir du ${preorderReleaseLabel}.` : " — expédié dès sa sortie."}
                {product.preorderMessage ? (
                  <div className="mt-1 text-[#8a6a2a]">{product.preorderMessage}</div>
                ) : null}
              </div>
            )}

            {/* Contact rows — its own mobile pill; on desktop keeps the top
                border + mt-auto (pins to the bottom of the buy-box card). */}
            <div className="flex flex-col rounded-[28px] bg-white px-5 lg:mt-auto lg:rounded-none lg:bg-transparent lg:px-0 lg:border-t lg:border-[#efe9e3]">
              {phone && (
                <a
                  href={`tel:${phone.replace(/\s+/g, "")}`}
                  className="flex items-center justify-between gap-2.5 border-b border-[#efe9e3] py-4 text-[14px] text-[#0e1218]"
                >
                  <span className="flex items-center gap-2.5">
                    <Phone size={16} style={{ color: CRIMSON }} />
                    Commander par téléphone
                  </span>
                  <strong>{phone}</strong>
                </a>
              )}
              {pickups.length > 0 && (
                <button
                  onClick={() => scrollTo(storesRef)}
                  className="flex items-center justify-between gap-2.5 border-none bg-transparent py-4 text-left text-[14px] text-[#0e1218]"
                >
                  <span className="flex items-center gap-2.5">
                    <MapPin size={16} style={{ color: CRIMSON }} />
                    Retrait gratuit en magasin
                  </span>
                  <span className="flex items-center gap-1 font-bold">
                    {pickups.length} magasin{pickups.length > 1 ? "s" : ""}
                    <ChevronRight size={14} />
                  </span>
                </button>
              )}
            </div>
            </div>
            {/* ── end buy box wrapper ── */}
          </aside>
        </section>

        {/* 2 ─ SERVICE BAND — backend-driven reassurance strip (admin Contenu &
            Design → Badges de confiance; delivery/returns copy from Système →
            Checkout; warranty = this product's resolved coverage). Self-hides when
            no badge resolves or the admin disabled the strip on the product surface.
            NOTHING hardcoded. */}
        <TrustBand surface="product" inStock={stock === "in_stock"} warranty={warranty?.full ?? null} />

        {/* 3 ─ PRÉSENTATION */}
        {longParas.length > 0 && (
          <section
            ref={descRef}
            className="flex scroll-mt-24 flex-col gap-7 rounded-[36px] bg-white p-[clamp(28px,5vw,64px)]"
          >
            <h2 className="m-0 text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-.03em]">Présentation du produit</h2>
            <div className="relative max-w-[820px]">
              <div
                className="overflow-hidden transition-[max-height] duration-500"
                style={{ maxHeight: descOpen ? 4000 : 230 }}
              >
                {longParas.map((para, i) => (
                  <p key={i} className="m-0 mb-[18px] text-[17px] leading-[1.75] text-[#2a2d33] [text-wrap:pretty]">
                    {para}
                  </p>
                ))}
              </div>
              {!descOpen && longParas.join(" ").length > 320 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[90px] bg-gradient-to-b from-transparent to-white" />
              )}
            </div>
            {longParas.join(" ").length > 320 && (
              <button
                onClick={() => setDescOpen((o) => !o)}
                className="flex h-[46px] w-fit items-center gap-2 rounded-full border-[1.5px] border-[#0e1218] bg-white px-5 text-[14px] font-bold text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white"
              >
                {descOpen ? "Réduire" : "Lire la suite"}
                <ChevronDown size={14} style={{ transform: descOpen ? "rotate(180deg)" : "none" }} />
              </button>
            )}
            {features.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
                {features.map((f, i) => (
                  <div key={i} className="flex items-center gap-3.5 rounded-[20px] p-5" style={{ background: PAPER }}>
                    <span className="flex h-9 w-9 flex-[0_0_36px] items-center justify-center rounded-full bg-white">
                      {f.swatch ? (
                        <span
                          className="h-4 w-4 rounded-full"
                          style={{ background: f.swatch, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.1)" }}
                        />
                      ) : (
                        <Check size={16} style={{ color: CRIMSON }} />
                      )}
                    </span>
                    <span className="text-[15px] font-bold">{f.label}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* 3b ─ VIDÉO PRODUIT — backend « Vidéo produit » tab (url + poster + title +
            caption). Renders the player ONLY when the admin set a video URL; nothing
            is fabricated. */}
        <VideoSection product={product} />

        {/* 4 ─ DESCRIPTIF TECHNIQUE */}
        {specs.length > 0 && (
          <section className="flex flex-col gap-7 rounded-[36px] bg-white p-[clamp(28px,5vw,64px)]">
            <h2 className="m-0 text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-.03em]">Descriptif technique</h2>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-x-12 border-t border-[#ece6df]">
              {specs.map((sp, i) => (
                <div
                  key={i}
                  className="flex items-baseline justify-between gap-5 border-b border-[#ece6df] py-5 text-[15px]"
                >
                  <span className="flex-[0_0_auto] text-[#5b5d62]">{sp.label}</span>
                  <span className="flex items-center gap-2 text-right font-bold [overflow-wrap:anywhere]">
                    {sp.swatch ? (
                      <span
                        className="inline-block h-3.5 w-3.5 rounded-full"
                        style={{ background: sp.swatch, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.1)" }}
                      />
                    ) : null}
                    {sp.value}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 4b ─ AVIS CLIENTS (live backend reviews; summary + list + write + pagination) */}
        <ReviewsSection
          reviews={reviews}
          summary={reviewSummary}
          productId={product.id}
          slug={product.slug}
          auth={reviewAuth}
        />

        {/* 5 ─ RETRAIT & LIVRAISON — driven by the delivery backend (Commandes →
            Livraison): physical in-store pickup points + the nationwide carrier. */}
        {(pickups.length > 0 || carriers.length > 0) && (
          <section ref={storesRef} className="flex scroll-mt-24 flex-col gap-6 px-1">
            <h2 className="m-0 text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-.03em]">Retrait &amp; livraison</h2>

            {/* Points de retrait — retrait gratuit en magasin */}
            {pickups.length > 0 && (
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="m-0 flex items-center gap-2 text-[16px] font-extrabold">
                    <MapPin size={17} style={{ color: CRIMSON }} /> Retrait gratuit en magasin
                  </h3>
                  <span className="text-[13px] text-[#5b5d62]">
                    {pickups.length} point{pickups.length > 1 ? "s" : ""} de retrait
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
                  {pickups.map((s) => (
                    <div
                      key={s.id}
                      className="flex flex-col gap-3.5 rounded-[28px] border-[1.5px] border-transparent bg-white p-6 transition-colors hover:border-primary"
                    >
                      <div className="flex items-center justify-between gap-2.5">
                        <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-[color-mix(in_oklab,var(--primary)_14%,transparent)]">
                          <Store size={18} style={{ color: CRIMSON }} />
                        </span>
                        <span className="rounded-full bg-[#eaf7ee] px-2.5 py-1 text-[12px] font-bold text-[#15803d]">
                          {s.fee > 0 ? `${fmtPrice(s.fee)} TND` : "Gratuit"}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <div className="text-[17px] font-extrabold leading-snug tracking-[-.01em]">{s.name}</div>
                        {s.address && <div className="text-[13.5px] leading-snug text-[#5b5d62]">{s.address}</div>}
                        {s.hours && <div className="text-[12.5px] text-[#9a938a]">{s.hours}</div>}
                      </div>
                      {s.phone && (
                        <a
                          href={`tel:${s.phone.replace(/\s+/g, "")}`}
                          className="mt-auto flex h-[46px] items-center justify-center gap-2 rounded-full text-[14px] font-bold text-[#0e1218]"
                          style={{ background: PAPER }}
                        >
                          <Phone size={14} /> {s.phone}
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Transporteur — livraison à domicile, partout en Tunisie */}
            {carriers.length > 0 && (
              <div className="flex flex-col gap-3.5">
                <h3 className="m-0 flex items-center gap-2 text-[16px] font-extrabold">
                  <Truck size={17} style={{ color: CRIMSON }} /> Livraison à domicile
                </h3>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(270px,1fr))] gap-3.5">
                  {carriers.map((c) => {
                    const baseFee = c.fee != null ? c.fee : shipping.fee;
                    const feeLabel = baseFee > 0 ? `${fmtPrice(baseFee)} TND` : "Offerte";
                    return (
                      <div key={c.id} className="flex items-center gap-4 rounded-[28px] bg-[#0e1218] p-6 text-white">
                        <span
                          className="flex h-12 w-12 flex-[0_0_48px] items-center justify-center rounded-[16px]"
                          style={{ background: CRIMSON }}
                        >
                          <Truck size={20} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[17px] font-extrabold leading-snug">{c.name}</div>
                          <div className="mt-0.5 text-[13.5px] text-[#b9bdc4]">
                            {c.zone ?? "Partout en Tunisie"} · Livraison 24–48h
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
                            <span className="font-bold">{feeLabel}</span>
                            {shipping.freeFrom > 0 && (
                              <span className="text-[#b9bdc4]">· Offerte dès {fmtPrice(shipping.freeFrom)} TND</span>
                            )}
                            <span className="text-[#b9bdc4]">· Paiement à la livraison</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        {/* 6 ─ FAQ */}
        <FaqSection faqs={faqs} phone={phone} />

        {/* 6b ─ COMPLÉMENTAIRES — curated accessories (admin « Produits supplémentaires »). */}
        {complementary.length > 0 && <ProductRail title="Complétez votre achat" items={complementary} />}

        {/* 7 ─ SIMILAIRES */}
        {related.length > 0 && <ProductRail title="Produits similaires" items={related} />}

        {/* 8 ─ AUSSI REGARDÉ */}
        {alsoViewed.length > 0 && <ProductRail title="Nos clients ont aussi regardé" items={alsoViewed} />}
      </div>

      {/* ─── MOBILE / TABLET: switchable floating buy bar (lg:hidden) ──────────
          Game-Zone structure in Tokyo's design: a white floating pill (matching
          the top nav) ALWAYS present on the PDP — qty · live total · Panier ·
          Acheter — that the shopper can PEEK down via the chevron to reveal the
          normal bottom nav, then restore via the chip. `data-buy-bar="shown"`
          makes globals.css slide the global bottom nav away while the bar is up,
          so the two never stack — switching between them IS the peek/restore.
          Hidden only while quick-buy owns the buy box. */}
      <div
        data-buy-bar={!quickBuy && !barPeeked ? "shown" : "hidden"}
        aria-hidden={quickBuy || barPeeked}
        className={`fixed inset-x-0 bottom-0 z-40 transition-[opacity,translate] duration-[420ms] ease-soft lg:hidden ${
          !quickBuy && !barPeeked
            ? "visible translate-y-0 opacity-100"
            : "pointer-events-none invisible translate-y-3 opacity-0"
        }`}
      >
        {/* Edge-to-edge bottom bar (no side/bottom gutters): top-rounded, border-top,
            upward shadow + safe-area padding. */}
        <div
          className="flex flex-col gap-2.5 rounded-t-[26px] border-t border-[#efe9e3] bg-white px-4 pt-3 shadow-[0_-12px_40px_rgba(14,18,24,.14)]"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.7rem)" }}
        >
          {/* Row 1 — return · thumb · title/stock · live total */}
          <div className="flex items-center gap-3 pr-0.5">
            <button
              type="button"
              onClick={() => setBarPeeked(true)}
              aria-label="Revenir au menu"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[#efe9e3] text-[#5b5d62] transition-colors hover:bg-[#f6f2ed] hover:text-[#0e1218]"
            >
              <Undo2 size={17} />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={curImg} alt="" className="h-11 w-11 shrink-0 rounded-full bg-[#f6f2ed] object-contain p-1" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-extrabold leading-tight text-[#0e1218]">{product.title}</div>
              <div className="text-[12px] font-medium text-[#5b5d62]">{STOCK_LABEL[stock]}</div>
            </div>
            <div className="shrink-0 whitespace-nowrap text-[18px] font-black leading-none text-primary">
              {fmtPrice(price * qty)} <span className="text-[12px] font-extrabold">TND</span>
            </div>
          </div>
          {/* Row 2 — qty · Panier · Acheter */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-[52px] shrink-0 items-center rounded-full border border-[#e6dfd7] bg-[#fbf9f7]">
              <button type="button" onClick={() => setQty((q) => Math.max(minQty, q - 1))} aria-label="Diminuer la quantité" className="h-full w-10 text-[20px] leading-none text-[#5b5d62]">−</button>
              <input
                type="text"
                inputMode="numeric"
                aria-label="Quantité"
                value={qty || ""}
                onChange={(e) => {
                  const d = e.target.value.replace(/[^\d]/g, "").slice(0, 4);
                  setQty(d === "" ? 0 : parseInt(d, 10));
                }}
                onBlur={() => setQty((q) => Math.min(maxQty, Math.max(minQty, q || minQty)))}
                className="w-8 border-none bg-transparent text-center text-[16px] font-extrabold tabular-nums text-[#0e1218] outline-none"
              />
              <button type="button" onClick={() => setQty((q) => Math.min(maxQty, q + 1))} aria-label="Augmenter la quantité" className="h-full w-10 text-[20px] leading-none text-[#0e1218]">+</button>
            </div>
            <button
              type="button"
              onClick={doAdd}
              disabled={!orderable}
              className="flex h-[52px] flex-1 items-center justify-center gap-1.5 rounded-full border-[1.5px] border-[#0e1218] bg-white text-[14px] font-bold text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white disabled:opacity-60"
            >
              {added ? <Check size={17} /> : <ShoppingBag size={17} />} Panier
            </button>
            <button
              type="button"
              onClick={() => setQuickBuy(true)}
              disabled={!orderable}
              className="flex h-[52px] flex-[1.25] items-center justify-center gap-1.5 rounded-full text-[15px] font-bold text-white transition-[filter] hover:brightness-95 disabled:opacity-60"
              style={{ background: CRIMSON }}
            >
              <Zap size={17} /> Acheter
            </button>
          </div>
        </div>
      </div>

      {/* Restore chip — shown only while the bar is peeked; taps bring it back. */}
      <button
        type="button"
        onClick={() => setBarPeeked(false)}
        aria-label="Afficher la barre d'achat"
        className={`fixed bottom-(--dock-bottom) left-1/2 z-[41] flex items-center gap-1.5 rounded-full border border-[#efe9e3] bg-white px-4 py-2.5 text-[13px] font-bold text-[#0e1218] shadow-[0_14px_40px_rgba(14,18,24,.18)] transition-[opacity] duration-300 lg:hidden ${
          !quickBuy && barPeeked
            ? "visible opacity-100"
            : "pointer-events-none invisible opacity-0"
        }`}
        style={{ transform: "translateX(-50%)" }}
      >
        <ChevronUp size={15} style={{ color: CRIMSON }} /> Acheter · {fmtPrice(price * qty)} TND
      </button>

      {/* ─── MOBILE: « Achat rapide » bottom sheet (lg:hidden) ─────────────────
          The express form opens as a dismissible bottom sheet OVER the product
          (Game-Zone pattern) instead of pushing the page down to a detached
          form. Backdrop tap or the form's « Retour » closes it; body scroll is
          locked while open (effect above). Desktop uses the inline morph. */}
      {quickBuy && (
        <div
          className="fixed inset-0 z-[60] lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Achat rapide"
        >
          <div
            className="absolute inset-0 bg-[#0e1218]/55 backdrop-blur-sm"
            onClick={() => setQuickBuy(false)}
          />
          <div
            className="absolute inset-x-0 bottom-0 max-h-[90dvh] overflow-y-auto overscroll-contain rounded-t-[30px] border-t border-[#efe9e3] bg-white px-4 pt-3 shadow-[0_-18px_55px_rgba(14,18,24,.24)]"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
          >
            {/* grab handle (decorative) */}
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-[#e6dfd7]" aria-hidden />
            <QuickBuyForm
              product={product}
              qty={qty}
              carePlanId={planId}
              variantId={currentCombo?.id ?? null}
              unitPrice={price}
              onClose={() => setQuickBuy(false)}
              initial={prefill}
            />
          </div>
        </div>
      )}

      {/* ─── DESKTOP: centered sticky pill (lg only) — unchanged behavior ────── */}
      <div
        className="fixed bottom-4 left-1/2 z-40 hidden w-[min(820px,calc(100%-24px))] items-center gap-3.5 rounded-full bg-[#0e1218] p-2 pl-2.5 text-white shadow-[0_18px_50px_rgba(14,18,24,.25)] transition-[transform,opacity] duration-300 lg:flex"
        style={{
          transform: `translate(-50%, ${sticky && !quickBuy ? "0" : "140%"})`,
          opacity: sticky && !quickBuy ? 1 : 0,
          pointerEvents: sticky && !quickBuy ? "auto" : "none",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={curImg} alt="" className="h-12 w-12 flex-[0_0_48px] rounded-full bg-white p-1 object-contain" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-bold">{product.title}</div>
          <div className="text-[13px] text-[#b9bdc4]">
            {fmtPrice(price)} TND · {STOCK_LABEL[stock]}
          </div>
        </div>
        <button
          onClick={doAdd}
          disabled={!orderable}
          className="flex h-[50px] flex-[0_0_auto] items-center gap-2 rounded-full border-none px-[22px] text-[15px] font-bold text-white transition-colors disabled:opacity-60"
          style={{ background: added ? "#16a34a" : CRIMSON }}
        >
          {added ? <Check size={17} /> : <ShoppingBag size={17} />}
          {added ? "Ajouté" : "Ajouter"}
        </button>
      </div>

      {/* TOAST */}
      <div
        role="status"
        className="fixed right-5 top-5 z-50 flex w-[min(360px,calc(100%-40px))] items-center gap-3 rounded-[20px] bg-[#0e1218] p-3.5 text-white shadow-[0_18px_50px_rgba(14,18,24,.3)] transition-[transform,opacity] duration-300"
        style={{ transform: toast ? "translateY(0)" : "translateY(-140%)", opacity: toast ? 1 : 0, pointerEvents: toast ? "auto" : "none" }}
      >
        <span className="flex h-9 w-9 flex-[0_0_36px] items-center justify-center rounded-full bg-[#16a34a]">
          <Check size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-bold">Ajouté au panier</div>
          <div className="truncate text-[13px] text-[#b9bdc4]">{toast}</div>
        </div>
        <Link
          href="/panier"
          className="flex h-10 flex-[0_0_auto] items-center rounded-full px-3.5 text-[13px] font-bold text-white"
          style={{ background: CRIMSON }}
        >
          Voir le panier
        </Link>
      </div>

    </div>
  );
}

/* ───────────────────────────────────────────────── sub-components */

function StockBadge({ state }: { state: string }) {
  const green = state === "in_stock" || state === "backorder";
  return (
    <span
      className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-semibold"
      style={{
        background: green ? "#eaf7ee" : "#fdecec",
        color: green ? "#15803d" : "#b00020",
      }}
    >
      {green && <span className="h-2 w-2 animate-pulse rounded-full bg-[#16a34a]" />}
      {STOCK_LABEL[state as keyof typeof STOCK_LABEL] ?? "En stock"}
    </span>
  );
}

function RatingLine({ product }: { product: Product }) {
  const reviews = product.reviews ?? 0;
  const rating = product.rating ?? 0;
  const has = reviews > 0 && rating > 0;
  return (
    <span className="flex w-fit items-center gap-1.5 text-[13px] text-[#5b5d62]">
      <span className="tracking-[2px]" style={{ color: has ? CRIMSON : "#c9c2ba" }}>
        {"★★★★★"}
      </span>
      {has ? (
        <>
          {rating.toFixed(1)} · {reviews} avis
        </>
      ) : (
        <>
          Pas encore d&apos;avis ·{" "}
          <span className="text-[#0e1218] underline underline-offset-[3px]">soyez le premier</span>
        </>
      )}
    </span>
  );
}

/** Deterministic fr date (UTC) so SSR + client markup match — no hydration drift. */
function fmtReviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** 5-star row; fills round(value) stars crimson, the rest muted. */
function Stars({ value, size = 14 }: { value: number; size?: number }) {
  const filled = Math.round(value);
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value.toFixed(1)} sur 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden style={{ color: i <= filled ? CRIMSON : "#d8cfc4", fontSize: size, lineHeight: 1 }}>
          ★
        </span>
      ))}
    </span>
  );
}

/** Review card — one approved review (shared by the list + empty/filtered states). */
function ReviewCard({ r }: { r: ProductReview }) {
  return (
    <article className="flex flex-col gap-3 rounded-[24px] bg-white p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 flex-[0_0_40px] items-center justify-center rounded-full text-[15px] font-extrabold"
          style={{ background: PAPER, color: INK }}
        >
          {r.author.trim().charAt(0).toUpperCase() || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[15px] font-bold text-[#0e1218]">{r.author}</span>
            {r.verified && (
              <span className="flex items-center gap-1 rounded-full bg-[#eaf7ee] px-2 py-0.5 text-[11px] font-bold text-[#15803d]">
                <Check size={11} /> Achat vérifié
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Stars value={r.rating} />
            {r.date && <span className="text-[12px] text-[#9a938a]">{fmtReviewDate(r.date)}</span>}
          </div>
        </div>
      </div>
      {r.title && <h3 className="m-0 text-[16px] font-extrabold text-[#0e1218] [text-wrap:balance]">{r.title}</h3>}
      <p className="m-0 whitespace-pre-line text-[14.5px] leading-[1.6] text-[#3d4046] [text-wrap:pretty]">{r.body}</p>
    </article>
  );
}

function ReviewFilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="rounded-full border px-3 py-1.5 text-[13px] font-semibold tabular-nums transition-colors"
      style={{
        borderColor: active ? INK : "#e6dfd7",
        background: active ? INK : "#fff",
        color: active ? "#fff" : INK,
      }}
    >
      {children}
    </button>
  );
}

const REVIEWS_PAGE = 6;

/**
 * « Avis clients » — live backend reviews. Header carries a « Donner mon avis »
 * action (write form inline / login link / already-reviewed note per `auth`).
 * Desktop: a sticky summary card (average + clickable per-star distribution)
 * beside the review list; mobile: stacked. The list has star filters, a sort
 * control, and « Voir plus » pagination past REVIEWS_PAGE. With no approved
 * reviews it shows a tasteful empty state (no fabricated social proof).
 */
function ReviewsSection({
  reviews,
  summary,
  productId,
  slug,
  auth,
}: {
  reviews: ProductReview[];
  summary?: ProductReviewSummary;
  productId: string;
  slug: string;
  auth?: ReviewAuth;
}) {
  const count = summary?.count ?? 0;
  const average = summary?.average ?? 0;
  const distribution = summary?.distribution ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const hasReviews = count > 0 && reviews.length > 0;
  const enabled = auth?.enabled ?? true;

  const [showForm, setShowForm] = useState(false);
  const [sort, setSort] = useState<"recent" | "top" | "low">("recent");
  const [starFilter, setStarFilter] = useState(0); // 0 = all
  const [shown, setShown] = useState(REVIEWS_PAGE);

  const filtered = useMemo(() => {
    const list = starFilter ? reviews.filter((r) => r.rating === starFilter) : reviews.slice();
    list.sort((a, b) =>
      sort === "top"
        ? b.rating - a.rating || b.date.localeCompare(a.date)
        : sort === "low"
          ? a.rating - b.rating || b.date.localeCompare(a.date)
          : b.date.localeCompare(a.date),
    );
    return list;
  }, [reviews, sort, starFilter]);
  const visible = filtered.slice(0, shown);

  const pickStar = (s: number) => {
    setStarFilter((cur) => (cur === s ? 0 : s));
    setShown(REVIEWS_PAGE);
  };

  // Write action: a crimson button (toggles the inline form), a login link, or a
  // short "already reviewed" note — depending on the session + policy.
  const canWrite = enabled && !!auth?.signedIn && !auth?.alreadyReviewed;
  const btnBase =
    "flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-bold transition-[filter,background]";
  const writeSlot = !enabled ? null : !auth?.signedIn ? (
    <Link href={`/login?from=/${slug}`} className={`${btnBase} text-white hover:brightness-95`} style={{ background: CRIMSON }}>
      <Star size={16} /> Donner mon avis
    </Link>
  ) : auth.alreadyReviewed ? (
    <span className="text-[13px] font-medium text-[#5b5d62]">Vous avez déjà donné votre avis. Merci&nbsp;!</span>
  ) : (
    <button type="button" onClick={() => setShowForm((v) => !v)} className={`${btnBase} text-white hover:brightness-95`} style={{ background: CRIMSON }}>
      <Star size={16} /> {showForm ? "Fermer" : "Donner mon avis"}
    </button>
  );

  return (
    <section className="flex flex-col gap-6 px-1">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="m-0 text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-.03em]">Avis clients</h2>
          {hasReviews && (
            <span className="text-[15px] text-[#5b5d62]">
              {count} avis · {average.toFixed(1)}/5
            </span>
          )}
        </div>
        {writeSlot}
      </div>

      {showForm && canWrite && (
        <ReviewForm
          productId={productId}
          slug={slug}
          policy={auth!.policy}
          requireApproval={auth!.requireApproval}
          previouslyRejected={auth!.previouslyRejected}
        />
      )}

      {hasReviews ? (
        <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* Summary card — sticky alongside the list on desktop; bars filter the list. */}
          <div className="flex flex-col gap-5 rounded-[24px] bg-white p-6 lg:sticky lg:top-24">
            <div className="flex items-center gap-4">
              <span className="text-[46px] font-black leading-none tracking-[-.03em] text-[#0e1218]">
                {average.toFixed(1)}
              </span>
              <span className="flex flex-col gap-1">
                <Stars value={average} size={16} />
                <span className="text-[13px] text-[#5b5d62]">sur 5 · {count} avis</span>
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {[5, 4, 3, 2, 1].map((s) => {
                const c = distribution[s] ?? 0;
                const pct = count > 0 ? Math.round((c / count) * 100) : 0;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => pickStar(s)}
                    aria-pressed={starFilter === s}
                    className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-[12px] text-[#5b5d62] transition-colors ${starFilter === s ? "bg-[color-mix(in_oklab,var(--primary)_14%,transparent)]" : "hover:bg-[#f6f2ed]"}`}
                  >
                    <span className="flex w-6 items-center justify-end gap-0.5 tabular-nums">
                      {s}
                      <span style={{ color: CRIMSON }}>★</span>
                    </span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#efe9e3]">
                      <span
                        className="block h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${pct}%`, background: CRIMSON }}
                      />
                    </span>
                    <span className="w-6 text-right tabular-nums">{c}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Review list — filters, cards, pagination. */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap gap-1.5">
                <ReviewFilterChip active={starFilter === 0} onClick={() => pickStar(0)}>
                  Tous
                </ReviewFilterChip>
                {[5, 4, 3, 2, 1].map((s) => (
                  <ReviewFilterChip key={s} active={starFilter === s} onClick={() => pickStar(s)}>
                    {s}★
                  </ReviewFilterChip>
                ))}
              </div>
              <SelectField
                ariaLabel="Trier les avis"
                size="sm"
                value={sort}
                onChange={(v) => setSort(v as "recent" | "top" | "low")}
                options={[
                  { value: "recent", label: "Plus récents" },
                  { value: "top", label: "Mieux notés" },
                  { value: "low", label: "Moins bien notés" },
                ]}
                className="w-full sm:w-48"
              />
            </div>

            {visible.length === 0 ? (
              <p className="py-8 text-center text-[14px] italic text-[#9a938a]">Aucun avis pour ce filtre.</p>
            ) : (
              visible.map((r) => <ReviewCard key={r.id} r={r} />)
            )}

            {visible.length < filtered.length && (
              <button
                type="button"
                onClick={() => setShown((s) => s + REVIEWS_PAGE)}
                className="flex h-[52px] items-center justify-center gap-2 rounded-full border-[1.5px] border-[#0e1218] bg-white text-[14px] font-bold text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white"
              >
                Voir plus d&apos;avis ({filtered.length - visible.length})
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-[24px] bg-white px-6 py-12 text-center">
          <Stars value={0} size={24} />
          <h3 className="m-0 text-[18px] font-extrabold text-[#0e1218]">Pas encore d&apos;avis</h3>
          <p className="m-0 max-w-[44ch] text-[14px] leading-[1.6] text-[#5b5d62]">
            Soyez le premier à partager votre expérience — votre avis aidera les autres clients Tokyo Store.
          </p>
        </div>
      )}
    </section>
  );
}

/** Inline « Laisser un avis » form (Tokyo-styled); posts via submitReviewAction. */
function ReviewForm({
  productId,
  slug,
  policy,
  requireApproval,
  previouslyRejected,
}: {
  productId: string;
  slug: string;
  policy: "all" | "buyers_only";
  requireApproval: boolean;
  previouslyRejected: boolean;
}) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(submitReviewAction, null);
  const fieldCls =
    "w-full rounded-[16px] border border-[#e6dfd7] bg-[#fbf9f7] px-4 text-[15px] text-[#0e1218] outline-none transition-colors focus:border-primary";

  return (
    <form action={formAction} className="flex flex-col gap-4 rounded-[24px] bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-extrabold uppercase tracking-[.16em]" style={{ color: CRIMSON }}>
          Laisser un avis
        </span>
        {previouslyRejected && !state?.ok && (
          <span className="text-[12px] text-[#5b5d62]">
            Votre avis précédent a été refusé — vous pouvez en soumettre un nouveau.
          </span>
        )}
        {policy === "buyers_only" && (
          <span className="text-[12px] text-[#5b5d62]">Réservé aux acheteurs de ce produit.</span>
        )}
      </div>

      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="rating" value={rating} />

      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-semibold text-[#5b5d62]">Votre note</label>
        <div className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((s) => {
            const on = s <= (hover || rating);
            return (
              <button
                key={s}
                type="button"
                onClick={() => setRating(s)}
                onMouseEnter={() => setHover(s)}
                aria-label={`${s} étoile${s > 1 ? "s" : ""}`}
                className="p-1"
              >
                <Star size={26} strokeWidth={1.5} style={{ color: on ? CRIMSON : "#d8cfc4" }} fill={on ? "currentColor" : "none"} />
              </button>
            );
          })}
        </div>
      </div>

      <input name="title" required maxLength={120} placeholder="Titre de votre avis" className={`${fieldCls} h-[52px]`} />
      <textarea
        name="body"
        required
        maxLength={4000}
        rows={4}
        placeholder="Partagez votre expérience avec ce produit…"
        className={`${fieldCls} resize-none py-3`}
      />

      {state && !state.ok && <p className="text-[13px] font-medium text-[#b00020]">{state.message}</p>}
      {state?.ok && (
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#15803d]">
          <Check size={15} /> {state.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || rating < 1}
          className="flex h-[52px] items-center justify-center gap-2 rounded-full px-6 text-[15px] font-bold text-white transition-[filter] hover:brightness-95 disabled:opacity-60"
          style={{ background: CRIMSON }}
        >
          {pending && <Loader2 size={17} className="animate-spin" />} Envoyer mon avis
        </button>
        {requireApproval && <span className="text-[12px] text-[#5b5d62]">Publié après validation.</span>}
      </div>
    </form>
  );
}

/**
 * Resolve an admin-entered video URL to how the PLAYER should load it: an iframe
 * `embedUrl` for a known host (YouTube / Vimeo / Dailymotion — watch/short/embed
 * forms accepted) or a direct `fileUrl` for a hosted media file (.mp4…). Mirrors
 * the host handling of the SEO `buildProductVideoLd` so the on-page player and the
 * VideoObject schema agree on the player URL.
 */
function resolveVideoPlayer(url: string): { embedUrl: string } | { fileUrl: string } {
  const yt = url.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i,
  );
  if (yt) return { embedUrl: `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0&modestbranding=1` };
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo) return { embedUrl: `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1` };
  const dm = url.match(/(?:dailymotion\.com\/(?:embed\/)?video\/|dai\.ly\/)([A-Za-z0-9]+)/i);
  if (dm) return { embedUrl: `https://www.dailymotion.com/embed/video/${dm[1]}?autoplay=1` };
  return { fileUrl: url };
}

/**
 * « Vidéo produit » — the crimson PDP video section, driven by the backend video
 * fields (admin Catalogue → Produits → Vidéo). Renders NOTHING when no URL is set
 * (admin controls visibility by leaving the field empty). Heading + caption show
 * only when the admin entered them — no fabricated copy. The poster falls back
 * primary-image when no dedicated poster is set; a click swaps the still for the
 * YouTube/Vimeo/Dailymotion iframe or the hosted `<video>`.
 */
function VideoSection({ product }: { product: Product }) {
  const [playing, setPlaying] = useState(false);
  const url = product.videoUrl?.trim();
  if (!url) return null;

  const player = resolveVideoPlayer(url);
  const isEmbed = "embedUrl" in player;
  const poster = (product.videoPoster || product.ogImage || product.image || "").trim();
  const posterAlt =
    (product.videoPoster ? product.videoPosterAlt : product.imageAlt) ||
    product.videoTitle ||
    product.title;
  const heading = product.videoTitle?.trim() || "";
  const caption = product.videoDescription?.trim() || "";

  return (
    <section className="flex flex-col gap-7 rounded-[36px] bg-white p-[clamp(28px,5vw,64px)]">
      <div className="flex flex-col gap-3">
        <span
          className="inline-flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[.16em]"
          style={{ color: CRIMSON }}
        >
          <Film size={14} /> En vidéo
        </span>
        {heading && (
          <h2 className="m-0 text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-.03em]">{heading}</h2>
        )}
        {caption && (
          <p className="m-0 max-w-[820px] text-[17px] leading-[1.75] text-[#2a2d33] [text-wrap:pretty]">
            {caption}
          </p>
        )}
      </div>

      <div className="overflow-hidden rounded-[28px] bg-[#0e1218]">
        <div className="relative aspect-video w-full">
          {playing && isEmbed ? (
            <iframe
              src={(player as { embedUrl: string }).embedUrl}
              title={heading || `${product.title} — vidéo`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 h-full w-full border-0"
            />
          ) : playing ? (
            <video
              src={(player as { fileUrl: string }).fileUrl}
              controls
              autoPlay
              playsInline
              poster={poster || undefined}
              className="absolute inset-0 h-full w-full bg-black object-contain"
            />
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              aria-label="Lire la vidéo"
              className="group absolute inset-0 block w-full"
            >
              {poster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={poster} alt={posterAlt} className="h-full w-full object-cover" />
              ) : (
                <span className="absolute inset-0 bg-[#0e1218]" />
              )}
              <span className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />
              <span className="absolute inset-0 grid place-items-center">
                <span
                  className="grid h-[72px] w-[72px] place-items-center rounded-full text-white shadow-[0_18px_40px_-12px_rgba(0,0,0,.6)] transition duration-300 group-hover:scale-105 md:h-20 md:w-20"
                  style={{ background: CRIMSON }}
                >
                  <Play className="ml-1 h-7 w-7 fill-current" strokeWidth={0} />
                </span>
              </span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function FaqSection({ faqs, phone }: { faqs: { q: string; a: string }[]; phone: string | null }) {
  /* One index drives both layouts: on DESKTOP it is the selected tab (always a
     valid row); on MOBILE it is the expanded accordion row (-1 = all collapsed).
     Both layouts map ALL faqs, so the section scales to any number of them. */
  const [sel, setSel] = useState(0);
  if (faqs.length === 0) return null;
  const active = sel < 0 ? 0 : sel;
  const num = (i: number) => String(i + 1).padStart(2, "0");

  return (
    <section className="flex flex-col gap-6 px-1">
      <h2 className="m-0 text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-.03em]">Questions fréquentes</h2>

      {/* MOBILE / TABLET: accordion — each question expands its answer inline, so
          the answer is always right there and it scales to any number of FAQs. */}
      <div className="flex flex-col gap-2.5 lg:hidden">
        {faqs.map((f, i) => {
          const on = sel === i;
          return (
            <div key={i} className="overflow-hidden rounded-[22px] bg-white">
              <button
                aria-expanded={on}
                onClick={() => setSel(on ? -1 : i)}
                className="flex w-full items-center gap-3 px-4 py-4 text-left"
              >
                <span
                  className="flex h-8 w-8 flex-[0_0_32px] items-center justify-center rounded-full text-[12px] font-extrabold tabular-nums transition-colors"
                  style={{ background: on ? CRIMSON : PAPER, color: on ? "#fff" : INK }}
                >
                  {num(i)}
                </span>
                <span className="min-w-0 flex-1 text-[15px] font-bold leading-5 text-[#0e1218]">{f.q}</span>
                <ChevronDown
                  size={18}
                  className="flex-[0_0_18px] transition-transform duration-300"
                  style={{ transform: on ? "rotate(180deg)" : "none", color: on ? CRIMSON : "#9a938a" }}
                />
              </button>
              {/* grid-rows 0fr→1fr = smooth height transition with no JS measuring. */}
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-soft"
                style={{ gridTemplateRows: on ? "1fr" : "0fr" }}
              >
                <div className="overflow-hidden">
                  <p className="m-0 px-4 pb-4 text-[14px] leading-[1.6] text-[#3d4046] [text-wrap:pretty]">{f.a}</p>
                </div>
              </div>
            </div>
          );
        })}
        {phone && (
          <div className="mt-1.5">
            <FaqContact phone={phone} />
          </div>
        )}
      </div>

      {/* DESKTOP: master–detail. The tablist scrolls when there are many FAQs; the
          answer panel sticks alongside. */}
      <div className="hidden items-start gap-4 lg:grid lg:grid-cols-2">
        <div
          role="tablist"
          aria-orientation="vertical"
          className="flex max-h-[460px] flex-col gap-2 overflow-y-auto pr-1 [scrollbar-width:thin]"
        >
          {faqs.map((f, i) => {
            const on = active === i;
            return (
              <button
                key={i}
                role="tab"
                aria-selected={on}
                onClick={() => setSel(i)}
                className="grid h-[72px] flex-[0_0_auto] grid-cols-[32px_minmax(0,1fr)_16px] items-center gap-4 rounded-[24px] border-none px-5 text-left transition-colors"
                style={{ background: on ? INK : "#fff", color: on ? "#fff" : INK }}
              >
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-extrabold tabular-nums"
                  style={{ background: on ? CRIMSON : PAPER, color: on ? "#fff" : INK }}
                >
                  {num(i)}
                </span>
                <span className="line-clamp-2 text-[15px] font-bold leading-5">{f.q}</span>
                <ChevronRight size={16} style={{ opacity: on ? 1 : 0.3 }} />
              </button>
            );
          })}
        </div>
        <div className="sticky top-24 flex min-h-[312px] flex-col rounded-[24px] bg-white p-8">
          <span className="text-[12px] font-extrabold uppercase tracking-[.16em]" style={{ color: CRIMSON }}>
            Question {num(active)}
          </span>
          <h3 className="m-0 mt-3 text-[24px] font-extrabold leading-8 tracking-[-.02em] [text-wrap:balance]">
            {faqs[active].q}
          </h3>
          <p className="m-0 mt-4 max-w-[60ch] text-[16px] leading-[26px] text-[#3d4046] [text-wrap:pretty]">
            {faqs[active].a}
          </p>
          {phone && (
            <div className="mt-auto pt-6">
              <FaqContact phone={phone} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* "Une autre question ?" contact row. Stacks (label over a full-width phone
   button) on narrow phones so the long number never overflows its pill; becomes
   the inline pill on sm+ (incl. the desktop answer panel). */
function FaqContact({ phone }: { phone: string }) {
  return (
    <a
      href={`tel:${phone.replace(/\s+/g, "")}`}
      className="flex flex-col gap-2 rounded-[18px] p-3 text-[14px] leading-5 text-[#0e1218] sm:h-12 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:rounded-full sm:p-0 sm:pl-5 sm:pr-2"
      style={{ background: PAPER }}
    >
      <span className="px-1 font-medium sm:px-0">Une autre question ?</span>
      <span className="flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[#0e1218] px-4 font-bold text-white sm:h-8 sm:px-3.5">
        <Phone size={14} /> {phone}
      </span>
    </a>
  );
}

function ProductRail({ title, items }: { title: string; items: Product[] }) {
  const rail = useRef<HTMLDivElement | null>(null);
  const scroll = (dir: number) => {
    const el = rail.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };
  return (
    <section className="flex flex-col gap-5 px-1">
      <div className="flex items-end justify-between gap-4">
        <h2 className="m-0 text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-.03em]">{title}</h2>
        <div className="flex gap-2">
          <button
            onClick={() => scroll(-1)}
            aria-label="Précédent"
            className="flex h-[46px] w-[46px] items-center justify-center rounded-full border-none bg-white text-[20px] text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white"
          >
            ‹
          </button>
          <button
            onClick={() => scroll(1)}
            aria-label="Suivant"
            className="flex h-[46px] w-[46px] items-center justify-center rounded-full border-none bg-white text-[20px] text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white"
          >
            ›
          </button>
        </div>
      </div>
      <div ref={rail} className="flex gap-3.5 overflow-x-auto [scrollbar-width:none] [scroll-snap-type:x_mandatory]">
        {items.map((p) => (
          <div
            key={p.id ?? p.slug}
            className="flex-[0_0_clamp(220px,calc((100%-70px)/6),300px)] [scroll-snap-align:start]"
          >
            <CatalogProductCard product={p} />
          </div>
        ))}
      </div>
    </section>
  );
}
