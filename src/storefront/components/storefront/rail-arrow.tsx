import { ChevronLeft, ChevronRight } from "lucide-react";

import { iconBtn } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

/** The one carousel/rail arrow: the hero's 44px glass control. */
export function RailArrow({
  direction,
  label,
  onClick,
  disabled,
  className,
}: {
  direction: "prev" | "next";
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(iconBtn.base, iconBtn.glass, className)}
    >
      <Icon aria-hidden className="size-5" />
    </button>
  );
}
