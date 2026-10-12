"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, type LucideIcon } from "lucide-react";

import { chip } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

export type MobileCategoryLink = { label: string; href: string };
export type MobileCategorySection = {
  title?: string;
  /** null when the title has no shelf of its own (it renders as plain text). */
  href: string | null;
  items: MobileCategoryLink[];
};
export type MobileCategory = {
  label: string;
  icon: LucideIcon;
  /** The universe page ("Voir tout"). */
  href: string;
  sections: MobileCategorySection[];
};

/**
 * The mobile menu's "Rayons": one row per universe, opening onto its sections
 * with the same titles and destinations as the desktop mega menu. Titles are
 * crimson eyebrows, items are 44px rows whose text sits on the universe
 * label's line (48px in).
 */
export function MobileCategoryAccordion({
  categories,
  onClose,
}: {
  categories: MobileCategory[];
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const baseId = useId();

  const toggle = (label: string) => {
    setOpen((current) => (current === label ? null : label));
  };

  return (
    <div className="px-4 pt-4 pb-2">
      <p className="eyebrow text-muted-foreground">Rayons</p>
      <ul className="mt-1">
        {categories.map((cat, cIdx) => {
          const Icon = cat.icon;
          const isOpen = open === cat.label;
          const panelId = `${baseId}-${cIdx}`;
          return (
            <li key={cat.label} className="border-b border-border/50 last:border-0">
              {/* rounded-inner: the row sits 17px inside the 28px island, so its
                  focus ring takes the nested radius, not a sharp rectangle. */}
              <button
                type="button"
                onClick={() => toggle(cat.label)}
                aria-expanded={isOpen}
                aria-controls={panelId}
                className="flex w-full items-center gap-3 rounded-inner py-3.5 text-left text-[15px] font-medium text-graphite transition-transform active:scale-[0.99]"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                  <Icon aria-hidden className="size-4" />
                </span>
                <span className="flex-1">{cat.label}</span>
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "size-4 text-muted-foreground transition-transform duration-200",
                    isOpen && "rotate-180",
                  )}
                />
              </button>
              {/* grid-rows 0fr -> 1fr animates to the content's real height (a
                  max-height clipped the longer universes). Inert while closed,
                  so the collapsed links are out of the tab order. */}
              <div
                id={panelId}
                inert={!isOpen}
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-300 ease-soft",
                  isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                )}
              >
                {/* The 4px of top/right padding keeps the focus ring inside
                    the overflow clip. pl-9: 36px disc + 12px gap - the rows'
                    own 12px = text on the label line. */}
                <div className="min-h-0 overflow-hidden">
                  <div className="pt-1 pr-1 pb-3 pl-9">
                    {/* The menu chip (chip.lg, 44px). -ml-1 because its 16px
                        padding is 4px more than the rows' 12px: the label
                        stays on the universe label's line. pb-2 keeps 8px to
                        the section title below, itself a 44px target. */}
                    <div className="pt-1 pb-2">
                      <Link
                        href={cat.href}
                        onClick={onClose}
                        className={cn(chip.base, chip.lg, chip.accent, "-ml-1")}
                      >
                        Voir tout {cat.label}
                        <ArrowRight aria-hidden className="size-4" />
                      </Link>
                    </div>
                    {cat.sections.map((section, sIdx) => (
                      <div key={sIdx}>
                        {section.title &&
                          (section.href ? (
                            <Link
                              href={section.href}
                              onClick={onClose}
                              className="eyebrow flex min-h-11 w-fit items-end rounded-full px-3 pb-1 text-primary-ink"
                            >
                              {section.title}
                            </Link>
                          ) : (
                            <p className="eyebrow flex min-h-11 items-end px-3 pb-1 text-primary-ink">
                              {section.title}
                            </p>
                          ))}
                        <ul>
                          {section.items.map((item) => (
                            <li key={`${sIdx}-${item.label}`}>
                              <Link
                                href={item.href}
                                onClick={onClose}
                                className="flex min-h-11 items-center rounded-full px-3 text-[14px] text-graphite transition-colors duration-200 active:bg-secondary"
                              >
                                {item.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
