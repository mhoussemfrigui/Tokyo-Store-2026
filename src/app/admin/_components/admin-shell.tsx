"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutDashboard,
  Home,
  Package,
  Users,
  MessageSquare,
  FilePlus,
  ShoppingCart,
  Tag,
  Tags,
  BarChart3,
  Settings,
  FileText,
  FileUp,
  Image as ImageIcon,
  Menu,
  Sparkles,
  Palette,
  ChevronLeft,
  ChevronRight,
  Mail,
  Send,
  ShoppingBag,
  X,
  LogIn,
  LogOut,
  Boxes,
  Star,
  Globe,
  Signpost,
  SlidersHorizontal,
  ClipboardList,
  ShieldCheck,
  Video,
  Cookie,
  Coins,
  CreditCard,
  Contact,
  Search as SearchIcon,
  Truck,
  Receipt,
  Webhook,
  Database,
  Server,
  Gauge,
  Lock,
  Bot,
  Clock,
  Zap,
  Undo2,
  Heart,
  PanelTop,
  PanelBottom,
  Bell,
  CheckCircle2,
  FolderTree,
  Megaphone,
  Newspaper,
  Award,
  PenLine,
  Store,
  ScrollText,
} from "lucide-react";

import { signoutAction } from "@/lib/actions/auth";
import {
  ORDER_NEW_VIEW_GRANTS,
  USER_SETTINGS_VIEW_GRANTS,
  IMPORT_DATA_VIEW_GRANTS,
  isNavItemVisible,
  type PermissionGrant,
} from "@/lib/rbac/nav-access";

/**
 * Admin shell — the "ADMIN UI" design: a floating white sidebar holding a dark
 * icon RAIL (one icon per section) beside an expandable TAB PANE (the section's
 * sub-tabs), a white topbar (section-icon tile + breadcrumb + title + ⌘K search
 * + notifications), a mobile drawer, and a command palette. Every href maps to an
 * existing /admin page; real auth + RBAC is enforced server-side by
 * `app/admin/layout.tsx` — this component is purely presentational + navigational.
 */

type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: React.ElementType;
  badge?: string;
  /**
   * Explicit visibility rule for an item whose page guard is NOT `<id>:view`:
   * shown when the user holds ANY of these grants. Always the SAME constant the
   * page passes to `requirePermissionAny` (src/lib/rbac/nav-access.ts), so the
   * link can neither 404 nor hide a page the role may open.
   */
  visibleWhen?: readonly PermissionGrant[];
};

// Grouped by what a first-time admin is trying to do: the commerce flow first
// (Catalogue → Commandes → Clients), then the things you publish (Contenu &
// Design, Blog), then platform admin (Système) + read-only diagnostics
// (Infrastructure). The nav `id`s map 1:1 to the RBAC permission registry —
// regrouping changes only the visual blocks, never the ids/grants. Keep this in
// sync with the `group` fields in src/lib/rbac/registry.ts so the role editor
// mirrors the sidebar.
const NAV_GROUPS: { label: string; icon: React.ElementType; items: NavItem[] }[] = [
  // ── OPÉRATIONS (daily work) — then each domain's CONFIGURATION sits right
  //    after it (Catalogue → Structure du catalogue, Commandes → Vente &
  //    paiement). A divider separates the commerce domains from the site-wide
  //    content + platform configuration (Contenu & Design, Système,
  //    Infrastructure). The nav `id`s still map 1:1 to the RBAC permission
  //    registry — regrouping/renaming changes only labels/visual blocks, never
  //    the ids/grants/hrefs. The `group` fields in src/lib/rbac/registry.ts are
  //    kept in sync so the role editor mirrors these sections.
  {
    label: "Tableau de bord",
    icon: LayoutDashboard,
    items: [
      { id: "dashboard", label: "Tableau de bord", href: "/admin", icon: LayoutDashboard },
      { id: "analytics", label: "Statistiques", href: "/admin/analytics", icon: BarChart3 },
    ],
  },
  {
    // Day-to-day catalogue work (what a webmaster edits constantly).
    label: "Catalogue",
    icon: Package,
    items: [
      { id: "products", label: "Produits", href: "/admin/catalog/products", icon: Package },
      { id: "stock", label: "Stock", href: "/admin/catalog/stock", icon: Boxes },
      { id: "reviews", label: "Avis clients", href: "/admin/catalog/reviews", icon: Star },
      { id: "media", label: "Médiathèque", href: "/admin/media", icon: ImageIcon },
    ],
  },
  {
    // Catalogue STRUCTURE (taxonomy + add-ons that shape the storefront).
    label: "Structure du catalogue",
    icon: FolderTree,
    items: [
      { id: "categories", label: "Catégories", href: "/admin/catalog/categories", icon: FolderTree },
      { id: "brands", label: "Marques", href: "/admin/catalog/brands", icon: Award },
      { id: "attributes", label: "Attributs", href: "/admin/catalog/attributes", icon: SlidersHorizontal },
      { id: "care", label: "Tokyo Care", href: "/admin/catalog/care", icon: ShieldCheck },
    ],
  },
  {
    // Order processing (daily).
    label: "Commandes",
    icon: ShoppingCart,
    items: [
      {
        id: "orders_new",
        label: "Nouvelle commande",
        href: "/admin/orders/new",
        icon: FilePlus,
        visibleWhen: ORDER_NEW_VIEW_GRANTS,
      },
      { id: "orders", label: "Commandes", href: "/admin/orders", icon: ShoppingCart },
      { id: "cart", label: "Paniers", href: "/admin/cart", icon: ShoppingBag },
      { id: "returns", label: "Retours & SAV", href: "/admin/orders/returns", icon: Undo2 },
    ],
  },
  {
    // Commerce CONFIGURATION — how the shop charges, ships + taxes (set once).
    label: "Vente & paiement",
    icon: CreditCard,
    items: [
      { id: "system_payments", label: "Paiement & encaissement", href: "/admin/system/payments", icon: CreditCard },
      { id: "system_express", label: "Achat express", href: "/admin/system/express", icon: Zap },
      { id: "system_delivery", label: "Livraison", href: "/admin/system/delivery", icon: Truck },
      { id: "system_tax", label: "Taxes", href: "/admin/system/tax", icon: Receipt },
      { id: "system_currency", label: "Devises", href: "/admin/system/currency", icon: Coins },
      { id: "checkout", label: "Tunnel de commande", href: "/admin/system/checkout", icon: ClipboardList },
    ],
  },
  {
    label: "Clients",
    icon: Users,
    items: [
      { id: "customers", label: "Clients", href: "/admin/customers", icon: Users },
      { id: "invites", label: "Invités", href: "/admin/customers/guests", icon: Contact },
      { id: "favorites", label: "Favoris", href: "/admin/customers/favorites", icon: Heart },
    ],
  },
  {
    // Audience engagement — promotions, segments + e-mail reach, gathered.
    label: "Marketing",
    icon: Megaphone,
    items: [
      { id: "promotions", label: "Promotions & codes", href: "/admin/promotions", icon: Tag },
      { id: "promotions", label: "Segments", href: "/admin/marketing/segments", icon: Users },
      { id: "newsletter", label: "Newsletter", href: "/admin/newsletter", icon: Mail },
      { id: "system_mail", label: "Campagnes e-mail", href: "/admin/marketing/mailing", icon: Send },
    ],
  },
  {
    label: "Blog",
    icon: Newspaper,
    items: [
      { id: "blog_posts", label: "Articles", href: "/admin/blog/posts", icon: FileText },
      { id: "blog_cats", label: "Catégories", href: "/admin/blog/categories", icon: FolderTree },
      { id: "blog_tags", label: "Tags", href: "/admin/blog/tags", icon: Tags },
      { id: "blog_authors", label: "Auteurs", href: "/admin/blog/authors", icon: PenLine },
      { id: "blog_comments", label: "Commentaires", href: "/admin/blog/comments", icon: MessageSquare },
    ],
  },
  {
    // Storefront content + appearance (the public site you publish).
    label: "Contenu & Design",
    icon: Palette,
    items: [
      { id: "home", label: "Page d'accueil", href: "/admin/cms/home", icon: Home },
      { id: "pages", label: "Pages", href: "/admin/cms/pages", icon: FileText },
      { id: "showcase", label: "Vitrines", href: "/admin/cms/showcase", icon: Sparkles },
      { id: "trust_badges", label: "Badges de confiance", href: "/admin/cms/trust-badges", icon: ShieldCheck },
      { id: "reels", label: "Vidéos (Reels)", href: "/admin/cms/reels", icon: Video },
      { id: "navigation", label: "Menu de navigation", href: "/admin/cms/nav-menu", icon: PanelTop },
      { id: "navigation", label: "Pied de page", href: "/admin/cms/footer", icon: PanelBottom },
      { id: "settings_theme", label: "Thème & apparence", href: "/admin/cms/theme", icon: Palette },
      { id: "settings_site", label: "Identité & contact", href: "/admin/cms/settings", icon: Store },
    ],
  },
  {
    // Platform administration — users/roles, account config + automation.
    label: "Système",
    icon: Settings,
    items: [
      { id: "users", label: "Utilisateurs & rôles", href: "/admin/users", icon: Users },
      {
        id: "system_auth",
        label: "Connexion & comptes",
        href: "/admin/users/settings",
        icon: LogIn,
        visibleWhen: USER_SETTINGS_VIEW_GRANTS,
      },
      { id: "system_ai", label: "IA & automatisation", href: "/admin/system/ai", icon: Bot },
      { id: "system_jobs", label: "Tâches planifiées", href: "/admin/system/jobs", icon: Clock },
      { id: "system_seo", label: "SEO & données structurées", href: "/admin/system/seo", icon: Globe },
      { id: "system_redirects", label: "Redirections & 404", href: "/admin/system/redirects", icon: Signpost },
      { id: "system_cookies", label: "Cookies & RGPD", href: "/admin/system/cookies", icon: Cookie },
      { id: "system_analytics", label: "Suivi & analytics", href: "/admin/system/analytics", icon: Gauge },
      { id: "system_search", label: "Recherche", href: "/admin/system/search", icon: SearchIcon },
      { id: "system_audit", label: "Journal d'audit", href: "/admin/system/audit", icon: ScrollText },
      {
        id: "system_import",
        label: "Import de données",
        href: "/admin/system/import-data",
        icon: FileUp,
        visibleWhen: IMPORT_DATA_VIEW_GRANTS,
      },
    ],
  },
  {
    label: "Infrastructure",
    icon: Server,
    items: [
      { id: "system_api", label: "API & webhooks", href: "/admin/system/api", icon: Webhook },
      { id: "system_database", label: "Base de données", href: "/admin/system/database", icon: Database },
      { id: "system_resources", label: "Ressources", href: "/admin/system/resources", icon: Server },
      { id: "system_performance", label: "Performance", href: "/admin/system/performance", icon: Gauge },
      { id: "system_security", label: "Sécurité", href: "/admin/system/security", icon: Lock },
    ],
  },
];

// A thin divider is drawn in the icon rail BEFORE this section — it splits the
// commerce domains (above) from the site-wide content + platform config (below).
const DIVIDE_BEFORE = new Set(["Contenu & Design"]);

// Flat list of every nav href — used to resolve the SINGLE active link via a
// longest-prefix match. Some nav links are nested under others (e.g.
// /admin/orders/returns under /admin/orders), so a bare `pathname.startsWith`
// would light up both; only the most specific link may win.
const ALL_NAV_HREFS = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));

function isNavActive(href: string, pathname: string): boolean {
  if (pathname === href) return true;
  if (href === "/admin") return false; // dashboard: exact match only
  if (!pathname.startsWith(href + "/")) return false;
  return !ALL_NAV_HREFS.some(
    (other) =>
      other !== href &&
      other.length > href.length &&
      (pathname === other || pathname.startsWith(other + "/")),
  );
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// A rail label that collapses to zero width + fades out when the rail is in its
// narrow icon-only mode (module scope so the CSS transition isn't remounted).
function RailLabel({ children, hide }: { children: React.ReactNode; hide: boolean }) {
  return (
    <span
      className={`overflow-hidden whitespace-nowrap text-left text-[12.5px] font-semibold transition-all duration-200 ${
        hide ? "max-w-0 opacity-0" : "max-w-[150px] opacity-100"
      }`}
    >
      {children}
    </span>
  );
}

export function AdminShell({
  children,
  userName,
  userEmail,
  grantedKeys,
  logoUrl,
}: {
  children: React.ReactNode;
  userName: string;
  userEmail: string;
  /** Sidebar logo URL (médiathèque override or the bundled brand mark fallback). */
  logoUrl: string;
  /**
   * Concrete `<module>:<action>` keys the signed-in user holds, resolved
   * server-side by the layout. `null` = the wildcard (super_admin / legacy
   * admin) → show every section. Otherwise an item shows on `<id>:view` or on
   * its `visibleWhen` grants; empty groups are dropped.
   */
  grantedKeys: string[] | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [palOpen, setPalOpen] = useState(false);
  const [palQuery, setPalQuery] = useState("");
  const [notifOpen, setNotifOpen] = useState(false);
  const palInputRef = useRef<HTMLInputElement>(null);

  // Standalone printable document routes render BARE — no shell chrome (they are
  // opened in their own tab and printed). The route's server guard still runs.
  const isOrderDocRoute =
    /^\/admin\/orders\/[^/]+\/(invoice|delivery-note)$/.test(pathname) ||
    /^\/admin\/catalog\/stock\/transfers\/[^/]+\/print$/.test(pathname);

  const visibleGroups = useMemo(() => {
    const granted = grantedKeys === null ? null : new Set(grantedKeys);
    return NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => isNavItemVisible(i, granted)),
    })).filter((g) => g.items.length > 0);
  }, [grantedKeys]);

  // The section (group) whose route is currently active.
  const activeGroup = useMemo(
    () => visibleGroups.find((g) => g.items.some((it) => isNavActive(it.href, pathname))) ?? null,
    [visibleGroups, pathname],
  );
  const activeItem = useMemo(() => {
    for (const g of visibleGroups) {
      const it = g.items.find((i) => isNavActive(i.href, pathname));
      if (it) return it;
    }
    return null;
  }, [visibleGroups, pathname]);

  // Two-bar sidebar: the dark rail (bar 1) lists the sections; the light pane
  // (bar 2) shows the tabs of whichever section is "previewed" — a click in the
  // rail — falling back to the section of the current page. Resetting the
  // preview on navigation keeps the pane following the page. `paneGroup.label`
  // keys the pane so switching sections replays the slide-in transition.
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [syncedActive, setSyncedActive] = useState(activeGroup?.label ?? null);
  if ((activeGroup?.label ?? null) !== syncedActive) {
    setSyncedActive(activeGroup?.label ?? null);
    setPreviewLabel(null);
  }
  const paneGroup =
    visibleGroups.find((g) => g.label === previewLabel) ?? activeGroup ?? visibleGroups[0] ?? null;

  // Master/detail: pick a section → collapse the rail + slide its tabs open;
  // « Retour » → collapse the tabs back and re-expand the labelled rail.
  const selectSection = (label: string) => {
    setPreviewLabel(label);
    setDetailOpen(true);
  };
  const closeDetail = () => setDetailOpen(false);

  const activeTitle = activeItem?.label ?? "Administration";
  const sectionLabel = activeGroup?.label ?? "Administration";
  const SectionIcon = activeGroup?.icon ?? LayoutDashboard;

  // ── Command palette (⌘K / Ctrl+K) ────────────────────────────────────────
  const palResults = useMemo(() => {
    const q = palQuery
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    const all = visibleGroups.flatMap((g) => g.items.map((it) => ({ g, it })));
    if (!q) {
      const inSection = all.filter((x) => x.g.label === activeGroup?.label);
      return [...inSection, ...all.filter((x) => x.g.label !== activeGroup?.label)].slice(0, 8);
    }
    const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return all
      .filter((x) => norm(x.it.label).includes(q) || norm(x.g.label).includes(q))
      .sort((a, b) => (norm(a.it.label).startsWith(q) ? 0 : 1) - (norm(b.it.label).startsWith(q) ? 0 : 1))
      .slice(0, 10);
  }, [palQuery, visibleGroups, activeGroup]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalOpen(true);
        setPalQuery("");
      }
      if (e.key === "Escape") {
        setPalOpen(false);
        setNotifOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (palOpen) setTimeout(() => palInputRef.current?.focus(), 30);
  }, [palOpen]);

  const goTo = (href: string) => {
    setPalOpen(false);
    setMobileOpen(false);
    router.push(href);
  };

  // Bare passthrough for the printable document routes.
  if (isOrderDocRoute) return <>{children}</>;

  const railWidth = "lg:grid-cols-[268px_minmax(0,1fr)]";

  // ── Desktop sidebar (two-state master/detail) ─────────────────────────────
  // Bar 1 — the dark SECTION rail. Default = full width + labels. When a section
  // is chosen it collapses (transition-[width]) to an icon strip; its labels fade
  // to max-w-0. Bar 2 — the light TAB pane — then slides/fades from a thin peek
  // to full width. « Retour » reverses both. Total sidebar width stays constant
  // (rail shrinks as the pane grows) so the page content never reflows.
  const railSectionBtn = (g: (typeof NAV_GROUPS)[number]) => {
    const Icon = g.icon;
    const isActive = g.label === activeGroup?.label;
    const isViewing = detailOpen && g.label === paneGroup?.label;
    return (
      <div key={g.label}>
        {DIVIDE_BEFORE.has(g.label) && <span className="my-1.5 mx-1 block h-px bg-white/10" />}
        <button
          type="button"
          onClick={() => selectSection(g.label)}
          title={g.label}
          aria-pressed={isViewing}
          className={`relative flex w-full items-center rounded-[12px] py-[7px] text-left transition ${
            detailOpen ? "justify-center gap-0 px-0" : "gap-2.5 px-2"
          } ${
            isViewing
              ? "bg-white/[0.12] text-white"
              : isActive
                ? "text-white hover:bg-white/[0.07]"
                : "text-white/60 hover:bg-white/[0.06] hover:text-white"
          }`}
        >
          <span
            className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px] transition ${
              isActive ? "bg-[#d40530] text-white" : "bg-white/[0.07] text-white/75"
            }`}
          >
            <Icon className="h-[14px] w-[14px]" strokeWidth={2} />
          </span>
          <RailLabel hide={detailOpen}>{g.label}</RailLabel>
          <span
            className="absolute left-[-10px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-[#d40530] transition-opacity"
            style={{ opacity: isViewing ? 1 : 0 }}
          />
        </button>
      </div>
    );
  };

  const renderRail = () => (
    <div
      className={`relative z-10 flex shrink-0 flex-col gap-1 rounded-[24px] bg-[#252a33] p-2.5 transition-[width] duration-300 ease-out ${
        detailOpen ? "w-[60px]" : "w-[250px]"
      }`}
    >
      {/* Brand */}
      <Link
        href="/admin"
        title="Tokyo Store"
        className={`mb-1 flex items-center pt-0.5 ${detailOpen ? "justify-center px-0" : "gap-2.5 px-1"}`}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-white">
          <img src={logoUrl} alt="Tokyo Store" className="max-h-[26px] max-w-[28px] object-contain" />
        </span>
        <span className={`min-w-0 flex-col ${detailOpen ? "hidden" : "flex"}`}>
          <span className="truncate text-[13px] font-black leading-tight tracking-[-0.02em] text-white">Tokyo Store</span>
          <span className="truncate text-[9.5px] font-semibold uppercase tracking-[0.18em] text-white/45">Administration</span>
        </span>
      </Link>

      {/* Search */}
      <button
        type="button"
        onClick={() => {
          setPalOpen(true);
          setPalQuery("");
        }}
        title="Rechercher (⌘K)"
        className={`mb-0.5 flex items-center rounded-[12px] bg-white/[0.06] py-2 text-white/70 transition hover:bg-white/[0.12] hover:text-white ${
          detailOpen ? "justify-center px-0" : "gap-2.5 px-2.5"
        }`}
      >
        <SearchIcon className="h-[16px] w-[16px] shrink-0" strokeWidth={2} />
        <RailLabel hide={detailOpen}>Rechercher</RailLabel>
      </button>

      <span className="my-1 h-px w-full bg-white/10" />

      {/* Sections */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visibleGroups.map((g) => railSectionBtn(g))}
      </div>

      <span className="my-1 h-px w-full bg-white/10" />

      {/* Footer actions */}
      <a
        href="/"
        title="Retour à la boutique"
        className={`flex items-center rounded-[12px] py-2 text-white/65 transition hover:bg-white/[0.08] hover:text-white ${
          detailOpen ? "justify-center px-0" : "gap-2.5 px-2.5"
        }`}
      >
        <Home className="h-[16px] w-[16px] shrink-0" strokeWidth={2} />
        <RailLabel hide={detailOpen}>Retour à la boutique</RailLabel>
      </a>
      <form action={signoutAction}>
        <button
          type="submit"
          title="Se déconnecter"
          className={`flex w-full items-center rounded-[12px] py-2 text-white/65 transition hover:bg-white/[0.08] hover:text-white ${
            detailOpen ? "justify-center px-0" : "gap-2.5 px-2.5"
          }`}
        >
          <LogOut className="h-[16px] w-[16px] shrink-0" strokeWidth={2} />
          <RailLabel hide={detailOpen}>Se déconnecter</RailLabel>
        </button>
      </form>
      <div
        className={`mt-0.5 flex items-center rounded-[12px] bg-white/[0.05] py-1.5 ${
          detailOpen ? "justify-center px-0" : "gap-2.5 px-2.5"
        }`}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#d40530] text-[11px] font-extrabold text-white">
          {initialsFor(userName)}
        </span>
        <div className={`min-w-0 flex-col ${detailOpen ? "hidden" : "flex"}`}>
          <span className="truncate text-[12px] font-bold text-white">{userName}</span>
          <span className="truncate text-[10px] text-white/45">{userEmail}</span>
        </div>
      </div>
    </div>
  );

  // Soft custom scrollbar for the light tab lists (desktop + mobile).
  const paneScroll =
    "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

  const tabLink = (item: NavItem, onNavigate?: () => void) => {
    const current = paneGroup?.label === activeGroup?.label && isNavActive(item.href, pathname);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        aria-current={current ? "page" : undefined}
        className={`flex min-h-[40px] items-center gap-3 rounded-[12px] px-3 text-[13.5px] transition ${
          current ? "bg-[#fdecef] font-extrabold text-[#d40530]" : "font-semibold text-[#3d4046] hover:bg-[#f6f2ed]"
        }`}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full border-[1.5px] ${
            current
              ? "border-[#d40530] bg-[#d40530] shadow-[0_0_0_4px_rgba(212,5,48,0.15)]"
              : "border-[#c9c2ba] bg-transparent"
          }`}
        />
        <span className="flex-1 truncate">{item.label}</span>
      </Link>
    );
  };

  // Bar 2 — the light TAB pane. flex-1 fills whatever the rail leaves: a thin
  // white peek by default, full width once a section is chosen. The fixed-width
  // inner (w-[192px]) is clipped + faded in the peek state, and keyed on the
  // section so switching replays the slide-in.
  const renderPane = () =>
    paneGroup && (
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div
          className={`flex h-full w-[192px] flex-col py-2 pl-2.5 pr-1 transition-opacity duration-200 ${
            detailOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <button
            type="button"
            onClick={closeDetail}
            className="mb-2 flex w-full items-center gap-1.5 rounded-[10px] bg-[#f3eee7] px-3 py-2 text-[12.5px] font-bold text-[#3d4046] transition hover:bg-[#ece4da] hover:text-[#0e1218]"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2.4} />
            Retour
          </button>
          <div
            key={paneGroup.label}
            className="flex min-h-0 flex-1 flex-col gap-2.5 duration-200 animate-in fade-in slide-in-from-left-2"
          >
            <div className="px-1.5">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#a79f96]">
                {paneGroup.items.length} onglets
              </span>
              <h2 className="truncate text-[18px] font-black leading-[1.15] tracking-[-0.02em] text-[#0e1218]">
                {paneGroup.label}
              </h2>
            </div>
            <div className={paneScroll}>{paneGroup.items.map((item) => tabLink(item))}</div>
          </div>
        </div>
      </div>
    );

  // ── Mobile / tablet drawer (single-column master/detail) ──────────────────
  // Full-width section list that slides left to reveal the chosen section's tabs
  // (and a « Retour » back to the list). Same `detailOpen` state as desktop.
  // (responsive master/detail)
  const renderMobileNav = (onNavigate: () => void) => (
    <div className="relative h-full w-full overflow-hidden rounded-r-[26px] bg-[#252a33]">
      {/* Sections */}
      <div
        className={`absolute inset-0 flex flex-col gap-1 p-3 transition-transform duration-300 ease-out ${
          detailOpen ? "-translate-x-full" : "translate-x-0"
        }`}
      >
        <div className="mb-1 flex items-center gap-2.5 px-1">
          <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-white">
            <img src={logoUrl} alt="Tokyo Store" className="max-h-[26px] max-w-[28px] object-contain" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-black leading-tight text-white">Tokyo Store</span>
            <span className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">Administration</span>
          </div>
          <button
            type="button"
            onClick={onNavigate}
            aria-label="Fermer le menu"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-white/[0.08] text-white transition hover:bg-white/[0.16]"
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setPalOpen(true);
            setPalQuery("");
          }}
          className="mb-0.5 flex items-center gap-2.5 rounded-[12px] bg-white/[0.06] px-3 py-2.5 text-white/70 transition hover:bg-white/[0.12] hover:text-white"
        >
          <SearchIcon className="h-[16px] w-[16px]" strokeWidth={2} />
          <span className="flex-1 text-left text-[13px] font-semibold">Rechercher</span>
          <span className="rounded-[6px] bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-extrabold text-white/50">⌘K</span>
        </button>
        <span className="my-1 h-px w-full bg-white/10" />
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {visibleGroups.map((g) => {
            const Icon = g.icon;
            const isActive = g.label === activeGroup?.label;
            return (
              <div key={g.label}>
                {DIVIDE_BEFORE.has(g.label) && <span className="my-1.5 mx-1 block h-px bg-white/10" />}
                <button
                  type="button"
                  onClick={() => selectSection(g.label)}
                  className={`flex w-full items-center gap-3 rounded-[12px] px-2.5 py-2.5 text-left transition ${
                    isActive ? "text-white" : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-[8px] ${
                      isActive ? "bg-[#d40530] text-white" : "bg-white/[0.07] text-white/80"
                    }`}
                  >
                    <Icon className="h-[15px] w-[15px]" strokeWidth={2} />
                  </span>
                  <span className="flex-1 truncate text-[13.5px] font-semibold">{g.label}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-white/35" strokeWidth={2.4} />
                </button>
              </div>
            );
          })}
        </div>
        <span className="my-1 h-px w-full bg-white/10" />
        <a href="/" className="flex items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-white/65 transition hover:bg-white/[0.08] hover:text-white">
          <Home className="h-[16px] w-[16px]" strokeWidth={2} />
          <span className="text-[12.5px] font-semibold">Retour à la boutique</span>
        </a>
        <form action={signoutAction}>
          <button type="submit" className="flex w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-white/65 transition hover:bg-white/[0.08] hover:text-white">
            <LogOut className="h-[16px] w-[16px]" strokeWidth={2} />
            <span className="text-[12.5px] font-semibold">Se déconnecter</span>
          </button>
        </form>
      </div>

      {/* Tabs */}
      <div
        className={`absolute inset-0 flex flex-col bg-white transition-transform duration-300 ease-out ${
          detailOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {paneGroup && (
          <div className="flex h-full flex-col p-3">
            <button
              type="button"
              onClick={closeDetail}
              className="mb-2 flex w-full items-center gap-1.5 rounded-[10px] bg-[#f3eee7] px-3 py-2.5 text-[13px] font-bold text-[#3d4046] transition hover:bg-[#ece4da] hover:text-[#0e1218]"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={2.4} />
              Retour
            </button>
            <div className="mb-2 px-1">
              <span className="text-[10.5px] font-extrabold uppercase tracking-[0.16em] text-[#a79f96]">
                {paneGroup.items.length} onglets
              </span>
              <h2 className="text-[20px] font-black tracking-[-0.02em] text-[#0e1218]">{paneGroup.label}</h2>
            </div>
            <div className={paneScroll}>{paneGroup.items.map((item) => tabLink(item, onNavigate))}</div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="admin min-h-screen bg-background text-foreground">
      <div className={`lg:grid lg:gap-3 lg:p-3 ${railWidth}`}>
        {/* ── Desktop sidebar ─────────────────────────────────────────────── */}
        <aside className="sticky top-3 hidden h-[calc(100vh-24px)] overflow-hidden rounded-[32px] bg-white p-1.5 lg:flex">
          {renderRail()}
          {renderPane()}
        </aside>

        {/* ── Content column ──────────────────────────────────────────────── */}
        <main className="flex min-w-0 flex-col gap-3 p-3 lg:p-0">
          {/* Topbar */}
          <header className="flex min-w-0 items-center gap-3.5 rounded-[28px] bg-white p-3 pl-3 lg:pl-[18px]">
            <button
              type="button"
              onClick={() => {
                setDetailOpen(false);
                setMobileOpen(true);
              }}
              aria-label="Menu"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-[#f6f2ed] text-[#0e1218] lg:hidden"
            >
              <Menu className="h-[18px] w-[18px]" strokeWidth={2.2} />
            </button>
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[16px] bg-[#fdecef] text-[#d40530]">
              <SectionIcon className="h-[22px] w-[22px]" strokeWidth={2} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[12px] font-extrabold uppercase tracking-[0.12em] text-[#d40530]">
                {sectionLabel}
              </span>
              <h1 className="truncate text-[clamp(20px,2.2vw,28px)] font-black leading-[1.1] tracking-[-0.03em] text-[#0e1218]">
                {activeTitle}
              </h1>
            </div>
            <button
              type="button"
              onClick={() => {
                setPalOpen(true);
                setPalQuery("");
              }}
              aria-label="Rechercher"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-[#f6f2ed] text-[#0e1218] lg:hidden"
            >
              <SearchIcon className="h-[18px] w-[18px]" strokeWidth={2} />
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen((o) => !o)}
                aria-label="Notifications"
                aria-expanded={notifOpen}
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-[14px] transition ${
                  notifOpen ? "bg-[#0e1218] text-white" : "bg-[#f6f2ed] text-[#0e1218] hover:bg-[#efe9e3]"
                }`}
              >
                <Bell className="h-[19px] w-[19px]" strokeWidth={2} />
              </button>
              {notifOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
                  <div
                    role="dialog"
                    aria-label="Notifications"
                    className="absolute right-0 top-[54px] z-50 flex max-h-[min(560px,calc(100vh-100px))] w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden rounded-[24px] border border-[#efe9e3] bg-white shadow-[0_24px_70px_rgba(14,18,24,0.2)]"
                  >
                    <div className="flex items-center justify-between gap-2 p-4 pb-2">
                      <span className="text-[18px] font-black tracking-[-0.02em]">Notifications</span>
                    </div>
                    <div className="flex flex-col items-center gap-2 px-4 py-9 text-center">
                      <span className="grid h-12 w-12 place-items-center rounded-[16px] bg-[#eaf7ee]">
                        <CheckCircle2 className="h-5 w-5 text-[#15803d]" strokeWidth={2.4} />
                      </span>
                      <span className="text-[15px] font-extrabold">Vous êtes à jour</span>
                      <span className="text-[13px] text-[#5b5d62]">Aucune notification pour le moment.</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </header>

          {children}
        </main>
      </div>

      {/* ── Mobile drawer ─────────────────────────────────────────────────── */}
      {mobileOpen && (
        <>
          <div className="fixed inset-0 z-[60] bg-[rgba(14,18,24,0.4)] lg:hidden" onClick={() => setMobileOpen(false)} />
          <div
            role="dialog"
            aria-label="Menu"
            className="fixed inset-y-0 left-0 z-[61] w-[min(340px,86vw)] lg:hidden"
          >
            {renderMobileNav(() => setMobileOpen(false))}
          </div>
        </>
      )}

      {/* ── Command palette ───────────────────────────────────────────────── */}
      {palOpen && (
        <>
          <div className="fixed inset-0 z-[70] bg-[rgba(14,18,24,0.35)]" onClick={() => setPalOpen(false)} />
          <div
            role="dialog"
            aria-label="Recherche"
            className="fixed left-1/2 top-[12vh] z-[71] flex max-h-[min(560px,calc(100vh-120px))] w-[min(620px,calc(100%-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_30px_80px_rgba(14,18,24,0.25)]"
          >
            <label className="flex h-16 shrink-0 items-center gap-3 border-b border-[#efe9e3] px-5 text-[#8a857f]">
              <SearchIcon className="h-[18px] w-[18px] shrink-0" strokeWidth={2} />
              <input
                ref={palInputRef}
                value={palQuery}
                onChange={(e) => setPalQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && palResults[0]) goTo(palResults[0].it.href);
                }}
                placeholder="Aller à un onglet… (ex. stock, retours, SEO)"
                className="min-w-0 flex-1 border-none bg-transparent text-[17px] text-[#0e1218] outline-none"
              />
              <span className="rounded-[7px] bg-[#f6f2ed] px-[7px] py-1 text-[11px] font-extrabold text-[#5b5d62]">
                Échap
              </span>
            </label>
            <div className="flex-1 overflow-y-auto p-2">
              {palResults.map(({ g, it }) => {
                const Icon = it.icon;
                return (
                  <button
                    key={`${g.label}-${it.href}`}
                    type="button"
                    onClick={() => goTo(it.href)}
                    className="flex min-h-[48px] w-full items-center gap-3 rounded-[14px] px-3 py-2 text-left transition hover:bg-[#f6f2ed]"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[#f6f2ed] text-[#0e1218]">
                      <Icon className="h-4 w-4" strokeWidth={2} />
                    </span>
                    <span className="flex-1 truncate text-[15px] font-bold text-[#0e1218]">{it.label}</span>
                    <span className="shrink-0 text-[12px] text-[#8a857f]">{g.label}</span>
                  </button>
                );
              })}
              {palResults.length === 0 && (
                <p className="p-7 text-center text-[14px] text-[#5b5d62]">Aucun onglet ne correspond.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
