import Link from "next/link";
import { MapPin, Phone } from "lucide-react";

import { MaintenanceCountdown } from "@/components/maintenance-countdown";
import { TokyoFace } from "@/components/tokyo-face";
import { PLATFORM_BG, PLATFORM_META } from "@/components/social-icons";
import type { SocialLink } from "@/lib/cms/social-list";
import type { SiteModeConfig } from "@/lib/site-mode/parse";

/** Backend-driven identity + contacts for the gated scene, passed by the
 *  `(shop)` layout. Every field optional → each section hides when unset (never a
 *  hardcoded placeholder). */
export type MaintenanceSceneData = {
  logoUrl?: string | null;
  /** Footer-flagged boutiques (« Identité & contact ») — the maintenance stores row. */
  stores?: string[];
  phone?: string | null;
  whatsapp?: string | null;
  /** Social links (« Identité & contact » → social.links) — the « suivez-nous » row. */
  socials?: SocialLink[];
};

/** Digits-only (for a wa.me link / tel: href) from a raw phone/WhatsApp string. */
function digits(v: string): string {
  return v.replace(/\D/g, "");
}

/**
 * Full-page "site unavailable" scene shown to the public when the store is in
 * `maintenance` or `coming_soon` mode (the `(shop)` layout's hard gate). The
 * crimson Tokyo system, matching the 404 scene: a white card on the beige canvas.
 *
 *   • coming_soon — a « Bientôt disponible » badge, the headline, an optional live
 *     countdown to the launch date, and the real social accounts to follow.
 *   • maintenance — a « Maintenance en cours » badge, the mascot face with a wrench,
 *     the headline, an optional "back online in…" countdown, the boutiques that stay
 *     open, and WhatsApp / phone shortcuts.
 *
 * Everything is backend-driven — copy + countdown from the site-mode settings,
 * stores + phone + WhatsApp from « Identité & contact », socials from the
 * storefront's accounts. Nothing is invented: a section with no data hides.
 * Emits `noindex` (React 19 hoists it to <head>) so a temporary state is never
 * indexed as the site's content.
 */
export function MaintenanceScene({
  config,
  data = {},
}: {
  config: SiteModeConfig;
  data?: MaintenanceSceneData;
}) {
  const comingSoon = config.mode === "coming_soon";
  const logoSrc = data.logoUrl?.trim() || "/tokyo-logo.png";
  const showCountdown = config.showCountdown && !!config.launchAt;
  const stores = (data.stores ?? []).filter((s) => s.trim());
  const wa = data.whatsapp ? digits(data.whatsapp) : "";
  const tel = data.phone ? data.phone.trim() : "";
  // tel: href keeps a single leading "+" so an E.164 international number
  // (e.g. "+216 50 059 160") dials correctly; wa.me takes digits only.
  const telHref = tel ? (tel.startsWith("+") ? `+${digits(tel)}` : digits(tel)) : "";

  return (
    <main className="tokyo flex min-h-[100dvh] box-border bg-[#f6f2ed] p-3 font-sans text-[#0e1218]">
      <meta name="robots" content="noindex,nofollow" />
      <div className="relative flex flex-1 flex-col items-center justify-center gap-[clamp(22px,3vw,32px)] overflow-hidden rounded-[36px] bg-white px-[clamp(18px,4vw,56px)] pt-[clamp(84px,9vw,96px)] pb-[clamp(28px,4vw,48px)] text-center">
        {/* Logo, top-left. */}
        <Link href="/" aria-label="Tokyo Store" className="absolute left-[clamp(16px,3vw,32px)] top-[clamp(16px,3vw,32px)] flex">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} alt="" width={44} height={44} className="h-11 w-11 rounded-full object-cover" />
        </Link>

        {/* Status badge. */}
        {comingSoon ? (
          <span className="inline-flex h-[34px] items-center gap-2 rounded-full bg-[#f9dde2] px-3.5 text-[13px] font-extrabold tracking-[.06em] text-[#b80329]">
            <span className="h-2 w-2 rounded-full bg-[#d40530] shadow-[0_0_0_4px_#d4053033]" />
            Bientôt disponible
          </span>
        ) : (
          <span className="inline-flex h-[34px] items-center gap-2 rounded-full bg-[#fff7e6] px-3.5 text-[13px] font-extrabold tracking-[.06em] text-[#9a6410]">
            <span className="h-2 w-2 rounded-full bg-[#d99a1e] shadow-[0_0_0_4px_#d99a1e33]" />
            Maintenance en cours
          </span>
        )}

        {/* Maintenance only: the mascot face with a wrench badge. */}
        {!comingSoon && (
          <TokyoFace badge="wrench" className="h-[clamp(150px,22vw,250px)] w-[clamp(150px,22vw,250px)]" />
        )}

        {/* Copy. */}
        <div className="flex flex-col items-center gap-3">
          <h1 className="m-0 text-[clamp(34px,5vw,68px)] font-black leading-none tracking-[-.045em] text-balance">
            {config.title}
          </h1>
          <p className="m-0 max-w-[56ch] text-[17px] leading-[1.6] text-[#3d4046] text-pretty">{config.message}</p>
        </div>

        {/* Live countdown — coming-soon: time to launch; maintenance: time to reopen.
            The maintenance label lives inside the countdown so it never orphans. */}
        {showCountdown && config.launchAt && (
          <MaintenanceCountdown
            targetIso={config.launchAt}
            label={comingSoon ? undefined : "Retour en ligne dans"}
          />
        )}

        {/* Maintenance: the boutiques that stay open. */}
        {!comingSoon && stores.length > 0 && (
          <div className="flex flex-col items-center gap-3">
            <span className="text-[12px] font-extrabold uppercase tracking-[.14em] text-[#5b5d62]">
              Nos boutiques restent ouvertes
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              {stores.map((s) => (
                <span key={s} className="flex h-11 items-center gap-2 rounded-full bg-[#f6f2ed] px-4 text-[14px] font-bold">
                  <MapPin className="h-[15px] w-[15px] shrink-0 text-[#d40530]" strokeWidth={2.2} aria-hidden />
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Maintenance: WhatsApp / phone shortcuts. */}
        {!comingSoon && (wa || tel) && (
          <div className="flex flex-wrap justify-center gap-2.5">
            {wa && (
              <a
                href={`https://wa.me/${wa}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-[52px] items-center gap-2.5 rounded-full bg-[#d40530] px-6 text-[15px] font-bold text-white transition hover:brightness-[.92]"
              >
                Commander sur WhatsApp
              </a>
            )}
            {tel && (
              <a
                href={`tel:${telHref}`}
                className="inline-flex h-[52px] items-center gap-2.5 rounded-full bg-[#0e1218] px-[22px] text-[15px] font-bold text-white transition-colors hover:bg-[#2a2e35]"
              >
                <Phone className="h-4 w-4 shrink-0" strokeWidth={2.2} aria-hidden />
                {tel}
              </a>
            )}
          </div>
        )}

        {/* Coming soon: the real social accounts to follow (« Identité & contact »
            → social.links; no invented counts). */}
        {comingSoon && (data?.socials ?? []).length > 0 && (
          <div className="flex flex-col items-center gap-3 pt-1.5">
            <span className="text-[12px] font-extrabold uppercase tracking-[.14em] text-[#5b5d62]">
              En attendant, suivez-nous
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              {(data?.socials ?? []).map((s, i) => {
                const { name, Icon } = PLATFORM_META[s.platform];
                const caption = s.label?.trim() || name;
                return (
                  <a
                    key={`${s.platform}-${i}`}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-[52px] items-center gap-2.5 rounded-full border-[1.5px] border-[#e6dfd7] bg-white py-0 pl-1.5 pr-4 transition-colors hover:border-[#0e1218]"
                  >
                    <span
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white"
                      style={{ background: PLATFORM_BG[s.platform] }}
                    >
                      <Icon className="h-[18px] w-[18px]" aria-hidden />
                    </span>
                    <span className="text-[15px] font-black leading-[1.15]">{caption}</span>
                  </a>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
