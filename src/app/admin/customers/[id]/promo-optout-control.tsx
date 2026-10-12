"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { setCustomerPromoOptOutAction } from "@/lib/actions/admin";

/**
 * ADMIN control: exclude this customer from PUBLIC promotions
 * (customer_profiles.promo_opt_out). Admin-only — there is no customer
 * self-service for this. Targeted promos still reach the customer.
 */
export function PromoOptOutControl({
  profileId,
  optedOut,
}: {
  profileId: string;
  optedOut: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [checked, setChecked] = useState(optedOut);
  const [error, setError] = useState<string | null>(null);

  const toggle = (next: boolean) => {
    if (pending) return;
    setChecked(next);
    setError(null);
    start(async () => {
      const res = await setCustomerPromoOptOutAction({ profileId, optOut: next });
      if (!res.ok) {
        // Revert the optimistic flip AND tell the operator why — a checkbox that
        // silently snaps back gave no clue the exclusion never applied.
        setChecked(!next);
        setError(res.message || "L'exclusion n'a pas pu être enregistrée. Réessayez.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={(e) => toggle(e.target.checked)}
          className="h-4 w-4 rounded border-border accent-foreground"
        />
        <span>Exclure des promotions publiques</span>
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </label>
      {error && (
        <p role="alert" className="text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
