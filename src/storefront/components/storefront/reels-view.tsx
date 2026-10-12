"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  type LucideIcon,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Eye,
  Facebook,
  Flame,
  GitCompare,
  Heart,
  House,
  Instagram,
  LayoutGrid,
  Lightbulb,
  Music2,
  Package,
  Phone,
  Play,
  Share2,
  ShoppingBag,
  Sparkles,
  Star,
  UserPlus,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";

import { findProductBySlug, getCategoryLabel, type Product } from "@/storefront/lib/catalog";
import type { SocialPlatform } from "@/lib/cms/social-list";
import { addToCart } from "@/storefront/lib/cart";
import { fmtPrice } from "@/storefront/lib/productMeta";
import { smoothBehavior } from "@/storefront/lib/motion";
import { cn } from "@/storefront/lib/utils";

/* ──────────────────────────────── Data ────────────────────────────────
   The videos are editorial/demo content (no reels backend), but the SHOPPABLE
   products in each one are REAL catalogue products (resolved by slug → live
   title / price / image / PDP link), so "Voir le produit" and "Ajouter au
   panier" behave exactly like everywhere else on the store. */

type Platform = "TikTok" | "Instagram" | "Facebook";

/* The reels "Suivre" / "Voir sur …" actions open the REAL store account — the
   first configured link for that platform from « Identité & contact »
   (social.links), passed in by the page through this context (no hardcoded
   list). Falls back to "#" when the operator configured no link for it. */
const REELS_PLATFORM: Record<Platform, SocialPlatform> = {
  TikTok: "tiktok",
  Instagram: "instagram",
  Facebook: "facebook",
};
const ReelsSocialContext = createContext<Partial<Record<SocialPlatform, string>>>({});
function socialHref(urls: Partial<Record<SocialPlatform, string>>, plat: Platform): string {
  return urls[REELS_PLATFORM[plat]] ?? "#";
}

const PLAT_ICON: Record<Platform, LucideIcon> = {
  TikTok: Music2,
  Instagram: Instagram,
  Facebook: Facebook,
};
/* Platform badge grounds. Instagram → crimson (the brand accent we already own);
   TikTok → ink; Facebook → graphite. */
const PLAT_BG: Record<Platform, string> = {
  TikTok: "bg-foreground",
  Instagram: "bg-primary",
  Facebook: "bg-[#3d4046]",
};

type Account = {
  id: string;
  plat: Platform;
  name: string;
  handle: string;
  followers: string;
  gaming: boolean;
};

const ACCOUNTS: Account[] = [
  { id: "tt", plat: "TikTok", name: "Tokyo Store", handle: "tokyostore", followers: "39K", gaming: false },
  { id: "ig", plat: "Instagram", name: "Tokyo Store", handle: "tokyostore", followers: "128K", gaming: false },
  { id: "igg", plat: "Instagram", name: "Tokyo Gaming", handle: "tokyogaming", followers: "46K", gaming: true },
  { id: "fb", plat: "Facebook", name: "Tokyo Store", handle: "Tokyo Store", followers: "215K", gaming: false },
  { id: "fbg", plat: "Facebook", name: "Tokyo Gaming", handle: "Tokyo Gaming", followers: "72K", gaming: true },
];
const ACC = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a])) as Record<string, Account>;

const TOPICS: { key: string; label: string; Icon: LucideIcon }[] = [
  { key: "Unboxing", label: "Unboxing", Icon: Package },
  { key: "Tests & avis", label: "Tests & avis", Icon: Star },
  { key: "Comparatifs", label: "Comparatifs", Icon: GitCompare },
  { key: "Astuces", label: "Astuces", Icon: Lightbulb },
  { key: "Gaming", label: "Gaming", Icon: Flame },
  { key: "Nouveautés", label: "Nouveautés", Icon: Sparkles },
];

/** key → { catalogue slug, short display name }. Resolved to a live product below. */
const PRODUCT_SRC: Record<string, { slug: string; short: string }> = {
  redmiBleu: { slug: "casque-bluetooth-redmi-headphones-neo-bleu", short: "Redmi Neo Bleu" },
  redmiBlanc: { slug: "casque-bluetooth-redmi-headphones-neo-blanc", short: "Redmi Neo Blanc" },
  redmiNoir: { slug: "casque-bluetooth-redmi-headphones-neo-noir", short: "Redmi Neo Noir" },
  jindun: { slug: "casque-gaming-stereo-haute-performance-s921-pro-jindun", short: "JinDun S921 Pro" },
  cmfNoir: { slug: "casque-sans-fil-cmf-buds-pro-noir-nothing", short: "CMF Buds Pro Noir" },
  cmfVert: { slug: "casque-sans-fil-cmf-buds-pro-vert-clair-nothing", short: "CMF Buds Pro Vert" },
  galaxyA57: { slug: "samsung-galaxy-a57-8gb-256gb-5g-noir", short: "Galaxy A57 Noir" },
  galaxyA56: { slug: "samsung-galaxy-a56-8gb-256gb-5g-awesome-olive", short: "Galaxy A56 Olive" },
  fc27: { slug: "fc-27-jeu-switch-2", short: "FC 27 Switch 2" },
};

export type ReelProduct = {
  key: string;
  slug: string;
  short: string;
  title: string;
  price: number;
  image: string;
  category: string;
};

/* Resolve each referenced product once against the live catalogue. Any key that
   no longer resolves is dropped (snapshot-wall safe). */
const PRODUCTS: Record<string, ReelProduct> = Object.fromEntries(
  Object.entries(PRODUCT_SRC).flatMap(([key, { slug, short }]) => {
    const p: Product | undefined = findProductBySlug(slug);
    return p
      ? [[key, { key, slug, short, title: p.title, price: p.price, image: p.image, category: p.category }]]
      : [];
  }),
);

type Video = {
  id: number;
  title: string;
  acc: string;
  plat: Platform;
  topic: string;
  poster: string; // product key whose image is the thumbnail
  dur: number; // seconds
  views: number;
  likes: number;
  days: number;
  prods: string[]; // product keys
};

const VIDEO_SRC: [string, string, string, string, number, number, number, number, string[]][] = [
  ["Unboxing du Redmi Headphones Neo bleu", "tt", "Unboxing", "redmiBleu", 42, 128400, 9200, 2, ["redmiBleu", "redmiBlanc"]],
  ["Galaxy A57 : on l'a testé pendant 7 jours", "ig", "Tests & avis", "galaxyA57", 88, 86100, 6100, 4, ["galaxyA57"]],
  ["CMF Buds Pro vs Redmi Neo : lequel choisir ?", "tt", "Comparatifs", "cmfNoir", 58, 64300, 4800, 6, ["cmfNoir", "redmiBleu"]],
  ["FC 27 sur Switch 2 : les premières minutes", "fbg", "Gaming", "fc27", 35, 212000, 18400, 1, ["fc27"]],
  ["3 réglages à faire sur votre Galaxy A57", "ig", "Astuces", "galaxyA57", 47, 41200, 2900, 9, ["galaxyA57"]],
  ["Arrivage : la gamme CMF en vert clair", "fb", "Nouveautés", "cmfVert", 21, 23800, 1700, 3, ["cmfVert"]],
  ["Le casque gaming S921 Pro en RGB", "igg", "Gaming", "jindun", 31, 97500, 7300, 12, ["jindun"]],
  ["Galaxy A56 Olive : déballage et premières impressions", "tt", "Unboxing", "galaxyA56", 52, 38600, 2600, 14, ["galaxyA56"]],
  ["Réduction de bruit : comment ça marche ?", "fb", "Astuces", "cmfNoir", 65, 19900, 1500, 18, ["cmfNoir"]],
  ["Redmi Neo : bleu ou blanc ?", "ig", "Comparatifs", "redmiBlanc", 39, 27100, 2100, 21, ["redmiBleu", "redmiBlanc"]],
  ["Notre avis sur le Redmi Neo après un mois", "tt", "Tests & avis", "redmiNoir", 72, 55800, 4100, 25, ["redmiNoir"]],
  ["Le micro du JinDun S921 testé en partie", "igg", "Gaming", "jindun", 56, 21300, 1600, 30, ["jindun"]],
  ["Nouveau en boutique : le Redmi Neo blanc", "ig", "Nouveautés", "redmiBlanc", 18, 15700, 1200, 8, ["redmiBlanc"]],
  ["Comment bien entretenir votre casque", "fb", "Astuces", "redmiNoir", 40, 44500, 3300, 35, ["redmiNoir"]],
];
const VIDEOS: Video[] = VIDEO_SRC.map(([title, acc, topic, poster, dur, views, likes, days, prods], id) => ({
  id,
  title,
  acc,
  plat: ACC[acc].plat,
  topic,
  poster,
  dur,
  views,
  likes,
  days,
  prods: prods.filter((k) => PRODUCTS[k]),
})).filter((v) => PRODUCTS[v.poster]);

type Duration = "all" | "s" | "m" | "l";
const DURS: { key: Duration; label: string; test: (d: number) => boolean }[] = [
  { key: "all", label: "Toutes", test: () => true },
  { key: "s", label: "< 30 s", test: (d) => d < 30 },
  { key: "m", label: "30 s – 1 min", test: (d) => d >= 30 && d <= 60 },
  { key: "l", label: "> 1 min", test: (d) => d > 60 },
];

type Sort = "recent" | "views" | "likes" | "short";
const SORTS: { key: Sort; label: string; Icon: LucideIcon }[] = [
  { key: "recent", label: "les plus récentes", Icon: Clock },
  { key: "views", label: "les plus vues", Icon: Eye },
  { key: "likes", label: "les plus aimées", Icon: Heart },
  { key: "short", label: "les plus courtes", Icon: Zap },
];

const FAQS: { q: string; a: string }[] = [
  {
    q: "Comment acheter un produit vu dans une vidéo ?",
    a: "Ouvrez la vidéo : les produits présentés s'affichent à côté, avec leur prix. Vous pouvez les ajouter au panier directement ou ouvrir leur fiche produit.",
  },
  {
    q: "Sur quels réseaux publiez-vous vos vidéos ?",
    a: "Nous publions sur TikTok (Tokyo Store), sur Instagram (Tokyo Store et Tokyo Gaming) et sur Facebook (Tokyo Store et Tokyo Gaming). Toutes les vidéos sont regroupées sur cette page.",
  },
  {
    q: "Puis-je proposer un produit à tester ?",
    a: "Oui. Écrivez-nous en message privé sur l'un de nos comptes ou appelez-nous au 50 059 160 : nous sélectionnons régulièrement les produits demandés par nos clients.",
  },
  {
    q: "Les produits des vidéos sont-ils disponibles en boutique ?",
    a: "Oui, dans la limite des stocks. Vous pouvez les retirer gratuitement dans nos boutiques de Lac 2 — Tunisia Mall, La Marsa ou Menzah 5, ou vous faire livrer en 24h partout en Tunisie.",
  },
];

const LONG_PARAS = [
  "Chez Tokyo Store, nous testons les produits avant de vous les proposer. Nos vidéos vous montrent les appareils tels qu'ils sont : déballage, premiers réglages, tests en conditions réelles et comparatifs entre modèles.",
  "Tokyo Store couvre les smartphones, l'audio et les accessoires, tandis que Tokyo Gaming est dédié aux consoles, aux jeux et aux équipements gaming. Chaque vidéo indique les produits présentés pour que vous puissiez les retrouver facilement.",
];
const INTRO =
  "Unboxings, tests, comparatifs et astuces : retrouvez toutes nos vidéos TikTok, Instagram et Facebook, avec les produits présentés disponibles en un clic.";
const SERVICE_PHONE = "50059160";
const PAGE_SIZE = 12;

/* ──────────────────────────────── Formatting ──────────────────────────── */
const kfmt = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(".0", "").replace(".", ",") + "K" : String(n);
const tfmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const ago = (d: number) =>
  d <= 1 ? "Hier" : d < 7 ? `Il y a ${d} jours` : d < 30 ? `Il y a ${Math.round(d / 7)} sem.` : `Il y a ${Math.round(d / 30)} mois`;

const platCats = (v: Video) => [...new Set(v.prods.map((k) => PRODUCTS[k].category))];

/* ──────────────────────────────── Component ───────────────────────────── */

export function ReelsView({
  socialUrls = {},
}: {
  /** First real store link per platform (« Identité & contact »), from the page. */
  socialUrls?: Partial<Record<SocialPlatform, string>>;
} = {}) {
  // Filters
  const [accs, setAccs] = useState<Set<string>>(new Set());
  const [topic, setTopic] = useState("all");
  const [dur, setDur] = useState<Duration>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [hover, setHover] = useState(-1);

  // Player
  const [open, setOpen] = useState(false);
  const [fi, setFi] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [t, setT] = useState(0);
  const [liked, setLiked] = useState<Record<number, boolean>>({});
  const [shared, setShared] = useState<Record<number, boolean>>({});
  const [sheet, setSheet] = useState(false);
  const [hint, setHint] = useState(true);
  const [added, setAdded] = useState<Record<string, boolean>>({});

  // Editorial
  const [faqActive, setFaqActive] = useState(0);
  const [descOpen, setDescOpen] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  // Toast
  const [toast, setToast] = useState<string | null>(null);

  const [narrow, setNarrow] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const listTopRef = useRef<HTMLDivElement>(null);
  const descRef = useRef<HTMLDivElement>(null);
  const sortBoxRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /* ── width ── */
  useEffect(() => {
    const onResize = () => {
      const n = window.innerWidth < 900;
      setNarrow(n);
      // Leaving narrow: the mobile product sheet has no desktop control, so clear
      // it (and resume) rather than stranding the slide frozen past the breakpoint.
      if (!n) {
        setSheet(false);
        setPlaying(true);
      }
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* ── filtering / sorting / paging ── */
  const pass = useCallback(
    (v: Video, except?: "acc" | "topic" | "dur") => {
      if (except !== "acc" && accs.size > 0 && !accs.has(v.acc)) return false;
      if (except !== "topic" && topic !== "all" && v.topic !== topic) return false;
      if (except !== "dur" && !DURS.find((d) => d.key === dur)!.test(v.dur)) return false;
      return true;
    },
    [accs, topic, dur],
  );

  const list = useMemo(() => {
    const sorters: Record<Sort, (a: Video, b: Video) => number> = {
      recent: (a, b) => a.days - b.days,
      views: (a, b) => b.views - a.views,
      likes: (a, b) => b.likes - a.likes,
      short: (a, b) => a.dur - b.dur,
    };
    return VIDEOS.filter((v) => pass(v)).sort(sorters[sort]);
  }, [pass, sort]);

  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = list.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const featureOn = safePage === 1 && accs.size === 0 && topic === "all" && dur === "all" && !narrow;

  /* ── active chips ── */
  const chips = useMemo(() => {
    const out: { key: string; label: string; remove: () => void }[] = [];
    accs.forEach((id) =>
      out.push({
        key: `acc-${id}`,
        label: `${ACC[id].plat} · ${ACC[id].name}`,
        remove: () =>
          setAccs((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          }),
      }),
    );
    if (topic !== "all") out.push({ key: "topic", label: topic, remove: () => setTopic("all") });
    if (dur !== "all")
      out.push({ key: "dur", label: DURS.find((d) => d.key === dur)!.label, remove: () => setDur("all") });
    return out;
  }, [accs, topic, dur]);

  const resetFilters = () => {
    setAccs(new Set());
    setTopic("all");
    setDur("all");
    setPage(1);
  };
  const toggleAcc = (id: string) => {
    setAccs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPage(1);
  };

  /* ── description collapse measure ── */
  useEffect(() => {
    const el = descRef.current;
    if (el) setCanExpand(el.scrollHeight > 220);
  }, []);

  /* ── sort outside-click / escape ── */
  useEffect(() => {
    if (!sortOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (sortBoxRef.current && !sortBoxRef.current.contains(e.target as Node)) setSortOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setSortOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [sortOpen]);

  /* The video currently on stage (null if the index fell out of range). The
     player renders — and the body scroll-lock holds — only while this exists. */
  const current = open ? (list[fi] ?? null) : null;
  const showPlayer = open && current !== null;

  /* ── player open/close ── */
  const goTo = useCallback((i: number) => {
    const f = feedRef.current;
    if (!f || i < 0) return;
    f.scrollTo({ top: i * f.clientHeight, behavior: smoothBehavior() });
  }, []);

  const openPlayer = useCallback(
    (id: number) => {
      const i = Math.max(0, list.findIndex((v) => v.id === id));
      setOpen(true);
      setFi(i);
      setT(0);
      setPlaying(true);
      setSheet(false);
      setHint(true);
      requestAnimationFrame(() => {
        const f = feedRef.current;
        if (f) f.scrollTop = i * f.clientHeight;
      });
    },
    [list],
  );
  const closePlayer = useCallback(() => {
    setOpen(false);
    setPlaying(false);
    setSheet(false);
  }, []);
  const startFeed = () => {
    if (list.length) openPlayer(list[0].id);
  };

  /* ── auto-advance tick (image-reel progress, like the mockup) ── */
  useEffect(() => {
    if (!open || !playing || sheet) return;
    const v = list[fi];
    if (!v) return;
    const id = setInterval(() => {
      setT((prev) => {
        if (prev + 0.1 >= v.dur) {
          goTo(fi + 1 < list.length ? fi + 1 : 0);
          return 0;
        }
        return prev + 0.1;
      });
    }, 100);
    return () => clearInterval(id);
  }, [open, playing, sheet, fi, list, goTo]);

  /* ── hide the scroll hint after a moment (openPlayer sets it true; a scroll
        hides it early via onFeedScroll) ── */
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => setHint(false), 3500);
    return () => clearTimeout(id);
  }, [open]);

  /* ── keyboard in player ── */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (sheet) {
          setSheet(false);
          setPlaying(true); // match the sheet's X/backdrop: resume, don't freeze
        } else {
          closePlayer();
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "j") {
        e.preventDefault();
        goTo(fi + 1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "k") {
        e.preventDefault();
        goTo(fi - 1);
      } else if (e.key === " ") {
        // Don't steal Space from a focused control (let it activate the button).
        const el = document.activeElement;
        if (el instanceof HTMLElement && el.closest("button, a, input, textarea, select")) return;
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "m") {
        setMuted((m) => !m);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, sheet, fi, goTo, closePlayer]);

  /* Lock the page scroll ONLY while the player is actually on screen, so the
     lock can never outlive the player (e.g. if the current index fell out of
     range) and strand the page frozen. */
  useEffect(() => {
    if (!showPlayer) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [showPlayer]);

  const onFeedScroll = () => {
    const f = feedRef.current;
    if (!f) return;
    const i = Math.round(f.scrollTop / f.clientHeight);
    if (i !== fi && i >= 0 && i < list.length) {
      setFi(i);
      setT(0);
      setPlaying(true);
      setSheet(false);
      setHint(false);
    }
  };

  /* ── pagination jump ── */
  const goPage = (n: number) => {
    setPage(n);
    const el = listTopRef.current;
    if (el)
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 20, behavior: smoothBehavior() });
  };

  /* ── cart ── */
  const notify = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };
  const addProduct = (key: string) => {
    const p = PRODUCTS[key];
    if (!p) return;
    addToCart(p.slug, 1);
    setAdded((prev) => ({ ...prev, [key]: true }));
    notify(p.title);
    setTimeout(() => setAdded((prev) => ({ ...prev, [key]: false })), 2200);
  };

  return (
    <ReelsSocialContext.Provider value={socialUrls}>
      {/* The page content is made inert while the player is on screen so its
          filter controls can't be reached (and shrink the feed) behind the modal. */}
      <div className="page-container flex flex-col gap-5 pt-3" inert={showPlayer || undefined}>
      {/* ── 1. Header ── */}
      <section className="flex flex-col gap-7 rounded-[36px] bg-background p-6 sm:p-9 lg:p-12">
        <nav aria-label="Fil d'Ariane" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Link
            href="/"
            aria-label="Accueil"
            className="grid size-[30px] shrink-0 place-items-center rounded-full bg-secondary text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <House aria-hidden className="size-3.5" strokeWidth={2} />
          </Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" strokeWidth={2.4} />
          <span
            aria-current="page"
            className="shrink-0 rounded-full bg-primary/10 px-3 py-1.5 text-[13px] font-semibold text-primary"
          >
            Vidéos
          </span>
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-3.5">
            <h1 className="text-[clamp(40px,6.5vw,88px)] font-black leading-[0.92] tracking-[-0.05em] text-foreground">
              Nos vidéos
            </h1>
            <p className="max-w-[62ch] text-[16px] leading-relaxed text-graphite text-pretty">{INTRO}</p>
          </div>
          <button
            type="button"
            onClick={startFeed}
            className="flex h-16 items-center gap-3.5 rounded-full bg-primary py-0 pl-2 pr-6 text-[16px] font-extrabold text-primary-foreground shadow-cta transition-transform hover:-translate-y-0.5 active:scale-[0.98]"
          >
            <span className="grid size-12 place-items-center rounded-full bg-background text-primary">
              <Play aria-hidden className="ml-0.5 size-5" fill="currentColor" />
            </span>
            <span className="flex flex-col items-start leading-tight">
              <span>Regarder en continu</span>
              <span className="text-[12px] font-semibold opacity-85">Faites défiler comme sur TikTok</span>
            </span>
          </button>
        </div>
      </section>

      {/* ── 2. Filters ── */}
      <section
        ref={listTopRef}
        className="flex scroll-mt-5 flex-col gap-6 rounded-[36px] bg-background p-5 sm:p-7 lg:p-8"
      >
        {/* Accounts */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
              Nos comptes
            </span>
            <span className="hidden text-[13px] text-muted-foreground sm:block">
              Sélectionnez un ou plusieurs comptes
            </span>
          </div>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
            <AccountCard
              active={accs.size === 0}
              all
              name="Tous les comptes"
              sub={`${VIDEOS.filter((v) => pass(v, "acc")).length} vidéos · 5 comptes`}
              followers="500K"
              followersLabel="abonnés au total"
              /* Clears ONLY the account selection (its count already honours the
                 active topic/duration), not every filter — "Tout effacer" does that. */
              onToggle={() => {
                setAccs(new Set());
                setPage(1);
              }}
            />
            {ACCOUNTS.map((a) => {
              const on = accs.has(a.id);
              const n = VIDEOS.filter((v) => v.acc === a.id && pass(v, "acc")).length;
              return (
                <AccountCard
                  key={a.id}
                  account={a}
                  active={on}
                  sub={`${a.plat} · ${n} ${n === 1 ? "vidéo" : "vidéos"}`}
                  followers={a.followers}
                  followersLabel="abonnés"
                  onToggle={() => toggleAcc(a.id)}
                />
              );
            })}
          </div>
        </div>

        {/* Topics */}
        <div className="flex flex-col gap-3 border-t border-border/70 pt-5">
          <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
            Sujets
          </span>
          <div className="flex flex-wrap gap-2">
            {[{ key: "all", label: "Tous", Icon: LayoutGrid }, ...TOPICS].map((tp) => {
              const on = topic === tp.key;
              const count = VIDEOS.filter(
                (v) => pass(v, "topic") && (tp.key === "all" || v.topic === tp.key),
              ).length;
              const Icon = tp.Icon;
              return (
                <button
                  key={tp.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setTopic(tp.key);
                    setPage(1);
                  }}
                  className={cn(
                    "flex h-12 items-center gap-2.5 rounded-full py-0 pl-1.5 pr-4 text-[14px] font-bold transition-colors duration-200",
                    on ? "bg-foreground text-background" : "bg-secondary text-foreground hover:brightness-[0.97]",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-9 place-items-center rounded-full transition-colors duration-200",
                      on ? "bg-primary text-primary-foreground" : "bg-background text-foreground",
                    )}
                  >
                    <Icon aria-hidden className="size-4" strokeWidth={2.2} />
                  </span>
                  {tp.label}
                  <span
                    className={cn(
                      "grid h-[22px] min-w-6 place-items-center rounded-full px-1.5 text-[12px] font-extrabold",
                      on ? "bg-background/20 text-background" : "bg-background text-foreground",
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Count + chips + duration + sort */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[15px]">
              <strong className="font-bold tabular-nums text-foreground">{list.length}</strong>{" "}
              <span className="text-muted-foreground">{list.length === 1 ? "vidéo" : "vidéos"}</span>
            </span>
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={c.remove}
                aria-label={`Retirer le filtre ${c.label}`}
                className="flex h-[34px] items-center gap-2 rounded-full bg-foreground py-0 pl-3.5 pr-2.5 text-[13px] font-semibold text-background"
              >
                {c.label}
                <span className="grid size-[18px] place-items-center rounded-full bg-background/20">
                  <X aria-hidden className="size-2.5" strokeWidth={3} />
                </span>
              </button>
            ))}
            {chips.length > 0 && (
              <button
                type="button"
                onClick={resetFilters}
                className="h-[34px] px-2 text-[13px] font-bold text-primary underline decoration-1 underline-offset-[3px]"
              >
                Tout effacer
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="radiogroup"
              aria-label="Durée"
              className="no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto rounded-full bg-secondary p-1"
            >
              {DURS.map((d) => {
                const on = dur === d.key;
                return (
                  <button
                    key={d.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      setDur(d.key);
                      setPage(1);
                    }}
                    className={cn(
                      "h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] font-bold text-foreground transition-colors duration-200",
                      on ? "bg-background shadow-island" : "hover:text-primary-ink",
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <ReelsSortMenu boxRef={sortBoxRef} open={sortOpen} setOpen={setSortOpen} sort={sort} setSort={setSort} setPage={setPage} />
          </div>
        </div>
      </section>

      {/* ── 3. Grid ── */}
      {list.length > 0 ? (
        <section
          style={
            {
              gridTemplateColumns: `repeat(auto-fill,minmax(min(100%,${narrow ? "150px" : "220px"}),1fr))`,
            } as CSSProperties
          }
          className="grid grid-flow-dense gap-3.5"
        >
          {visible.map((v, i) => (
            <VideoCard
              key={v.id}
              video={v}
              featured={featureOn && i === 0}
              hovered={hover === v.id}
              narrow={narrow}
              onEnter={() => setHover(v.id)}
              onLeave={() => setHover((h) => (h === v.id ? -1 : h))}
              onOpen={() => openPlayer(v.id)}
            />
          ))}
        </section>
      ) : (
        <div className="flex flex-col items-center gap-3.5 rounded-[28px] bg-background px-6 py-14 text-center">
          <span className="text-[20px] font-extrabold text-foreground">Aucune vidéo pour ce filtre</span>
          <button
            type="button"
            onClick={resetFilters}
            className="grid h-12 place-items-center rounded-full bg-foreground px-6 text-[14px] font-bold text-background transition-[filter] hover:brightness-110"
          >
            Voir toutes les vidéos
          </button>
        </div>
      )}

      {/* Pagination */}
      {list.length > 0 && pageCount > 1 && (
        <ReelsPagination
          page={safePage}
          pageCount={pageCount}
          from={(safePage - 1) * PAGE_SIZE + 1}
          to={Math.min(safePage * PAGE_SIZE, list.length)}
          total={list.length}
          onChange={goPage}
        />
      )}

      {/* ── 4. About ── */}
      <section
        className="flex scroll-mt-5 flex-col gap-7 rounded-[36px] bg-background p-7 sm:p-10 lg:p-14"
      >
        <h2 className="text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-0.03em] text-foreground">
          Tokyo Store en vidéo
        </h2>
        <div className="relative max-w-[820px]">
          <div
            className="overflow-hidden transition-[max-height] duration-500 ease-out"
            style={{ maxHeight: descOpen || !canExpand ? 4000 : 200 }}
          >
            <div ref={descRef} className="space-y-4">
              {LONG_PARAS.map((p, i) => (
                <p key={i} className="text-[17px] leading-relaxed text-graphite text-pretty">
                  {p}
                </p>
              ))}
            </div>
          </div>
          {canExpand && !descOpen && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-[90px] bg-gradient-to-t from-background to-transparent"
            />
          )}
        </div>
        {canExpand && (
          <button
            type="button"
            onClick={() => setDescOpen((v) => !v)}
            aria-expanded={descOpen}
            className="inline-flex h-[46px] w-fit items-center gap-2 rounded-full border-[1.5px] border-foreground bg-background px-5 text-[14px] font-bold text-foreground transition-colors duration-200 hover:bg-foreground hover:text-background"
          >
            {descOpen ? "Réduire" : "Lire la suite"}
            <ChevronDown
              aria-hidden
              className={cn("size-3.5 transition-transform duration-300", descOpen && "rotate-180")}
              strokeWidth={2.4}
            />
          </button>
        )}
      </section>

      {/* ── 5. FAQ ── */}
      <section className="flex flex-col gap-6 px-1 pt-6">
        <h2 className="text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-0.03em] text-foreground">
          Questions fréquentes
        </h2>
        <div className="grid items-stretch gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr))]">
          <div role="tablist" aria-label="Questions" className="flex flex-col gap-2">
            {FAQS.map((f, i) => {
              const on = faqActive === i;
              return (
                <button
                  key={f.q}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setFaqActive(i)}
                  className={cn(
                    "grid min-h-[72px] grid-cols-[32px_minmax(0,1fr)_16px] items-center gap-4 rounded-[24px] py-3 pl-5 pr-6 text-left transition-colors duration-200",
                    on ? "bg-foreground text-background" : "bg-background text-foreground hover:bg-surface-warm",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-8 place-items-center rounded-full text-[12px] font-extrabold tabular-nums transition-colors duration-200",
                      on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                    )}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="line-clamp-2 text-[15px] font-bold leading-5">{f.q}</span>
                  <ChevronRight
                    aria-hidden
                    className={cn("size-4 transition-opacity duration-200", on ? "opacity-100" : "opacity-30")}
                    strokeWidth={2.2}
                  />
                </button>
              );
            })}
          </div>
          <div role="tabpanel" className="grid min-h-[312px] rounded-[24px] bg-background p-8">
            {FAQS.map((f, i) => {
              const on = faqActive === i;
              return (
                <div
                  key={f.q}
                  aria-hidden={!on}
                  className={cn(
                    "col-start-1 row-start-1 flex flex-col transition-opacity duration-300",
                    on ? "opacity-100" : "pointer-events-none opacity-0",
                  )}
                >
                  <span className="text-[12px] font-extrabold uppercase leading-4 tracking-[0.16em] text-primary">
                    Question {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-3 text-[24px] font-extrabold leading-8 tracking-[-0.02em] text-balance">
                    {f.q}
                  </h3>
                  <p className="mt-4 max-w-[60ch] text-[16px] leading-relaxed text-graphite text-pretty">{f.a}</p>
                  <div className="mt-auto pt-6">
                    <a
                      href={`tel:+216${SERVICE_PHONE}`}
                      className="flex h-12 items-center justify-between gap-4 rounded-full bg-secondary py-0 pl-5 pr-2 text-[14px] text-foreground transition-colors duration-200 hover:bg-primary/10"
                    >
                      <span>Une autre question&nbsp;?</span>
                      <span className="flex h-8 items-center gap-2 rounded-full bg-foreground px-3.5 font-bold text-background">
                        <Phone aria-hidden className="size-3.5" strokeWidth={2} />
                        50&nbsp;059&nbsp;160
                      </span>
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
      </div>

      {/* ── Feed player ── */}
      {open && current && (
        <FeedPlayer
          list={list}
          fi={fi}
          current={current}
          playing={playing}
          muted={muted}
          t={t}
          liked={liked}
          shared={shared}
          added={added}
          sheet={sheet}
          hint={hint}
          narrow={narrow}
          feedRef={feedRef}
          onScroll={onFeedScroll}
          onClose={closePlayer}
          onToggleMute={() => setMuted((m) => !m)}
          onTogglePlay={() => setPlaying((p) => !p)}
          onGoTo={goTo}
          onLike={(id) => setLiked((prev) => ({ ...prev, [id]: !prev[id] }))}
          onShare={(id) => {
            try {
              void navigator.clipboard?.writeText(`${location.href.split("#")[0]}#video-${id}`);
            } catch {
              /* clipboard unavailable */
            }
            setShared((prev) => ({ ...prev, [id]: true }));
          }}
          onOpenSheet={() => {
            setSheet(true);
            setPlaying(false);
          }}
          onCloseSheet={() => {
            setSheet(false);
            setPlaying(true);
          }}
          onAddProduct={addProduct}
        />
      )}

      {/* ── Toast ── */}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "fixed right-4 top-4 z-[120] w-[min(360px,calc(100%-32px))] items-center gap-3 rounded-island bg-foreground p-3.5 text-background shadow-overlay transition-all duration-300",
          toast ? "flex translate-y-0 opacity-100" : "pointer-events-none hidden -translate-y-3 opacity-0",
        )}
      >
        <span className="grid size-9 flex-none place-items-center rounded-full bg-success text-success-foreground">
          <Check aria-hidden className="size-4" strokeWidth={2.6} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-bold">Ajouté au panier</div>
          <div className="truncate text-[13px] text-background/70">{toast}</div>
        </div>
        <Link
          href="/panier"
          className="ml-auto inline-flex h-9 flex-none items-center rounded-full bg-primary px-3.5 text-[13px] font-bold text-primary-foreground"
        >
          Voir le panier
        </Link>
      </div>
    </ReelsSocialContext.Provider>
  );
}

/* ──────────────────────────────── Account card ────────────────────────── */

function AccountCard({
  account,
  all,
  active,
  name,
  sub,
  followers,
  followersLabel,
  onToggle,
}: {
  account?: Account;
  all?: boolean;
  active: boolean;
  name?: string;
  sub: string;
  followers: string;
  followersLabel: string;
  onToggle: () => void;
}) {
  const label = account?.name ?? name ?? "";
  const PlatIcon = account ? PLAT_ICON[account.plat] : null;
  const socialUrls = useContext(ReelsSocialContext);
  return (
    <div
      className={cn(
        "flex items-center rounded-[22px] border-[1.5px] transition-[border-color,background,color,transform] duration-200",
        active
          ? "-translate-y-0.5 border-foreground bg-foreground text-background"
          : "border-border bg-background text-foreground hover:border-foreground/60",
      )}
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={onToggle}
        className="flex h-20 min-w-0 flex-1 items-center gap-3 py-0 pl-3 pr-1.5 text-left"
      >
        <span className="relative size-[46px] flex-none">
          <span
            className={cn(
              "grid size-[46px] place-items-center overflow-hidden rounded-full border border-border",
              all
                ? active
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground"
                : account?.gaming
                  ? "bg-foreground text-background"
                  : "bg-background text-foreground",
            )}
          >
            {all ? (
              <LayoutGrid aria-hidden className="size-[18px]" strokeWidth={2.2} />
            ) : (
              <img
                src="/tokyo-logo.png"
                alt=""
                className={cn("size-full object-cover", account?.gaming && "hue-rotate-180 invert")}
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
            )}
          </span>
          {account && PlatIcon && (
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 grid size-5 place-items-center rounded-full border-2 border-background text-background",
                PLAT_BG[account.plat],
              )}
            >
              <PlatIcon aria-hidden className="size-2.5" strokeWidth={2.4} />
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-bold">{label}</span>
          <span className="truncate text-[12px] opacity-70">{sub}</span>
        </span>
        <span className="flex flex-none flex-col items-end gap-px pr-1">
          <span
            className={cn(
              "text-[20px] font-black leading-[22px] tracking-[-0.03em] tabular-nums",
              active ? "text-background" : "text-primary",
            )}
          >
            {followers}
          </span>
          <span className="text-[11px] font-bold opacity-70">{followersLabel}</span>
        </span>
      </button>
      {account && (
        <a
          href={socialHref(socialUrls, account.plat)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Suivre ${account.name} sur ${account.plat}`}
          title={`Suivre ${account.name} sur ${account.plat}`}
          className={cn(
            "mr-2.5 grid size-9 flex-none place-items-center rounded-full transition-colors hover:bg-primary hover:text-primary-foreground",
            active ? "bg-background/15 text-background" : "bg-secondary text-foreground",
          )}
        >
          <UserPlus aria-hidden className="size-[15px]" strokeWidth={2.2} />
        </a>
      )}
    </div>
  );
}

/* ──────────────────────────────── Sort menu ───────────────────────────── */

function ReelsSortMenu({
  boxRef,
  open,
  setOpen,
  sort,
  setSort,
  setPage,
}: {
  boxRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  setOpen: (v: boolean) => void;
  sort: Sort;
  setSort: (s: Sort) => void;
  setPage: (n: number) => void;
}) {
  const label = SORTS.find((s) => s.key === sort)!.label;
  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-11 items-center gap-2.5 rounded-full border-[1.5px] bg-surface-warm pl-4 pr-3.5 text-[14px] text-foreground transition-colors duration-200 hover:border-foreground/60",
          open ? "border-foreground bg-background" : "border-border",
        )}
      >
        <ArrowUpDown aria-hidden className="size-4 shrink-0" strokeWidth={2.2} />
        <span className="whitespace-nowrap text-muted-foreground">Trier par</span>
        <strong className="whitespace-nowrap">{label}</strong>
        <ChevronDown
          aria-hidden
          className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
          strokeWidth={2.4}
        />
      </button>
      <div
        role="listbox"
        aria-label="Trier les vidéos"
        className={cn(
          "absolute right-0 top-[calc(100%+8px)] z-30 w-[248px] origin-top-right rounded-[22px] border border-border bg-background p-1.5 shadow-overlay transition-[opacity,transform] duration-200",
          open ? "scale-100 opacity-100" : "pointer-events-none -translate-y-1.5 scale-95 opacity-0",
        )}
      >
        {SORTS.map((s) => {
          const on = sort === s.key;
          const Icon = s.Icon;
          return (
            <button
              key={s.key}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => {
                setSort(s.key);
                setPage(1);
                setOpen(false);
              }}
              className={cn(
                "flex h-[46px] w-full items-center justify-between gap-3 rounded-[16px] px-3.5 text-left text-[14px] capitalize transition-colors duration-150 hover:bg-secondary",
                on ? "bg-surface-warm font-bold" : "font-medium",
              )}
            >
              <span className="flex items-center gap-2.5">
                <Icon
                  aria-hidden
                  className={cn("size-4", on ? "text-primary" : "text-muted-foreground")}
                  strokeWidth={2.2}
                />
                {s.label}
              </span>
              {on && (
                <span className="grid size-[22px] place-items-center rounded-full bg-primary">
                  <Check aria-hidden className="size-3 text-primary-foreground" strokeWidth={3.4} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ──────────────────────────────── Video card ──────────────────────────── */

function VideoCard({
  video,
  featured,
  hovered,
  narrow,
  onEnter,
  onLeave,
  onOpen,
}: {
  video: Video;
  featured: boolean;
  hovered: boolean;
  narrow: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onOpen: () => void;
}) {
  const a = ACC[video.acc];
  const PlatIcon = PLAT_ICON[video.plat as Platform] ?? Music2;
  const poster = PRODUCTS[video.poster].image;
  const span = featured ? 2 : 1;

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      aria-label={`Lire : ${video.title}`}
      style={{ gridColumn: `span ${span}`, gridRow: `span ${span}`, aspectRatio: featured ? "auto" : "9 / 16" }}
      className={cn(
        "group relative block h-full w-full overflow-hidden rounded-[24px] bg-foreground text-left text-white transition-[transform,box-shadow] duration-300 ease-out",
        hovered && "-translate-y-1 shadow-overlay",
      )}
    >
      <img
        src={poster}
        alt=""
        loading="lazy"
        className={cn(
          "absolute inset-0 size-full object-cover transition-transform duration-[1200ms] ease-out",
          hovered && "scale-[1.08]",
        )}
      />
      <span className="absolute inset-0 bg-[linear-gradient(180deg,rgba(14,18,24,.55)_0%,rgba(14,18,24,0)_24%,rgba(14,18,24,0)_46%,rgba(14,18,24,.92)_100%)]" />

      {/* Top row: platform + duration */}
      <span className="absolute inset-x-2.5 top-2.5 flex flex-wrap items-center justify-between gap-1.5">
        <span
          className={cn(
            "flex h-[30px] items-center gap-1.5 rounded-full py-0 pl-2 pr-2.5 text-[12px] font-bold text-white",
            PLAT_BG[video.plat as Platform],
          )}
        >
          <PlatIcon aria-hidden className="size-3.5" strokeWidth={2.2} />
          {a.name}
        </span>
        <span className="flex h-[26px] items-center rounded-full bg-foreground/70 px-2.5 text-[12px] font-bold tabular-nums">
          {tfmt(video.dur)}
        </span>
      </span>

      {/* Play button */}
      <span
        aria-hidden
        className={cn(
          "absolute left-1/2 top-[44%] grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full shadow-[0_8px_24px_rgba(0,0,0,.25)] transition-[transform,background,color] duration-300",
          featured ? "size-[72px]" : narrow ? "size-11" : "size-14",
          hovered ? "scale-110 bg-primary text-primary-foreground" : "bg-white/90 text-foreground",
        )}
      >
        <Play className="ml-1 size-6" fill="currentColor" />
      </span>

      {/* Bottom content */}
      <span
        className="absolute flex flex-col gap-2"
        style={{ left: narrow ? 10 : 14, right: narrow ? 10 : 14, bottom: narrow ? 10 : 14 }}
      >
        {featured && (
          <span className="flex h-[26px] w-fit items-center rounded-full bg-primary px-2.5 text-[12px] font-extrabold tracking-[0.04em]">
            À la une
          </span>
        )}
        <span
          className="line-clamp-3 font-extrabold leading-tight tracking-[-0.01em] text-pretty"
          style={{ fontSize: featured ? "clamp(20px,2vw,28px)" : narrow ? 13 : 15 }}
        >
          {video.title}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-white/85">
          <span className="flex items-center gap-1.5">
            <Eye aria-hidden className="size-3.5" strokeWidth={2.2} />
            {kfmt(video.views)} vues
          </span>
          <span className="flex items-center gap-1.5">
            <ShoppingBag aria-hidden className="size-3.5" strokeWidth={2.2} />
            {video.prods.length} {video.prods.length > 1 ? "produits" : "produit"}
          </span>
          <span>{ago(video.days)}</span>
        </span>
      </span>

      {/* Hover preview progress */}
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-[3px] bg-primary transition-[width] ease-linear"
        style={{ width: hovered ? "100%" : "0%", transitionDuration: hovered ? "3.2s" : "0s" }}
      />
    </button>
  );
}

/* ──────────────────────────────── Pagination ──────────────────────────── */

function pageList(page: number, total: number) {
  const out: (number | "…")[] = [];
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || Math.abs(i - page) <= 1) out.push(i);
    else if (out[out.length - 1] !== "…") out.push("…");
  }
  return out;
}

function ReelsPagination({
  page,
  pageCount,
  from,
  to,
  total,
  onChange,
}: {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  onChange: (n: number) => void;
}) {
  const circle =
    "grid size-11 place-items-center rounded-full text-[18px] transition-colors duration-200 disabled:pointer-events-none disabled:opacity-35";
  return (
    <nav
      aria-label="Pagination"
      className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-[24px] bg-background py-2 pl-5 pr-2"
    >
      <span className="text-[14px] text-muted-foreground">
        Vidéos{" "}
        <strong className="font-bold text-foreground tabular-nums">
          {from}–{to}
        </strong>{" "}
        sur {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          aria-label="Page précédente"
          className={cn(circle, "border border-border bg-background text-foreground hover:bg-secondary")}
        >
          <ChevronLeft aria-hidden className="size-4" strokeWidth={2.4} />
        </button>
        {pageList(page, pageCount).map((p, i) =>
          p === "…" ? (
            <span key={`e-${i}`} aria-hidden className="px-1 text-muted-foreground">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => p !== page && onChange(p)}
              aria-current={p === page ? "page" : undefined}
              className={cn(
                "grid h-11 min-w-11 place-items-center rounded-full px-1.5 text-[14px] font-bold tabular-nums transition-colors duration-200",
                p === page ? "bg-foreground text-background" : "bg-secondary text-foreground hover:brightness-95",
              )}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onChange(page + 1)}
          disabled={page === pageCount}
          aria-label="Page suivante"
          className={cn(circle, "bg-foreground text-background hover:brightness-125")}
        >
          <ChevronRight aria-hidden className="size-4" strokeWidth={2.4} />
        </button>
      </div>
    </nav>
  );
}

/* ──────────────────────────────── Feed player ─────────────────────────── */

function FeedPlayer({
  list,
  fi,
  current,
  playing,
  muted,
  t,
  liked,
  shared,
  added,
  sheet,
  hint,
  narrow,
  feedRef,
  onScroll,
  onClose,
  onToggleMute,
  onTogglePlay,
  onGoTo,
  onLike,
  onShare,
  onOpenSheet,
  onCloseSheet,
  onAddProduct,
}: {
  list: Video[];
  fi: number;
  current: Video;
  playing: boolean;
  muted: boolean;
  t: number;
  liked: Record<number, boolean>;
  shared: Record<number, boolean>;
  added: Record<string, boolean>;
  sheet: boolean;
  hint: boolean;
  narrow: boolean;
  feedRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onClose: () => void;
  onToggleMute: () => void;
  onTogglePlay: () => void;
  onGoTo: (i: number) => void;
  onLike: (id: number) => void;
  onShare: (id: number) => void;
  onOpenSheet: () => void;
  onCloseSheet: () => void;
  onAddProduct: (key: string) => void;
}) {
  if (typeof document === "undefined") return null;

  const feedLabel = `${fi + 1} / ${list.length}`;

  return createPortal(
    <div
      className="tokyo fixed inset-0 z-[110] bg-[#0b0e13]"
      role="dialog"
      aria-modal="true"
      aria-label="Flux vidéo"
    >
      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] flex h-[72px] items-center justify-between gap-3 px-4">
        <div className="pointer-events-auto flex items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 items-center gap-2 rounded-full bg-white/[0.12] py-0 pl-3 pr-4 text-[14px] font-bold text-white backdrop-blur-md transition-colors hover:bg-white/20"
          >
            <LayoutGrid aria-hidden className="size-4" strokeWidth={2.2} />
            Toutes les vidéos
          </button>
          <span className="flex h-8 items-center rounded-full bg-white/[0.08] px-3 text-[12px] font-semibold text-white/80">
            {feedLabel}
          </span>
        </div>
        <div className="pointer-events-auto flex gap-2">
          <button
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? "Activer le son" : "Couper le son"}
            className="grid size-11 place-items-center rounded-full bg-white/[0.12] text-white backdrop-blur-md"
          >
            {muted ? <VolumeX aria-hidden className="size-[18px]" /> : <Volume2 aria-hidden className="size-[18px]" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="grid size-11 place-items-center rounded-full bg-white text-foreground"
          >
            <X aria-hidden className="size-[18px]" strokeWidth={2.4} />
          </button>
        </div>
      </div>

      {/* Scroll-snap feed */}
      <div
        ref={feedRef}
        onScroll={onScroll}
        className="no-scrollbar absolute inset-0 snap-y snap-mandatory overflow-y-scroll overscroll-contain"
      >
        {list.map((v, i) => (
          <FeedSlide
            key={v.id}
            video={v}
            active={i === fi}
            near={Math.abs(i - fi) <= 1}
            playing={playing}
            t={t}
            liked={!!liked[v.id]}
            shared={!!shared[v.id]}
            added={added}
            narrow={narrow}
            onToggle={() => (i === fi ? onTogglePlay() : onGoTo(i))}
            onLike={() => onLike(v.id)}
            onShare={() => onShare(v.id)}
            onOpenSheet={onOpenSheet}
            onAddProduct={onAddProduct}
          />
        ))}
      </div>

      {/* Side arrows (desktop) */}
      {!narrow && (
        <div className="absolute right-5 top-1/2 z-[5] flex -translate-y-1/2 flex-col gap-2.5">
          <button
            type="button"
            onClick={() => onGoTo(fi - 1)}
            aria-label="Vidéo précédente"
            className={cn(
              "grid size-[52px] place-items-center rounded-full border border-white/20 bg-white/[0.08] text-white transition-colors hover:bg-white hover:text-foreground",
              fi === 0 && "opacity-30",
            )}
          >
            <ChevronUp aria-hidden className="size-[22px]" strokeWidth={2.2} />
          </button>
          <button
            type="button"
            onClick={() => onGoTo(fi + 1)}
            aria-label="Vidéo suivante"
            className="grid size-[52px] place-items-center rounded-full bg-white text-foreground transition-transform hover:scale-105"
          >
            <ChevronDown aria-hidden className="size-[22px]" strokeWidth={2.2} />
          </button>
        </div>
      )}

      {/* Scroll hint */}
      {hint && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 z-[5] flex h-10 -translate-x-1/2 items-center gap-2 rounded-full bg-white/[0.14] px-4 text-[13px] font-semibold text-white backdrop-blur-md">
          <ChevronDown aria-hidden className="size-[15px]" strokeWidth={2.2} />
          Faites défiler pour la vidéo suivante
        </div>
      )}

      {/* Product sheet (mobile) */}
      {sheet && narrow && (
        <>
          <div className="absolute inset-0 z-[6] bg-black/40" onClick={onCloseSheet} aria-hidden />
          <div className="absolute inset-x-0 bottom-0 z-[7] flex max-h-[75%] flex-col gap-3 overflow-y-auto rounded-t-[28px] bg-background px-4 pb-6 pt-2.5 text-foreground">
            <span className="mx-auto h-1.5 w-11 rounded-full bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-[17px] font-extrabold">Produits dans la vidéo</span>
              <button
                type="button"
                onClick={onCloseSheet}
                aria-label="Fermer"
                className="grid size-10 place-items-center rounded-full bg-secondary text-foreground"
              >
                <X aria-hidden className="size-4" strokeWidth={2.4} />
              </button>
            </div>
            {current.prods.map((k) => (
              <ProductRow key={k} product={PRODUCTS[k]} added={!!added[k]} onAdd={() => onAddProduct(k)} />
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

/* One vertical slide. The thumbnail is a poster image with a slow ken-burns zoom
   + a timed progress bar (there is no reels video backend; this mirrors the
   mockup's image-reel presentation). */
function FeedSlide({
  video,
  active,
  near,
  playing,
  t,
  liked,
  shared,
  added,
  narrow,
  onToggle,
  onLike,
  onShare,
  onOpenSheet,
  onAddProduct,
}: {
  video: Video;
  active: boolean;
  near: boolean;
  playing: boolean;
  t: number;
  liked: boolean;
  shared: boolean;
  added: Record<string, boolean>;
  narrow: boolean;
  onToggle: () => void;
  onLike: () => void;
  onShare: () => void;
  onOpenSheet: () => void;
  onAddProduct: (key: string) => void;
}) {
  const a = ACC[video.acc];
  const PlatIcon = PLAT_ICON[video.plat as Platform] ?? Music2;
  const poster = PRODUCTS[video.poster].image;
  const progress = active ? Math.min(100, (t / video.dur) * 100) : 0;
  const cats = platCats(video);
  const socialUrls = useContext(ReelsSocialContext);

  return (
    <section
      className="flex h-full snap-start snap-always items-center justify-center gap-6"
      style={{ padding: narrow ? 0 : "72px 96px 24px" }}
    >
      {/* Stage */}
      <div
        onClick={onToggle}
        className={cn(
          "relative aspect-[9/16] h-full max-h-[860px] max-w-full flex-none cursor-pointer overflow-hidden bg-black transition-[transform,opacity] duration-500 ease-out",
          narrow ? "rounded-none" : "rounded-[28px]",
          active ? "scale-100 opacity-100" : "scale-[0.92] opacity-45",
        )}
      >
        {near && (
          <>
            <img
              src={poster}
              alt=""
              className="absolute inset-0 size-full object-cover transition-transform ease-linear"
              style={{
                transform: active ? `scale(${1 + 0.12 * (t / video.dur)})` : "scale(1)",
                transitionDuration: active && t > 0 ? "0.2s" : "0s",
              }}
            />
          </>
        )}
        <span className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,.45)_0%,rgba(0,0,0,0)_18%,rgba(0,0,0,0)_52%,rgba(0,0,0,.88)_100%)]" />

        {/* Progress bar */}
        <span className="absolute inset-x-3 top-3 h-[3px] overflow-hidden rounded-full bg-white/[0.28]">
          <span className="block h-full bg-white" style={{ width: `${progress}%` }} />
        </span>

        {/* Big play (paused) */}
        {active && !playing && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[46%] grid size-[76px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/[0.92] text-foreground"
          >
            <Play className="ml-1 size-[30px]" fill="currentColor" />
          </span>
        )}

        {/* Right rail */}
        <div
          className="absolute right-2.5 flex flex-col items-center gap-3.5 text-white"
          style={{ bottom: 150 }}
          onClick={(e) => e.stopPropagation()}
        >
          <a
            href={socialHref(socialUrls, video.plat)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Suivre ${a.name} sur ${video.plat}`}
            className="relative block size-[46px] overflow-hidden rounded-full border-2 border-white bg-white"
          >
            <img src="/tokyo-logo.png" alt="" className="size-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
            <span className="absolute -bottom-0.5 left-1/2 grid size-[18px] -translate-x-1/2 place-items-center rounded-full bg-primary text-[13px] font-extrabold text-primary-foreground">
              +
            </span>
          </a>
          <button type="button" onClick={onLike} aria-label="J'aime" className="flex flex-col items-center gap-1 text-[12px] font-bold">
            <span
              className={cn(
                "grid size-[46px] place-items-center rounded-full bg-black/35 transition-transform duration-300",
                liked ? "scale-110 text-primary" : "text-white",
              )}
            >
              <Heart aria-hidden className="size-[22px]" fill={liked ? "currentColor" : "none"} strokeWidth={2} />
            </span>
            {kfmt(video.likes + (liked ? 1 : 0))}
          </button>
          <button
            type="button"
            onClick={narrow ? onOpenSheet : undefined}
            aria-label="Produits"
            className="flex flex-col items-center gap-1 text-[12px] font-bold"
          >
            <span className="grid size-[46px] place-items-center rounded-full bg-primary">
              <ShoppingBag aria-hidden className="size-5" strokeWidth={2.2} />
            </span>
            {video.prods.length}
          </button>
          <button type="button" onClick={onShare} aria-label="Partager" className="flex flex-col items-center gap-1 text-[12px] font-bold">
            <span className="grid size-[46px] place-items-center rounded-full bg-black/35">
              <Share2 aria-hidden className="size-5" strokeWidth={2.2} />
            </span>
            {shared ? "Copié" : "Partager"}
          </button>
        </div>

        {/* Bottom caption */}
        <div
          className="absolute bottom-4 left-3.5 flex flex-col gap-2.5 text-white"
          style={{ right: 72 }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="flex items-center gap-2 text-[13px]">
            <strong className="text-[14px]">@{a.handle.toLowerCase().replace(/\s+/g, "")}</strong>
            <span className="flex items-center gap-1.5 opacity-85">
              <PlatIcon aria-hidden className="size-3.5" strokeWidth={2.2} />
              {video.plat}
            </span>
            <span className="opacity-70">· {ago(video.days)}</span>
          </span>
          <span className="text-[16px] font-extrabold leading-snug text-pretty">{video.title}</span>
          <span className="flex flex-wrap gap-1.5">
            {cats.map((c) => (
              <span
                key={c}
                className="flex h-[26px] items-center rounded-full bg-white/[0.16] px-2.5 text-[12px] font-bold backdrop-blur-sm"
              >
                #{getCategoryLabel(c)}
              </span>
            ))}
          </span>
          {/* Product rail (mobile only; desktop uses the aside) */}
          {narrow && (
            <div className="no-scrollbar -mr-14 flex gap-2 overflow-x-auto pr-14">
              {video.prods.map((k) => {
                const p = PRODUCTS[k];
                return (
                  <div
                    key={k}
                    className="flex max-w-[260px] flex-none items-center gap-2 rounded-2xl bg-white/95 p-1.5 text-foreground"
                  >
                    <Link href={`/${p.slug}`} className="flex min-w-0 items-center gap-2 text-foreground">
                      <span className="size-10 flex-none overflow-hidden rounded-[10px] bg-white">
                        <img src={p.image} alt="" className="size-full object-contain" />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="max-w-[140px] truncate text-[12px] font-bold">{p.short}</span>
                        <span className="text-[13px] font-extrabold text-primary">{fmtPrice(p.price)} TND</span>
                      </span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => onAddProduct(k)}
                      aria-label="Ajouter au panier"
                      className={cn(
                        "grid size-[34px] flex-none place-items-center rounded-full text-primary-foreground transition-colors",
                        added[k] ? "bg-success" : "bg-primary",
                      )}
                    >
                      {added[k] ? (
                        <Check aria-hidden className="size-[15px]" strokeWidth={2.8} />
                      ) : (
                        <ShoppingBag aria-hidden className="size-[15px]" strokeWidth={2.4} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Desktop aside */}
      {!narrow && (
        <aside
          className={cn(
            "flex max-h-[min(100%,860px)] flex-[0_1_360px] flex-col gap-4 self-center overflow-y-auto rounded-[28px] bg-background p-[22px] text-foreground transition-opacity duration-500",
            active ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-extrabold uppercase tracking-[0.14em] text-primary">
              {video.topic} · {a.name}
            </span>
            <span className="text-[20px] font-extrabold leading-tight tracking-[-0.02em] text-balance">
              {video.title}
            </span>
            <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Eye aria-hidden className="size-3.5" strokeWidth={2.2} />
              {kfmt(video.views)} vues · {ago(video.days)}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
              Produits dans la vidéo
            </span>
            {video.prods.map((k) => (
              <ProductRow key={k} product={PRODUCTS[k]} added={!!added[k]} onAdd={() => onAddProduct(k)} expanded />
            ))}
          </div>
          {cats.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
                Catégories liées
              </span>
              <div className="flex flex-wrap gap-1.5">
                {cats.map((c) => (
                  <Link
                    key={c}
                    href={`/${c}`}
                    className="flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-border px-3.5 text-[13px] font-bold text-foreground transition-colors hover:border-foreground"
                  >
                    {getCategoryLabel(c)}
                    <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.2} />
                  </Link>
                ))}
              </div>
            </div>
          )}
          <a
            href={socialHref(socialUrls, video.plat)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto flex h-12 items-center justify-center gap-2.5 rounded-full bg-foreground text-[14px] font-bold text-background transition-[filter] hover:brightness-125"
          >
            <PlatIcon aria-hidden className="size-4" strokeWidth={2.2} />
            Voir sur {video.plat}
          </a>
        </aside>
      )}
    </section>
  );
}

/* A product row inside the player (aside / sheet). */
function ProductRow({
  product,
  added,
  onAdd,
  expanded,
}: {
  product: ReelProduct;
  added: boolean;
  onAdd: () => void;
  expanded?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5 rounded-[18px]", expanded ? "border border-border p-2.5" : "p-0")}>
      <div className="flex items-center gap-3">
        <Link href={`/${product.slug}`} className="flex min-w-0 flex-1 items-center gap-3 text-foreground hover:text-primary">
          <span className="size-16 flex-none overflow-hidden rounded-xl border border-border bg-background">
            <img src={product.image} alt="" className="size-full object-contain p-1" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="line-clamp-2 text-[14px] font-bold leading-[18px]">{product.title}</span>
            <span className="text-[15px] font-extrabold text-primary">
              {fmtPrice(product.price)} <span className="text-[10px]">TND</span>
            </span>
          </span>
        </Link>
        {!expanded && (
          <button
            type="button"
            onClick={onAdd}
            aria-label="Ajouter au panier"
            className={cn(
              "grid size-12 flex-none place-items-center rounded-full text-primary-foreground transition-colors",
              added ? "bg-success" : "bg-primary",
            )}
          >
            {added ? <Check aria-hidden className="size-[18px]" strokeWidth={2.6} /> : <ShoppingBag aria-hidden className="size-[18px]" strokeWidth={2.4} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="grid grid-cols-2 gap-1.5">
          <Link
            href={`/${product.slug}`}
            className="grid h-10 place-items-center rounded-full bg-secondary text-[13px] font-bold text-foreground transition-colors hover:bg-foreground hover:text-background"
          >
            Voir le produit
          </Link>
          <button
            type="button"
            onClick={onAdd}
            className={cn(
              "flex h-10 items-center justify-center gap-1.5 rounded-full text-[13px] font-bold text-primary-foreground transition-colors",
              added ? "bg-success" : "bg-primary",
            )}
          >
            {added ? <Check aria-hidden className="size-3.5" strokeWidth={2.8} /> : <ShoppingBag aria-hidden className="size-3.5" strokeWidth={2.4} />}
            {added ? "Ajouté" : "Ajouter"}
          </button>
        </div>
      )}
    </div>
  );
}
