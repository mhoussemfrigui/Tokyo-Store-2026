"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Lock, ShoppingBag } from "lucide-react";

import {
  CartStep,
  RecoRail,
  SummaryAside,
  Toast,
  CRIMSON,
  INK,
  MUTED,
  PAPER,
} from "@/storefront/components/storefront/checkout-view";
import {
  cartItems,
  cartTotals,
  useCart,
  useCartReady,
  useShippingConfig,
} from "@/storefront/lib/cart";
import { useHydrated } from "@/storefront/lib/hydration";
import { fmtPrice } from "@/storefront/lib/productMeta";

/**
 * The cart page (`/panier`). It shares the checkout's exact cart surface — the
 * "Votre panier" card + per-line Tokyo Care (`<CartStep>`), the Récapitulatif
 * (`<SummaryAside>`) and the "Vous aimerez aussi" rail — so the whole purchase
 * path (cart → checkout) reads as one harmonious flow. The only difference from
 * the checkout's step 0 is the top (a back + secure row, not the wizard stepper)
 * and that the CTA navigates to `/checkout` instead of advancing a step.
 */
export function CartView() {
  const router = useRouter();
  const hydrated = useHydrated();
  const ready = useCartReady();
  const state = useCart();
  const items = useMemo(() => cartItems(state), [state]);
  const shipping = useShippingConfig();
  const totals = cartTotals(items, "delivery", shipping);

  const [w, setW] = useState(1400);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    on();
    return () => window.removeEventListener("resize", on);
  }, []);
  const narrow = w < 1024;
  const small = w < 600;

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), []);

  const goCheckout = () => router.push("/checkout");

  // A plain render helper (not a component) so it is not recreated each render.
  // No min-h-screen / nested .tokyo (the layout provides scope, beige canvas and
  // min height) and no bottom padding — <main>'s pb is the single content→footer
  // gap, and the mobile order bar's footer clearance comes from the global
  // data-buy-bar rule.
  const shell = (children: React.ReactNode) => (
    <div className="w-full" style={{ background: PAPER, color: INK }}>
      <div className="page-container flex w-full flex-col gap-5 pt-3">
        {children}
      </div>
    </div>
  );

  const topBar = (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-[clamp(24px,4vw,36px)] bg-white p-[clamp(18px,3vw,26px)]">
      <Link
        href="/"
        className="flex h-11 items-center gap-2 rounded-full bg-[#f6f2ed] pl-3 pr-4 text-[14px] font-bold text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white"
      >
        <ArrowLeft size={16} /> Continuer mes achats
      </Link>
      <span className="flex items-center gap-1.5 text-[13px]" style={{ color: MUTED }}>
        <Lock size={14} /> Commande sécurisée
      </span>
    </section>
  );

  /* ── guards ── */
  if (!hydrated || !ready) {
    return shell(
      <>
        {topBar}
        <section className="flex flex-wrap items-start gap-5">
          <div className="min-h-[320px] flex-[1_1_560px] rounded-[28px] bg-white" />
          <div
            className="min-h-[220px] rounded-[28px] bg-white"
            style={{ flex: narrow ? "1 1 100%" : "0 0 380px" }}
          />
        </section>
      </>,
    );
  }

  if (items.length === 0) {
    return shell(
      <>
        {topBar}
        <div className="flex flex-col items-center gap-3.5 rounded-[28px] bg-white px-6 py-14 text-center">
          <span
            className="flex h-24 w-24 items-center justify-center rounded-full"
            style={{ background: "#f9dde2", color: CRIMSON }}
          >
            <ShoppingBag size={40} strokeWidth={1.8} />
          </span>
          <h1 className="m-0 text-[clamp(22px,2.2vw,30px)] font-extrabold tracking-[-.03em]">
            Votre panier est vide
          </h1>
          <p className="m-0 max-w-[42ch] text-[15px]" style={{ color: MUTED }}>
            Ajoutez des produits pour passer commande : iPhone, smartphones, consoles, audio et
            accessoires disponibles en stock à Tunis.
          </p>
          <Link
            href="/"
            className="mt-1 flex h-[52px] items-center rounded-full px-6 text-[15px] font-bold text-white"
            style={{ background: CRIMSON }}
          >
            Continuer mes achats
          </Link>
        </div>
      </>,
    );
  }

  return shell(
    <>
      {topBar}

      <section className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_560px] flex-col gap-4">
          <CartStep items={items} small={small} onNotify={notify} />
        </div>
        <aside
          className="flex min-w-0 flex-col gap-3"
          style={{ flex: narrow ? "1 1 100%" : "0 0 380px", position: narrow ? "relative" : "sticky", top: 12 }}
        >
          <SummaryAside
            items={items}
            totals={totals}
            mode="home"
            showItems={false}
            shipping={shipping}
            ctaLabel="Passer la commande"
            ctaIcon={ArrowRight}
            disabled={false}
            sending={false}
            onNext={goCheckout}
            error={null}
            showCta={!narrow}
          />
        </aside>
      </section>

      <RecoRail items={items} onNotify={notify} />

      {/* Mobile order bar — swaps with the global bottom nav (data-buy-bar). */}
      {narrow && (
        <div
          data-buy-bar="shown"
          className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-3 border-t border-[#ece6df] bg-white px-3 pt-2.5 shadow-[0_-10px_30px_rgba(14,18,24,.08)]"
          style={{ paddingBottom: "calc(0.6rem + env(safe-area-inset-bottom))" }}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[12px]" style={{ color: MUTED }}>
              Total · {totals.count} article{totals.count > 1 ? "s" : ""}
            </span>
            <span className="text-[20px] font-black leading-none" style={{ color: CRIMSON }}>
              {fmtPrice(totals.total)} TND
            </span>
          </span>
          <button
            type="button"
            onClick={goCheckout}
            className="flex h-[52px] shrink-0 items-center gap-2 rounded-full px-5 text-[15px] font-bold text-white"
            style={{ background: CRIMSON }}
          >
            Commander <ArrowRight size={16} />
          </button>
        </div>
      )}

      {toast && <Toast text={toast} />}
    </>,
  );
}
