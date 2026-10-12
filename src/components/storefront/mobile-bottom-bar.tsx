"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Home, Heart, ShoppingBag } from "lucide-react";

import { useWishlist } from "@/components/wishlist/wishlist-provider";
import { isBottomBarHiddenRoute } from "./bottom-bar";

/**
 * Mobile bottom navigation pill — the floating Accueil · Favoris · Panier bar
 * that occupies the reserved bottom strip on phones. It exists because the cart
 * + wishlist icons are intentionally HIDDEN from the mobile header (kept on
 * desktop), so this bar is where mobile shoppers reach their cart and favourites.
 *
 * Shown on every page except the cart/checkout flow routes (those own their
 * in-flow CTAs). The matching `BottomBarSpacer` reserves the height so there is
 * no overlap with the footer.
 */
export function MobileBottomBar({ cartCount = 0 }: { cartCount?: number }) {
  const pathname = usePathname();
  const wl = useWishlist();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (isBottomBarHiddenRoute(pathname)) return null;

  const wishlistCount = mounted ? (wl?.count ?? 0) : 0;
  const items: { href: string; label: string; Icon: typeof Home; badge: number }[] = [
    { href: "/", label: "Accueil", Icon: Home, badge: 0 },
    { href: "/favoris", label: "Favoris", Icon: Heart, badge: wishlistCount },
    { href: "/panier", label: "Panier", Icon: ShoppingBag, badge: cartCount },
  ];

  return (
    <nav
      aria-label="Navigation"
      className="fixed inset-x-0 bottom-0 z-[90] lg:hidden"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))" }}
    >
      <div className="mx-auto flex max-w-xs items-center justify-around gap-1 rounded-2xl border border-border/20 bg-background/95 px-2 py-2 shadow-[0_10px_32px_-10px_hsl(var(--foreground)/0.3)] backdrop-blur">
        {items.map(({ href, label, Icon, badge }) => (
          <Link
            key={href}
            href={href}
            aria-label={label}
            className="relative grid flex-1 place-items-center gap-1 rounded-xl px-2 py-1.5 text-foreground/60 transition-colors hover:text-foreground"
          >
            <span className="relative">
              <Icon className="h-[19px] w-[19px]" strokeWidth={1.4} />
              {badge > 0 && (
                <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-olive px-1 font-body text-[0.5rem] font-medium leading-none text-olive-foreground">
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </span>
            <span className="font-body text-[0.55rem] uppercase tracking-[0.08em]">{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
