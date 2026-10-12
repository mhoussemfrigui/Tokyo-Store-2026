"use client";

import Image from "next/image";
import Link from "next/link";
import { createElement, useState, type ComponentType } from "react";
import { MapPin, Phone, Mail, Clock, ChevronDown } from "lucide-react";

import { KawnAttribution } from "@/components/kawn-attribution";
import { NewsletterSignup } from "@/components/storefront/newsletter-signup";
import { FooterBottomActions } from "@/components/storefront/footer-bottom-actions";
import { PLATFORM_META } from "@/components/social-icons";
import { promoIcon } from "@/lib/links/promo-icons";
import { safeHref } from "@/lib/utils/safe-href";
import { getSiteContacts, footerEntries } from "@/lib/cms/contact-list";
import { resolveSocialList } from "@/lib/cms/social-list";
import {
  FOOTER_APPEARANCE_DEFAULTS,
  type FooterAppearance,
  type FooterTone,
} from "@/lib/cms/footer-appearance";

type SocialIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

type FooterSettings = Record<string, string | null>;

export type FooterLink = {
  label: string;
  href: string;
  icon?: string | null;
  newTab?: boolean;
  children?: FooterLink[];
};

export type FooterColumn = {
  /** Stable menu key — the render identity (keys + accordion open-state) so two
   *  columns an admin renamed to the same title never collide. */
  key: string;
  title: string;
  links: FooterLink[];
};

/**
 * Per-tone surface for the footer. Each tone pins a FIXED dark background PLUS
 * light `--background` / readable accent tokens, so the footer stays a dark
 * luxury surface with legible light text in BOTH the light and dark storefront
 * themes (otherwise `--background` flips near-black in dark mode and the whole
 * footer disappears). `accent` picks the tint that reads on that surface — olive
 * on the near-blacks, gold on the dark-olive (olive-on-olive is too low-contrast).
 */
type ToneDef = { bg: string; accent: "olive" | "gold" };
const TONE: Record<FooterTone, ToneDef> = {
  onyx: { bg: "#201e1b", accent: "olive" },
  ink: { bg: "#0b0b0d", accent: "olive" },
  olive: { bg: "#15170f", accent: "gold" },
};
/** Light text/border + readable accent tokens, pinned so they don't theme-flip. */
const CARD_VARS = {
  "--background": "hsl(40 25% 96%)",
  "--olive": "hsl(80 24% 55%)",
  "--gold": "hsl(38 42% 62%)",
} as React.CSSProperties;
const toneStyle = (tone: FooterTone): React.CSSProperties => ({
  backgroundColor: TONE[tone].bg,
  ...CARD_VARS,
});
/** Full literal classes (Tailwind-scannable) for the per-tone accent tint. */
const ICON_ACCENT = { olive: "text-olive/70", gold: "text-gold/75" } as const;
const EYEBROW_ACCENT = { olive: "text-olive/80", gold: "text-gold/85" } as const;

/** Social icon chip treatment (appearance setting). */
const SOCIAL_STYLE = {
  circle: "h-11 w-11 rounded-full border border-background/[0.08] hover:border-background/30 hover:bg-background/[0.04]",
  square: "h-11 w-11 rounded-xl border border-background/[0.08] hover:border-background/30 hover:bg-background/[0.04]",
  plain: "h-9 w-9 rounded-full hover:bg-background/[0.06]",
} as const;

/** Admin-picked link icon (own-key lookup → crash-safe; createElement keeps the
 *  looked-up component from being flagged as created-in-render). */
function NavLinkIcon({ icon }: { icon?: string | null }) {
  const comp = promoIcon(icon);
  return comp ? createElement(comp, { className: "h-3.5 w-3.5 shrink-0", strokeWidth: 2, "aria-hidden": true }) : null;
}

function newTabProps(newTab?: boolean) {
  return newTab ? { target: "_blank" as const, rel: "noopener noreferrer" } : {};
}

/** A footer link row (+ optional nested children). Keyed by href|label so two
 *  links sharing a label in one column don't collide. */
function LinkRow({ link, muted }: { link: FooterLink; muted?: boolean }) {
  return (
    <li>
      <Link
        href={link.href || "#"}
        {...newTabProps(link.newTab)}
        className={`inline-flex items-center gap-1.5 text-[0.82rem] tracking-wide transition-colors duration-300 hover:text-background/90 ${
          muted ? "text-background/40" : "text-background/55"
        }`}
      >
        <NavLinkIcon icon={link.icon} />
        {link.label}
      </Link>
      {link.children && link.children.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-l border-background/[0.08] pl-3">
          {link.children.map((c) => (
            <LinkRow key={`${c.href}|${c.label}`} link={c} muted />
          ))}
        </ul>
      )}
    </li>
  );
}

type ContactData = { addresses: string[]; phones: string[]; emails: string[]; hours: string | null };

/** Contact rows (icon + value) — SHARED by the desktop « Coordonnées » column and
 *  the mobile accordion pill so the two never drift. Renders EVERY footer-flagged
 *  entry of each list (several boutiques → several address/phone rows). The
 *  map/tel/mail rows are links that brighten on hover; the static hours row stays
 *  put (its base has no hover brighten — adding a second `hover:` utility would
 *  lose to Tailwind's source order, so only the links carry the brighten). */
function ContactRows({ contact, iconClass }: { contact: ContactData; iconClass: string }) {
  const base = "flex items-start gap-3 text-[0.8rem] tracking-wide text-background/55";
  const link = `${base} transition-colors duration-300 hover:text-background/90`;
  const icon = `mt-0.5 h-3.5 w-3.5 shrink-0 ${iconClass}`;
  return (
    <div className="space-y-3">
      {contact.addresses.map((a, i) => (
        <a key={`${i}-${a}`} href={`https://maps.google.com/?q=${encodeURIComponent(a)}`} target="_blank" rel="noopener noreferrer" className={link}>
          <MapPin className={icon} strokeWidth={1.5} />
          <span className="min-w-0 break-words">{a}</span>
        </a>
      ))}
      {contact.phones.map((p, i) => (
        <a key={`${i}-${p}`} href={`tel:${p.replace(/[^\d+]/g, "")}`} className={link}>
          <Phone className={icon} strokeWidth={1.5} />
          <span className="min-w-0 break-words">{p}</span>
        </a>
      ))}
      {contact.emails.map((e, i) => (
        <a key={`${i}-${e}`} href={`mailto:${e}`} className={link}>
          <Mail className={icon} strokeWidth={1.5} />
          <span className="min-w-0 break-all">{e}</span>
        </a>
      ))}
      {contact.hours && (
        <div className={base}>
          <Clock className={icon} strokeWidth={1.5} />
          <span className="min-w-0 break-words">{contact.hours}</span>
        </div>
      )}
    </div>
  );
}

type FooterSocial = { Icon: SocialIcon; href: string; label: string };

function FooterSocials({ socials, socialClass, className = "" }: { socials: FooterSocial[]; socialClass: string; className?: string }) {
  if (socials.length === 0) return null;
  return (
    <div className={`flex gap-2.5 ${className}`}>
      {socials.map(({ Icon, href, label }, i) => (
        <a
          key={`${label}-${i}`}
          href={href}
          aria-label={label}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={`grid place-items-center text-background/40 transition-colors duration-300 hover:text-background/90 ${socialClass}`}
        >
          <Icon className="h-4 w-4" strokeWidth={1.6} />
        </a>
      ))}
    </div>
  );
}

function FooterNewsletterCopy({
  newsletter,
  eyebrowClass,
}: {
  newsletter: { eyebrow: string | null; title: string; subtitle: string | null };
  eyebrowClass: string;
}) {
  return (
    <div className="text-center md:text-left">
      {newsletter.eyebrow && (
        <p className={`mb-2 text-[0.6rem] uppercase tracking-[0.28em] ${eyebrowClass}`}>{newsletter.eyebrow}</p>
      )}
      <h3 className="mb-2 font-serif text-xl tracking-tight text-background/90 md:text-2xl">{newsletter.title}</h3>
      {newsletter.subtitle && (
        <p className="mx-auto mb-5 max-w-md text-xs tracking-wide text-background/45 md:mx-0 md:text-sm">
          {newsletter.subtitle}
        </p>
      )}
    </div>
  );
}

/** One mobile accordion pill (soft rounded chip that expands its content). */
function Pill({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div
      className={`overflow-hidden rounded-[1.25rem] border transition-all duration-300 ${
        open ? "border-background/15 bg-background/[0.05]" : "border-background/[0.08] bg-background/[0.02]"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-[0.6rem] uppercase tracking-[0.28em] text-background/60"
      >
        <span>{title}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-background/40 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          strokeWidth={2}
        />
      </button>
      {open && <div className="border-t border-background/[0.06] px-5 pb-4 pt-3.5">{children}</div>}
    </div>
  );
}

/** Even desktop columns for the links band — the count is small + fixed
 *  (Coordonnées + up to 3 link menus). Literal classes so Tailwind emits them. */
const COL_GRID: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "sm:grid-cols-2 lg:grid-cols-2",
  3: "sm:grid-cols-3 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

/**
 * Storefront footer — a full-bleed dark band across the page foot, fully
 * backend-driven + hide-when-unset. Laid out as stacked bands: a BRAND bar (logo
 * + description + socials on one line), a LINKS band (Coordonnées + the CMS footer
 * menus as columns), then the legal bar (cookies/theme · © · Kawn). CONTENT from
 * `site.*`/`social.*` + the footer menus + the `footer`-placement newsletter banner;
 * APPEARANCE (tone, newsletter style, social style, show-toggles) from
 * `storefront.footer.*`. Mobile: the links collapse into space-saving accordion
 * pills (one open at a time). KawnAttribution is non-removable.
 */
export function SiteFooter({
  settings = {},
  columns = [],
  logoUrl = null,
  newsletter = null,
  darkMode = "off",
  appearance = FOOTER_APPEARANCE_DEFAULTS,
}: {
  settings?: FooterSettings;
  columns?: FooterColumn[];
  darkMode?: "off" | "system" | "on";
  logoUrl?: string | null;
  newsletter?: { eyebrow: string | null; title: string; subtitle: string | null; cta: string } | null;
  appearance?: FooterAppearance;
}) {
  const [openCol, setOpenCol] = useState<string | null>(null);

  const brandName = settings["site.name"]?.trim() || "Tokyo Store";
  const tagline = settings["site.tagline"]?.trim() || null;
  const description = appearance.showDescription ? settings["site.description"]?.trim() || null : null;

  // Multi-value contact lists — only the entries the operator flagged for the
  // footer (per-entry « Footer » checkbox in the admin). Each address links to a
  // Maps SEARCH query (a plain link, never an embedded iframe).
  const sc = getSiteContacts(settings);
  const addresses = appearance.showContact ? footerEntries(sc.addresses).map((e) => e.value) : [];
  const phones = appearance.showContact ? footerEntries(sc.phones).map((e) => e.value) : [];
  const emails = appearance.showContact ? footerEntries(sc.emails).map((e) => e.value) : [];
  const contactHours = appearance.showContact ? sc.hours : null;
  const hasContact = addresses.length > 0 || phones.length > 0 || emails.length > 0 || Boolean(contactHours);
  const contact: ContactData | null = hasContact ? { addresses, phones, emails, hours: contactHours } : null;

  // All links from « Identité & contact » (social.links — many per platform),
  // using the shared platform → icon map. Each entry's own label (or the
  // platform name) is the accessible label; dead/invalid URLs drop out.
  const socials: FooterSocial[] = appearance.showSocials
    ? resolveSocialList(settings)
        .map((link) => {
          const { name, Icon } = PLATFORM_META[link.platform];
          return { Icon: Icon as SocialIcon, href: safeHref(link.url), label: link.label?.trim() || name };
        })
        .filter((s) => s.href !== "#")
    : [];
  const socialClass = SOCIAL_STYLE[appearance.socialStyle];

  const tone = appearance.tone;
  const iconAccent = ICON_ACCENT[TONE[tone].accent];
  const eyebrowAccent = EYEBROW_ACCENT[TONE[tone].accent];

  const showNewsletter = newsletter !== null && appearance.newsletterStyle !== "off";
  const year = new Date().getFullYear();

  // The links band: Coordonnées (when shown) + each link column, as even columns.
  const colCount = (contact ? 1 : 0) + columns.length;
  const colGrid = COL_GRID[Math.min(Math.max(colCount, 1), 4)] ?? COL_GRID[4];
  const hasLinks = colCount > 0;
  const CONTACT_KEY = "__contact__";

  // Built ONLY when the newsletter is shown. As a plain const this JSX is
  // constructed on every render, which eagerly evaluates `newsletter!.cta` — so on
  // a store with no footer-newsletter banner (newsletter === null, e.g. a fresh DB)
  // it threw "Cannot read properties of null (reading 'cta')" and crashed every page
  // via the footer chrome, even though the render sites below gate on showNewsletter.
  const newsletterRow = showNewsletter ? (
    <div className="flex flex-col items-center justify-between gap-6 md:flex-row md:gap-12">
      <FooterNewsletterCopy newsletter={newsletter!} eyebrowClass={eyebrowAccent} />
      <NewsletterSignup cta={newsletter!.cta} />
    </div>
  ) : null;

  return (
    <footer
      className="relative mt-16 w-full overflow-hidden text-background md:mt-24"
      style={{ ...toneStyle(tone), paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0px))" }}
    >
      {/* Subtle sheen overlay — pure CSS over the dark surface. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04] mix-blend-soft-light"
        style={{ backgroundImage: "radial-gradient(120% 120% at 50% -10%, rgba(255,255,255,0.6), transparent 55%)" }}
      />

      {/* Newsletter — BANNER: full-width row at the top. */}
      {showNewsletter && appearance.newsletterStyle === "banner" && (
        <div className="relative z-10 border-b border-background/[0.07]">
          <div className="mx-auto max-w-7xl px-6 py-10 md:px-10 md:py-12 lg:px-16">{newsletterRow}</div>
        </div>
      )}

      {/* Newsletter — CARD: a framed card at the top of the content. */}
      {showNewsletter && appearance.newsletterStyle === "card" && (
        <div className="relative z-10 mx-auto max-w-7xl px-6 pt-10 md:px-10 lg:px-16">
          <div className="rounded-[1.75rem] border border-background/[0.08] bg-background/[0.03] px-6 py-8 md:px-10 md:py-10">
            {newsletterRow}
          </div>
        </div>
      )}

      {/* ── BRAND bar — logo + name · description · socials, on one line ── */}
      <div className="relative z-10 border-b border-background/[0.08]">
        <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-6 py-10 text-center md:px-10 lg:flex-row lg:items-center lg:justify-between lg:gap-10 lg:px-16 lg:text-left">
          <Link href="/" className="flex shrink-0 flex-col items-center gap-2.5 lg:flex-row lg:items-center lg:gap-3">
            {logoUrl && (
              <Image src={logoUrl} alt={brandName} width={88} height={88} className="h-16 w-auto object-contain opacity-80 lg:h-20" />
            )}
            <span className="leading-tight">
              <span className="block font-serif text-lg tracking-[0.15em] text-background/90 md:text-xl">{brandName}</span>
              {tagline && (
                <span className="mt-0.5 block text-[0.5rem] uppercase tracking-[0.22em] text-background/40">{tagline}</span>
              )}
            </span>
          </Link>

          {description && (
            <p className="max-w-md text-[0.82rem] leading-relaxed tracking-wide text-background/55 lg:flex-1 lg:px-8">
              {description}
            </p>
          )}

          <FooterSocials socials={socials} socialClass={socialClass} className="shrink-0 justify-center" />
        </div>
      </div>

      {/* ── LINKS band — Coordonnées + link columns (mobile: expandable pills) ── */}
      {hasLinks && (
        <div className="relative z-10 mx-auto max-w-7xl px-6 py-12 md:px-10 lg:px-16">
          {/* Desktop: open columns. */}
          <div className={`hidden gap-10 lg:grid ${colGrid}`}>
            {contact && (
              <div>
                <h4 className="mb-6 text-[0.58rem] uppercase tracking-[0.28em] text-background/55">Coordonnées</h4>
                <ContactRows contact={contact} iconClass={iconAccent} />
              </div>
            )}
            {columns.map((col) => (
              <div key={col.key}>
                <h4 className="mb-6 text-[0.58rem] uppercase tracking-[0.28em] text-background/55">{col.title}</h4>
                <ul className="space-y-3">
                  {col.links.map((l) => (
                    <LinkRow key={`${l.href}|${l.label}`} link={l} />
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Mobile: expandable pills (one open at a time). */}
          <div className="flex flex-col gap-2.5 lg:hidden">
            {contact && (
              <Pill title="Coordonnées" open={openCol === CONTACT_KEY} onToggle={() => setOpenCol(openCol === CONTACT_KEY ? null : CONTACT_KEY)}>
                <ContactRows contact={contact} iconClass={iconAccent} />
              </Pill>
            )}
            {columns.map((col) => (
              <Pill key={col.key} title={col.title} open={openCol === col.key} onToggle={() => setOpenCol(openCol === col.key ? null : col.key)}>
                <ul className="space-y-3">
                  {col.links.map((l) => (
                    <LinkRow key={`${l.href}|${l.label}`} link={l} />
                  ))}
                </ul>
              </Pill>
            ))}
          </div>
        </div>
      )}

      {/* ── Bottom legal bar — cookies/theme · © · Kawn, with © centered on lg ── */}
      <div className="relative z-10 border-t border-background/[0.07]">
        <div className="mx-auto flex max-w-7xl flex-col items-center gap-3 px-6 py-5 md:px-10 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:px-16">
          <div className="order-2 lg:order-1 lg:justify-self-start">
            <FooterBottomActions darkMode={darkMode} />
          </div>
          <p className="order-1 whitespace-nowrap text-[0.55rem] tracking-[0.2em] text-background/40 lg:order-2 lg:justify-self-center">
            © {year} {brandName.toUpperCase()}
          </p>
          {/* NON-REMOVABLE — Kawn Digital Studio attribution (see kawn-attribution.tsx). */}
          <div className="order-3 lg:justify-self-end">
            <KawnAttribution className="whitespace-nowrap font-body text-[0.6rem] tracking-[0.15em]" />
          </div>
        </div>
      </div>
    </footer>
  );
}
