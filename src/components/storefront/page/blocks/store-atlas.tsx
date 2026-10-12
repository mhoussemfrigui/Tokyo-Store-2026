"use client";

import { useRef, useState } from "react";
import { Clock, Mail, MapPin, Navigation, Phone } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/** A store, fully resolved on the server (pickup-location link merged, contact fallbacks
 *  applied, map urls derived) — this island only handles WHICH store the map shows. */
export type AtlasStore = {
  name: string;
  badge: string;
  address: string;
  city: string;
  phone: string;
  phoneHref: string;
  email: string;
  hours: { label: string; value: string }[];
  services: string[];
  note: string;
  embed: string;
  directions: string;
  image: { src: string; alt: string } | null;
};

/**
 * « L'Atlas » — the boutique directory: address cards on the left, ONE sticky Google map
 * on the right that follows the selected boutique (desktop). On mobile the map sits under
 * the list. The iframe loads lazily and only for the active store.
 */
export function StoreAtlas({
  stores,
  showMap,
  indexOffset = 0,
  total,
}: {
  stores: AtlasStore[];
  showMap: boolean;
  /** When a single card is rendered per section (« Salons »), its real position. */
  indexOffset?: number;
  total?: number;
}) {
  const [active, setActive] = useState(0);
  const mapRef = useRef<HTMLDivElement>(null);
  const current = stores[active] ?? stores[0];
  const withMap = showMap && Boolean(current?.embed);
  // Below the desktop grid the map sits UNDER the list — bring it into view so the
  // visitor actually sees the boutique they picked (desktop: the map is sticky beside).
  const show = (i: number) => {
    setActive(i);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => mapRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" }));
    }
  };

  return (
    <div className={cn("grid gap-y-8", withMap && "lg:grid-cols-12 lg:gap-x-10")}>
      <ol className={cn("grid gap-4", withMap ? "lg:col-span-5" : stores.length > 1 ? "md:grid-cols-2 xl:grid-cols-3" : "")}>
        {stores.map((s, i) => {
          const isActive = withMap && i === active;
          return (
            <li key={`${s.name}-${i}`}>
              <article
                className={cn(
                  "h-full rounded-[1.5rem] border bg-card/80 p-6 transition-[border-color,box-shadow] duration-500 sm:p-7",
                  isActive
                    ? "border-olive/50 shadow-[0_24px_50px_-34px_rgba(43,40,37,0.45)]"
                    : "border-border/60",
                )}
              >
                {s.image && (
                  <img
                    src={s.image.src}
                    alt={s.image.alt}
                    loading="lazy"
                    decoding="async"
                    className="mb-6 aspect-[16/9] w-full rounded-2xl object-cover"
                  />
                )}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    {s.badge && (
                      <p className="mb-2 font-body text-[0.65rem] uppercase tracking-[0.28em] text-olive">{s.badge}</p>
                    )}
                    <h3 className="font-serif text-2xl leading-tight tracking-tight text-foreground">{s.name}</h3>
                  </div>
                  <span className="pt-1 font-body text-[0.68rem] tabular-nums text-muted-foreground">
                    {String(i + 1 + indexOffset).padStart(2, "0")}/{String(total ?? stores.length).padStart(2, "0")}
                  </span>
                </div>

                {(s.address || s.city) && (
                  <address className="mt-5 flex gap-2.5 font-body text-sm not-italic leading-relaxed text-foreground/85">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold" strokeWidth={1.6} aria-hidden />
                    <span>
                      {s.address}
                      {s.address && s.city ? ", " : ""}
                      {s.city}
                    </span>
                  </address>
                )}

                {s.hours.length > 0 && (
                  <div className="mt-4 flex gap-2.5">
                    <Clock className="mt-0.5 h-4 w-4 shrink-0 text-gold" strokeWidth={1.6} aria-hidden />
                    <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-body text-sm">
                      {s.hours.map((h, j) => (
                        <div key={j} className="contents">
                          <dt className="text-muted-foreground">{h.label}</dt>
                          <dd className="text-right text-foreground/90 sm:text-left">{h.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                {s.services.length > 0 && (
                  <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="Services">
                    {s.services.map((sv) => (
                      <li
                        key={sv}
                        className="rounded-full border border-border/70 px-3 py-1 font-body text-[0.68rem] tracking-wide text-muted-foreground"
                      >
                        {sv}
                      </li>
                    ))}
                  </ul>
                )}

                {s.note && <p className="mt-4 font-body text-sm leading-relaxed text-muted-foreground">{s.note}</p>}

                <div className="mt-6 flex flex-wrap gap-2">
                  {s.directions && (
                    <a
                      href={s.directions}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={buttonVariants({ variant: "primary", size: "sm" })}
                    >
                      <span className="btn__label">
                        <Navigation className="h-3.5 w-3.5" aria-hidden /> Itinéraire
                      </span>
                    </a>
                  )}
                  {s.phoneHref && (
                    <a href={s.phoneHref} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                      <span className="btn__label">
                        <Phone className="h-3.5 w-3.5" aria-hidden /> Appeler
                      </span>
                    </a>
                  )}
                  {s.email && (
                    <a href={`mailto:${s.email}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                      <span className="btn__label">
                        <Mail className="h-3.5 w-3.5" aria-hidden /> Écrire
                      </span>
                    </a>
                  )}
                  {withMap && stores.length > 1 && s.embed && (
                    <button
                      type="button"
                      onClick={() => show(i)}
                      aria-pressed={i === active}
                      className={buttonVariants({ variant: "ghost", size: "sm" })}
                    >
                      <span className="btn__label">{i === active ? "Sur la carte" : "Voir sur la carte"}</span>
                    </button>
                  )}
                </div>
              </article>
            </li>
          );
        })}
      </ol>

      {withMap && current && (
        <div className="lg:col-span-7" ref={mapRef}>
          <div className="lg:sticky lg:top-28">
            <div className="relative aspect-[4/3] overflow-hidden rounded-[1.75rem] border border-border/60 bg-muted lg:aspect-auto lg:h-[min(74vh,660px)]">
              <iframe
                key={current.embed}
                src={current.embed}
                title={`Carte — ${current.name}`}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
                className="absolute inset-0 h-full w-full grayscale-[30%] contrast-[1.05]"
              />
              <div className="pointer-events-none absolute left-4 top-4 max-w-[80%] rounded-full bg-background/90 px-4 py-2 font-body text-[0.7rem] uppercase tracking-[0.18em] text-foreground shadow-sm backdrop-blur">
                {current.name}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
