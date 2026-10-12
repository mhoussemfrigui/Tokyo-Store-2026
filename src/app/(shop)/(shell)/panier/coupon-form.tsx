"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Loader2, Tag, X } from "lucide-react";

import {
  applyCouponAction,
  clearCouponAction,
} from "@/lib/actions/promotion";
import { type ActionState } from "@/lib/actions/types";
import { useMoney } from "@/components/money-provider";

/**
 * Coupon code input on /panier. The applied promotion is cookie-stored, so
 * /checkout picks it up server-side and shows the discount without an input
 * of its own. When a code is already applied (`appliedName` non-null), shows
 * a "Retirer" affordance instead of the input. The remove action runs in a
 * useTransition so the user sees an instant pending state without leaving
 * the page.
 *
 * Visual language: the promo block — a Tag-iconed toggle that expands into a
 * monospace code input, and an applied-state chip with a remove control. Wiring
 * (applyCouponAction / clearCouponAction) unchanged.
 *
 * The operator-facing labels (the collapsed toggle, the applied-chip eyebrow,
 * and the submit button) come from `getCartPageCopy` via the `copy` prop, so
 * they stay editable through the `cart.coupon.*` settings. Defaults match the
 * previous literals.
 */
export function CouponForm({
  appliedName,
  appliedDiscountCents,
  copy,
}: {
  appliedName: string | null;
  appliedDiscountCents: number;
  /** Operator-tunable coupon labels (defaults to the previous literals). */
  copy: { addToggle: string; appliedLabel: string; apply: string };
}) {
  const money = useMoney();
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    applyCouponAction,
    null,
  );
  const [isRemoving, startRemove] = useTransition();
  // Collapsed by default — expands into the code input on the "+ Ajouter un
  // code promo" toggle.
  const [open, setOpen] = useState(false);

  if (appliedName) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-olive/25 bg-olive/[0.07] p-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-olive/15 text-olive">
          <Check className="h-4 w-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-body text-[0.6rem] uppercase tracking-[0.18em] text-olive">
            {copy.appliedLabel}
          </p>
          <p className="truncate font-serif text-sm text-foreground">{appliedName}</p>
          {appliedDiscountCents > 0 && (
            <p className="mt-0.5 font-body text-[0.65rem] tracking-wide text-muted-foreground/70">
              −{money.fromMinor(appliedDiscountCents)} appliqué
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={isRemoving}
          onClick={() =>
            startRemove(async () => {
              await clearCouponAction();
            })
          }
          aria-label="Retirer le code"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-olive/70 transition-colors duration-300 hover:bg-olive/15 hover:text-olive disabled:opacity-50"
        >
          {isRemoving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-4 w-4" strokeWidth={1.3} />
          )}
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-olive/25 bg-olive/[0.06] px-4 py-2.5 font-body text-[0.65rem] uppercase tracking-[0.2em] text-olive/80 transition-colors duration-300 hover:border-olive/40 hover:bg-olive/[0.1] hover:text-olive"
      >
        <Tag className="h-3.5 w-3.5" strokeWidth={1.5} />
        {copy.addToggle}
      </button>
    );
  }

  return (
    <form action={formAction} className="tk-fade-in-up space-y-2">
      <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-background p-1.5 transition-colors duration-300 focus-within:border-olive/50">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-olive/10 text-olive">
          <Tag className="h-4 w-4" strokeWidth={1.5} />
        </span>
        <input
          name="code"
          type="text"
          placeholder="Code promo"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="h-9 min-w-0 flex-1 bg-transparent font-mono text-sm uppercase tracking-wide placeholder:font-body placeholder:tracking-normal placeholder:text-muted-foreground/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className="btn-solid inline-flex h-9 shrink-0 items-center justify-center rounded-lg px-4 text-[0.6rem] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : copy.apply}
        </button>
      </div>
      {state && !state.ok && (
        <p className="px-1 font-body text-[0.65rem] tracking-wide text-destructive">
          {state.message}
        </p>
      )}
      {state?.ok && (
        <p className="px-1 font-body text-[0.65rem] tracking-wide text-olive">
          {state.message}
        </p>
      )}
    </form>
  );
}
