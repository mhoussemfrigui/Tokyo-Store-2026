"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  Check,
  Copy,
  CreditCard,
  FileText,
  Heart,
  Loader2,
  Lock,
  MapPin,
  Pencil,
  Phone,
  Plus,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  Truck,
  User,
} from "lucide-react";
import { z } from "zod";

import { SelectField } from "@/components/ui/select-field";
import { EmptyState } from "@/storefront/components/storefront/empty-state";
import { PendingBody } from "@/storefront/components/storefront/pending-body";
import { PageTop } from "@/storefront/components/storefront/page-top";
import type { Crumb } from "@/storefront/components/storefront/breadcrumb";
import {
  useCartItems,
  cartTotals,
  clearCart,
  addToCart,
  setQty,
  removeFromCart,
  setLinePlan,
  protectionPlans,
  useShippingConfig,
  type CartItem,
} from "@/storefront/lib/cart";
import { useCareConfig } from "@/storefront/lib/care-config";
import { toggleFavorite } from "@/storefront/lib/favorites";
import { placeOrderFromCartAction } from "@/lib/actions/order";
import { createAddressAction, editAddressAction } from "@/lib/actions/customer";
import type { ActionState } from "@/lib/actions/types";
import { useSiteContacts, telHref } from "@/storefront/lib/site-contacts";
import { useLiveProductsByCategory } from "@/storefront/lib/use-live-products";
import { useHydrated } from "@/storefront/lib/hydration";
import { smoothBehavior } from "@/storefront/lib/motion";
import { fmtPrice, conditionLabel, isOrderable } from "@/storefront/lib/productMeta";
import type { Product } from "@/storefront/types/catalog";
import { TrustBand } from "./trust-band";

/* Palette — explicit values so the page renders faithfully to the mockup.
   Exported so the cart page (/panier) renders the SAME language as the checkout. */
export const INK = "#0e1218";
export const CRIMSON = "var(--primary)";
export const PAPER = "#f6f2ed";
export const MUTED = "#5b5d62";

type CheckoutPickup = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  /** Pickup handling fee in millimes (0 / null = free). The backend charges it
   *  from `pickupLocationId`; the UI must show it so "Payer X" == the charge. */
  feeCents: number | null;
};
type CheckoutAddress = {
  id: string;
  label: string | null;
  fullName: string | null;
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  phone: string | null;
  isDefault: boolean;
};
type Viewer = { name: string; email: string; phone: string };

const governorates = [
  "Tunis", "Ariana", "Ben Arous", "Manouba", "Nabeul", "Bizerte", "Sousse",
  "Monastir", "Mahdia", "Sfax", "Kairouan", "Gabès", "Médenine", "Autre",
];

// 3-step wizard: the cart lives on /panier (the full editable surface), so
// checkout opens straight at Livraison instead of repeating the cart.
const STEPS = [
  { label: "Livraison", hint: "Adresse & réception", Icon: Truck },
  { label: "Paiement", hint: "Méthode sécurisée", Icon: CreditCard },
  { label: "Confirmation", hint: "Commande validée", Icon: Check },
];

const CRUMBS: Crumb[] = [
  { label: "Accueil", to: "/" },
  { label: "Panier", to: "/panier" },
  { label: "Commande" },
];

const contactSchema = z.object({
  name: z.string().trim().min(3, "Nom complet requis").max(80),
  phone: z.string().trim().regex(/^[0-9\s]{8,15}$/, "Numéro invalide"),
  email: z.string().trim().email("E-mail invalide").max(120).or(z.literal("")),
});

type Done = {
  orderId: string | null;
  orderNumber: string | null;
  firstName: string;
  phone: string;
  email: string;
  mode: "home" | "store";
  where: string;
  pay: "cod" | "card";
  items: CartItem[];
  totals: ReturnType<typeof cartTotals>;
};

export function CheckoutView({
  pickups = [],
  viewer = null,
  addresses = [],
  hasProfile = false,
}: {
  pickups?: CheckoutPickup[];
  viewer?: Viewer | null;
  addresses?: CheckoutAddress[];
  hasProfile?: boolean;
}) {
  const hydrated = useHydrated();
  const { items, ready } = useCartItems();
  const shipping = useShippingConfig();
  const careCfg = useCareConfig();

  const canPickup = pickups.length > 0;
  const [w, setW] = useState(1400);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    on();
    return () => window.removeEventListener("resize", on);
  }, []);
  const narrow = w < 1024;
  const small = w < 600;

  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"home" | "store">("home");
  const [storeId, setStoreId] = useState(pickups[0]?.id ?? "");
  // Saved addresses are editable in checkout, so hold them in local state and
  // patch the edited one in place (the server action persists it in parallel).
  const [addressList, setAddressList] = useState<CheckoutAddress[]>(addresses);
  const patchAddress = (id: string, patch: Partial<CheckoutAddress>) =>
    setAddressList((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const appendAddress = (addr: CheckoutAddress) =>
    setAddressList((list) => [...list, addr]);
  const [addrId, setAddrId] = useState<string>(
    (addresses.find((a) => a.isDefault) ?? addresses[0])?.id ?? "new",
  );
  const [pay, setPay] = useState<"cod" | "card">("cod");
  const [cgv, setCgv] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const [values, setValues] = useState({
    name: viewer?.name ?? "",
    phone: (viewer?.phone ?? "").replace(/^\+?216\s*/, ""),
    email: viewer?.email ?? "",
    address: "",
    city: "Tunis",
    note: "",
  });
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const set = (k: keyof typeof values, v: string) => setValues((p) => ({ ...p, [k]: v }));

  const selectedPickup = pickups.find((p) => p.id === storeId) ?? pickups[0] ?? null;
  const selectedAddr = addressList.find((a) => a.id === addrId) ?? null;
  const usingSavedAddr = mode === "home" && addrId !== "new" && !!selectedAddr;

  const totals = cartTotals(
    items,
    mode === "store" ? "pickup" : "delivery",
    shipping,
    careCfg,
    mode === "store" ? selectedPickup?.feeCents ?? 0 : 0,
  );

  const goStep = (n: number) => {
    setStep(n);
    setTried(false);
    window.scrollTo({ top: 0, behavior: smoothBehavior() });
  };

  /* Per-step validation (mirrors the mockup's errors()). */
  const validate = (): Record<string, boolean> => {
    const e: Record<string, boolean> = {};
    if (step === 0) {
      const parsed = contactSchema.safeParse({
        name: values.name,
        phone: values.phone,
        email: values.email,
      });
      if (!parsed.success)
        for (const i of parsed.error.issues) e[String(i.path[0])] = true;
      if (mode === "home") {
        // Customers with an address book must pick/save a real address (the
        // order ships to selectedAddressId); guests fill the inline field.
        if (hasProfile) {
          if (!usingSavedAddr) e.address = true;
        } else if (values.address.trim().length < 6) {
          e.address = true;
        }
      }
    }
    if (step === 1) {
      if (!cgv) e.cgv = true;
    }
    return e;
  };

  const next = () => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      setTried(true);
      // Open the contact card only for contact-field errors (not the address).
      if (step === 0 && (e.name || e.phone || e.email)) setEditOpen(true);
      return;
    }
    if (step === 1) return void submit();
    goStep(step + 1);
  };

  const submit = async () => {
    setFormError(null);
    setSending(true);
    const fullPhone = `+216 ${values.phone.trim()}`;
    const homeStreet = usingSavedAddr
      ? [selectedAddr!.line1, selectedAddr!.line2].filter(Boolean).join(", ")
      : values.address.trim();
    const homeRegion = usingSavedAddr
      ? selectedAddr!.region || selectedAddr!.city || "Tunis"
      : values.city.trim() || "Tunis";
    try {
      const res = await placeOrderFromCartAction({
        contactEmail: values.email.trim(),
        contactPhone: fullPhone,
        fullName: values.name.trim(),
        streetLine1:
          mode === "store"
            ? selectedPickup
              ? `Retrait — ${selectedPickup.name}`
              : "Retrait en boutique"
            : homeStreet || "Adresse de livraison",
        city: mode === "store" ? selectedPickup?.city || "Tunis" : homeRegion,
        region: mode === "store" ? selectedPickup?.city || "Tunis" : homeRegion,
        paymentMethod: pay === "card" ? "flouci" : "cod",
        deliveryMethod: mode === "store" ? "in_store" : "home_delivery",
        pickupLocationId: mode === "store" ? selectedPickup?.id : undefined,
        selectedAddressId: usingSavedAddr ? selectedAddr!.id : undefined,
        notes: values.note.trim() || undefined,
      });
      if (!res.ok) {
        setSending(false);
        setFormError(res.message || "La commande n'a pas pu être finalisée.");
        window.scrollTo({ top: 0, behavior: smoothBehavior() });
        return;
      }
      if (res.redirectUrl) {
        window.location.assign(res.redirectUrl);
        return;
      }
      const where =
        mode === "store"
          ? selectedPickup?.name ?? "notre boutique"
          : usingSavedAddr
            ? `${homeStreet}${selectedAddr!.city ? `, ${selectedAddr!.city}` : ""}`
            : `${homeStreet}, ${homeRegion}`;
      setDone({
        orderId: res.orderId ?? null,
        orderNumber: res.orderNumber ?? null,
        firstName: values.name.trim().split(/\s+/)[0] || "",
        phone: fullPhone,
        email: values.email.trim(),
        mode,
        where,
        pay,
        items,
        totals,
      });
      clearCart();
      setStep(2);
      setSending(false);
      window.scrollTo({ top: 0, behavior: smoothBehavior() });
    } catch {
      setSending(false);
      setFormError("Une erreur est survenue. Réessayez dans un instant.");
      window.scrollTo({ top: 0, behavior: smoothBehavior() });
    }
  };

  /* ───────── guard states ───────── */
  if (step !== 2 && (!hydrated || !ready)) {
    return (
      <>
        <PageTop crumbs={CRUMBS} title="Finaliser ma commande" />
        <PendingBody />
      </>
    );
  }
  if (step !== 2 && items.length === 0) {
    return (
      <>
        <PageTop crumbs={CRUMBS} title="Finaliser ma commande" />
        <div className="page-container pb-10 pt-3">
          <EmptyState
            icon={ShoppingBag}
            title="Votre panier est vide"
            actions={
              <Link
                href="/"
                className="flex h-[52px] items-center rounded-full px-6 text-[15px] font-bold text-white"
                style={{ background: CRIMSON }}
              >
                Continuer mes achats
              </Link>
            }
          >
            Ajoutez des produits pour passer commande.
          </EmptyState>
        </div>
      </>
    );
  }

  /* ───────── confirmation (step 2) ───────── */
  if (step === 2 && done) {
    return (
      <div className="w-full" style={{ background: PAPER, color: INK }}>
        <div className="page-container flex w-full flex-col gap-5 pt-3">
          <Confirmation done={done} />
        </div>
      </div>
    );
  }

  const ctaLabel = ["Continuer vers le paiement", pay === "card" ? `Payer ${fmtPrice(totals.total)} TND` : "Confirmer la commande"][step];
  const ctaShort = ["Continuer", "Confirmer"][step];
  const err = tried ? errors : {};

  const aside = (
    <>
      <SummaryAside
        items={items}
        totals={totals}
        mode={mode}
        showItems
        shipping={shipping}
        ctaLabel={ctaLabel}
        ctaIcon={step === 1 ? Lock : ArrowRight}
        disabled={false}
        sending={sending}
        onNext={next}
        error={formError || (Object.keys(err).length ? (err.cgv && Object.keys(err).length === 1 ? "Veuillez accepter les conditions générales de vente." : "Vérifiez les champs indiqués en rouge.") : null)}
        showCta={!narrow}
      />
      {/* Checkout-only reassurance strip (« Afficher au paiement », off by default).
          Lives HERE, not in SummaryAside, so it never leaks onto /panier (which
          reuses SummaryAside). */}
      <TrustBand surface="checkout" />
    </>
  );

  return (
    <div className="w-full" style={{ background: PAPER, color: INK }}>
      <div className="page-container flex w-full flex-col gap-5 pt-3">
        {/* STEPPER */}
        <section className="flex flex-col gap-5 rounded-[clamp(24px,4vw,36px)] bg-white p-[clamp(20px,3vw,32px)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {step > 0 ? (
              <button
                type="button"
                onClick={() => goStep(step - 1)}
                className="flex h-11 items-center gap-2 rounded-full bg-[#f6f2ed] pl-3 pr-4 text-[14px] font-bold text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white"
              >
                <ArrowLeft size={16} /> Retour à la livraison
              </button>
            ) : (
              <Link
                href="/panier"
                className="flex h-11 items-center gap-2 rounded-full bg-[#f6f2ed] pl-3 pr-4 text-[14px] font-bold text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white"
              >
                <ArrowLeft size={16} /> Retour au panier
              </Link>
            )}
            <span className="flex items-center gap-1.5 text-[13px]" style={{ color: MUTED }}>
              <Lock size={14} /> Commande sécurisée
            </span>
          </div>
          <div className="relative mx-auto grid w-full max-w-[640px] grid-cols-3">
            <span className="absolute left-[16.666%] right-[16.666%] top-[28px] h-[3px] -translate-y-1/2 rounded-full bg-[#ece6df]" />
            <span
              className="absolute left-[16.666%] top-[28px] h-[3px] -translate-y-1/2 rounded-full transition-[width] duration-700 ease-soft"
              style={{ width: `calc(${Math.min(step, 2) / 2} * 66.666%)`, background: CRIMSON }}
            />
            {STEPS.map((s, i) => {
              const isDoneStep = i < step;
              const cur = i === step;
              const active = isDoneStep || cur;
              const Ic = isDoneStep ? Check : s.Icon;
              return (
                <button
                  key={s.label}
                  type="button"
                  disabled={!isDoneStep}
                  onClick={() => isDoneStep && goStep(i)}
                  className="group relative z-10 flex flex-col items-center gap-2.5 border-none bg-transparent p-0"
                  style={{ cursor: isDoneStep ? "pointer" : "default" }}
                >
                  <span
                    className="flex h-[56px] w-[56px] items-center justify-center rounded-full border-4 border-white transition-all duration-300 ease-soft"
                    style={{
                      background: active ? CRIMSON : "#fff",
                      color: active ? "#fff" : "#b4aca3",
                      boxShadow: cur
                        ? `0 0 0 1.5px ${CRIMSON}, 0 0 0 6px color-mix(in oklab, var(--primary) 14%, transparent)`
                        : `0 0 0 1.5px ${active ? CRIMSON : "#e6dfd7"}`,
                      transform: cur ? "scale(1.06)" : "none",
                    }}
                  >
                    <Ic size={21} strokeWidth={2.4} />
                  </span>
                  <span className="flex flex-col items-center gap-0.5 leading-tight">
                    <span
                      className="text-[13.5px] tracking-[-.01em] transition-colors"
                      style={{ fontWeight: cur ? 800 : 700, color: cur ? CRIMSON : active ? INK : "#a39b92" }}
                    >
                      {s.label}
                    </span>
                    <span className="hidden text-[11px] font-medium sm:block" style={{ color: cur ? MUTED : "#bbb2a8" }}>
                      {s.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* CONTENT + ASIDE */}
        <section className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-[1_1_560px] flex-col gap-4">
            {step === 0 && (
              <DeliveryStep
                viewer={viewer}
                values={values}
                set={set}
                err={err}
                editOpen={editOpen}
                setEditOpen={setEditOpen}
                mode={mode}
                setMode={setMode}
                totals={totals}
                shipping={shipping}
                addresses={addressList}
                hasProfile={hasProfile}
                onAddressUpdated={patchAddress}
                onAddressCreated={appendAddress}
                addrId={addrId}
                setAddrId={setAddrId}
                pickups={pickups}
                canPickup={canPickup}
                storeId={storeId}
                setStoreId={setStoreId}
                small={small}
              />
            )}
            {step === 1 && (
              <PaymentStep
                pay={pay}
                setPay={setPay}
                note={values.note}
                setNote={(v) => set("note", v)}
                cgv={cgv}
                setCgv={setCgv}
                err={err}
                hasCare={totals.protection > 0}
              />
            )}
          </div>
          <aside
            className="flex min-w-0 flex-col gap-3"
            style={{ flex: narrow ? "1 1 100%" : "0 0 380px", position: narrow ? "relative" : "sticky", top: 12 }}
          >
            {aside}
          </aside>
        </section>
      </div>

      {/* mobile bottom bar — swaps with the global bottom nav (data-buy-bar, per
          globals.css) so the two don't stack. */}
      {narrow && items.length > 0 && (
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
            onClick={next}
            disabled={sending}
            className="flex h-[52px] shrink-0 items-center gap-2 rounded-full px-5 text-[15px] font-bold text-white disabled:opacity-60"
            style={{ background: CRIMSON }}
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : null}
            {ctaShort} <ArrowRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ STEP 0 — CART ═══════════════════ */

/**
 * LIVE cart complements — real products from the first cart item's category
 * (fetched from /api/store/products → Postgres, rolled up to descendants), minus
 * whatever is already in the cart. Replaces the former snapshot-backed pool, so
 * the "Complétez votre commande" / "Vous aimerez aussi" rails are backend-truth.
 * Returns [] until the fetch lands or when the cart is empty.
 */
function useCartComplementPool(items: CartItem[]): Product[] {
  const seedCategory = items[0]?.product.category ?? null;
  const { products: pool } = useLiveProductsByCategory(seedCategory);
  return useMemo(() => {
    const inCart = new Set(items.map((i) => i.product.slug));
    return pool.filter((p) => !inCart.has(p.slug));
  }, [pool, items]);
}

export function CartStep({ items, small, onNotify }: { items: CartItem[]; small: boolean; onNotify: (t: string) => void }) {
  const pool = useCartComplementPool(items);
  const complements = useMemo(() => pool.filter((p) => p.price < 500).slice(0, 4), [pool]);

  return (
    <>
      <div className="flex flex-col gap-1.5 rounded-[28px] bg-white p-[clamp(18px,2.4vw,28px)]">
        <div className="flex items-center justify-between gap-3 pb-2">
          <h2 className="m-0 text-[clamp(22px,2.2vw,30px)] font-extrabold tracking-[-.03em]">Votre panier</h2>
          <span className="text-[14px]" style={{ color: MUTED }}>
            {items.reduce((s, i) => s + i.line.qty, 0)} article{items.reduce((s, i) => s + i.line.qty, 0) > 1 ? "s" : ""}
          </span>
        </div>
        {items.map((it) => (
          <CartLine key={it.product.slug} it={it} small={small} onNotify={onNotify} />
        ))}
      </div>

      {complements.length > 0 && (
        <div className="flex flex-col gap-3.5 rounded-[28px] bg-white p-[clamp(18px,2.4vw,28px)]">
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[clamp(22px,2.2vw,30px)] font-extrabold tracking-[-.03em]">Complétez votre commande</h2>
            <span className="text-[14px]" style={{ color: MUTED }}>Les accessoires adaptés à votre panier.</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-2.5">
            {complements.map((p) => (
              <div key={p.slug} className="group flex items-center gap-3 rounded-[20px] border-[1.5px] border-[#ece6df] bg-white p-2.5 transition-colors hover:border-[#0e1218]">
                <Link href={`/${p.slug}`} className="flex min-w-0 flex-1 items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image} alt="" className="h-16 w-16 flex-[0_0_64px] rounded-[14px] border border-[#f0ebe5] object-contain" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {p.brand && <span className="text-[11px] font-bold" style={{ color: MUTED }}>{p.brand}</span>}
                    <span className="line-clamp-2 text-[14px] font-bold leading-tight transition-colors group-hover:text-primary">{p.title}</span>
                    <span className="text-[15px] font-black" style={{ color: CRIMSON }}>{fmtPrice(p.price)} TND</span>
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => { addToCart(p.slug, 1); onNotify(p.title); }}
                  aria-label={`Ajouter ${p.title} au panier`}
                  title={`Ajouter ${p.title} au panier`}
                  className="flex h-11 w-11 flex-[0_0_44px] items-center justify-center rounded-full text-white transition-transform hover:scale-105"
                  style={{ background: INK }}
                >
                  <Plus size={18} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function CartLine({ it, small, onNotify }: { it: CartItem; small: boolean; onNotify: (t: string) => void }) {
  const { product, line, plan } = it;
  const slug = product.slug;
  const plans = protectionPlans(product);
  const imgSize = small ? 84 : 112;

  return (
    <div className="flex flex-col gap-3.5 border-t border-[#f0ebe5] py-4">
      <div className="flex items-start gap-4">
        <Link href={`/${slug}`} className="flex-[0_0_auto] overflow-hidden rounded-[18px] border border-[#ece6df] bg-white" style={{ width: imgSize, height: imgSize }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={product.image} alt={product.title} className="h-full w-full object-contain p-1" />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              {product.brand && <span className="text-[11px] font-semibold uppercase tracking-[.14em]" style={{ color: MUTED }}>{product.brand}</span>}
              <Link href={`/${slug}`} className="text-[16px] font-bold leading-tight text-[#0e1218] hover:text-primary">{product.title}</Link>
              <span className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="rounded-full px-2.5 py-1 font-semibold" style={{ background: PAPER, color: MUTED }}>{conditionLabel(product.condition)}</span>
                {isOrderable(product) && (
                  <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold" style={{ background: "#eaf7ee", color: "#15803d" }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#16a34a" }} /> En stock
                  </span>
                )}
              </span>
            </div>
            <span className="flex flex-[0_0_auto] flex-col items-end gap-0.5">
              <span className="whitespace-nowrap text-[19px] font-black" style={{ color: CRIMSON }}>{fmtPrice(it.lineTotal)} <span className="text-[11px]">TND</span></span>
              {line.qty > 1 && <span className="whitespace-nowrap text-[12px]" style={{ color: MUTED }}>{fmtPrice(product.price)} TND / unité</span>}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex h-11 items-center rounded-full border border-[#e6dfd7] bg-[#fbf9f7]">
              <button type="button" onClick={() => setQty(slug, Math.max(1, line.qty - 1))} aria-label="Moins" className="h-full w-11 text-[18px]" style={{ color: line.qty > 1 ? INK : "#c9c2ba" }}>−</button>
              <span className="min-w-[24px] text-center text-[15px] font-extrabold tabular-nums">{line.qty}</span>
              <button type="button" onClick={() => setQty(slug, Math.min(10, line.qty + 1))} aria-label="Plus" className="h-full w-11 text-[18px] text-[#0e1218]">+</button>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => { toggleFavorite(slug); removeFromCart(slug); onNotify("Mis dans vos favoris"); }}
                className="flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold text-[#0e1218] transition-colors hover:bg-[#f6f2ed]"
              >
                <Heart size={15} /> {!small && "Mettre de côté"}
              </button>
              <button
                type="button"
                onClick={() => removeFromCart(slug)}
                className="flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_14%,transparent)]"
                style={{ color: CRIMSON }}
              >
                <Trash2 size={15} /> {!small && "Supprimer"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {plans.length > 0 && (
        <div
          className="flex flex-col gap-3 rounded-[22px] border-[1.5px] p-3.5"
          style={{ borderColor: plan ? CRIMSON : "#ece6df", background: plan ? "color-mix(in oklab, var(--primary) 5%, white)" : "#fbf9f7" }}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 flex-[0_0_40px] items-center justify-center rounded-xl text-white" style={{ background: CRIMSON }}>
              <ShieldCheck size={20} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[15px] font-extrabold">Tokyo Care <span className="text-[13px] font-semibold" style={{ color: MUTED }}>· optionnel</span></span>
              <span className="text-[13px]" style={{ color: "#3d4046" }}>Prolongez la garantie au-delà des 12 mois constructeur.</span>
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,170px),1fr))] gap-2">
            <CareOption title="Garantie standard" sub="12 mois constructeur" price="Inclus" priceColor="#15803d" on={!plan} onClick={() => setLinePlan(slug, null)} />
            {plans.map((pl, i) => (
              <CareOption key={pl.id} title={pl.label} sub={`${pl.months} mois de garantie`} price={`+${fmtPrice(pl.total)} TND`} priceColor={CRIMSON} popular={i === 0} on={plan?.id === pl.id} onClick={() => setLinePlan(slug, pl.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CareOption({ title, sub, price, priceColor, on, popular, onClick }: { title: string; sub: string; price: string; priceColor: string; on: boolean; popular?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className="relative flex items-start gap-2.5 rounded-[18px] border-[1.5px] bg-white p-3.5 text-left transition-colors"
      style={{ borderColor: on ? CRIMSON : "#ece6df" }}
    >
      <span className="mt-0.5 flex h-[22px] w-[22px] flex-[0_0_22px] items-center justify-center rounded-full border-2" style={{ borderColor: on ? CRIMSON : "#cfc7be" }}>
        <span className="h-2.5 w-2.5 rounded-full transition-transform" style={{ background: CRIMSON, transform: on ? "scale(1)" : "scale(0)" }} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-extrabold">{title}</span>
        <span className="text-[12px]" style={{ color: MUTED }}>{sub}</span>
        <span className="mt-0.5 text-[15px] font-black" style={{ color: priceColor }}>{price}</span>
      </span>
      {popular && <span className="absolute -top-2 right-3 flex h-5 items-center rounded-full px-2 text-[10px] font-extrabold text-white" style={{ background: INK }}>LE PLUS CHOISI</span>}
    </button>
  );
}

/* ═══════════════════ STEP 1 — DELIVERY ═══════════════════ */

function DeliveryStep(props: {
  viewer: Viewer | null;
  values: { name: string; phone: string; email: string; address: string; city: string; note: string };
  set: (k: "name" | "phone" | "email" | "address" | "city" | "note", v: string) => void;
  err: Record<string, boolean>;
  editOpen: boolean;
  setEditOpen: (v: boolean) => void;
  mode: "home" | "store";
  setMode: (m: "home" | "store") => void;
  totals: ReturnType<typeof cartTotals>;
  shipping: ReturnType<typeof useShippingConfig>;
  addresses: CheckoutAddress[];
  hasProfile: boolean;
  onAddressUpdated: (id: string, patch: Partial<CheckoutAddress>) => void;
  onAddressCreated: (addr: CheckoutAddress) => void;
  addrId: string;
  setAddrId: (id: string) => void;
  pickups: CheckoutPickup[];
  canPickup: boolean;
  storeId: string;
  setStoreId: (id: string) => void;
  small: boolean;
}) {
  const { viewer, values, set, err, editOpen, setEditOpen, mode, setMode, totals, shipping, addresses, hasProfile, onAddressUpdated, onAddressCreated, addrId, setAddrId, pickups, canPickup, storeId, setStoreId } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingAddress = addresses.find((a) => a.id === editingId) ?? null;
  const fallbackAddrId = () => (addresses.find((a) => a.isDefault) ?? addresses[0])?.id ?? "new";
  const addrToFields = (a: CheckoutAddress) => ({
    label: a.label ?? "",
    fullName: a.fullName ?? values.name ?? "",
    streetLine1: a.line1 ?? "",
    city: a.city ?? "",
    region: a.region || "Tunis",
    postalCode: a.postalCode ?? "",
    phone: a.phone ?? "",
    setDefault: a.isDefault,
  });
  const initials = (values.name || viewer?.name || "?").split(/\s+/).filter(Boolean).map((x) => x[0]).slice(0, 2).join("").toUpperCase();
  const signedIn = !!viewer;
  const editForced = err.name || err.phone || err.email || err.address;
  const open = editOpen || editForced || !signedIn;
  const feeLabel = totals.products >= (shipping.freeFrom || Infinity) || mode === "store" ? "Offerte" : shipping.fee > 0 ? `${fmtPrice(shipping.fee)} TND` : "Offerte";

  const fieldWrap = () =>
    `flex h-[54px] items-center gap-2.5 rounded-[16px] border-[1.5px] bg-white pl-3.5 pr-1.5 transition-colors`;

  return (
    <>
      {/* Vos coordonnées */}
      <div className="flex flex-col gap-4 rounded-[28px] bg-white p-[clamp(18px,2.4vw,28px)]">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[clamp(22px,2.2vw,30px)] font-extrabold tracking-[-.03em]">Vos coordonnées</h2>
          <span className="text-[14px]" style={{ color: MUTED }}>Utilisées pour le suivi de votre commande et la facture.</span>
        </div>

        {signedIn && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3.5 rounded-[22px] border-[1.5px] bg-[#fbf9f7] p-4" style={{ borderColor: editForced ? CRIMSON : "#ece6df" }}>
            <span className="relative flex h-14 w-14 flex-[0_0_56px] items-center justify-center rounded-full text-[18px] font-black text-white" style={{ background: INK }}>
              {initials}
              <span className="absolute bottom-0 right-0 h-4 w-4 rounded-full border-[3px] border-[#fbf9f7]" style={{ background: "#16a34a" }} />
            </span>
            <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1.5">
              <span className="flex flex-wrap items-center gap-2">
                <strong className="text-[17px] tracking-[-.01em]">{values.name || viewer!.name}</strong>
                <span className="flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-[11px] font-extrabold" style={{ background: "#eaf7ee", color: "#15803d" }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#16a34a" }} /> Connectée
                </span>
              </span>
              <span className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]" style={{ color: "#3d4046" }}>
                {values.phone && <span className="flex items-center gap-1.5"><Phone size={13} style={{ color: "#8a857f" }} /> +216 {values.phone}</span>}
                <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-ellipsis"><User size={13} style={{ color: "#8a857f" }} /> {viewer!.email}</span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setEditOpen(!editOpen)}
              className="flex h-[42px] items-center gap-2 rounded-full border-[1.5px] px-4 text-[13px] font-bold transition-colors"
              style={{ borderColor: open ? INK : "#e6dfd7", background: open ? INK : "#fff", color: open ? "#fff" : INK }}
            >
              <Pencil size={14} /> {open ? "Terminé" : "Modifier"}
            </button>
          </div>
        )}

        <div className="grid transition-[grid-template-rows] duration-300 ease-soft" style={{ gridTemplateRows: open ? "1fr" : "0fr" }}>
          <div className="overflow-hidden">
            <div className="grid grid-cols-1 gap-3.5 px-0.5 pb-1.5 pt-1 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[13px] font-bold" style={{ color: "#3d4046" }}>Nom complet</span>
                <span className={fieldWrap()} style={{ borderColor: err.name ? CRIMSON : "#e6dfd7" }}>
                  <User size={17} style={{ color: "#8a857f" }} />
                  <input value={values.name} onChange={(e) => set("name", e.target.value)} placeholder="Prénom et nom" className="h-full min-w-0 flex-1 border-none bg-transparent text-[15px] font-semibold outline-none" />
                </span>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[13px] font-bold" style={{ color: "#3d4046" }}>Téléphone mobile</span>
                <span className={fieldWrap()} style={{ borderColor: err.phone ? CRIMSON : "#e6dfd7" }}>
                  <Phone size={17} style={{ color: "#8a857f" }} />
                  <span className="flex h-[30px] flex-[0_0_auto] items-center rounded-[10px] px-2.5 text-[13px] font-extrabold" style={{ background: PAPER }}>+216</span>
                  <input value={values.phone} onChange={(e) => set("phone", e.target.value.replace(/[^\d ]/g, ""))} inputMode="tel" placeholder="22 345 678" className="h-full min-w-0 flex-1 border-none bg-transparent text-[15px] font-semibold outline-none" />
                </span>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
                <span className="text-[13px] font-bold" style={{ color: "#3d4046" }}>E-mail <span className="font-normal" style={{ color: MUTED }}>(facultatif)</span></span>
                <span className={fieldWrap()} style={{ borderColor: err.email ? CRIMSON : "#e6dfd7" }}>
                  <User size={17} style={{ color: "#8a857f" }} />
                  <input value={values.email} onChange={(e) => set("email", e.target.value)} type="email" placeholder="vous@mail.tn" className="h-full min-w-0 flex-1 border-none bg-transparent text-[15px] font-semibold outline-none" />
                </span>
                <span className="text-[12px]" style={{ color: MUTED }}>Votre facture et la confirmation y seront envoyées.</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Mode de réception */}
      <div className="flex flex-col gap-4 rounded-[28px] bg-white p-[clamp(18px,2.4vw,28px)]">
        <h2 className="m-0 text-[clamp(22px,2.2vw,30px)] font-extrabold tracking-[-.03em]">Mode de réception</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2.5">
          <ModeTile Icon={Truck} title="Livraison à domicile" sub="24 à 72h partout en Tunisie" price={feeLabel} on={mode === "home"} onClick={() => setMode("home")} />
          {canPickup &&
            (() => {
              // Fee of the chosen boutique (most pickups are free). Shown here and
              // folded into the total so "Payer X" matches the backend charge.
              const fee = (pickups.find((p) => p.id === storeId) ?? pickups[0])?.feeCents ?? 0;
              return (
                <ModeTile
                  Icon={Store}
                  title="Retrait en boutique"
                  sub={fee > 0 ? "Prêt en magasin" : "Gratuit · prêt en magasin"}
                  price={fee > 0 ? `${fmtPrice(fee / 1000)} TND` : "Gratuit"}
                  on={mode === "store"}
                  onClick={() => setMode("store")}
                />
              );
            })()}
        </div>

        {mode === "home" && (
          <div className="flex flex-col gap-2.5">
            <span className="text-[12px] font-extrabold uppercase tracking-[.12em]" style={{ color: MUTED }}>Adresse de livraison</span>
            {/* Saved-address tiles — select one or edit it in place. */}
            {!editingAddress && addresses.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-2.5">
                {addresses.map((a) => (
                  <AddressTile
                    key={a.id}
                    a={a}
                    on={addrId === a.id}
                    onSelect={() => setAddrId(a.id)}
                    onEdit={() => setEditingId(a.id)}
                  />
                ))}
                <RadioTile on={addrId === "new"} onClick={() => setAddrId("new")}>
                  <strong className="flex items-center gap-1.5 text-[15px]"><Plus size={15} /> Nouvelle adresse</strong>
                  <span style={{ color: MUTED }}>Livrer à une autre adresse</span>
                </RadioTile>
              </div>
            )}

            {/* Edit a saved address (persists via editAddressAction). */}
            {editingAddress && (
              <AddressFormCard
                title="Modifier l'adresse"
                submitLabel="Enregistrer"
                showDefault={false}
                initial={addrToFields(editingAddress)}
                onCancel={() => setEditingId(null)}
                onSubmit={(out) => editAddressAction({ addressId: editingAddress.id, ...out })}
                onSuccess={(out) => {
                  onAddressUpdated(editingAddress.id, {
                    label: out.label ?? editingAddress.label,
                    fullName: out.fullName ?? editingAddress.fullName,
                    line1: out.streetLine1 ?? editingAddress.line1,
                    city: out.city ?? editingAddress.city,
                    region: out.region ?? editingAddress.region,
                    postalCode: out.postalCode ?? editingAddress.postalCode,
                    phone: out.phone ?? editingAddress.phone,
                  });
                  setAddrId(editingAddress.id);
                  setEditingId(null);
                }}
              />
            )}

            {/* New address — full account-compatible form, saved to the book. */}
            {!editingAddress && hasProfile && (addresses.length === 0 || addrId === "new") && (
              <div className="flex flex-col gap-2">
                {err.address && (
                  <span className="text-[13px] font-semibold" style={{ color: CRIMSON }}>
                    Enregistrez votre adresse pour continuer.
                  </span>
                )}
                <AddressFormCard
                  title="Nouvelle adresse"
                  submitLabel="Enregistrer l'adresse"
                  showDefault
                  initial={{
                    label: "",
                    fullName: values.name,
                    streetLine1: "",
                    city: "Tunis",
                    region: "Tunis",
                    postalCode: "",
                    phone: values.phone ? `+216 ${values.phone}` : "",
                    setDefault: addresses.length === 0,
                  }}
                  onCancel={addresses.length > 0 ? () => setAddrId(fallbackAddrId()) : undefined}
                  onSubmit={(out) => createAddressAction(out)}
                  onSuccess={(out, res) => {
                    if (!res.ok || !res.id) return;
                    onAddressCreated({
                      id: res.id,
                      label: out.label ?? null,
                      fullName: out.fullName ?? null,
                      line1: out.streetLine1 ?? "",
                      line2: null,
                      city: out.city ?? null,
                      region: out.region ?? null,
                      postalCode: out.postalCode ?? null,
                      phone: out.phone ?? null,
                      isDefault: !!out.setAsDefaultShipping,
                    });
                    setAddrId(res.id);
                  }}
                />
              </div>
            )}

            {/* Guest / first-time buyer (no address book) — inline one-off. */}
            {!editingAddress && !hasProfile && (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-bold" style={{ color: "#3d4046" }}>Adresse</span>
                  <input value={values.address} onChange={(e) => set("address", e.target.value)} placeholder="Rue, numéro, étage" className="h-[54px] rounded-[16px] border-[1.5px] bg-white px-4 text-[15px] font-semibold outline-none" style={{ borderColor: err.address ? CRIMSON : "#e6dfd7" }} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-bold" style={{ color: "#3d4046" }}>Gouvernorat</span>
                  <SelectField ariaLabel="Gouvernorat" value={values.city} onChange={(v) => set("city", v)} options={governorates.map((g) => ({ value: g, label: g }))} searchable triggerClassName="h-[54px]" />
                </label>
              </div>
            )}
            <span className="flex items-center gap-2 text-[13px]" style={{ color: MUTED }}>
              <Truck size={15} style={{ color: CRIMSON }} /> Livraison prévue sous 24h à 72h ouvrées
            </span>
          </div>
        )}

        {mode === "store" && canPickup && (
          <div className="flex flex-col gap-2.5">
            <span className="text-[12px] font-extrabold uppercase tracking-[.12em]" style={{ color: MUTED }}>Choisissez votre boutique</span>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-2.5">
              {pickups.map((p) => (
                <RadioTile key={p.id} on={storeId === p.id} onClick={() => setStoreId(p.id)}>
                  <strong className="text-[15px]">{p.name}</strong>
                  {p.address && <span style={{ color: "#3d4046" }}>{p.address}</span>}
                  <span className="font-bold" style={{ color: "#15803d" }}>Prêt aujourd&apos;hui</span>
                  {p.feeCents != null && p.feeCents > 0 && (
                    <span className="font-bold" style={{ color: INK }}>Frais de retrait {fmtPrice(p.feeCents / 1000)} TND</span>
                  )}
                </RadioTile>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function ModeTile({ Icon, title, sub, price, on, onClick }: { Icon: typeof Truck; title: string; sub: string; price: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className="flex items-start gap-3.5 rounded-[22px] border-[1.5px] p-[18px] text-left transition-colors" style={{ borderColor: on ? INK : "#ece6df", background: on ? "#fbf9f7" : "#fff" }}>
      <span className="flex h-11 w-11 flex-[0_0_44px] items-center justify-center rounded-[14px] transition-colors" style={{ background: on ? CRIMSON : "#f6f2ed", color: on ? "#fff" : INK }}>
        <Icon size={20} />
      </span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-extrabold">{title}</span>
        <span className="text-[13px]" style={{ color: MUTED }}>{sub}</span>
      </span>
      <span className="whitespace-nowrap text-[15px] font-black" style={{ color: price === "Gratuit" || price === "Offerte" ? "#15803d" : INK }}>{price}</span>
    </button>
  );
}

function RadioTile({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className="flex items-start gap-3 rounded-[20px] border-[1.5px] p-4 text-left transition-colors" style={{ borderColor: on ? INK : "#ece6df", background: on ? "#fbf9f7" : "#fff" }}>
      <span className="mt-0.5 flex h-[22px] w-[22px] flex-[0_0_22px] items-center justify-center rounded-full border-2" style={{ borderColor: on ? CRIMSON : "#cfc7be" }}>
        <span className="h-2.5 w-2.5 rounded-full transition-transform" style={{ background: CRIMSON, transform: on ? "scale(1)" : "scale(0)" }} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 text-[13px] leading-snug">{children}</span>
    </button>
  );
}

/* A saved shipping address: a radio-select area + a "Modifier" button that
   opens the inline edit form (the button can't nest in the select button). */
function AddressTile({ a, on, onSelect, onEdit }: { a: CheckoutAddress; on: boolean; onSelect: () => void; onEdit: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-[20px] border-[1.5px] p-4 transition-colors" style={{ borderColor: on ? INK : "#ece6df", background: on ? "#fbf9f7" : "#fff" }}>
      <button type="button" role="radio" aria-checked={on} onClick={onSelect} className="flex min-w-0 flex-1 items-start gap-3 border-none bg-transparent p-0 text-left">
        <span className="mt-0.5 flex h-[22px] w-[22px] flex-[0_0_22px] items-center justify-center rounded-full border-2" style={{ borderColor: on ? CRIMSON : "#cfc7be" }}>
          <span className="h-2.5 w-2.5 rounded-full transition-transform" style={{ background: CRIMSON, transform: on ? "scale(1)" : "scale(0)" }} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 text-[13px] leading-snug">
          <strong className="text-[15px]">{a.label || "Adresse"}</strong>
          <span style={{ color: "#3d4046" }}>{[a.line1, a.line2].filter(Boolean).join(", ")}</span>
          <span style={{ color: "#3d4046" }}>{[a.city, a.region].filter(Boolean).join(" · ")}</span>
          {a.phone && <span className="flex items-center gap-1.5" style={{ color: MUTED }}><Phone size={12} /> {a.phone}</span>}
        </span>
      </button>
      <button type="button" onClick={onEdit} aria-label={`Modifier ${a.label || "l'adresse"}`} className="flex h-8 shrink-0 items-center gap-1 rounded-full border-[1.5px] border-[#e6dfd7] bg-white px-2.5 text-[12px] font-bold text-[#0e1218] transition-colors hover:border-[#0e1218]">
        <Pencil size={12} /> Modifier
      </button>
    </div>
  );
}

type AddressOut = {
  label?: string;
  fullName: string;
  streetLine1: string;
  city: string;
  region?: string;
  postalCode?: string;
  phone?: string;
  setAsDefaultShipping: boolean;
};

/* Shared address form — same fields as the /account address form (label, nom
   complet, adresse, ville, gouvernorat, code postal, téléphone + default), used
   for both "Nouvelle adresse" (create) and "Modifier" (edit). The parent wires
   onSubmit to createAddressAction / editAddressAction and patches its list. */
function AddressFormCard({
  title,
  submitLabel,
  showDefault,
  initial,
  onSubmit,
  onSuccess,
  onCancel,
}: {
  title: string;
  submitLabel: string;
  showDefault: boolean;
  initial: { label: string; fullName: string; streetLine1: string; city: string; region: string; postalCode: string; phone: string; setDefault: boolean };
  onSubmit: (out: AddressOut) => Promise<ActionState>;
  onSuccess: (out: AddressOut, res: ActionState) => void;
  onCancel?: () => void;
}) {
  const [f, setF] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, boolean>>({});
  const upd = (k: "label" | "fullName" | "streetLine1" | "city" | "region" | "postalCode" | "phone", v: string) =>
    setF((p) => ({ ...p, [k]: v }));

  const fieldCls = "h-[52px] rounded-[14px] border-[1.5px] bg-white px-3.5 text-[15px] font-semibold outline-none focus:border-[#0e1218]";
  const labelCls = "text-[13px] font-bold";

  const save = async () => {
    const e: Record<string, boolean> = {};
    if (f.fullName.trim().length < 3) e.fullName = true;
    if (f.streetLine1.trim().length < 5) e.streetLine1 = true;
    if (f.city.trim().length < 2) e.city = true;
    setFe(e);
    if (Object.keys(e).length) { setError("Vérifiez les champs indiqués en rouge."); return; }
    setSaving(true);
    setError(null);
    const out: AddressOut = {
      label: f.label.trim() || undefined,
      fullName: f.fullName.trim(),
      streetLine1: f.streetLine1.trim(),
      city: f.city.trim(),
      region: f.region.trim() || undefined,
      postalCode: f.postalCode.trim() || undefined,
      phone: f.phone.trim() || undefined,
      setAsDefaultShipping: f.setDefault,
    };
    try {
      const res = await onSubmit(out);
      setSaving(false);
      if (!res.ok) { setError(res.message || "L'enregistrement a échoué."); return; }
      onSuccess(out, res);
    } catch {
      setSaving(false);
      setError("Une erreur est survenue. Réessayez.");
    }
  };

  return (
    <div className="flex flex-col gap-3.5 rounded-[22px] border-[1.5px] border-[#ece6df] bg-[#fbf9f7] p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[15px] font-extrabold">{title}</span>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-[13px] font-bold" style={{ color: MUTED }}>Annuler</button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={labelCls} style={{ color: "#3d4046" }}>Nom de l&apos;adresse <span className="font-normal" style={{ color: MUTED }}>(facultatif)</span></span>
          <input value={f.label} onChange={(e) => upd("label", e.target.value)} placeholder="Maison, Bureau…" className={fieldCls} style={{ borderColor: "#e6dfd7" }} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelCls} style={{ color: "#3d4046" }}>Nom complet</span>
          <input value={f.fullName} onChange={(e) => upd("fullName", e.target.value)} placeholder="Prénom et nom" autoComplete="name" className={fieldCls} style={{ borderColor: fe.fullName ? CRIMSON : "#e6dfd7" }} />
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className={labelCls} style={{ color: "#3d4046" }}>Adresse</span>
          <input value={f.streetLine1} onChange={(e) => upd("streetLine1", e.target.value)} placeholder="Rue, numéro, étage" autoComplete="address-line1" className={fieldCls} style={{ borderColor: fe.streetLine1 ? CRIMSON : "#e6dfd7" }} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelCls} style={{ color: "#3d4046" }}>Ville</span>
          <input value={f.city} onChange={(e) => upd("city", e.target.value)} placeholder="Tunis" autoComplete="address-level2" className={fieldCls} style={{ borderColor: fe.city ? CRIMSON : "#e6dfd7" }} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelCls} style={{ color: "#3d4046" }}>Gouvernorat</span>
          <SelectField ariaLabel="Gouvernorat" value={f.region} onChange={(v) => upd("region", v)} options={governorates.map((g) => ({ value: g, label: g }))} searchable triggerClassName="h-[52px]" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelCls} style={{ color: "#3d4046" }}>Code postal <span className="font-normal" style={{ color: MUTED }}>(facultatif)</span></span>
          <input value={f.postalCode} onChange={(e) => upd("postalCode", e.target.value)} inputMode="numeric" placeholder="1000" autoComplete="postal-code" className={fieldCls} style={{ borderColor: "#e6dfd7" }} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelCls} style={{ color: "#3d4046" }}>Téléphone <span className="font-normal" style={{ color: MUTED }}>(facultatif)</span></span>
          <input value={f.phone} onChange={(e) => upd("phone", e.target.value)} inputMode="tel" placeholder="+216 22 345 678" autoComplete="tel" className={fieldCls} style={{ borderColor: "#e6dfd7" }} />
        </label>
      </div>
      {showDefault && (
        <button type="button" role="checkbox" aria-checked={f.setDefault} onClick={() => setF((p) => ({ ...p, setDefault: !p.setDefault }))} className="flex items-center gap-2.5 border-none bg-transparent p-0 text-left text-[14px] text-[#0e1218]">
          <span className="flex h-5 w-5 flex-[0_0_20px] items-center justify-center rounded-md border-[1.5px] transition-colors" style={{ borderColor: f.setDefault ? CRIMSON : "#cfc7be", background: f.setDefault ? CRIMSON : "#fff" }}>
            {f.setDefault && <Check size={12} color="#fff" strokeWidth={3.2} />}
          </span>
          Définir comme adresse de livraison par défaut
        </button>
      )}
      {error && <span className="text-[13px] font-semibold" style={{ color: CRIMSON }}>{error}</span>}
      <div className="flex flex-wrap items-center justify-end gap-2.5">
        {onCancel && (
          <button type="button" onClick={onCancel} className="flex h-11 items-center rounded-full px-4 text-[14px] font-bold" style={{ color: INK }}>Annuler</button>
        )}
        <button type="button" onClick={save} disabled={saving} className="flex h-11 items-center gap-2 rounded-full px-5 text-[14px] font-bold text-white transition-[filter] hover:brightness-95 disabled:opacity-60" style={{ background: CRIMSON }}>
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} {submitLabel}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════ STEP 2 — PAYMENT ═══════════════════ */

function PaymentStep({ pay, setPay, note, setNote, cgv, setCgv, err, hasCare }: { pay: "cod" | "card"; setPay: (p: "cod" | "card") => void; note: string; setNote: (v: string) => void; cgv: boolean; setCgv: (v: boolean) => void; err: Record<string, boolean>; hasCare: boolean }) {
  const PAYS = [
    { k: "cod" as const, Icon: Banknote, title: "Paiement à la livraison", sub: "En espèces ou par carte au livreur" },
    { k: "card" as const, Icon: CreditCard, title: "Carte bancaire", sub: "Paiement sécurisé en ligne (Flouci)" },
  ];
  return (
    <div className="flex flex-col gap-4 rounded-[28px] bg-white p-[clamp(18px,2.4vw,28px)]">
      <h2 className="m-0 text-[clamp(22px,2.2vw,30px)] font-extrabold tracking-[-.03em]">Paiement</h2>
      <div className="flex flex-col gap-2.5">
        {PAYS.map((p) => {
          const on = pay === p.k;
          return (
            <div key={p.k} className="overflow-hidden rounded-[22px] border-[1.5px] transition-colors" style={{ borderColor: on ? INK : "#ece6df", background: on ? "#fbf9f7" : "#fff" }}>
              <button type="button" role="radio" aria-checked={on} onClick={() => setPay(p.k)} className="flex w-full items-center gap-3.5 border-none bg-transparent p-[18px] text-left">
                <span className="flex h-[22px] w-[22px] flex-[0_0_22px] items-center justify-center rounded-full border-2" style={{ borderColor: on ? CRIMSON : "#cfc7be" }}>
                  <span className="h-2.5 w-2.5 rounded-full transition-transform" style={{ background: CRIMSON, transform: on ? "scale(1)" : "scale(0)" }} />
                </span>
                <span className="flex h-11 w-11 flex-[0_0_44px] items-center justify-center rounded-[14px] border border-[#ece6df] bg-white"><p.Icon size={20} /></span>
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-[15px] font-extrabold">{p.title}</span>
                  <span className="text-[13px]" style={{ color: MUTED }}>{p.sub}</span>
                </span>
              </button>
              {p.k === "card" && (
                <div className="grid transition-[grid-template-rows] duration-300 ease-soft" style={{ gridTemplateRows: on ? "1fr" : "0fr" }}>
                  <div className="overflow-hidden">
                    <p className="m-0 flex items-start gap-2 px-[18px] pb-[18px] text-[13px] leading-relaxed" style={{ color: "#3d4046" }}>
                      <Lock size={15} className="mt-0.5 flex-[0_0_15px]" style={{ color: CRIMSON }} />
                      Vous serez redirigé vers le paiement sécurisé Flouci pour régler par carte bancaire. Aucune donnée de carte n&apos;est saisie sur ce site.
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold" style={{ color: "#3d4046" }}>Note pour la commande <span className="font-normal" style={{ color: MUTED }}>· optionnel</span></span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Instructions pour le livreur, cadeau…" className="resize-y rounded-[16px] border-[1.5px] border-[#e6dfd7] bg-[#fbf9f7] px-4 py-3.5 text-[15px] outline-none focus:border-[#0e1218]" />
      </label>

      <button type="button" role="checkbox" aria-checked={cgv} onClick={() => setCgv(!cgv)} className="flex items-start gap-3 border-none bg-transparent p-0 text-left text-[14px] leading-relaxed text-[#0e1218]">
        <span className="flex h-6 w-6 flex-[0_0_24px] items-center justify-center rounded-lg border-[1.5px] transition-colors" style={{ borderColor: cgv ? CRIMSON : err.cgv ? CRIMSON : "#cfc7be", background: cgv ? CRIMSON : "#fff" }}>
          {cgv && <Check size={14} color="#fff" strokeWidth={3.2} />}
        </span>
        <span>J&apos;accepte les <Link href="/cgv" className="font-bold text-[#0e1218] underline">conditions générales de vente</Link>{hasCare ? " et les conditions de Tokyo Care" : ""}.</span>
      </button>
    </div>
  );
}

/* ═══════════════════ SUMMARY ASIDE ═══════════════════ */

export function SummaryAside({ items, totals, mode, showItems, shipping, ctaLabel, ctaIcon: CtaIcon, disabled, sending, onNext, error, showCta }: { items: CartItem[]; totals: ReturnType<typeof cartTotals>; mode: "home" | "store"; showItems: boolean; shipping: ReturnType<typeof useShippingConfig>; ctaLabel: string; ctaIcon: typeof ArrowRight; disabled: boolean; sending: boolean; onNext: () => void; error: string | null; showCta: boolean }) {
  const freeBase = totals.products;
  const left = (shipping.freeFrom || 0) - freeBase;
  const showFreeBar = mode === "home" && items.length > 0 && shipping.freeFrom > 0;
  return (
    <div className="flex flex-col gap-4 rounded-[28px] bg-white p-[clamp(18px,2.4vw,28px)]">
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[20px] font-extrabold tracking-[-.02em]">Récapitulatif</span>
        <span className="text-[13px]" style={{ color: MUTED }}>{totals.count} article{totals.count > 1 ? "s" : ""}</span>
      </div>
      {showItems && (
        <div className="flex flex-col gap-2 border-b border-[#f0ebe5] pb-3.5">
          {items.map((it) => (
            <div key={it.product.slug} className="flex items-center gap-2.5">
              <span className="relative flex h-12 w-12 flex-[0_0_48px] items-center justify-center overflow-visible rounded-xl border border-[#ece6df] bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.product.image} alt="" className="h-full w-full rounded-[11px] object-contain p-0.5" />
                <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-[20px] place-items-center rounded-full px-1 text-[11px] font-extrabold text-white" style={{ background: INK }}>{it.line.qty}</span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-bold">{it.product.title}</span>
                {it.plan && <span className="flex items-center gap-1 text-[11px] font-bold" style={{ color: CRIMSON }}><ShieldCheck size={11} /> {it.plan.label}</span>}
              </span>
              <span className="whitespace-nowrap text-[13px] font-extrabold">{fmtPrice(it.lineTotal)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2.5 text-[14px]">
        <Row label="Sous-total" value={`${fmtPrice(totals.products)} TND`} />
        {totals.protection > 0 && <Row label="Tokyo Care" value={`${fmtPrice(totals.protection)} TND`} careIcon />}
        <Row
          label={mode === "store" ? "Retrait en boutique" : "Livraison 24h – 72h"}
          value={totals.shipping ? `${fmtPrice(totals.shipping)} TND` : "Offerte"}
          valueColor={totals.shipping ? INK : "#15803d"}
        />
      </div>
      {showFreeBar && (
        <div className="flex flex-col gap-2 rounded-[16px] bg-[#fbf9f7] p-3.5">
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            <Truck size={15} style={{ color: CRIMSON }} />
            {left > 0 ? `Plus que ${fmtPrice(left)} TND pour la livraison offerte` : "Livraison offerte sur votre commande"}
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-[#ece6df]">
            <span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.min(100, shipping.freeFrom > 0 ? (freeBase / shipping.freeFrom) * 100 : 100)}%`, background: left > 0 ? CRIMSON : "#16a34a" }} />
          </span>
        </div>
      )}
      <div className="flex items-baseline justify-between gap-2.5 border-t border-[#f0ebe5] pt-3.5">
        <span className="text-[16px] font-extrabold">Total</span>
        <span className="flex flex-col items-end">
          <span className="text-[30px] font-black leading-none tracking-[-.03em]" style={{ color: CRIMSON }}>{fmtPrice(totals.total)} <span className="text-[14px]">TND</span></span>
          <span className="mt-1 text-[12px]" style={{ color: MUTED }}>TVA incluse</span>
        </span>
      </div>
      {showCta && (
        <button type="button" onClick={onNext} disabled={disabled || sending} className="flex h-[58px] items-center justify-center gap-2.5 rounded-full text-[16px] font-bold text-white transition-[filter] hover:brightness-95 disabled:opacity-40" style={{ background: CRIMSON }}>
          {sending ? <Loader2 size={18} className="animate-spin" /> : <CtaIcon size={18} />} {ctaLabel}
        </button>
      )}
      {error && <span className="text-center text-[13px] font-semibold" style={{ color: CRIMSON }}>{error}</span>}
      <span className="flex items-center justify-center gap-1.5 text-[12px]" style={{ color: MUTED }}>
        <Lock size={13} /> Paiement sécurisé · Données chiffrées
      </span>
    </div>
  );
}

function Row({ label, value, valueColor, careIcon }: { label: string; value: string; valueColor?: string; careIcon?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2.5">
      <span className="flex items-center gap-1.5" style={{ color: MUTED }}>{careIcon && <ShieldCheck size={14} style={{ color: CRIMSON }} />}{label}</span>
      <span className="font-bold" style={{ color: valueColor ?? INK }}>{value}</span>
    </div>
  );
}

/* ═══════════════════ STEP 3 — CONFIRMATION ═══════════════════ */

function Confirmation({ done }: { done: Done }) {
  const [copied, setCopied] = useState(false);
  const { phone: sitePhone } = useSiteContacts();
  const ref = done.orderNumber ?? done.orderId ?? "—";
  const careLines = done.items.filter((i) => i.plan).map((i) => ({ name: i.product.title, plan: i.plan! }));
  const steps = [
    { title: "Commande confirmée", desc: "Confirmation envoyée par e-mail et SMS.", Icon: Check, done: true },
    { title: "Préparation", desc: "Nos techniciens vérifient vos articles avant l'expédition.", Icon: ShoppingBag, done: false },
    done.mode === "home"
      ? { title: "Livraison", desc: `Le livreur vous appelle avant de passer.${done.pay === "cod" ? " Paiement à la réception." : ""}`, Icon: Truck, done: false }
      : { title: "Retrait", desc: "Présentez votre numéro de commande en boutique.", Icon: Store, done: false },
  ];

  return (
    <>
      <section className="flex flex-wrap items-stretch gap-5">
        <div className="flex min-w-0 flex-[1.4_1_480px] flex-col gap-5 rounded-[36px] bg-white p-[clamp(24px,4vw,48px)]">
          <span className="flex h-[84px] w-[84px] items-center justify-center rounded-full" style={{ background: "#16a34a" }}>
            <Check size={42} color="#fff" strokeWidth={2.8} />
          </span>
          <div className="flex flex-col gap-2.5">
            <span className="text-[13px] font-extrabold uppercase tracking-[.14em]" style={{ color: "#15803d" }}>Commande confirmée</span>
            <h1 className="m-0 text-[clamp(34px,5vw,64px)] font-black leading-[0.95] tracking-[-.05em]">Merci {done.firstName} !</h1>
            <p className="m-0 max-w-[52ch] text-[16px] leading-relaxed" style={{ color: "#3d4046" }}>
              Votre commande est enregistrée. Une confirmation a été envoyée{done.email ? ` à ${done.email}` : ""} et un conseiller Tokyo Store vous contacte au {done.phone}.
            </p>
          </div>
          <span className="flex w-fit flex-wrap items-center gap-2.5 rounded-full bg-[#f6f2ed] py-1.5 pl-[18px] pr-1.5 text-[14px]">
            <span style={{ color: MUTED }}>N° de commande</span>
            <strong className="text-[16px] tracking-[.02em]">{ref}</strong>
            <button type="button" onClick={() => { try { void navigator.clipboard?.writeText(ref); } catch { /* clipboard unavailable */ } setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold transition-colors" style={{ background: copied ? "#16a34a" : "#fff", color: copied ? "#fff" : INK }}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copié" : "Copier"}
            </button>
          </span>
          <div className="mt-auto flex flex-wrap gap-2.5">
            <Link href={done.orderId ? `/order/${done.orderId}` : "/account"} className="flex h-14 items-center gap-2.5 rounded-full px-6 text-[15px] font-bold text-white" style={{ background: INK }}>
              <Truck size={18} /> Suivre ma commande
            </Link>
            {done.orderId && (
              <a href={`/facture/${done.orderId}?autoprint=1`} className="flex h-14 items-center gap-2.5 rounded-full border-[1.5px] border-[#e6dfd7] bg-white px-5 text-[15px] font-bold text-[#0e1218] hover:border-[#0e1218]">
                <FileText size={17} /> Facture
              </a>
            )}
            <Link href="/" className="flex h-14 items-center px-4 text-[15px] font-bold text-[#0e1218] underline underline-offset-4">Continuer mes achats</Link>
          </div>
        </div>

        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-5 rounded-[36px] bg-[#0e1218] p-[clamp(24px,3.4vw,40px)] text-white">
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-extrabold uppercase tracking-[.14em]" style={{ color: "#f3a3b4" }}>{done.mode === "home" ? "Livraison prévue" : "Retrait en boutique"}</span>
            <span className="text-[clamp(28px,3vw,40px)] font-black leading-[1.05] tracking-[-.03em]">{done.mode === "home" ? "Sous 24h à 72h" : "Aujourd'hui en magasin"}</span>
            <span className="flex items-center gap-2 text-[14px]" style={{ color: "#d9dbdf" }}><MapPin size={15} /> {done.where}</span>
          </div>
          <div className="flex flex-col">
            {steps.map((s, i) => (
              <div key={s.title} className="flex gap-3.5">
                <div className="flex flex-col items-center">
                  <span className="flex h-9 w-9 flex-[0_0_36px] items-center justify-center rounded-full" style={{ background: s.done ? "#16a34a" : "rgba(255,255,255,.1)", color: s.done ? "#fff" : "#b9bdc4" }}>
                    <s.Icon size={16} />
                  </span>
                  {i < steps.length - 1 && <span className="my-1 w-0.5 flex-1" style={{ background: "rgba(255,255,255,.12)" }} />}
                </div>
                <div className="flex flex-col gap-0.5 pb-4 pt-1.5">
                  <span className="text-[15px] font-extrabold">{s.title}</span>
                  <span className="text-[13px] leading-relaxed" style={{ color: "#b9bdc4" }}>{s.desc}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-auto flex items-center justify-between gap-3 rounded-[20px] p-4" style={{ background: "rgba(255,255,255,.07)" }}>
            <span className="flex flex-col gap-0.5">
              <span className="text-[12px]" style={{ color: "#b9bdc4" }}>{done.pay === "card" ? "Carte bancaire" : "À la livraison"}</span>
              <span className="text-[22px] font-black tracking-[-.02em]">{fmtPrice(done.totals.total)} <span className="text-[12px]">TND</span></span>
            </span>
            <a href={telHref(sitePhone)} className="flex h-[42px] items-center gap-2 rounded-full bg-white px-3.5 text-[13px] font-bold text-[#0e1218]"><Phone size={14} /> {sitePhone}</a>
          </div>
        </div>
      </section>

      <section className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1.4_1_480px] flex-col gap-3.5 rounded-[28px] bg-white p-[clamp(18px,2.4vw,28px)]">
          <div className="flex items-center justify-between gap-2.5">
            <h2 className="m-0 text-[clamp(22px,2.2vw,30px)] font-extrabold tracking-[-.03em]">Votre commande</h2>
            <span className="text-[13px]" style={{ color: MUTED }}>{done.totals.count} article{done.totals.count > 1 ? "s" : ""}</span>
          </div>
          {done.items.map((it) => (
            <div key={it.product.slug} className="flex items-center gap-3.5 rounded-[20px] bg-[#fbf9f7] p-2.5">
              <span className="h-16 w-16 flex-[0_0_64px] overflow-hidden rounded-[14px] bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.product.image} alt="" className="h-full w-full object-contain p-1" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[14px] font-bold leading-tight">{it.product.title}</span>
                <span className="flex flex-wrap gap-x-2 text-[12px]" style={{ color: MUTED }}>
                  <span>Qté {it.line.qty}</span>
                  {it.plan && <span className="flex items-center gap-1 font-bold" style={{ color: CRIMSON }}><ShieldCheck size={12} /> {it.plan.label}</span>}
                </span>
              </span>
              <span className="whitespace-nowrap text-[15px] font-extrabold">{fmtPrice(it.lineTotal)} <span className="text-[10px]">TND</span></span>
            </div>
          ))}
          <div className="flex flex-col gap-2 border-t border-[#f0ebe5] pt-3 text-[14px]">
            <Row label="Sous-total" value={`${fmtPrice(done.totals.products)} TND`} />
            {done.totals.protection > 0 && <Row label="Tokyo Care" value={`${fmtPrice(done.totals.protection)} TND`} careIcon />}
            <Row label={done.mode === "store" ? "Retrait en boutique" : "Livraison"} value={done.totals.shipping ? `${fmtPrice(done.totals.shipping)} TND` : "Offerte"} valueColor={done.totals.shipping ? INK : "#15803d"} />
            <div className="flex items-baseline justify-between border-t border-[#f0ebe5] pt-2">
              <span className="text-[16px] font-extrabold">Total</span>
              <span className="text-[22px] font-black" style={{ color: CRIMSON }}>{fmtPrice(done.totals.total)} TND</span>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-3.5">
          {careLines.length > 0 && (
            <div className="relative overflow-hidden rounded-[28px] border-[1.5px] bg-white p-6" style={{ borderColor: "#f3b8c4" }}>
              <span className="absolute -right-8 -top-8 h-36 w-36 rounded-full" style={{ background: "color-mix(in oklab, var(--primary) 14%, transparent)" }} />
              <span className="relative flex h-12 w-12 items-center justify-center rounded-[14px] text-white" style={{ background: CRIMSON }}><ShieldCheck size={24} /></span>
              <div className="relative mt-3.5 flex flex-col gap-1">
                <span className="text-[12px] font-extrabold uppercase tracking-[.14em]" style={{ color: CRIMSON }}>Tokyo Care activé</span>
                <span className="text-[19px] font-extrabold tracking-[-.02em]">Vos appareils sont protégés plus longtemps</span>
              </div>
              {careLines.map((cl) => (
                <div key={cl.name} className="relative mt-2.5 flex items-center justify-between gap-2.5 rounded-[14px] bg-[#fbf9f7] px-3 py-2.5 text-[13px]">
                  <span className="truncate font-bold">{cl.name}</span>
                  <span className="whitespace-nowrap font-extrabold" style={{ color: CRIMSON }}>{cl.plan.months} mois</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-3 rounded-[28px] bg-white p-[clamp(18px,2.4vw,28px)]">
            <span className="text-[12px] font-extrabold uppercase tracking-[.12em]" style={{ color: MUTED }}>Coordonnées</span>
            <div className="flex flex-col gap-2 text-[14px]">
              <span className="flex items-center gap-2.5"><User size={15} style={{ color: "#8a857f" }} /> <strong>{done.firstName}</strong></span>
              <span className="flex items-center gap-2.5" style={{ color: "#3d4046" }}><Phone size={15} style={{ color: "#8a857f" }} /> {done.phone}</span>
              <span className="flex items-center gap-2.5" style={{ color: "#3d4046" }}><MapPin size={15} style={{ color: "#8a857f" }} /> {done.where}</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/* ═══════════════════ RECO + TOAST ═══════════════════ */

export function RecoRail({ items, onNotify }: { items: CartItem[]; onNotify: (t: string) => void }) {
  const rail = useRef<HTMLDivElement | null>(null);
  // Live pool from the seed's category; skip the first few (shown as CartStep
  // complements) so the two rails don't repeat the same products.
  const pool = useCartComplementPool(items);
  const recos = useMemo(() => pool.slice(4, 14), [pool]);
  if (recos.length === 0) return null;
  const scroll = (d: number) => rail.current?.scrollBy({ left: d * rail.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <section className="flex flex-col gap-[18px] px-1 pt-6">
      <div className="flex items-end justify-between gap-4">
        <h2 className="m-0 text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-.03em]">Vous aimerez aussi</h2>
        <div className="flex gap-2">
          <button type="button" onClick={() => scroll(-1)} aria-label="Précédent" className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-white text-[20px] text-[#0e1218] hover:bg-[#0e1218] hover:text-white">‹</button>
          <button type="button" onClick={() => scroll(1)} aria-label="Suivant" className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-white text-[20px] text-[#0e1218] hover:bg-[#0e1218] hover:text-white">›</button>
        </div>
      </div>
      <div ref={rail} className="flex gap-3.5 overflow-x-auto pb-1 [scrollbar-width:none]">
        {recos.map((p: Product) => (
          <article key={p.slug} className="flex flex-[0_0_clamp(200px,calc((100%-70px)/6),280px)] flex-col gap-2.5 rounded-[22px] border border-[#ece6df] bg-white p-2">
            <Link href={`/${p.slug}`} className="block aspect-square overflow-hidden rounded-[16px] bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.image} alt={p.title} className="h-full w-full object-contain" />
            </Link>
            <div className="flex flex-col gap-1.5 px-1.5 pb-1.5">
              {p.brand && <span className="text-[11px] font-semibold uppercase tracking-[.14em]" style={{ color: MUTED }}>{p.brand}</span>}
              <Link href={`/${p.slug}`} className="line-clamp-2 min-h-[38px] text-[14px] font-bold leading-tight text-[#0e1218]">{p.title}</Link>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[16px] font-black" style={{ color: CRIMSON }}>{fmtPrice(p.price)} <span className="text-[11px]">TND</span></span>
                <button type="button" onClick={() => { addToCart(p.slug, 1); onNotify(p.title); }} aria-label={`Ajouter ${p.title}`} className="flex h-9 w-9 items-center justify-center rounded-full text-white" style={{ background: INK }}><Plus size={16} /></button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Toast({ text }: { text: string }) {
  return (
    <div role="status" className="fixed right-5 top-5 z-50 flex w-[min(360px,calc(100%-40px))] items-center gap-3 rounded-[20px] bg-[#0e1218] p-3.5 text-white shadow-[0_18px_50px_rgba(14,18,24,.3)]">
      <span className="flex h-9 w-9 flex-[0_0_36px] items-center justify-center rounded-full" style={{ background: "#16a34a" }}><Check size={18} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-bold">Ajouté au panier</div>
        <div className="truncate text-[13px]" style={{ color: "#b9bdc4" }}>{text}</div>
      </div>
      <Link href="/panier" className="flex h-10 flex-[0_0_auto] items-center rounded-full px-3.5 text-[13px] font-bold text-white" style={{ background: CRIMSON }}>Voir le panier</Link>
    </div>
  );
}
