"use client";

import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Clock,
  MapPin,
  Phone,
  RefreshCw,
  ShieldCheck,
  Store,
  Truck,
} from "lucide-react";

import { SectionHeading, ViewAllLink } from "@/storefront/components/storefront/section-heading";
import { btn, card, promise, rhythm } from "@/storefront/components/storefront/ui-classes";
import { useShippingConfig } from "@/storefront/lib/cart";
import { useSiteContacts, telHref } from "@/storefront/lib/site-contacts";
import { cn } from "@/storefront/lib/utils";

/** A storefront boutique card — mapped from the backend in-store pickup
 *  locations (delivery module), the real, admin-editable source of truth. */
export type StoreCard = { city: string; address: string; hours: string; phone: string };

/** The delivery promise copy tracks the live free-shipping threshold (admin-
 *  configurable, read via useShippingConfig). `freeFrom === 0` = no free offer.
 *  The boutiques promise is derived from the real store list (no hardcoded count). */
const buildPromises = (freeFrom: number, stores: StoreCard[]) => [
  {
    icon: ShieldCheck,
    title: "Garantie jusqu’à 24 mois",
    copy: "Sur tous les iPhone reconditionnés.",
  },
  {
    icon: RefreshCw,
    title: "Reprise immédiate",
    copy: "Jusqu'à 2 500 TND pour votre ancien iPhone.",
  },
  {
    icon: Truck,
    title: "Livraison 24h",
    copy:
      freeFrom > 0
        ? `Partout en Tunisie, gratuite dès ${freeFrom} TND.`
        : "Partout en Tunisie, livrée en 24h.",
  },
  {
    icon: Store,
    title:
      stores.length > 0
        ? `${stores.length} boutique${stores.length > 1 ? "s" : ""} en Tunisie`
        : "Retrait en boutique",
    copy: stores.length > 0 ? stores.map((s) => s.city).join(" · ") : "Disponible en magasin.",
  },
];

const mapsSearch = (query: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

/** The shop's line, until a trade-in estimate page exists. */

/**
 * The Journal tiles' padding. Horizontally the pill's own inset (16 / lg:20),
 * so the text lands on the logo line like the promo bars, store cards,
 * newsletter and Tokyo Repair banner (28 + 1 + 16 = 45 at md, 49 at lg);
 * vertically one shared 20 / 32 / 40, so the photo cards and the Reprise tile
 * sharing a row end on the same line. 20 on phones: the 16:10 Édito card is
 * 185px tall at 320 and its caption needs 144 of them.
 */
const EDITORIAL_PAD = "px-4 py-5 sm:py-8 lg:px-5 lg:py-10";

export function PromoGrid({ stores }: { stores: StoreCard[] }) {
  const { freeFrom } = useShippingConfig();
  const { phone: sitePhone } = useSiteContacts();
  const promises = buildPromises(freeFrom, stores);
  return (
    <section className="pt-14 sm:pt-16 lg:pt-20">
      <div className="page-container">
        {/* Editorial grid */}
        <SectionHeading
          eyebrow="Le Journal Tokyo"
          title="Guides, tests & bons plans"
          action={<ViewAllLink href="/nouveautes">Tous les articles</ViewAllLink>}
        />

        <div
          className={cn(rhythm.head, "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3", rhythm.gap)}
        >
          {/* Below md the three photo cards are the stores' snap rail (they
              stacked into 1,100px of page at 390), all 4:3, and the Reprise
              tile follows as an island. -my-3 cancels the py-3 kept for the
              shadow and focus ring inside the scroll clip, so the heading gap
              stays 20 / 24. From md, `contents` hands the cards back to the
              grid. */}
          <div className="no-scrollbar mx-[calc(-1*var(--gutter))] -my-3 flex snap-x snap-mandatory scroll-px-(--gutter) gap-3 overflow-x-auto px-(--gutter) py-3 sm:gap-5 md:contents">
            <FeatureCard
              href="/iphones-d-occasion"
              image="/assets/banner-1.jpg"
              eyebrow="Édito"
              title="L'iPhone reconditionné, mode d'emploi"
              copy="Nos experts vous expliquent pourquoi choisir un iPhone reconditionné chez Tokyo Store."
              /* 21:9 from 2xl, near the photo's own 2.27:1: at 16:9 the
                 uncapped column made the row 695px tall at 1920. */
              span="md:col-span-2 aspect-[4/3] md:aspect-[2/1] lg:aspect-[16/9] 2xl:aspect-[21/9]"
              dark
            />
            <FeatureCard
              href="/ipad-et-mac"
              image="/assets/cat-mac.jpg"
              eyebrow="Mac · Neuf"
              title="MacBook Air M3"
              copy="À partir de 4 590 TND, garantie officielle Apple."
              span="aspect-[4/3] lg:aspect-auto"
            />
            <FeatureCard
              href="/audio"
              image="/assets/cat-audio.jpg"
              eyebrow="Audio"
              title="Casques & AirPods"
              copy="La qualité Apple à prix Tokyo."
              /* lg:aspect-auto: the grid row stretches it to the Reprise tile
                 beside it, instead of ending 46px short. */
              span="aspect-[4/3] lg:aspect-auto"
            />
          </div>
          {/* The Tokyo Repair banner's sibling: same dark island, text line,
              copy spacing and 48px page CTA — full width on phones like its
              CTAs and the newsletter's, hugging its label from sm. Its
              white/10 hairline (the footer's ink-island border) is the 1px the
              logo-line sum counts. */}
          <div
            className={cn(
              EDITORIAL_PAD,
              "relative flex min-h-[280px] flex-col justify-between overflow-hidden rounded-island border border-white/10 bg-foreground text-background shadow-island md:col-span-2",
            )}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-primary/30 blur-3xl"
            />
            <div className="relative">
              <p className="eyebrow text-background/70">Reprise Tokyo</p>
              <h3 className="title-section mt-2 max-w-md">
                Reprenez votre iPhone.
                <br />
                Repartez avec le neuf.
              </h3>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-background/70 sm:mt-4">
                Estimation en 2 minutes, valeur déduite immédiatement de votre nouveau iPhone.
                Reprise possible en boutique ou par retrait à domicile.
              </p>
            </div>
            <a
              href={telHref(sitePhone)}
              className={cn(btn.base, btn.lg, btn.primary, "relative mt-6 self-stretch sm:mt-8 sm:self-start")}
            >
              Estimer mon iPhone
              <Phone aria-hidden className="size-4" />
            </a>
          </div>
        </div>

        {/* Stores block */}
        <div className="mt-14 sm:mt-16 lg:mt-20">
          <SectionHeading
            eyebrow="Nos boutiques"
            title={
              stores.length > 0
                ? `${stores.length} boutique${stores.length > 1 ? "s" : ""} en Tunisie`
                : "Nos boutiques"
            }
            action={
              <ViewAllLink href={mapsSearch("Tokyo Store Tunis")}>Voir les boutiques</ViewAllLink>
            }
          />
          {/* Below md: a snap rail bleeding to the screen edges (the three
              stacked cards were 716px of page), one card and a peek on
              phones, two and a peek from sm — three columns of 189px at 640
              wrapped every line of the cards. A row of three from md. py-3
              (cancelled by the margins) is room for the shadow and focus ring
              inside the scroll clip, so the gap to the heading stays 20 / 24. */}
          <ul className="no-scrollbar mx-[calc(-1*var(--gutter))] -mb-3 mt-2 flex snap-x snap-mandatory scroll-px-(--gutter) gap-3 overflow-x-auto px-(--gutter) py-3 sm:mt-3 sm:gap-5 md:mx-0 md:mb-0 md:mt-6 md:grid md:grid-cols-3 md:overflow-visible md:px-0 md:py-0 lg:mt-8 lg:gap-6">
            {/* The cards stay on the uncapped grid, but their content keeps
                its natural width: from lg the button hugs its label (it was
                563px wide at 1920), and from 2xl — where the longest address
                still fits beside it — it moves up beside the details, so a
                wide card reads as one row instead of a tall, mostly empty
                tile. */}
            {stores.map((s) => (
              <li
                key={s.city}
                className="flex w-[85%] shrink-0 snap-start flex-col rounded-card border border-border bg-background p-4 shadow-island transition-colors duration-200 hover:border-primary/40 sm:w-[45%] md:w-auto lg:p-5 2xl:grid 2xl:grid-cols-[minmax(0,1fr)_auto] 2xl:items-end 2xl:gap-x-6"
              >
                <div className="flex items-start justify-between gap-3 2xl:col-span-2">
                  {/* No fabricated "Ouvert" status: real-time open/closed is not tracked. */}
                  <h3 className="title-block text-foreground">{s.city}</h3>
                </div>
                {/* flex-1: the buttons line up across the row whatever the
                    address length. */}
                <ul className="mt-4 flex-1 space-y-2.5 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2.5">
                    <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>{s.address}</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>{s.hours}</span>
                  </li>
                  {s.phone && (
                    <li className="flex items-start gap-2.5">
                      <Phone aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span>{s.phone}</span>
                    </li>
                  )}
                </ul>
                <a
                  href={mapsSearch(s.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    btn.base,
                    btn.md,
                    btn.outline,
                    "mt-5 w-full lg:w-auto lg:self-start 2xl:mt-0 2xl:self-end",
                  )}
                >
                  Itinéraire
                  <ArrowUpRight aria-hidden className="size-4" />
                </a>
              </li>
            ))}
          </ul>

          {/* Promises — the reassurance tile shared with the category
              guarantees and the product services (disc on the left, 15px
              display title, 13px copy), one island gap below the shops. They
              close the page as reassurance. Not links, so no hover state.
              One column on phones (a disc beside the text leaves no room in
              halves of 320), two from sm, a row of four from xl — at 1024 a
              quarter left the title 126px and wrapped every line. */}
          <ul
            className={cn(
              rhythm.island,
              "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
              rhythm.gap,
            )}
          >
            {promises.map((p) => (
              <li key={p.title} className={cn(card, promise.tile)}>
                <span className={promise.disc}>
                  <p.icon aria-hidden className="size-5" strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <h3 className={promise.title}>{p.title}</h3>
                  <p className={promise.copy}>{p.copy}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function FeatureCard({
  href,
  image,
  eyebrow,
  title,
  copy,
  span,
  dark,
}: {
  href: string;
  image: string;
  eyebrow: string;
  title: string;
  copy: string;
  span: string;
  dark?: boolean;
}) {
  return (
    /* isolate: keeps the rounded clip on the zooming photo in Safari.
       Rail widths below md: one card and a peek, like the store cards; 60%
       from sm, where a 45% card (274px) left the 4:3 photo no room above its
       caption. */
    <Link
      href={href}
      className={cn(
        "group relative isolate block w-[85%] shrink-0 snap-start overflow-hidden rounded-island shadow-island sm:w-[60%] md:w-auto",
        span,
      )}
    >
      <img
        src={image}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-soft motion-safe:group-hover:scale-105"
      />
      {/* One scrim for the light photos: the old one was clear from the
          middle up, where the eyebrow sat on a silver laptop. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 bg-gradient-to-t",
          dark
            ? "from-black/80 via-black/30 to-transparent"
            : "from-black/80 via-black/45 to-black/0",
        )}
      />
      {/* inset-px stands in for the 1px border of the other islands (a
          transparent one would show the canvas round the photo), so the text
          lands on the logo line with them. */}
      <div className={cn(EDITORIAL_PAD, "absolute inset-px flex flex-col justify-end text-white")}>
        <p className="eyebrow text-white/80">{eyebrow}</p>
        <h3 className="title-block mt-2">{title}</h3>
        <p className="mt-1.5 line-clamp-2 max-w-sm text-[13px] text-white/85 sm:line-clamp-none sm:text-sm">
          {copy}
        </p>
        <span className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold sm:text-sm">
          Découvrir <ArrowRight aria-hidden className="size-4" />
        </span>
      </div>
    </Link>
  );
}
