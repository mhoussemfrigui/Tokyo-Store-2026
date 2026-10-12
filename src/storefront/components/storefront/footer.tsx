"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, Mail, MapPin, Phone } from "lucide-react";

import { PLATFORM_META } from "@/components/social-icons";
import type { FooterColumn, NavLink } from "@/lib/api/cms";
import { FOOTER_APPEARANCE_DEFAULTS, type FooterAppearance, type FooterSocialStyle } from "@/lib/cms/footer-appearance";
import { FOOTER_COLUMN_DEFAULTS, FOOTER_LEGAL_COLUMN_KEY } from "@/lib/cms/nav-menus";
import type { SocialLink } from "@/lib/cms/social-list";
import { cn } from "@/storefront/lib/utils";

/** Backend-controlled identity + contacts (from site_settings), passed by the
 *  (tokyo) layout. Every field is optional so the footer renders on a fresh DB. */
export type FooterData = {
  brandName?: string | null;
  tagline?: string | null;
  logoUrl?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Footer-flagged boutiques (« Identité & contact »). Empty → the row hides —
   *  never a hardcoded / placeholder store address. */
  stores?: string[];
  /** Central HQ / registered address (« Identité & contact » → Informations
   *  légales). Shown in the bottom bar ONLY when `hqAddressPublic` is on; distinct
   *  from the retail `stores` above. */
  hqAddress?: string | null;
  hqAddressPublic?: boolean;
  /** Active blog categories (from the backend) — the « Blog » footer section. */
  blogCategories?: { slug: string; name: string }[];
  /** Social links (« Identité & contact » → social.links), N per platform. The
   *  optional `label` shows as the pill caption; empty → the row hides. */
  socials?: SocialLink[];
  /** The footer link columns from CMS → Footer (the fixed-key nav menus
   *  footer-shop/footer-support/footer-society). `undefined` (couldn't read, or no
   *  prop) → the built-in fallback columns, so the footer stays pixel-identical.
   *  An empty array → the operator emptied the menus → render no link columns. */
  columns?: FooterColumn[];
  /** Footer appearance (show toggles + social style) from CMS → Footer. Unset →
   *  the defaults (everything shown, round social discs) = today's look. */
  appearance?: FooterAppearance;
};

/** No href = no page for it yet: rendered as plain text, never a dead button or a 404. */
type FooterLinkItem = { label: string; href?: string; newTab?: boolean };
type FooterCol = { key: string; title: string; links: FooterLinkItem[] };

/** Built-in fallback columns (Boutique / Tokyo Store / Légal) — the SAME links the
 *  CMS footer menus are seeded with, so an unconfigured store (no menu rows, or a
 *  DB hiccup) renders exactly like a configured one. Single source: nav-menus.ts. */
const FALLBACK_COLUMNS: FooterCol[] = FOOTER_COLUMN_DEFAULTS.map((c) => ({
  key: c.key,
  title: c.title,
  links: c.items.map((it) => ({ label: it.label, href: it.href })),
}));

/** A resolved nav link → a footer link item. An empty / "#" destination becomes
 *  plain text (never a dead button). Sub-items are flattened out (the footer is a
 *  flat chip design). */
function navLinkToItem(l: NavLink): FooterLinkItem {
  const href = l.href?.trim();
  return { label: l.label, href: href && href !== "#" ? href : undefined, newTab: l.newTab };
}

/** The dynamic « Blog » column — built from the live blog categories (falls back
 *  to just « Tous les articles » on a fresh site). Kept as a special auto column
 *  (not an editable menu) so it always mirrors the published blog taxonomy. */
function buildBlogColumn(blogCats: { slug: string; name: string }[]): FooterCol {
  return {
    key: "blog",
    title: "Blog",
    links: [
      { label: "Tous les articles", href: "/blog" },
      ...blogCats.slice(0, 5).map((c) => ({ label: c.name, href: `/blog/${c.slug}` })),
    ],
  };
}

/**
 * The footer's link columns in render order — Boutique, Tokyo Store, (dynamic)
 * Blog, Légal — resolved from the backend CMS footer menus when configured, else
 * the built-in fallback. The Blog column is always slotted 3rd (its place in the
 * design). The « Légal » column (footer-society) is returned separately because
 * it ALSO feeds the always-visible bottom legal row, so the two can never drift.
 */
function resolveColumns(data: FooterData): { columns: FooterCol[]; legal: FooterLinkItem[] } {
  // `undefined` (the layout couldn't read the menus — a DB hiccup, or the Footer
  // is used without the prop) → the built-in fallback, so the footer never breaks.
  // An EMPTY array means the menus were read fine but the operator left them
  // without a visible link → honour that (no link columns), NOT the defaults.
  const source: FooterCol[] =
    data.columns === undefined
      ? FALLBACK_COLUMNS
      : data.columns.map((c) => ({ key: c.key, title: c.title, links: c.links.map(navLinkToItem) }));
  const byKey = new Map(source.map((c) => [c.key, c]));
  const legalCol = byKey.get(FOOTER_LEGAL_COLUMN_KEY);
  const columns = [
    byKey.get("footer-shop"),
    byKey.get("footer-support"),
    buildBlogColumn(data.blogCategories ?? []),
    legalCol,
  ].filter((c): c is FooterCol => Boolean(c));
  return { columns, legal: legalCol?.links ?? [] };
}

/** The sitemap's outlined chips (the v0.1 look); size and fill are set per layout. */
const sitemapChip =
  "inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] text-background/80";
const sitemapChipHover =
  "transition-colors duration-200 hover:border-primary/60 hover:bg-primary/15 hover:text-background";

/**
 * One footer entry: a Link for internal routes, an <a> for tel:/mailto:, and
 * plain text when there is no destination. `className` is the shared
 * geometry; `linkClassName` (hover and colour) applies to real links only.
 * `dim` fades destination-less text; the sitemap chips pass false so every
 * chip keeps the same look at rest (they just have no hover or action).
 */
function FooterLink({
  item,
  className,
  linkClassName,
  dim = true,
}: {
  item: FooterLinkItem;
  className: string;
  linkClassName: string;
  dim?: boolean;
}) {
  if (!item.href)
    return <span className={cn(className, dim && "text-background/50")}>{item.label}</span>;
  const cls = cn(className, linkClassName);
  const newTab = item.newTab
    ? ({ target: "_blank", rel: "noopener noreferrer" } as const)
    : undefined;
  if (item.href.startsWith("/") && !item.newTab) {
    return (
      <Link href={item.href} className={cls}>
        {item.label}
      </Link>
    );
  }
  return (
    <a href={item.href} className={cls} {...newTab}>
      {item.label}
    </a>
  );
}

/**
 * A 44px social link: an icon disc on its own, or (`labelled`) a pill whose 32px
 * icon disc sits 6px in (22 − 6 = 16, concentric) followed by the operator's
 * caption (the optional `label`, else the platform name). Backend-driven — no
 * fabricated follower counts.
 */
function SocialPill({
  link,
  labelled = false,
  style = "circle",
}: {
  link: SocialLink;
  labelled?: boolean;
  /** CMS → Footer « Style des réseaux ». circle (default) = today's round disc. */
  style?: FooterSocialStyle;
}) {
  const { name, Icon } = PLATFORM_META[link.platform];
  const caption = link.label?.trim() || name;
  // square swaps the pill-radius to a rounded-rect; plain drops the fill (icon only).
  const rounded = style === "square" ? "rounded-[14px]" : "rounded-full";
  const plain = style === "plain";
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={link.label ? `${name} — ${link.label}` : name}
      className={cn(
        "inline-flex h-11 items-center transition-colors duration-200",
        rounded,
        plain ? "text-background/70 hover:text-primary" : "bg-white/10 hover:bg-primary",
        labelled ? "gap-2 pr-4 pl-1.5" : "w-11 justify-center",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center",
          rounded,
          labelled && !plain && "bg-white/10",
        )}
      >
        <Icon aria-hidden className={labelled ? "size-4" : "size-5"} />
      </span>
      {labelled && <span className="text-[13px] leading-none font-semibold">{caption}</span>}
    </a>
  );
}

/**
 * The page's closing bookend: the hero's envelope (12 / 16px inset, radius
 * 28 / 36 / 44) in ink. Its padding puts the content on the pill's logo line
 * from md (16 + 1 + 28 = 45, 16 + 1 + 32 = 49). On phones it is the last thing
 * above the floating bottom nav, so it (not <main>) clears it: --dock-bottom
 * leaves exactly 12px between the island and the nav at the end of the page.
 * From md (no bottom nav) it keeps 16px above the home indicator, not the
 * screen edge, like --dock-bottom does for the docked bars.
 */
export function Footer({ data = {} }: { data?: FooterData }) {
  // Track the open column by its stable KEY (not title) so two columns an admin
  // renamed to the same label never collide. shownKey keeps the last column on
  // screen while the desktop panel collapses.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);

  const appearance = data.appearance ?? FOOTER_APPEARANCE_DEFAULTS;

  // Backend-controlled identity (site_settings). The brand name + logo keep a
  // default (the store's own name / mark — not fabricated data); the pitch line
  // and the contact details HIDE when unset rather than showing an invented
  // number / email / tagline (the project-wide no-fabricated-fallbacks rule).
  const brandName = data.brandName?.trim() || "Tokyo Store";
  const tagline = data.tagline?.trim() || "";
  const logoUrl = data.logoUrl?.trim() || "/tokyo-logo.png";
  const phone = data.phone?.trim() || "";
  const email = data.email?.trim() || "";
  const phoneHref = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : "";
  const stores = appearance.showContact ? (data.stores ?? []).filter((s) => s.trim().length > 0) : [];
  const socials = appearance.showSocials ? (data.socials ?? []) : [];
  const { columns, legal } = resolveColumns(data);
  const showTagline = appearance.showDescription && tagline.length > 0;
  const hasContact = appearance.showContact && (phone.length > 0 || email.length > 0);
  // HQ / registered address — shown in the bottom bar only when the admin enabled
  // its front-end visibility (business.hq_address_public). Empty → the line hides,
  // so the footer stays byte-identical when the toggle is off.
  const hqAddress = data.hqAddressPublic ? data.hqAddress?.trim() || "" : "";

  const toggle = (key: string) => {
    const next = openKey === key ? null : key;
    setOpenKey(next);
    if (next) setShownKey(next);
  };

  return (
    <footer className="envelope-x pb-(--dock-bottom) md:pb-[calc(1rem+env(safe-area-inset-bottom))]">
      {/* The 1px hairline is what lands the text on 45 / 49, like every other
          envelope. Focus rings switch to the light ink so they read on the dark. */}
      <div className="radius-envelope border border-white/10 bg-foreground pt-12 pb-8 text-background shadow-card sm:pt-16 [&_:focus-visible]:outline-background">
        <div className="px-4 md:px-7 lg:px-8">
          {/* Top block: centred logo, pitch, contacts, stores, socials. The
              hairline separators use a softer white than the envelope outline so
              they read as quiet dividers on the dark surface, not bright lines. */}
          <div className="footer-divider flex flex-col items-center border-b pb-10 text-center sm:pb-12">
            <img
              src={logoUrl}
              alt={brandName}
              width={300}
              height={300}
              loading="lazy"
              decoding="async"
              className="h-16 w-auto rounded-card bg-white object-contain p-3 sm:h-20"
            />
            {/* The pitch line (site.tagline) — hidden when unset or toggled off
                (« Afficher le slogan »), never an invented sentence. */}
            {showTagline && (
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-background/70">{tagline}</p>
            )}

            {/* Contacts — only the values the operator configured (first footer-
                flagged phone + email). Each line hides when unset; the whole row
                hides when « Afficher les coordonnées » is off or nothing is set. */}
            {hasContact && (
              <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-background/70">
                {phone && (
                  <li>
                    <a
                      href={phoneHref}
                      className="inline-flex min-h-11 items-center gap-2 transition-colors hover:text-background md:min-h-8 pointer-coarse:min-h-11"
                    >
                      <Phone aria-hidden className="size-4 text-primary" /> {phone}
                    </a>
                  </li>
                )}
                {email && (
                  <li>
                    <a
                      href={`mailto:${email}`}
                      className="inline-flex min-h-11 items-center gap-2 transition-colors hover:text-background md:min-h-8 pointer-coarse:min-h-11"
                    >
                      <Mail aria-hidden className="size-4 text-primary" /> {email}
                    </a>
                  </li>
                )}
              </ul>
            )}

            {/* Boutiques — ONLY the footer-flagged addresses from « Identité &
                contact » (backend). No addresses configured → the row is absent,
                never a placeholder store. A wrapping row, not a 3-column grid. */}
            {stores.length > 0 && (
              <ul className="mt-2 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-background/70">
                {stores.map((store) => (
                  <li key={store} className="flex items-center gap-2">
                    <MapPin aria-hidden className="size-4 shrink-0 text-primary" />
                    <a
                      href={`https://maps.google.com/?q=${encodeURIComponent(store)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center transition-colors hover:text-background md:min-h-8 pointer-coarse:min-h-11"
                    >
                      {store}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {/* Below sm: a centred row of 44px icon discs. Hidden when the
                operator configured no social links (never a placeholder). */}
            {socials.length > 0 && (
              <ul className="mt-5 flex flex-wrap justify-center gap-2 sm:hidden">
                {socials.map((s, i) => (
                  <li key={`${s.platform}-${i}`}>
                    <SocialPill link={s} style={appearance.socialStyle} />
                  </li>
                ))}
              </ul>
            )}

            {/* From sm: one row of labelled pills (icon + the operator's caption). */}
            {socials.length > 0 && (
              <ul className="mt-5 hidden flex-wrap justify-center gap-2 sm:flex">
                {socials.map((s, i) => (
                  <li key={`${s.platform}-${i}`}>
                    <SocialPill link={s} labelled style={appearance.socialStyle} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Links — the owner's preferred look (as in v0.1): expandable cards
              of outlined chips on phones, and from md one centred capsule bar
              of four segments over a shared chip panel. */}
          <div className="footer-divider border-b py-10 sm:py-12">
            {/* Below md: one accordion card per column. items-start: in the sm
                two-column band an open card must not stretch its closed
                neighbour on the same row into an empty box. */}
            <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 md:hidden">
              {columns.map((col, i) => {
                const isOpen = openKey === col.key;
                const panelId = `footer-links-${i}`;
                return (
                  <div
                    key={col.key}
                    className={cn(
                      "rounded-island border transition-colors duration-300 motion-reduce:transition-none",
                      isOpen
                        ? "border-primary/40 bg-white/[0.04]"
                        : "border-white/10 bg-white/[0.02]",
                    )}
                  >
                    <h2>
                      <button
                        type="button"
                        onClick={() => toggle(col.key)}
                        aria-expanded={isOpen}
                        aria-controls={panelId}
                        className="flex w-full items-center justify-between gap-3 rounded-island px-5 py-4 text-left"
                      >
                        <span className="font-sans text-[13px] font-bold tracking-[0.14em] text-background/90 uppercase">
                          {col.title}
                        </span>
                        <span
                          aria-hidden
                          className={cn(
                            "grid size-7 place-items-center rounded-full transition-[rotate,background-color,color] duration-300 ease-soft motion-reduce:transition-none",
                            isOpen
                              ? "rotate-180 bg-primary text-primary-foreground"
                              : "bg-white/10 text-background/70",
                          )}
                        >
                          <ChevronDown className="size-4" />
                        </span>
                      </button>
                    </h2>
                    {/* inert while closed: the collapsed chips leave the tab
                        order and the accessibility tree, not just the view. */}
                    <div
                      id={panelId}
                      inert={!isOpen}
                      className={cn(
                        "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
                        isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                      )}
                    >
                      <div className="overflow-hidden">
                        {/* px-4 as in v0.1; pt-1 leaves room for the focus ring. */}
                        <ul className="flex flex-wrap gap-2 px-4 pt-1 pb-5">
                          {col.links.map((link) => (
                            <li key={link.label}>
                              <FooterLink
                                item={link}
                                dim={false}
                                className={cn(sitemapChip, "px-3.5 py-1.5 text-xs")}
                                linkClassName={sitemapChipHover}
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* From md: a single capsule bar of four segments, centred under
                the brand block; the open segment goes solid crimson (as the
                open Catégories chip does in the nav) and its links drop into
                the shared panel beneath. */}
            <div className="hidden md:block">
              <div className="mx-auto flex max-w-3xl items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1.5">
                {columns.map((col) => {
                  const isOpen = openKey === col.key;
                  return (
                    <button
                      key={col.key}
                      type="button"
                      onClick={() => toggle(col.key)}
                      aria-expanded={isOpen}
                      aria-controls="footer-links-panel"
                      className={cn(
                        "flex flex-1 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[12px] font-bold tracking-[0.16em] uppercase transition-[color,background-color,box-shadow] duration-200",
                        isOpen
                          ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30"
                          : "text-background/70 hover:bg-white/[0.06] hover:text-background",
                      )}
                    >
                      <span>{col.title}</span>
                      <ChevronDown
                        aria-hidden
                        className={cn(
                          "size-3.5 transition-transform duration-300 motion-reduce:transition-none",
                          isOpen && "rotate-180",
                        )}
                      />
                    </button>
                  );
                })}
              </div>

              {/* The shared panel. It keeps the last column's chips while it
                  collapses (they used to vanish before the panel had closed),
                  and is inert while closed, so hidden chips leave the tab order. */}
              <div
                id="footer-links-panel"
                inert={!openKey}
                className={cn(
                  "grid transition-[grid-template-rows,opacity,margin] duration-[400ms] ease-out motion-reduce:transition-none",
                  openKey ? "mt-5 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  {/* 32px: the pill's radius, like the bar above it. */}
                  <div className="mx-auto max-w-3xl rounded-[32px] border border-primary/20 bg-white/[0.04] px-6 py-6">
                    <ul className="flex flex-wrap justify-center gap-2">
                      {columns
                        .find((c) => c.key === shownKey)
                        ?.links.map((link) => (
                          <li key={link.label}>
                            <FooterLink
                              item={link}
                              dim={false}
                              className={cn(
                                sitemapChip,
                                "bg-white/[0.04] px-4 py-2 text-[13px] text-background/85",
                              )}
                              linkClassName={sitemapChipHover}
                            />
                          </li>
                        ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* HQ / registered address — a single centred line, shown only when the
              admin turned on its front-end visibility (the retail boutiques stay in
              the contact block above). Hidden → byte-identical bottom bar. */}
          {hqAddress && (
            <p className="pt-6 text-center text-xs text-background/55">
              Siège social : {hqAddress}
            </p>
          )}

          {/* Bottom bar — one row from lg: copyright · legal · credit. Wraps to
              centred rows below. From lg a 1fr / auto / 1fr grid, not
              justify-between: the side items differ in width (223 vs 202px),
              which pushed the legal row ~10px off the island's centre. The
              16px gap keeps each 1fr track wider than the copyright at 1024. */}
          <div className="flex flex-col items-center gap-4 pt-6 text-xs text-background/60 lg:grid lg:grid-cols-[1fr_auto_1fr]">
            <p className="order-2 text-center lg:order-1 lg:justify-self-start lg:whitespace-nowrap lg:text-left">
              © {new Date().getFullYear()} {brandName} · Tous droits réservés.
            </p>

            <ul
              aria-label="Informations légales"
              className="order-1 flex flex-wrap items-center justify-center gap-x-1 gap-y-1 lg:order-2"
            >
              {legal.map((link) => (
                <li key={link.label}>
                  <FooterLink
                    item={link}
                    /* Plain-text entries keep a 32px line; only real links
                       grow to a 44px touch target. */
                    className="inline-flex min-h-8 items-center rounded-full px-3"
                    linkClassName="min-h-11 transition-colors hover:bg-white/10 hover:text-background md:min-h-8 pointer-coarse:min-h-11"
                  />
                </li>
              ))}
            </ul>

            {/* hit-44: a 44px touch target around the 34px pill. The Kawn credit
                is a CONTRACTUAL, non-editable attribution — hardcoded here (no
                setting key), marked with data-kawn-attribution so it's covered by
                the attribution-presence checks. Do NOT make it configurable. */}
            <a
              href="https://kawn.me"
              target="_blank"
              rel="nofollow noopener"
              data-kawn-attribution="true"
              aria-label="Propulsé par Kawn Digital Studio"
              className="hit-44 order-3 shrink-0 rounded-full lg:justify-self-end border border-white/15 bg-white/10 px-3 py-2 text-[12px] font-semibold whitespace-nowrap text-background transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
            >
              Propulsé par Kawn Digital Studio
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
