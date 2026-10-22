"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Check, ExternalLink, Facebook, Instagram, Music2, Plus, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { addToCart } from "@/storefront/lib/cart";
import { fmtPrice } from "@/storefront/lib/productMeta";
import { cn } from "@/storefront/lib/utils";
import {
  REEL_PLATFORM_LABELS,
  REEL_TOPICS,
  type ReelPlatform,
  type ReelTopic,
} from "@/lib/cms/reels-content";

/*
  « Nos vidéos » (/reels) — the storefront video library.

  Everything here is BACKEND-TRUTH: the reels are the ones the operator added in
  the admin (Contenu & Design → Vidéos), each one a REAL post (opened via « Voir
  sur … »), with a REAL poster and the catalogue products it features (resolved
  live on the server, add-to-cart in one tap). There are NO invented videos and NO
  fabricated engagement metrics (views / likes / follower counts were removed — they
  were never backed by anything). When no reels are configured, an honest empty
  state invites visitors to follow the shop's real social accounts.
*/

/** A catalogue product featured in a reel (resolved on the server). */
export type ReelCardProduct = {
  slug: string;
  title: string;
  price: number;
  image: string;
};

/** A reel, resolved for rendering (products already hydrated from the catalogue). */
export type ReelCard = {
  id: string;
  title: string;
  platform: ReelPlatform;
  topic: ReelTopic;
  videoUrl: string;
  posterUrl: string;
  products: ReelCardProduct[];
};

const PLAT_ICON: Record<ReelPlatform, LucideIcon> = {
  tiktok: Music2,
  instagram: Instagram,
  facebook: Facebook,
};

/** The three reel platforms, in display order, for the "Suivre" strip + filters. */
const PLATFORMS = Object.keys(REEL_PLATFORM_LABELS) as ReelPlatform[];

export function ReelsView({
  videos,
  socialUrls,
}: {
  videos: ReelCard[];
  /** First real account URL per platform, from « Identité & contact » → social links. */
  socialUrls: Partial<Record<string, string>>;
}) {
  const [plat, setPlat] = useState<ReelPlatform | "all">("all");
  const [topic, setTopic] = useState<ReelTopic | "all">("all");
  const [added, setAdded] = useState<Record<string, boolean>>({});

  const filtered = useMemo(
    () =>
      videos.filter(
        (v) => (plat === "all" || v.platform === plat) && (topic === "all" || v.topic === topic),
      ),
    [videos, plat, topic],
  );

  const add = (slug: string) => {
    addToCart(slug, 1);
    setAdded((a) => ({ ...a, [slug]: true }));
  };

  // Which topics actually occur, so the filter never offers an empty chip.
  const topics = useMemo(
    () => REEL_TOPICS.filter((t) => videos.some((v) => v.topic === t)),
    [videos],
  );

  const followLinks = PLATFORMS.map((p) => ({ p, url: socialUrls[p] })).filter(
    (x): x is { p: ReelPlatform; url: string } => Boolean(x.url),
  );

  return (
    <div className="page-container flex flex-col gap-8 py-6 sm:gap-10 sm:py-8">
      {/* Header */}
      <header className="flex flex-col gap-3">
        <p className="eyebrow text-primary-ink">Nos vidéos</p>
        <h1 className="title-page text-foreground">Unboxings, tests & gaming</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-graphite">
          Nos vidéos sur TikTok, Instagram et Facebook — avec les produits présentés disponibles en
          un clic.
        </p>
        {followLinks.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2.5">
            {followLinks.map(({ p, url }) => {
              const Icon = PLAT_ICON[p];
              return (
                <a
                  key={p}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-10 items-center gap-2 rounded-full border-[1.5px] border-border bg-card px-4 text-sm font-bold text-foreground transition-colors hover:border-primary/40"
                >
                  <Icon aria-hidden className="size-4" />
                  Suivre sur {REEL_PLATFORM_LABELS[p]}
                </a>
              );
            })}
          </div>
        )}
      </header>

      {videos.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-[28px] bg-card px-6 py-16 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-muted text-muted-foreground">
            <Video aria-hidden className="size-7" />
          </span>
          <p className="text-[18px] font-extrabold text-foreground">Nos vidéos arrivent bientôt</p>
          <p className="max-w-md text-sm text-muted-foreground">
            En attendant, suivez-nous sur nos réseaux pour ne rien manquer de nos unboxings, tests
            et nouveautés.
          </p>
        </div>
      ) : (
        <>
          {/* Filters: platform + topic */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <FilterChip active={plat === "all"} onClick={() => setPlat("all")}>
                Toutes les plateformes
              </FilterChip>
              {PLATFORMS.filter((p) => videos.some((v) => v.platform === p)).map((p) => (
                <FilterChip key={p} active={plat === p} onClick={() => setPlat(p)}>
                  {REEL_PLATFORM_LABELS[p]}
                </FilterChip>
              ))}
            </div>
            {topics.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <FilterChip active={topic === "all"} onClick={() => setTopic("all")} subtle>
                  Tous les sujets
                </FilterChip>
                {topics.map((t) => (
                  <FilterChip key={t} active={topic === t} onClick={() => setTopic(t)} subtle>
                    {t}
                  </FilterChip>
                ))}
              </div>
            )}
          </div>

          {/* Grid */}
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Aucune vidéo pour ce filtre.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((v) => {
                const Icon = PLAT_ICON[v.platform];
                return (
                  <li
                    key={v.id}
                    className="flex flex-col overflow-hidden rounded-[24px] border border-border bg-card shadow-island"
                  >
                    <a
                      href={v.videoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative block aspect-[4/5] overflow-hidden bg-muted"
                    >
                      {v.posterUrl ? (
                        <Image
                          src={v.posterUrl}
                          alt={v.title}
                          fill
                          sizes="(max-width:640px) 100vw, (max-width:1024px) 50vw, 33vw"
                          className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                        />
                      ) : (
                        <span className="grid h-full place-items-center text-muted-foreground">
                          <Video aria-hidden className="size-10" />
                        </span>
                      )}
                      <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-foreground/80 px-2.5 py-1 text-[12px] font-bold text-background backdrop-blur">
                        <Icon aria-hidden className="size-3.5" />
                        {REEL_PLATFORM_LABELS[v.platform]}
                      </span>
                      <span className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[12px] font-bold text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100">
                        Voir sur {REEL_PLATFORM_LABELS[v.platform]}
                        <ExternalLink aria-hidden className="size-3.5" />
                      </span>
                    </a>
                    <div className="flex flex-1 flex-col gap-3 p-4">
                      <div>
                        <span className="text-[12px] font-bold uppercase tracking-wide text-primary">
                          {v.topic}
                        </span>
                        <h2 className="mt-1 text-[15px] font-extrabold leading-snug text-foreground">
                          {v.title || "Vidéo"}
                        </h2>
                      </div>
                      {v.products.length > 0 && (
                        <ul className="mt-auto flex flex-col gap-2">
                          {v.products.map((p) => (
                            <li
                              key={p.slug}
                              className="flex items-center gap-3 rounded-2xl bg-muted p-2"
                            >
                              <span className="relative size-11 shrink-0 overflow-hidden rounded-xl bg-card">
                                {p.image && (
                                  <Image
                                    src={p.image}
                                    alt={p.title}
                                    fill
                                    sizes="44px"
                                    className="object-contain"
                                  />
                                )}
                              </span>
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[13px] font-bold text-foreground">
                                  {p.title}
                                </span>
                                <span className="text-[13px] font-extrabold text-primary">
                                  {fmtPrice(p.price)}
                                </span>
                              </span>
                              <button
                                type="button"
                                onClick={() => add(p.slug)}
                                aria-label={`Ajouter ${p.title} au panier`}
                                className={cn(
                                  "grid size-9 shrink-0 place-items-center rounded-full text-white transition-colors",
                                  added[p.slug] ? "bg-success" : "bg-primary hover:brightness-95",
                                )}
                              >
                                {added[p.slug] ? (
                                  <Check aria-hidden className="size-4" strokeWidth={2.6} />
                                ) : (
                                  <Plus aria-hidden className="size-4" strokeWidth={2.6} />
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function FilterChip({
  active,
  subtle,
  onClick,
  children,
}: {
  active: boolean;
  subtle?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-10 rounded-full border-[1.5px] px-4 text-sm font-bold transition-colors",
        active
          ? subtle
            ? "border-foreground bg-foreground text-background"
            : "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-foreground hover:border-primary/40",
      )}
    >
      {children}
    </button>
  );
}
