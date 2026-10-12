import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asBool, asStr } from "@/lib/cms/setting-coerce";
import { HOME_DEFAULTS } from "./home-config-defaults";

/**
 * Typed, admin-controllable config for the storefront HOME page. Modeled on
 * `collection-page-config.ts`: read namespaced `home.*` keys from
 * `site_settings`, fall back to sensible defaults, return a plain object the
 * home client renders from. This is the single source consolidating the rail
 * titles + the luxury editorial blocks (fiftyfifty / appointment /
 * complications / heritage) that used to be hardcoded strings.
 *
 * Visibility toggles default to TRUE (so an un-configured site renders the
 * full home page). Content fields that are decorative default to "" and the
 * client hides them; the rail titles keep functional defaults so a shown rail
 * is never title-less.
 */

export type HomeRailConfig = { visible: boolean; label: string; title: string; subtitle: string };

/** A single light "FiftyFiftySection" card (image stored as a media-id). */
export type HomeFiftyCardConfig = {
  label: string;
  title: string;
  desc: string;
  imageMediaId: string;
  href: string;
};
/** A single dark "OneThirdTwoThirdsSection" complication card. */
export type HomeComplicationCardConfig = {
  tag: string;
  title: string;
  desc: string;
  price: string;
  imageMediaId: string;
  href: string;
};
/** Shared shape for the editorial 50/50 block (heritage). */
export type HomeEditorialConfig = {
  visible: boolean;
  eyebrow: string;
  titleLine1: string;
  titleLine2: string;
  titleLine3: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
  imageMediaId: string;
};

export type HomePageConfig = {
  hero: { visible: boolean };
  rails: {
    newArrivals: HomeRailConfig;
    promotions: HomeRailConfig;
  };
  /** Block 3 — two light cards (Powermatic Rosé / Le Locle Vert). */
  fiftyfifty: {
    visible: boolean;
    cards: HomeFiftyCardConfig[];
  };
  /** Block 4 — image banner + dark "Prenez Rendez-vous" text bar. */
  appointment: {
    visible: boolean;
    eyebrow: string;
    title: string;
    titleAccent: string;
    description: string;
    imageMediaId: string;
    href: string;
  };
  /** Block 5 — "Complications Exceptionnelles" two dark cards. */
  complications: {
    visible: boolean;
    label: string;
    title: string;
    titleAccent: string;
    cards: HomeComplicationCardConfig[];
  };
  /** Block 7 — "Un Héritage d'Excellence" 50/50 (text left / image right). */
  heritage: HomeEditorialConfig;
};

export async function getHomePageConfig(): Promise<HomePageConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // settings table unavailable — defaults below keep the home page working
  }
  const k = (key: string) => s[key];

  return {
    hero: { visible: asBool(k("home.hero.visible"), true) },
    rails: {
      newArrivals: {
        visible: asBool(k("home.rail.new.visible"), true),
        label: asStr(k("home.rail.new.label"), HOME_DEFAULTS.rails.new.label),
        title: asStr(k("home.rail.new.title"), HOME_DEFAULTS.rails.new.title),
        subtitle: asStr(k("home.rail.new.subtitle"), ""),
      },
      promotions: {
        visible: asBool(k("home.rail.promotions.visible"), true),
        label: asStr(k("home.rail.promotions.label"), HOME_DEFAULTS.rails.promotions.label),
        title: asStr(k("home.rail.promotions.title"), HOME_DEFAULTS.rails.promotions.title),
        subtitle: asStr(k("home.rail.promotions.subtitle"), ""),
      },
    },
    fiftyfifty: {
      visible: asBool(k("home.fiftyfifty.visible"), true),
      // Two cards. All copy blank by default (the client hides a card whose
      // image+title are empty); href falls back so a shown card always links.
      cards: [
        {
          label: asStr(k("home.fiftyfifty.card1.label"), ""),
          title: asStr(k("home.fiftyfifty.card1.title"), ""),
          desc: asStr(k("home.fiftyfifty.card1.desc"), ""),
          imageMediaId: asStr(k("home.fiftyfifty.card1.image_media_id"), ""),
          href: asStr(k("home.fiftyfifty.card1.href"), HOME_DEFAULTS.fiftyfifty.href),
        },
        {
          label: asStr(k("home.fiftyfifty.card2.label"), ""),
          title: asStr(k("home.fiftyfifty.card2.title"), ""),
          desc: asStr(k("home.fiftyfifty.card2.desc"), ""),
          imageMediaId: asStr(k("home.fiftyfifty.card2.image_media_id"), ""),
          href: asStr(k("home.fiftyfifty.card2.href"), HOME_DEFAULTS.fiftyfifty.href),
        },
      ],
    },
    appointment: {
      visible: asBool(k("home.appointment.visible"), true),
      eyebrow: asStr(k("home.appointment.eyebrow"), ""),
      title: asStr(k("home.appointment.title"), ""),
      titleAccent: asStr(k("home.appointment.title_accent"), ""),
      description: asStr(k("home.appointment.description"), ""),
      imageMediaId: asStr(k("home.appointment.image_media_id"), ""),
      href: asStr(k("home.appointment.href"), HOME_DEFAULTS.appointment.href),
    },
    complications: {
      visible: asBool(k("home.complications.visible"), true),
      label: asStr(k("home.complications.label"), ""),
      title: asStr(k("home.complications.title"), ""),
      titleAccent: asStr(k("home.complications.title_accent"), ""),
      cards: [
        {
          tag: asStr(k("home.complications.card1.tag"), ""),
          title: asStr(k("home.complications.card1.title"), ""),
          desc: asStr(k("home.complications.card1.desc"), ""),
          price: asStr(k("home.complications.card1.price"), ""),
          imageMediaId: asStr(k("home.complications.card1.image_media_id"), ""),
          href: asStr(k("home.complications.card1.href"), HOME_DEFAULTS.complications.href),
        },
        {
          tag: asStr(k("home.complications.card2.tag"), ""),
          title: asStr(k("home.complications.card2.title"), ""),
          desc: asStr(k("home.complications.card2.desc"), ""),
          price: asStr(k("home.complications.card2.price"), ""),
          imageMediaId: asStr(k("home.complications.card2.image_media_id"), ""),
          href: asStr(k("home.complications.card2.href"), HOME_DEFAULTS.complications.href),
        },
      ],
    },
    heritage: {
      // Editorial block — all copy blank by default (hidden until configured).
      visible: asBool(k("home.heritage.visible"), true),
      eyebrow: asStr(k("home.heritage.eyebrow"), ""),
      titleLine1: asStr(k("home.heritage.title_line1"), ""),
      titleLine2: asStr(k("home.heritage.title_line2"), ""),
      titleLine3: asStr(k("home.heritage.title_line3"), ""),
      description: asStr(k("home.heritage.description"), ""),
      ctaLabel: asStr(k("home.heritage.cta_label"), ""),
      ctaHref: asStr(k("home.heritage.cta_href"), HOME_DEFAULTS.heritage.ctaHref),
      imageMediaId: asStr(k("home.heritage.image_media_id"), ""),
    },
  };
}
