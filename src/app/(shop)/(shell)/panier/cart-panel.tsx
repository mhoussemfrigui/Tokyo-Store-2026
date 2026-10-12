"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Minus, Plus, X } from "lucide-react";

import {
  removeCartItemAction,
  setCartItemQuantityAction,
} from "@/lib/actions/cart";
import { track } from "@/lib/tracking/funnel";
import { useMoney } from "@/components/money-provider";
import { AVAILABILITY_LABELS } from "@/lib/catalog/availability-labels";

type Line = {
  id: string;
  productId: string;
  slug: string;
  name: string;
  variantLabel?: string;
  thumbUrl: string | null;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  inStock: boolean;
  /**
   * false = the product is deleted / unpublished / not released to this viewer
   * (or the variant is gone): the line is excluded from the cart totals and can
   * only be removed — no PDP link (it would 404), no increment.
   */
  available: boolean;
};

/**
 * Client wrapper around the cart line list. Owns quantity / remove
 * mutations; the parent server component reads the freshly-mutated state
 * on `router.refresh()`.
 *
 * Fires `view_cart` once on mount and `remove_from_cart` whenever a line
 * is deleted, so the funnel stays complete even when users abandon at
 * the cart step.
 *
 * Visual language: the luxury cart line (image, eyebrow, serif name, segmented
 * qty group, price) separated by the .luxury-divider. Wiring is unchanged from
 * the commerce backend.
 */
export function CartPanel({
  lines,
  subtotalCents,
}: {
  lines: Line[];
  subtotalCents: number;
}) {
  const router = useRouter();
  const viewedRef = useRef(false);

  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    track("view_cart", {
      value_cents: subtotalCents,
      items: lines.map((l) => ({
        item_id: l.productId,
        item_name: l.name,
        price_cents: l.unitPriceCents,
        quantity: l.quantity,
      })),
    });
  }, [lines, subtotalCents]);

  return (
    <ul className="space-y-0">
      {lines.map((line, idx) => (
        <li key={line.id}>
          {idx > 0 && <div className="luxury-divider" />}
          <CartLine
            line={line}
            onRemoved={() => {
              track("remove_from_cart", {
                value_cents: line.subtotalCents,
                items: [
                  {
                    item_id: line.productId,
                    item_name: line.name,
                    price_cents: line.unitPriceCents,
                    quantity: line.quantity,
                  },
                ],
              });
              router.refresh();
            }}
            onQuantityChanged={() => router.refresh()}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Segmented rounded-full quantity stepper — the shared luxury line-item control.
 * A single pill split into − / value / + with hairline dividers; the value cell
 * swaps to a spinner while the optimistic mutation is in flight.
 */
function QtyStepper({
  value,
  pending,
  canIncrement = true,
  onDecrement,
  onIncrement,
}: {
  value: number;
  pending: boolean;
  /** false on an unavailable line — it can only be reduced / removed. */
  canIncrement?: boolean;
  onDecrement: () => void;
  onIncrement: () => void;
}) {
  return (
    <div className="inline-flex items-center rounded-full border border-border/60 bg-card">
      <button
        type="button"
        onClick={onDecrement}
        disabled={pending}
        aria-label="Diminuer la quantité"
        className="grid h-9 w-9 place-items-center rounded-l-full text-foreground/70 transition-colors duration-300 hover:bg-accent/40 hover:text-foreground disabled:opacity-40"
      >
        <Minus className="h-3 w-3" strokeWidth={1.5} />
      </button>
      <span
        aria-live="polite"
        className="grid h-9 w-10 place-items-center border-x border-border/50 font-body text-xs tabular-nums text-foreground"
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : (
          value
        )}
      </span>
      <button
        type="button"
        onClick={onIncrement}
        disabled={pending || !canIncrement || value >= 99}
        aria-label="Augmenter la quantité"
        className="grid h-9 w-9 place-items-center rounded-r-full text-foreground/70 transition-colors duration-300 hover:bg-accent/40 hover:text-foreground disabled:opacity-40"
      >
        <Plus className="h-3 w-3" strokeWidth={1.5} />
      </button>
    </div>
  );
}

const THUMB_FRAME =
  "img-luxury relative block h-[88px] w-[70px] overflow-hidden rounded-xl bg-accent/30 sm:h-[124px] sm:w-[100px]";

function CartLine({
  line,
  onRemoved,
  onQuantityChanged,
}: {
  line: Line;
  onRemoved: () => void;
  onQuantityChanged: () => void;
}) {
  const money = useMoney();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // Optimistic local quantity so the +/- feels instant. The server is the
  // source of truth — we sync on each action result.
  const [localQty, setLocalQty] = useState(line.quantity);

  const change = (next: number) => {
    const clamped = Math.max(0, Math.min(99, next));
    setLocalQty(clamped);
    setErr(null);
    startTransition(async () => {
      if (clamped === 0) {
        const res = await removeCartItemAction(line.id);
        if (!res.ok) {
          setErr(res.message ?? "Erreur");
          setLocalQty(line.quantity);
          return;
        }
        onRemoved();
        return;
      }
      const res = await setCartItemQuantityAction(line.id, clamped);
      if (!res.ok) {
        setErr(res.message ?? "Erreur");
        setLocalQty(line.quantity);
        return;
      }
      onQuantityChanged();
    });
  };

  const thumb = line.thumbUrl ? (
    <Image
      src={line.thumbUrl}
      alt={line.name}
      fill
      sizes="(max-width: 640px) 70px, 100px"
      className="object-cover"
    />
  ) : (
    <span className="grid h-full w-full place-items-center text-xs text-muted-foreground/40">
      —
    </span>
  );

  return (
    <div className="group relative flex gap-3.5 py-5 sm:gap-6 sm:py-7">
      {/* Thumbnail wrapper — overflow-visible so the qty pill sits OUTSIDE the
          rounded/overflow-hidden image (which would otherwise clip it). */}
      <div className="relative shrink-0">
        {/* Product image — luxury portrait crop, links to the PDP (not for an
            unavailable line: its PDP would 404). */}
        {line.available ? (
          <Link href={`/${line.slug}`} className={THUMB_FRAME}>
            {thumb}
          </Link>
        ) : (
          <span className={`${THUMB_FRAME} opacity-60`}>{thumb}</span>
        )}
        {/* Quantity pill — only shown when >1, sits clear of the clipped image. */}
        {localQty > 1 && (
          <span className="pointer-events-none absolute -right-1.5 -top-1.5 z-10 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-olive px-1 font-body text-[0.6rem] font-medium leading-none tabular-nums text-olive-foreground shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.3)]">
            {localQty > 99 ? "99+" : localQty}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Variant eyebrow — muted uppercase, tracked. */}
            {line.variantLabel && (
              <p className="mb-1.5 truncate font-body text-[0.6rem] uppercase tracking-[0.3em] text-muted-foreground/60">
                {line.variantLabel}
              </p>
            )}
            {line.available ? (
              <Link
                href={`/${line.slug}`}
                className="block font-serif text-[0.95rem] leading-snug text-foreground transition-colors duration-500 hover:text-primary sm:text-lg"
              >
                {line.name}
              </Link>
            ) : (
              <span className="block font-serif text-[0.95rem] leading-snug text-muted-foreground sm:text-lg">
                {line.name}
              </span>
            )}
            {/* Out-of-stock state — mirrors the order gate's "Indisponible". */}
            {!line.inStock && (
              <span className="mt-2 inline-flex items-center rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[0.55rem] font-medium uppercase tracking-[0.18em] text-amber-600">
                {AVAILABILITY_LABELS.unavailable}
              </span>
            )}
            {/* Unit price — quiet, beneath the name. */}
            <p className="mt-1.5 font-body text-[0.68rem] tracking-wide text-muted-foreground/70 sm:mt-2 sm:text-[0.72rem]">
              {money.fromMinor(line.unitPriceCents)}
              <span className="text-muted-foreground/40"> / unité</span>
            </p>
          </div>

          {/* Remove — quiet ghost control top-right. The stepper's "−" to 0
              also removes, but this is the explicit affordance. */}
          <button
            type="button"
            onClick={() => change(0)}
            disabled={pending}
            aria-label="Retirer du panier"
            className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground/40 transition-colors duration-300 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            <X className="h-4 w-4" strokeWidth={1.3} />
          </button>
        </div>

        {/* Stepper + right-aligned serif line subtotal. */}
        <div className="mt-auto flex items-end justify-between gap-3 pt-4 sm:pt-5">
          <QtyStepper
            value={localQty}
            pending={pending}
            canIncrement={line.available}
            onDecrement={() => change(localQty - 1)}
            onIncrement={() => change(localQty + 1)}
          />

          {/* An unavailable line is not counted in the totals — struck through. */}
          <p
            className={`font-serif text-base tabular-nums sm:text-xl ${
              line.available ? "text-foreground" : "text-muted-foreground/50 line-through"
            }`}
          >
            {money.fromMinor(line.subtotalCents)}
          </p>
        </div>

        {err && (
          <p className="mt-2.5 font-body text-[0.6rem] tracking-wide text-destructive">
            {err}
          </p>
        )}
      </div>
    </div>
  );
}
