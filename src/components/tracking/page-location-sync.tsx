"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { isSensitiveTrackedUrl, redactTrackedUrl } from "@/lib/tracking/redact-url";

/**
 * Keeps the third-party tags' notion of "the current page" scrubbed across
 * client navigations (the App Router never reloads the document, so the tags
 * <TrackingScripts> loaded on the landing page keep running):
 *  - Google: `gtag('set', { page_location })` (the global scope the GA4 snippet
 *    uses, so later auto-events follow the navigation) + a `gz_page_location`
 *    dataLayer EVENT carrying it, with the bearer segments / token params
 *    removed — `/order/<uuid>` reports `/order/:id`. The event key matters: a
 *    GTM History Change trigger fires inside pushState, BEFORE this effect, so
 *    it would read the previous page's value — fire the GTM GA4 page_view on
 *    the custom event `gz_page_location` instead (once per path, landing
 *    included), with page_location = the `page_location` Data Layer Variable.
 *  - Meta Pixel: its automatic pushState PageView is disabled at init (it always
 *    reports the real URL), so the PageView is sent here — once per path, and
 *    NOT on a bearer URL (order / receipt / join / token routes). Only drives a
 *    pixel our snippet initialised (`__GZ_META_PV__` set), never an owner's
 *    custom-snippet pixel, so nothing is double-counted.
 *
 * Best-effort, defence in depth: a GA4 enhanced-measurement / GTM history-change
 * hit fires synchronously inside pushState, before this effect runs. Renders
 * nothing. Mount once next to <ConsentModeSync>.
 */
export function PageLocationSync({ enabled }: { enabled: boolean }) {
  const pathname = usePathname();

  useEffect(() => {
    if (!enabled) return;
    const w = window as Window & {
      gtag?: (...args: unknown[]) => void;
      fbq?: (...args: unknown[]) => void;
      __GZ_META_PV__?: string;
    };
    const href = w.location.href;
    const pageLocation = redactTrackedUrl(href);

    w.dataLayer = w.dataLayer ?? [];
    w.dataLayer.push({ event: "gz_page_location", page_location: pageLocation });
    if (typeof w.gtag === "function") w.gtag("set", { page_location: pageLocation });

    // The pixel snippet decides the landing path's PageView itself and records
    // it in `__GZ_META_PV__`; this only covers paths reached afterwards.
    const path = w.location.pathname;
    if (typeof w.fbq === "function" && w.__GZ_META_PV__ !== undefined && w.__GZ_META_PV__ !== path) {
      w.__GZ_META_PV__ = path;
      if (!isSensitiveTrackedUrl(href)) w.fbq("track", "PageView");
    }
  }, [enabled, pathname]);

  return null;
}
