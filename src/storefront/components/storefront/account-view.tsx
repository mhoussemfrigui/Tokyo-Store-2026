"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  FileText,
  Heart,
  Home,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogIn,
  LogOut,
  Mail,
  MapPin,
  MessageSquare,
  Package,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Store,
  Tag,
  Truck,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { signoutAction } from "@/lib/actions/auth";
import {
  addAddressAction,
  changeEmailAction,
  changePasswordAction,
  deleteAddressAction,
  setDefaultShippingAddressAction,
  updateProfileAction,
} from "@/lib/actions/customer";
import { twoFactorQrAction } from "@/lib/actions/two-factor";
import { authClient } from "@/lib/auth/client";
import type { ActionState } from "@/lib/actions/types";
import type { OrderStatus } from "@/lib/order/status";
import {
  badge,
  btn,
  field,
  fieldLabel,
  panel,
} from "@/storefront/components/storefront/ui-classes";
import { useFavoriteCount } from "@/storefront/lib/favorites";
import { useHydrated } from "@/storefront/lib/hydration";
import { cn } from "@/storefront/lib/utils";

/** Customer service line (Tokyo Repair handles warranty + after-sales). */
const SERVICE_PHONE = "50059160";
const telHref = (p: string) => `tel:+216${p}`;

/* ─────────────────────────────── types (server → client) ───────────────── */

export type AccountSession = {
  fullName: string;
  /** First name (or email) for the greeting line. */
  greetingName: string;
  email: string;
  /** Avatar initials, e.g. "AB". */
  initials: string;
  image: string | null;
  twoFactorEnabled: boolean;
  /** "mars 2023" — cosmetic member-since month (fr-TN), or null. */
  memberSinceLabel: string | null;
};

export type AccountProfile = {
  firstName: string;
  lastName: string;
  phone: string;
  /** YYYY-MM-DD or "". */
  birthday: string;
  marketingOptIn: boolean;
};

export type AccountAddress = {
  id: string;
  label: string | null;
  fullName: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  phone: string | null;
  isDefaultShipping: boolean;
};

export type AccountOrderItem = {
  id: string;
  name: string;
  slug: string;
  qty: number;
  image: string | null;
  variantLabel: string | null;
  lineTotalLabel: string;
};

export type AccountOrder = {
  id: string;
  number: string;
  status: OrderStatus;
  statusLabel: string;
  bucket: "active" | "done" | "cancel";
  placedAtLabel: string;
  itemCount: number;
  itemCountLabel: string;
  totalLabel: string;
  subtotalLabel: string;
  discountLabel: string | null;
  shippingLabel: string;
  careLabel: string | null;
  taxLabel: string | null;
  taxIncludedNote: string | null;
  paymentLabel: string;
  deliveryModeLabel: string;
  addressLabel: string;
  headline: string;
  invoiceHref: string | null;
  callable: boolean;
  track: { steps: string[]; frontier: number; show: boolean };
  thumbs: (string | null)[];
  moreCount: number;
  items: AccountOrderItem[];
};

type TabKey = "overview" | "orders" | "addresses" | "profile" | "notifs";
type OrderFilter = "all" | "active" | "done" | "cancel";

/* ─────────────────────────────── small pieces ──────────────────────────── */

const TAB_LABELS: Record<TabKey, string> = {
  overview: "Tableau de bord",
  orders: "Commandes",
  addresses: "Adresses",
  profile: "Profil & sécurité",
  notifs: "Notifications",
};

/** Status dot-pill tone by history bucket. */
function toneFor(bucket: AccountOrder["bucket"]): { pill: string; dot: string } {
  if (bucket === "done") return { pill: "bg-success/10 text-success", dot: "bg-success" };
  if (bucket === "cancel") return { pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" };
  return { pill: "bg-primary/10 text-primary", dot: "bg-primary" };
}

const STEP_ICON: Record<string, LucideIcon> = {
  Confirmée: Check,
  Préparée: Package,
  Expédiée: Truck,
  Livrée: Home,
  Retirée: Store,
};

/** Overlapped product thumbnails (+N more), as in the mockup. */
function Thumbs({
  thumbs,
  more,
  size = 52,
}: {
  thumbs: (string | null)[];
  more: number;
  size?: 48 | 52;
}) {
  const dim = size === 48 ? "size-12" : "size-[52px]";
  const neg = size === 48 ? "-mr-2.5" : "-mr-3";
  return (
    <div className="flex items-center">
      {thumbs.map((src, i) => (
        <span
          key={i}
          className={cn(
            dim,
            neg,
            "grid shrink-0 place-items-center overflow-hidden rounded-[14px] border-2 border-background bg-surface-warm shadow-[0_0_0_1px_var(--color-border)]",
          )}
        >
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <Package aria-hidden className="size-4 text-muted-foreground/50" />
          )}
        </span>
      ))}
      {more > 0 && (
        <span
          className={cn(
            dim,
            neg,
            "grid shrink-0 place-items-center rounded-[14px] border-2 border-background bg-surface-warm text-[13px] font-extrabold text-foreground shadow-[0_0_0_1px_var(--color-border)]",
          )}
        >
          +{more}
        </span>
      )}
    </div>
  );
}

/** The 4-node (home) / 3-node (pickup) tracking rail. Generic over N steps. */
function Track({
  steps,
  frontier,
  onDark = false,
}: {
  steps: string[];
  frontier: number;
  onDark?: boolean;
}) {
  const n = steps.length;
  if (n === 0) return null;
  const firstPct = (0.5 / n) * 100;
  const lastPct = ((n - 0.5) / n) * 100;
  const span = lastPct - firstPct;
  const fillW = frontier > 0 ? (frontier / (n - 1)) * span : 0;
  return (
    <div className={cn("rounded-[20px] px-2 pb-3.5 pt-5", onDark ? "bg-white/[0.06]" : "bg-surface-warm")}>
      <div
        className="relative grid"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        <span
          aria-hidden
          className={cn("absolute top-[19px] h-1 rounded-full", onDark ? "bg-white/15" : "bg-border")}
          style={{ left: `${firstPct}%`, right: `${100 - lastPct}%` }}
        />
        <span
          aria-hidden
          className="absolute top-[19px] h-1 rounded-full bg-primary transition-[width] duration-700 ease-out"
          style={{ left: `${firstPct}%`, width: `${fillW}%` }}
        />
        {steps.map((label, i) => {
          const reached = i <= frontier;
          const done = i < frontier;
          const Icon = done ? Check : (STEP_ICON[label] ?? Check);
          return (
            <div key={label} className="relative flex flex-col items-center gap-2 px-1 text-center">
              <span
                className={cn(
                  "grid size-[42px] place-items-center rounded-full transition-colors",
                  reached
                    ? "bg-primary text-primary-foreground"
                    : onDark
                      ? "bg-white/10 text-white/40"
                      : "bg-background text-muted-foreground ring-1 ring-border",
                )}
              >
                <Icon aria-hidden className="size-[17px]" strokeWidth={2.2} />
              </span>
              <span
                className={cn(
                  "text-[12px] font-semibold sm:text-[13px]",
                  reached
                    ? onDark
                      ? "text-white"
                      : "text-foreground"
                    : onDark
                      ? "text-white/45"
                      : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Pill toggle switch (role="switch"); green when on. */
function Switch({
  checked,
  onToggle,
  disabled,
  label,
}: {
  checked: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative h-7 w-[46px] shrink-0 rounded-full p-[3px] transition-colors duration-200",
        checked ? "bg-success" : "bg-muted-foreground/40",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "block size-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.2)] transition-transform duration-200",
          checked && "translate-x-[18px]",
        )}
      />
    </button>
  );
}

/** A toggle ROW (icon tile + label/desc + switch). */
function ToggleRow({
  Icon,
  label,
  desc,
  checked,
  onToggle,
  disabled,
  soon,
}: {
  Icon: LucideIcon;
  label: string;
  desc: string;
  checked: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  soon?: boolean;
}) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <span className="flex min-w-0 items-center gap-3.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-warm text-foreground">
          <Icon aria-hidden className="size-[18px]" strokeWidth={2} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[15px] font-bold text-foreground">
            {label}
            {soon && (
              <span className={cn(badge.base, badge.neutral, "h-5 px-2 text-[10px]")}>Bientôt</span>
            )}
          </span>
          <span className="truncate text-[13px] text-muted-foreground">{desc}</span>
        </span>
      </span>
      <Switch checked={checked} onToggle={onToggle} disabled={disabled} label={label} />
    </div>
  );
}

/* ─────────────────────────────── root ──────────────────────────────────── */

export function AccountView({
  session,
  profile,
  addresses,
  orders,
}: {
  session: AccountSession | null;
  profile: AccountProfile | null;
  addresses: AccountAddress[];
  orders: AccountOrder[];
}) {
  const hydrated = useHydrated();
  const favCount = useFavoriteCount();

  const [tab, setTab] = useState<TabKey>("overview");
  const [orderFilter, setOrderFilter] = useState<OrderFilter>("all");
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  const activeCount = useMemo(() => orders.filter((o) => o.bucket === "active").length, [orders]);
  const counts = useMemo(
    () => ({
      all: orders.length,
      active: activeCount,
      done: orders.filter((o) => o.bucket === "done").length,
      cancel: orders.filter((o) => o.bucket === "cancel").length,
    }),
    [orders, activeCount],
  );
  const activeOrders = useMemo(() => orders.filter((o) => o.bucket === "active"), [orders]);
  const activeOrder = activeOrders[0] ?? null;

  /* SIGNED OUT — login CTA only (no dashboard). */
  if (!session) {
    return (
      <div className="page-container flex flex-col gap-5 pt-3">
        <section className={cn(panel, "mx-auto w-full max-w-xl p-6 text-center sm:p-10")}>
          <span className="mx-auto grid size-16 place-items-center rounded-full bg-foreground text-background">
            <UserRound aria-hidden className="size-7" strokeWidth={2} />
          </span>
          <h1 className="title-page mt-5 text-foreground">Votre compte Tokyo Store</h1>
          <p className="mx-auto mt-2 max-w-[44ch] text-[15px] leading-relaxed text-muted-foreground">
            Connectez-vous pour suivre vos commandes, gérer vos adresses et retrouver vos favoris.
          </p>
          <Link
            href="/login?from=/account"
            className={cn(btn.base, btn.lg, btn.primary, "mt-6 w-full sm:w-auto")}
          >
            <LogIn aria-hidden className="size-4" />
            Se connecter
          </Link>
          <p className="mt-4 text-[13px] text-muted-foreground">
            Pas encore de compte ?{" "}
            <Link href="/register?from=/account" className="font-semibold text-primary hover:underline">
              Créer un compte
            </Link>
          </p>
        </section>
      </div>
    );
  }

  const hasProfile = profile !== null;

  const goTab = (t: TabKey) => {
    setTab(t);
  };
  const openOrderInTab = (id: string, filter: OrderFilter = "all") => {
    setOrderFilter(filter);
    setOpenOrder(id);
    setTab("orders");
  };

  const padX = "p-5 sm:p-7 lg:p-9";

  const tabs: { key: TabKey; label: string; Icon: LucideIcon; count?: number }[] = [
    { key: "overview", label: "Tableau de bord", Icon: LayoutDashboard },
    { key: "orders", label: "Commandes", Icon: Package, count: activeCount },
    { key: "addresses", label: "Adresses", Icon: MapPin },
    { key: "profile", label: "Profil & sécurité", Icon: UserRound },
    { key: "notifs", label: "Notifications", Icon: Bell },
  ];
  const favCountShown = hydrated ? favCount : 0;

  return (
    <div className="page-container flex flex-col gap-5 pt-3">
      {/* 1 ─ PROFILE HERO */}
      <section className={cn(panel, "flex flex-col gap-6", padX)}>
        {/* Breadcrumb */}
        <nav
          aria-label="Fil d'Ariane"
          className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px]"
        >
          <Link
            href="/"
            aria-label="Accueil"
            className="grid size-[30px] shrink-0 place-items-center rounded-full bg-surface-warm text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <Home aria-hidden className="size-3.5" strokeWidth={2} />
          </Link>
          <ChevronDown aria-hidden className="size-3 -rotate-90 shrink-0 text-muted-foreground/60" />
          <span className="truncate px-0.5 py-1 text-muted-foreground">Mon compte</span>
          <ChevronDown aria-hidden className="size-3 -rotate-90 shrink-0 text-muted-foreground/60" />
          <span className="truncate rounded-full bg-primary/10 px-3 py-1.5 font-semibold text-primary">
            {TAB_LABELS[tab]}
          </span>
        </nav>

        {/* Identity + stats */}
        <div className="flex flex-wrap items-center justify-between gap-x-10 gap-y-5">
          <div className="flex min-w-0 items-center gap-5">
            <span className="relative grid size-[clamp(72px,8vw,96px)] shrink-0 place-items-center rounded-full bg-foreground text-[clamp(26px,3vw,34px)] font-black tracking-tight text-background">
              {session.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.image}
                  alt=""
                  className="size-full rounded-full object-cover"
                />
              ) : (
                session.initials
              )}
              <span className="absolute bottom-0.5 right-0.5 size-[22px] rounded-full bg-success ring-[3px] ring-background" />
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-sm text-muted-foreground">Bonjour,</span>
              <h1 className="min-w-0 truncate text-[clamp(32px,4.4vw,60px)] font-black leading-none tracking-[-0.045em] text-foreground">
                {session.greetingName || session.fullName}
              </h1>
              <span className="truncate text-[13px] text-muted-foreground">
                {session.memberSinceLabel ? `Client depuis ${session.memberSinceLabel} · ` : ""}
                {session.email}
              </span>
            </div>
          </div>

          <div className="grid w-full flex-[0_1_460px] grid-cols-3 gap-2 sm:w-auto">
            <button
              type="button"
              onClick={() => openOrderInTab(activeCount === 1 ? activeOrder?.id ?? "" : "", "active")}
              className="flex flex-col items-start gap-1 rounded-[22px] bg-foreground p-4 text-left text-background transition-[filter] hover:brightness-110"
            >
              <span className="text-[28px] font-black leading-none tracking-tight">{activeCount}</span>
              <span className="text-[12px] font-bold opacity-75">En cours</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setOrderFilter("all");
                setTab("orders");
              }}
              className="flex flex-col items-start gap-1 rounded-[22px] bg-surface-warm p-4 text-left text-foreground transition-[filter] hover:brightness-95"
            >
              <span className="text-[28px] font-black leading-none tracking-tight">{orders.length}</span>
              <span className="text-[12px] font-bold opacity-75">Commandes</span>
            </button>
            <Link
              href="/favoris"
              className="flex flex-col items-start gap-1 rounded-[22px] bg-primary/10 p-4 text-left text-primary transition-[filter] hover:brightness-95"
            >
              <span className="text-[28px] font-black leading-none tracking-tight">
                {favCountShown}
              </span>
              <span className="text-[12px] font-bold opacity-75">Favoris</span>
            </Link>
          </div>
        </div>
      </section>

      {/* 2 ─ BODY */}
      <section className="flex flex-wrap items-start gap-5">
        {/* Nav rail */}
        <nav
          aria-label="Menu du compte"
          className="flex w-full flex-[1_1_100%] flex-row gap-1 overflow-x-auto rounded-island bg-background p-2.5 shadow-island [scrollbar-width:none] lg:sticky lg:top-3 lg:w-[280px] lg:flex-[0_0_280px] lg:flex-col"
        >
          {tabs.map(({ key, label, Icon, count }) => {
            const on = tab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => goTab(key)}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex h-[52px] shrink-0 items-center gap-3 rounded-[18px] py-0 pl-2 pr-3.5 text-left text-sm font-bold transition-colors",
                  on ? "bg-foreground text-background" : "text-foreground hover:bg-surface-warm",
                )}
              >
                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-xl transition-colors",
                    on ? "bg-primary text-primary-foreground" : "bg-surface-warm text-foreground",
                  )}
                >
                  <Icon aria-hidden className="size-[17px]" strokeWidth={2.1} />
                </span>
                <span className="flex-1">{label}</span>
                {count != null && count > 0 && (
                  <span
                    className={cn(
                      "grid h-[22px] min-w-6 place-items-center rounded-full px-1.5 text-[12px] font-extrabold",
                      on ? "bg-white/20 text-background" : "bg-surface-warm text-foreground",
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          <Link
            href="/favoris"
            className="flex h-[52px] shrink-0 items-center gap-3 rounded-[18px] py-0 pl-2 pr-3.5 text-left text-sm font-bold text-foreground transition-colors hover:bg-surface-warm"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-warm text-foreground">
              <Heart aria-hidden className="size-[17px]" strokeWidth={2.1} />
            </span>
            <span className="flex-1">Favoris</span>
            {favCountShown > 0 && (
              <span className="grid h-[22px] min-w-6 place-items-center rounded-full bg-surface-warm px-1.5 text-[12px] font-extrabold text-foreground">
                {favCountShown}
              </span>
            )}
          </Link>

          <span aria-hidden className="mx-2 my-1.5 hidden h-px bg-border lg:block" />

          <form action={signoutAction} className="shrink-0">
            <button
              type="submit"
              className="flex h-[52px] w-full items-center gap-3 rounded-[18px] py-0 pl-2 pr-3.5 text-left text-sm font-bold text-primary transition-colors hover:bg-primary/10"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <LogOut aria-hidden className="size-[17px]" strokeWidth={2.1} />
              </span>
              <span className="flex-1">Se déconnecter</span>
            </button>
          </form>
        </nav>

        {/* Tab content */}
        <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-4">
          {tab === "overview" && (
            <OverviewTab
              activeOrders={activeOrders}
              orders={orders}
              activeCount={activeCount}
              addressCount={addresses.length}
              favCount={favCountShown}
              padX={padX}
              onOpenOrder={openOrderInTab}
              onGoOrders={() => setTab("orders")}
              onGoAddresses={() => setTab("addresses")}
            />
          )}

          {tab === "orders" && (
            <OrdersTab
              orders={orders}
              counts={counts}
              filter={orderFilter}
              setFilter={setOrderFilter}
              openOrder={openOrder}
              setOpenOrder={setOpenOrder}
              padX={padX}
            />
          )}

          {tab === "addresses" && (
            <AddressesTab
              addresses={addresses}
              hasProfile={hasProfile}
              defaultFullName={session.fullName}
              padX={padX}
            />
          )}

          {tab === "profile" && (
            <ProfileTab
              profile={profile}
              email={session.email}
              twoFactorEnabled={session.twoFactorEnabled}
              padX={padX}
            />
          )}

          {tab === "notifs" && (
            <NotificationsTab profile={profile} padX={padX} />
          )}
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────────── OVERVIEW ──────────────────────────────── */

function OverviewTab({
  activeOrders,
  orders,
  activeCount,
  addressCount,
  favCount,
  padX,
  onOpenOrder,
  onGoOrders,
  onGoAddresses,
}: {
  activeOrders: AccountOrder[];
  orders: AccountOrder[];
  activeCount: number;
  addressCount: number;
  favCount: number;
  padX: string;
  onOpenOrder: (id: string, filter?: OrderFilter) => void;
  onGoOrders: () => void;
  onGoAddresses: () => void;
}) {
  const recent = orders.slice(0, 3);

  const quick: {
    label: string;
    desc: string;
    Icon: LucideIcon;
    tint: string;
    onClick?: () => void;
    href?: string;
  }[] = [
    {
      label: "Suivre une commande",
      desc: `${activeCount} en cours`,
      Icon: Truck,
      tint: "bg-primary/10 text-primary",
      onClick: () => onOpenOrder(activeOrders.length === 1 ? activeOrders[0].id : "", "active"),
    },
    {
      label: "Mes favoris",
      desc: `${favCount} produit${favCount > 1 ? "s" : ""}`,
      Icon: Heart,
      tint: "bg-surface-warm text-foreground",
      href: "/favoris",
    },
    {
      label: "Mes adresses",
      desc: `${addressCount} adresse${addressCount > 1 ? "s" : ""}`,
      Icon: MapPin,
      tint: "bg-surface-warm text-foreground",
      onClick: onGoAddresses,
    },
    {
      label: "Reprise immédiate",
      desc: "Estimez votre appareil",
      Icon: RefreshCw,
      tint: "bg-success/10 text-success",
      href: "/service-client",
    },
  ];

  return (
    <>
      {/* Active orders — one dark INK card per in-progress order */}
      {activeOrders.map((o, i) => (
        <div
          key={o.id}
          className="flex flex-col gap-5 rounded-island bg-foreground p-5 text-background sm:p-7"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-primary">
                Commande en cours
                {activeOrders.length > 1 ? ` ${i + 1}/${activeOrders.length}` : ""}
              </span>
              <span className="text-[clamp(20px,2vw,26px)] font-extrabold tracking-tight">
                {o.headline}
              </span>
              <span className="text-[13px] text-background/70">
                {o.number} · {o.itemCountLabel} · {o.totalLabel} TND
              </span>
            </div>
            <button
              type="button"
              onClick={() => onOpenOrder(o.id, "active")}
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-background px-5 text-sm font-bold text-foreground transition-[filter] hover:brightness-95"
            >
              Voir le détail
              <ArrowRight aria-hidden className="size-4" strokeWidth={2.2} />
            </button>
          </div>

          {o.track.show && <Track steps={o.track.steps} frontier={o.track.frontier} onDark />}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Thumbs thumbs={o.thumbs} more={o.moreCount} size={48} />
            <span className="flex items-center gap-2 text-[13px] text-background/80">
              <MapPin aria-hidden className="size-4 shrink-0" strokeWidth={2} />
              {o.deliveryModeLabel} {o.addressLabel}
            </span>
          </div>
        </div>
      ))}

      {/* Quick actions */}
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
        {quick.map((q) => {
          const inner = (
            <>
              <span className={cn("grid size-11 place-items-center rounded-[14px]", q.tint)}>
                <q.Icon aria-hidden className="size-5" strokeWidth={2.1} />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px] font-extrabold text-foreground">{q.label}</span>
                <span className="text-[13px] text-muted-foreground">{q.desc}</span>
              </span>
            </>
          );
          const cls = cn(
            panel,
            "flex flex-col gap-3.5 p-5 text-left transition-transform hover:-translate-y-0.5",
          );
          return q.href ? (
            <Link key={q.label} href={q.href} className={cls}>
              {inner}
            </Link>
          ) : (
            <button key={q.label} type="button" onClick={q.onClick} className={cls}>
              {inner}
            </button>
          );
        })}
      </div>

      {/* Recent orders */}
      <div className={cn(panel, "flex flex-col gap-3.5", padX)}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="title-block text-foreground">Dernières commandes</h2>
          {orders.length > 0 && (
            <button
              type="button"
              onClick={onGoOrders}
              className="inline-flex h-10 items-center rounded-full bg-surface-warm px-4 text-[13px] font-bold text-foreground transition-colors hover:bg-foreground hover:text-background"
            >
              Tout voir
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-card bg-surface-warm px-6 py-10 text-center">
            <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
              <Package aria-hidden className="size-5" strokeWidth={2} />
            </span>
            <p className="max-w-[40ch] text-[15px] text-muted-foreground">
              Vos commandes apparaîtront ici dès votre premier achat.
            </p>
            <Link href="/" className={cn(btn.base, btn.md, btn.primary)}>
              Découvrir nos bons plans
            </Link>
          </div>
        ) : (
          recent.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => onOpenOrder(o.id)}
              className="flex flex-wrap items-center gap-x-5 gap-y-3.5 rounded-[20px] border border-border bg-background p-3.5 text-left transition-colors hover:border-foreground"
            >
              <Thumbs thumbs={o.thumbs} more={o.moreCount} />
              <span className="flex min-w-0 flex-[1_1_160px] flex-col gap-0.5 pl-3">
                <span className="text-[15px] font-extrabold text-foreground">{o.number}</span>
                <span className="text-[13px] text-muted-foreground">
                  {o.placedAtLabel} · {o.itemCountLabel}
                </span>
              </span>
              <StatusPill order={o} />
              <span className="shrink-0 whitespace-nowrap text-[17px] font-black text-foreground">
                {o.totalLabel} <span className="text-[11px]">TND</span>
              </span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

function StatusPill({ order }: { order: AccountOrder }) {
  const tone = toneFor(order.bucket);
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12px] font-extrabold",
        tone.pill,
      )}
    >
      <span className={cn("size-[7px] rounded-full", tone.dot)} />
      {order.statusLabel}
    </span>
  );
}

/* ─────────────────────────────── ORDERS ────────────────────────────────── */

function OrdersTab({
  orders,
  counts,
  filter,
  setFilter,
  openOrder,
  setOpenOrder,
  padX,
}: {
  orders: AccountOrder[];
  counts: { all: number; active: number; done: number; cancel: number };
  filter: OrderFilter;
  setFilter: (f: OrderFilter) => void;
  openOrder: string | null;
  setOpenOrder: (id: string | null) => void;
  padX: string;
}) {
  const shown = useMemo(
    () => (filter === "all" ? orders : orders.filter((o) => o.bucket === filter)),
    [orders, filter],
  );
  const filters: { key: OrderFilter; label: string; count: number }[] = [
    { key: "all", label: "Toutes", count: counts.all },
    { key: "active", label: "En cours", count: counts.active },
    { key: "done", label: "Livrées", count: counts.done },
    { key: "cancel", label: "Annulées", count: counts.cancel },
  ];

  return (
    <div className={cn(panel, "flex flex-col gap-[18px]", padX)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="title-block text-foreground">Mes commandes</h2>
        <div className="flex flex-wrap gap-1.5 rounded-full bg-surface-warm p-1">
          {filters.map((f) => {
            const on = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold text-foreground transition-colors",
                  on ? "bg-background shadow-[0_1px_4px_rgba(14,18,24,.1)]" : "hover:text-primary",
                )}
              >
                {f.label}
                <span className="text-[11px] opacity-60">{f.count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-8 text-center text-[15px] text-muted-foreground">
          Aucune commande dans cette catégorie.
        </p>
      ) : (
        shown.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            expanded={openOrder === o.id}
            onToggle={() => setOpenOrder(openOrder === o.id ? null : o.id)}
          />
        ))
      )}
    </div>
  );
}

function OrderCard({
  order,
  expanded,
  onToggle,
}: {
  order: AccountOrder;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-card border-[1.5px] transition-colors",
        expanded ? "border-foreground" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "flex w-full flex-wrap items-center gap-x-5 gap-y-3.5 p-4 text-left transition-colors",
          expanded ? "bg-surface-warm" : "bg-background",
        )}
      >
        <Thumbs thumbs={order.thumbs} more={order.moreCount} />
        <span className="flex min-w-0 flex-[1_1_160px] flex-col gap-0.5 pl-3">
          <span className="text-[15px] font-extrabold text-foreground">{order.number}</span>
          <span className="text-[13px] text-muted-foreground">
            {order.placedAtLabel} · {order.itemCountLabel}
          </span>
        </span>
        <StatusPill order={order} />
        <span className="shrink-0 whitespace-nowrap text-[17px] font-black text-foreground">
          {order.totalLabel} <span className="text-[11px]">TND</span>
        </span>
        <span
          className={cn(
            "grid size-[34px] shrink-0 place-items-center rounded-full bg-surface-warm text-foreground transition-transform",
            expanded && "rotate-180",
          )}
        >
          <ChevronDown aria-hidden className="size-4" strokeWidth={2.4} />
        </span>
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-[400ms] ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-[18px] px-4 pb-[18px] pt-1">
            {order.track.show && <Track steps={order.track.steps} frontier={order.track.frontier} />}

            <div className="flex flex-wrap gap-4">
              {/* Articles */}
              <div className="flex min-w-0 flex-[2_1_300px] flex-col gap-2">
                <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
                  Articles
                </span>
                {order.items.map((it) => (
                  <div
                    key={it.id}
                    className="flex items-center gap-3 rounded-inner bg-surface-warm p-2"
                  >
                    <Link
                      href={`/${it.slug}`}
                      className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl bg-background"
                    >
                      {it.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={it.image} alt="" className="size-full object-cover" loading="lazy" />
                      ) : (
                        <Package aria-hidden className="size-5 text-muted-foreground/50" />
                      )}
                    </Link>
                    <Link href={`/${it.slug}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="line-clamp-2 text-[14px] font-bold leading-snug text-foreground">
                        {it.name}
                      </span>
                      <span className="text-[12px] text-muted-foreground">
                        {it.variantLabel ? `${it.variantLabel} · ` : ""}Qté {it.qty}
                      </span>
                    </Link>
                    <span className="shrink-0 whitespace-nowrap text-[15px] font-extrabold text-foreground">
                      {it.lineTotalLabel} <span className="text-[10px]">TND</span>
                    </span>
                  </div>
                ))}
              </div>

              {/* Récapitulatif */}
              <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-2.5">
                <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
                  Récapitulatif
                </span>
                <div className="flex flex-col gap-2 rounded-inner bg-surface-warm p-3.5 text-[14px]">
                  <RecapRow label="Sous-total" value={`${order.subtotalLabel} TND`} />
                  {order.discountLabel && <RecapRow label="Remise" value={order.discountLabel} />}
                  <RecapRow label="Livraison" value={order.shippingLabel} />
                  {order.careLabel && <RecapRow label="Tokyo Care" value={order.careLabel} />}
                  {order.taxLabel && <RecapRow label="TVA" value={order.taxLabel} />}
                  <div className="flex justify-between gap-2.5 border-t border-border pt-2">
                    <span className="font-extrabold text-foreground">Total</span>
                    <span className="font-black text-foreground">{order.totalLabel} TND</span>
                  </div>
                  {order.taxIncludedNote && (
                    <p className="text-right text-[12px] text-muted-foreground">
                      {order.taxIncludedNote}
                    </p>
                  )}
                  <RecapRow label="Paiement" value={order.paymentLabel} small />
                  <RecapRow label={order.deliveryModeLabel} value={order.addressLabel} small />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              {order.callable && (
                <a
                  href={telHref(SERVICE_PHONE)}
                  className="inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-[18px] text-[13px] font-bold text-background transition-[filter] hover:brightness-110"
                >
                  <Phone aria-hidden className="size-[15px]" strokeWidth={2.2} />
                  Appeler le service client
                </a>
              )}
              {order.invoiceHref && (
                <a
                  href={order.invoiceHref}
                  className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-border bg-background px-[18px] text-[13px] font-bold text-foreground transition-colors hover:border-foreground"
                >
                  <FileText aria-hidden className="size-[15px]" strokeWidth={2.2} />
                  Télécharger la facture
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecapRow({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-2.5", small && "text-[13px]")}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-bold text-foreground">{value}</span>
    </div>
  );
}

/* ─────────────────────────────── ADDRESSES ─────────────────────────────── */

function AddressesTab({
  addresses,
  hasProfile,
  defaultFullName,
  padX,
}: {
  addresses: AccountAddress[];
  hasProfile: boolean;
  defaultFullName: string;
  padX: string;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    addAddressAction,
    null,
  );

  // Close the form on a successful add (the action revalidates /account).
  useEffect(() => {
    if (state?.ok) setAddOpen(false);
  }, [state?.ok]);

  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);
  const generalError = state && !state.ok && !state.fieldErrors ? state.message : undefined;

  return (
    <div className={cn(panel, "flex flex-col gap-[18px]", padX)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="title-block text-foreground">Mes adresses</h2>
        {hasProfile && (
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className={cn(
              "inline-flex h-11 items-center gap-2 rounded-full px-[18px] text-sm font-bold text-background transition-colors",
              addOpen ? "bg-muted-foreground" : "bg-primary",
            )}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2.6} />
            {addOpen ? "Annuler" : "Ajouter une adresse"}
          </button>
        )}
      </div>

      {!hasProfile && (
        <p className="rounded-inner bg-surface-warm p-4 text-[14px] text-muted-foreground">
          Votre carnet d&apos;adresses sera disponible une fois votre profil client créé (après
          une première commande).
        </p>
      )}

      {/* Add form */}
      {hasProfile && (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-[400ms] ease-out",
            addOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <form
              action={action}
              className="mb-1 grid gap-3 rounded-[22px] bg-surface-warm p-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]"
            >
              {generalError && (
                <p className="col-span-full rounded-inner bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                  {generalError}
                </p>
              )}
              <label className="flex flex-col">
                <span className={fieldLabel}>Nom de l&apos;adresse</span>
                <input name="label" placeholder="Maison, Bureau…" className={field} />
                <FieldHint message={err("label")} />
              </label>
              <label className="flex flex-col">
                <span className={fieldLabel}>Nom complet</span>
                <input
                  name="fullName"
                  defaultValue={defaultFullName}
                  required
                  autoComplete="name"
                  className={field}
                  aria-invalid={!!err("fullName")}
                />
                <FieldHint message={err("fullName")} />
              </label>
              <label className="col-span-full flex flex-col">
                <span className={fieldLabel}>Adresse</span>
                <input
                  name="streetLine1"
                  placeholder="Rue, numéro, étage"
                  required
                  autoComplete="address-line1"
                  className={field}
                  aria-invalid={!!err("streetLine1")}
                />
                <FieldHint message={err("streetLine1")} />
              </label>
              <label className="flex flex-col">
                <span className={fieldLabel}>Ville</span>
                <input
                  name="city"
                  placeholder="Tunis"
                  required
                  autoComplete="address-level2"
                  className={field}
                  aria-invalid={!!err("city")}
                />
                <FieldHint message={err("city")} />
              </label>
              <label className="flex flex-col">
                <span className={fieldLabel}>Gouvernorat (facultatif)</span>
                <input name="region" autoComplete="address-level1" className={field} />
              </label>
              <label className="flex flex-col">
                <span className={fieldLabel}>Code postal (facultatif)</span>
                <input name="postalCode" autoComplete="postal-code" className={field} />
              </label>
              <label className="flex flex-col">
                <span className={fieldLabel}>Téléphone (facultatif)</span>
                <input name="phone" type="tel" autoComplete="tel" className={field} />
              </label>
              <label className="col-span-full flex cursor-pointer items-center gap-2.5 text-[14px] text-foreground">
                <input
                  type="checkbox"
                  name="setAsDefaultShipping"
                  className="size-4 accent-[var(--primary)]"
                />
                Définir comme adresse de livraison par défaut
              </label>
              <div className="col-span-full flex justify-end">
                <button
                  type="submit"
                  disabled={pending}
                  className={cn(btn.base, btn.md, btn.ink)}
                >
                  {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
                  Enregistrer l&apos;adresse
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cards */}
      {addresses.length === 0 && hasProfile ? (
        <p className="rounded-inner bg-surface-warm p-4 text-[14px] text-muted-foreground">
          Vous n&apos;avez pas encore enregistré d&apos;adresse.
        </p>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
          {addresses.map((a) => (
            <AddressCard key={a.id} address={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AddressCard({ address: a }: { address: AccountAddress }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const run = (fn: () => Promise<ActionState>) => {
    setErr(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setErr(res.message);
      else router.refresh();
    });
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-3.5 rounded-card border-[1.5px] p-5 transition-colors",
        a.isDefaultShipping ? "border-foreground bg-surface-warm" : "border-border bg-background",
      )}
    >
      <div className="flex items-center justify-between gap-2.5">
        <span className="flex items-center gap-2.5">
          <span
            className={cn(
              "grid size-10 place-items-center rounded-xl",
              a.isDefaultShipping ? "bg-primary text-primary-foreground" : "bg-surface-warm text-foreground",
            )}
          >
            <Home aria-hidden className="size-[18px]" strokeWidth={2.1} />
          </span>
          <strong className="text-[16px] text-foreground">{a.label || "Adresse"}</strong>
        </span>
        {a.isDefaultShipping && (
          <span className="inline-flex h-[26px] items-center rounded-full bg-primary px-2.5 text-[11px] font-extrabold text-primary-foreground">
            Par défaut
          </span>
        )}
      </div>

      <div className="flex flex-col gap-0.5 text-[14px] leading-normal text-muted-foreground">
        <span className="font-bold text-foreground">{a.fullName}</span>
        <span>
          {a.line1}
          {a.line2 ? `, ${a.line2}` : ""}
        </span>
        <span>{[a.postalCode, a.city, a.region].filter(Boolean).join(" ")}</span>
        {a.phone && <span>{a.phone}</span>}
      </div>

      {err && <p className="text-[12px] text-destructive">{err}</p>}

      <div className="mt-auto flex flex-wrap gap-1.5">
        {!a.isDefaultShipping && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => setDefaultShippingAddressAction(a.id))}
            className="inline-flex h-9 items-center rounded-full border-[1.5px] border-border bg-background px-3.5 text-[13px] font-bold text-foreground transition-colors hover:border-foreground disabled:opacity-60"
          >
            Définir par défaut
          </button>
        )}
        {!a.isDefaultShipping && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => deleteAddressAction(a.id))}
            className="inline-flex h-9 items-center rounded-full px-3.5 text-[13px] font-bold text-primary transition-colors hover:bg-primary/10 disabled:opacity-60"
          >
            Supprimer
          </button>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────── PROFILE & SECURITY ────────────────────── */

function ProfileTab({
  profile,
  email,
  twoFactorEnabled,
  padX,
}: {
  profile: AccountProfile | null;
  email: string;
  twoFactorEnabled: boolean;
  padX: string;
}) {
  return (
    <>
      <div className={cn(panel, "flex flex-col gap-5", padX)}>
        <div className="flex flex-col gap-1">
          <h2 className="title-block text-foreground">Informations personnelles</h2>
          <span className="text-[14px] text-muted-foreground">
            Ces informations sont utilisées pour vos livraisons et vos factures.
          </span>
        </div>
        {profile ? (
          <PersonalInfoForm
            key={`${profile.firstName}|${profile.lastName}|${profile.phone}|${profile.birthday}`}
            profile={profile}
            email={email}
          />
        ) : (
          <p className="rounded-inner bg-surface-warm p-4 text-[14px] text-muted-foreground">
            Votre fiche client n&apos;est pas encore disponible. Vos informations seront
            renseignées après votre première commande. Vous pouvez tout de même gérer votre
            e-mail et votre mot de passe ci-dessous.
          </p>
        )}
        {!profile && <EmailRow email={email} />}
      </div>

      <div className={cn(panel, "flex flex-col gap-1.5", padX)}>
        <h2 className="title-block mb-1.5 text-foreground">Sécurité</h2>
        <PasswordRow />
        <TwoFactorRow initialEnabled={twoFactorEnabled} />
        <ToggleRow
          Icon={KeyRound}
          label="Alertes de connexion"
          desc="Être prévenu d'une connexion depuis un nouvel appareil"
          checked={false}
          disabled
          soon
        />
      </div>
    </>
  );
}

function PersonalInfoForm({ profile, email }: { profile: AccountProfile; email: string }) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    updateProfileAction,
    null,
  );
  const [draft, setDraft] = useState(profile);
  const dirty =
    draft.firstName !== profile.firstName ||
    draft.lastName !== profile.lastName ||
    draft.phone !== profile.phone ||
    draft.birthday !== profile.birthday;

  const set = (k: keyof AccountProfile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);
  const generalError = state && !state.ok && !state.fieldErrors ? state.message : undefined;
  const saved = state?.ok === true && !dirty;

  return (
    <form action={action} className="flex flex-col gap-5">
      {/* Preserve the marketing opt-in (the action reads an ABSENT checkbox as
          opt-OUT), so saving the profile never silently clears it. */}
      {profile.marketingOptIn && <input type="hidden" name="marketingOptIn" value="on" />}

      {generalError && (
        <p className="rounded-inner bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {generalError}
        </p>
      )}

      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]">
        <label className="flex min-w-0 flex-col">
          <span className={fieldLabel}>Prénom</span>
          <input
            name="firstName"
            value={draft.firstName}
            onChange={set("firstName")}
            autoComplete="given-name"
            className={field}
            aria-invalid={!!err("firstName")}
          />
          <FieldHint message={err("firstName")} />
        </label>
        <label className="flex min-w-0 flex-col">
          <span className={fieldLabel}>Nom</span>
          <input
            name="lastName"
            value={draft.lastName}
            onChange={set("lastName")}
            autoComplete="family-name"
            className={field}
            aria-invalid={!!err("lastName")}
          />
          <FieldHint message={err("lastName")} />
        </label>
        <div className="col-span-full">
          <EmailRow email={email} />
        </div>
        <label className="flex min-w-0 flex-col">
          <span className={fieldLabel}>Téléphone</span>
          <input
            name="phone"
            type="tel"
            value={draft.phone}
            onChange={set("phone")}
            autoComplete="tel"
            placeholder="+216 XX XXX XXX"
            className={field}
            aria-invalid={!!err("phone")}
          />
          <FieldHint message={err("phone")} />
        </label>
        <label className="flex min-w-0 flex-col">
          <span className={fieldLabel}>Date de naissance</span>
          <input
            name="birthday"
            type="date"
            value={draft.birthday}
            onChange={set("birthday")}
            className={field}
            aria-invalid={!!err("birthday")}
          />
          <FieldHint message={err("birthday")} />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {dirty && <span className="text-[13px] text-muted-foreground">Modifications non enregistrées</span>}
        {saved && <span className="text-[13px] font-semibold text-success">Profil enregistré</span>}
        <button
          type="submit"
          disabled={pending || !dirty}
          className={cn(btn.base, btn.lg, dirty ? btn.primary : btn.ink)}
        >
          {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
          {pending ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}

/** E-mail: read-only display + a dedicated change-email flow (the backend sends a
 *  confirmation link to the CURRENT address — it can't be edited inline). */
function EmailRow({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    changeEmailAction,
    null,
  );
  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state?.ok]);
  const generalError = state && !state.ok ? state.message : undefined;

  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabel}>E-mail</span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-12 min-w-0 flex-1 items-center truncate rounded-full border border-border bg-surface-warm px-4 text-[15px] font-semibold text-foreground">
          {email}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(btn.base, btn.md, btn.outline)}
        >
          {open ? "Annuler" : "Modifier"}
        </button>
      </div>
      {state?.ok && (
        <p className="rounded-inner bg-success/10 px-3 py-2 text-[13px] text-success">
          {state.message}
        </p>
      )}
      {open && (
        <form action={action} className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col">
            <span className={fieldLabel}>Nouvelle adresse e-mail</span>
            <input name="newEmail" type="email" required autoComplete="email" className={field} />
          </label>
          <button type="submit" disabled={pending} className={cn(btn.base, btn.md, btn.ink)}>
            {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
            Envoyer le lien
          </button>
          {generalError && !state?.ok && (
            <p className="w-full text-[13px] text-destructive">{generalError}</p>
          )}
        </form>
      )}
    </div>
  );
}

function PasswordRow() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    changePasswordAction,
    null,
  );
  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state?.ok]);
  const generalError = state && !state.ok ? state.message : undefined;

  return (
    <div className="border-b border-border py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-warm text-foreground">
            <KeyRound aria-hidden className="size-[18px]" strokeWidth={2} />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] font-bold text-foreground">Mot de passe</span>
            <span className="text-[13px] text-muted-foreground">
              Changez-le régulièrement pour protéger votre compte
            </span>
          </span>
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(btn.base, btn.sm, btn.outline)}
        >
          {open ? "Annuler" : "Modifier"}
        </button>
      </div>
      {state?.ok && (
        <p className="mt-3 rounded-inner bg-success/10 px-3 py-2 text-[13px] text-success">
          {state.message}
        </p>
      )}
      {open && (
        <form action={action} className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col">
            <span className={fieldLabel}>Mot de passe actuel</span>
            <input
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              className={field}
            />
          </label>
          <label className="flex flex-col">
            <span className={fieldLabel}>Nouveau</span>
            <input
              name="newPassword"
              type="password"
              required
              autoComplete="new-password"
              className={field}
            />
          </label>
          <label className="flex flex-col">
            <span className={fieldLabel}>Confirmer</span>
            <input
              name="confirmPassword"
              type="password"
              required
              autoComplete="new-password"
              className={field}
            />
          </label>
          {generalError && !state?.ok && (
            <p className="text-[13px] text-destructive sm:col-span-3">{generalError}</p>
          )}
          <div className="flex justify-end sm:col-span-3">
            <button type="submit" disabled={pending} className={cn(btn.base, btn.md, btn.ink)}>
              {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
              Mettre à jour
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** 2FA — the design's single toggle opens the full TOTP enrol/disable flow. */
function TwoFactorRow({ initialEnabled }: { initialEnabled: boolean }) {
  const { data: session } = authClient.useSession();
  const liveEnabled =
    (session?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled ??
    initialEnabled;

  type Phase =
    | { step: "idle" }
    | { step: "password"; mode: "enable" | "disable" }
    | { step: "confirm"; qr: string | null; uri: string; backupCodes: string[] }
    | { step: "codes"; backupCodes: string[] };

  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setPhase({ step: "idle" });
    setPassword("");
    setCode("");
    setErr(null);
    setBusy(false);
  };

  const onToggle = () => {
    if (phase.step !== "idle") {
      reset();
      return;
    }
    setPhase({ step: "password", mode: liveEnabled ? "disable" : "enable" });
  };

  const beginEnable = async () => {
    setErr(null);
    setBusy(true);
    const res = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (res.error || !res.data) {
      setErr("Mot de passe incorrect ou erreur. Réessayez.");
      return;
    }
    const uri = res.data.totpURI;
    const backupCodes = res.data.backupCodes ?? [];
    const qr = await twoFactorQrAction(uri).catch(() => null);
    setPassword("");
    setPhase({ step: "confirm", qr, uri, backupCodes });
  };

  const disable = async () => {
    setErr(null);
    setBusy(true);
    const res = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (res.error) {
      setErr("Mot de passe incorrect ou erreur.");
      return;
    }
    reset();
  };

  const confirmEnable = async (backupCodes: string[]) => {
    setErr(null);
    setBusy(true);
    const res = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (res.error) {
      setErr("Code invalide. Vérifiez l'heure de votre téléphone et réessayez.");
      return;
    }
    setCode("");
    setPhase({ step: "codes", backupCodes });
  };

  return (
    <div className="border-b border-border py-3.5">
      <div className="flex min-h-10 items-center justify-between gap-4">
        <span className="flex min-w-0 items-center gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-warm text-foreground">
            {liveEnabled ? (
              <ShieldCheck aria-hidden className="size-[18px] text-success" strokeWidth={2} />
            ) : (
              <ShieldOff aria-hidden className="size-[18px]" strokeWidth={2} />
            )}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-bold text-foreground">Validation en deux étapes</span>
            <span className="truncate text-[13px] text-muted-foreground">
              {liveEnabled
                ? "Un code de votre application est demandé à chaque connexion"
                : "Ajoutez un code temporaire à la connexion"}
            </span>
          </span>
        </span>
        <Switch
          checked={liveEnabled}
          onToggle={onToggle}
          label="Validation en deux étapes"
        />
      </div>

      {err && <p className="mt-3 text-[13px] text-destructive">{err}</p>}

      {phase.step === "password" && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-[13px] text-muted-foreground">
            Confirmez votre mot de passe pour {phase.mode === "enable" ? "activer" : "désactiver"} la
            double authentification.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mot de passe actuel"
              className={cn(field, "max-w-xs")}
            />
            <button
              type="button"
              disabled={busy || password.length < 1}
              onClick={phase.mode === "enable" ? beginEnable : disable}
              className={cn(btn.base, btn.md, btn.ink)}
            >
              {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}
              Continuer
            </button>
          </div>
        </div>
      )}

      {phase.step === "confirm" && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[13px] text-muted-foreground">
            Scannez ce QR dans votre application d&apos;authentification, puis saisissez le code à 6
            chiffres.
          </p>
          {phase.qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={phase.qr}
              alt="QR 2FA"
              width={168}
              height={168}
              className="rounded-inner bg-white p-3 ring-1 ring-border"
            />
          ) : (
            <code className="block max-w-sm break-all rounded-inner bg-surface-warm px-3 py-2 text-[11px]">
              {phase.uri}
            </code>
          )}
          <div className="flex flex-wrap gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123 456"
              className={cn(field, "w-40 text-center tracking-widest")}
            />
            <button
              type="button"
              disabled={busy || code.trim().length < 6}
              onClick={() => confirmEnable(phase.backupCodes)}
              className={cn(btn.base, btn.md, btn.primary)}
            >
              {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}
              Confirmer
            </button>
          </div>
        </div>
      )}

      {phase.step === "codes" && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="inline-flex items-center gap-2 text-sm font-semibold text-success">
            <ShieldCheck aria-hidden className="size-4" /> Double authentification activée
          </p>
          <p className="text-[13px] font-medium text-foreground">
            Conservez ces codes de secours — affichés une seule fois.
          </p>
          <ul className="grid max-w-sm grid-cols-2 gap-1.5 rounded-inner border border-border bg-surface-warm p-3 font-mono text-[13px]">
            {phase.backupCodes.map((c) => (
              <li key={c} className="select-all">
                {c}
              </li>
            ))}
          </ul>
          <button type="button" onClick={reset} className={cn(btn.base, btn.md, btn.ink, "self-start")}>
            J&apos;ai sauvegardé mes codes
          </button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────── NOTIFICATIONS ─────────────────────────── */

function NotificationsTab({ profile, padX }: { profile: AccountProfile | null; padX: string }) {
  const router = useRouter();
  const [optIn, setOptIn] = useState(profile?.marketingOptIn ?? false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setOptIn(profile?.marketingOptIn ?? false);
  }, [profile?.marketingOptIn]);

  const toggleOptIn = () => {
    if (!profile) return;
    const next = !optIn;
    setOptIn(next);
    startTransition(async () => {
      const fd = new FormData();
      if (next) fd.set("marketingOptIn", "on");
      const res = await updateProfileAction(null, fd);
      if (!res.ok) setOptIn(!next);
      else router.refresh();
    });
  };

  return (
    <div className={cn(panel, "flex flex-col gap-1.5", padX)}>
      <div className="mb-1.5 flex flex-col gap-1">
        <h2 className="title-block text-foreground">Notifications</h2>
        <span className="text-[14px] text-muted-foreground">
          Choisissez comment nous vous tenons informé.
        </span>
      </div>

      <span className="mt-1 text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
        Canaux
      </span>
      <ToggleRow Icon={Phone} label="SMS" desc="Alertes par SMS" checked={false} disabled soon />
      <ToggleRow Icon={Mail} label="E-mail" desc="Alertes par e-mail" checked={false} disabled soon />
      <ToggleRow
        Icon={MessageSquare}
        label="WhatsApp"
        desc="Suivi de commande sur WhatsApp"
        checked={false}
        disabled
        soon
      />

      <span className="mt-4 text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
        Sujets
      </span>
      <ToggleRow
        Icon={Truck}
        label="Suivi de commande"
        desc="Confirmation, expédition, livraison"
        checked={false}
        disabled
        soon
      />
      <ToggleRow
        Icon={Tag}
        label="Retour en stock & baisses de prix"
        desc="Sur les produits de vos favoris"
        checked={false}
        disabled
        soon
      />
      <ToggleRow
        Icon={Heart}
        label="Bons plans"
        desc={
          profile
            ? "Offres et nouveautés Tokyo Store"
            : "Disponible une fois votre fiche client créée"
        }
        checked={optIn}
        onToggle={toggleOptIn}
        disabled={!profile}
      />
    </div>
  );
}

/* ─────────────────────────────── shared bits ───────────────────────────── */

function FieldHint({ message }: { message?: string }) {
  if (!message) return null;
  return <span className="mt-1 pl-1 text-[12px] text-destructive">{message}</span>;
}
