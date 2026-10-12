"use client";

import { Gamepad2, Phone, Timer } from "lucide-react";
import { AccessoryCarousel } from "@/storefront/components/storefront/accessory-carousel";
import { PromoBar } from "@/storefront/components/storefront/promo-bar";
import { GamingTabs } from "@/storefront/components/storefront/gaming-tabs";
import { GiftCardTabs } from "@/storefront/components/storefront/gift-card-tabs";
import { IphoneTabs } from "@/storefront/components/storefront/iphone-tabs";
import { TelephonieTabs } from "@/storefront/components/storefront/telephonie-tabs";
import { btn } from "@/storefront/components/storefront/ui-classes";
import { useSiteContacts, telHref } from "@/storefront/lib/site-contacts";
import { cn } from "@/storefront/lib/utils";

export function HomeExtras() {
  // The shop's line, from backend settings, until booking/quote pages exist.
  const { phone: sitePhone } = useSiteContacts();
  const shopTel = telHref(sitePhone);
  return (
    <section className="pt-14 sm:pt-16 lg:pt-20">
      <div className="page-container space-y-14 sm:space-y-16 lg:space-y-20">
        {/* Bons plans banner + the new iPhone line-up, tabbed by generation.
            A promo bar heads its shelf at the heading gap (20 / 24 / 32), not
            the section gap. */}
        <div className="space-y-5 sm:space-y-6 lg:space-y-8">
          <PromoBar
            href="/bons-plans"
            label="BONS PLANS"
            copy="Jusqu'à -30% sur iPhone, Gaming & Audio"
            meta="02j : 14h : 32m"
            metaIcon={Timer}
          />

          <IphoneTabs variant="neufs" />
        </div>

        {/* Accessories rail, then the second-hand line-up */}
        <AccessoryCarousel />

        <IphoneTabs variant="occasion" />

        {/* Editorial dark banner. It pads like the newsletter island, its
            full-width sibling: the pill's inset horizontally (16 / lg:20), so
            the text lands on the logo line with the promo bars and the
            Journal tiles (28 + 1 + 16 = 45 at md, 49 at lg; the white/10
            hairline, as on the footer's ink island, is the 1px the bordered
            islands have), and banner air vertically. */}
        <div className="relative flex flex-col gap-8 overflow-hidden rounded-island border border-white/10 bg-foreground px-4 py-10 text-background shadow-island sm:py-12 md:flex-row md:items-center md:justify-between md:gap-10 lg:px-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-primary/30 blur-3xl"
          />
          <div className="relative max-w-xl">
            <p className="eyebrow text-background/70">Tokyo Repair</p>
            <h2 className="title-section mt-2">Réparation tous appareils.</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-background/70 sm:mt-4">
              iPhone, iPad, Mac, Samsung, consoles &amp; plus — pris en charge en boutique.
            </p>
          </div>
          {/* Both 48px: the outline one's border is inside its h-12. */}
          <div className="relative flex flex-col gap-3 sm:flex-row md:shrink-0 md:flex-col">
            <a href={shopTel} className={cn(btn.base, btn.lg, btn.primary)}>
              Réserver <Phone aria-hidden className="size-4" />
            </a>
            <a
              href={shopTel}
              className={cn(
                btn.base,
                btn.lg,
                "border border-background/30 text-background hover:bg-background/10",
              )}
            >
              Obtenir un devis
            </a>
          </div>
        </div>

        <TelephonieTabs />

        {/* Gaming universe — the dark tone so it reads as its own world rather
            than a second Bons plans bar; paired with its shelf like Bons plans. */}
        <div className="space-y-5 sm:space-y-6 lg:space-y-8">
          <PromoBar
            href="/console-gaming"
            label="UNIVERS GAMING"
            copy="PS5, Nintendo Switch & Xbox — consoles, jeux & accessoires"
            meta="Le setup complet"
            metaIcon={Gamepad2}
            tone="dark"
            pixels
            size="tall"
          />

          <GamingTabs variant="consoles" />
        </div>

        <GamingTabs variant="jeux" />

        <GiftCardTabs />
      </div>
    </section>
  );
}
