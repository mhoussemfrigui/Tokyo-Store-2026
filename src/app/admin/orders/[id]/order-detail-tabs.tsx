"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

export type OrderTab = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  content: React.ReactNode;
};

/**
 * Tab shell for the order detail page. The old page crammed ~11 panels into a
 * 320px sidebar with related controls scattered; this groups them by operator
 * intent into three tabs — Information (articles, client,
 * livraison, notes, status trail — read-only context to CHECK first) · Actions
 * (confirm/advance + prepare + ship + fulfilment docs — what the operator DOES) ·
 * Paiement & retours (encaissement + TVA + refunds + returns + fiscal documents) —
 * so each task lives on one screen and the money/SAV controls read together.
 *
 * A bespoke strip rather than the shared `FormTabs` because each tab holds
 * SEVERAL independent cards/forms (a dashboard), not one form — `FormTabs`
 * wraps its body in a single card, which would nest card-in-card here. Every
 * panel stays mounted (toggled via the `hidden` attribute) so a half-typed
 * return draft or refund amount survives switching tabs. The strip is sticky so
 * the operator can move between tasks without scrolling back up.
 */
export function OrderDetailTabs({ tabs }: { tabs: OrderTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  // Guard against the active tab disappearing (it can't today — tab set is
  // computed server-side per render — but keeps the panel logic total).
  const activeId = tabs.some((t) => t.id === active) ? active : tabs[0]?.id;

  return (
    <div className="space-y-4">
      {/* The segmented strip gets its own white nav card (matches SubTabBar) so
          it doesn't float on the same-coloured page canvas; kept sticky because
          each tab is a multi-card dashboard the operator moves between. */}
      <div className="sticky top-2 z-20 rounded-[20px] border border-border bg-card p-2">
        <div
          role="tablist"
          className="inline-flex w-full items-center gap-1 overflow-x-auto rounded-[14px] bg-[var(--background)] p-1 [scrollbar-width:none]"
        >
          {tabs.map((t) => {
            const isActive = t.id === activeId;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(t.id)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-[14px] py-[8px] text-[13px] transition",
                  isActive
                    ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
                    : "font-semibold text-muted-foreground hover:text-foreground",
                )}
              >
                {t.icon}
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={t.id !== activeId} className="space-y-4">
          {t.content}
        </div>
      ))}
    </div>
  );
}
