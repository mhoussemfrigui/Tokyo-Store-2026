"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

import { useConsent } from "@/components/consent/consent-provider";
import type { ClientTrackingConfig } from "@/lib/tracking/config";
import {
  isSensitiveTrackedUrl,
  isTagFreePath,
  redactTrackedUrl,
} from "@/lib/tracking/redact-url";

/**
 * Bearer-URL scrubbing for the inline snippets below (see redact-url.ts). The
 * snippets run LATER — in next/script's afterInteractive effect, i.e. after a
 * client navigation has already committed the new URL — so they resolve
 * `page_location` / the Meta PageView decision at EXECUTION time through this
 * global, not from a (possibly stale) render-time `location`. Set at module
 * evaluation, which always precedes any snippet this module renders; a snippet
 * that somehow can't find it degrades to the bare origin / no PageView.
 */
if (typeof window !== "undefined") {
  (window as Window & { __GZ_TRACK_URL__?: unknown }).__GZ_TRACK_URL__ = {
    redact: redactTrackedUrl,
    isSensitive: isSensitiveTrackedUrl,
  };
}

/** Inline-snippet expression: the scrubbed current URL for `page_location`. */
const PAGE_LOCATION_JS =
  "(window.__GZ_TRACK_URL__?window.__GZ_TRACK_URL__.redact(location.href):location.origin+'/')";

/**
 * Loads the third-party tags (GTM / GA4 / Meta Pixel) configured in the admin
 * Suivi & Analytics tab. Three strategies (Google's own terminology):
 *
 *  - "advanced" (default): tags load immediately in a consent-DENIED state — the
 *    default-consent stub already ran in the layout (consent-mode.ts), so Google
 *    can send cookieless pings / model conversions; full collection after the
 *    visitor grants. <ConsentModeSync> pushes the consent updates.
 *  - "basic": a tag only mounts AFTER its consent category is granted (prior
 *    blocking — nothing third-party loads pre-consent).
 *  - "off": no Consent Mode — tags load immediately and collect normally (no
 *    Google consent signalling). The Meta Pixel keeps its OWN consent model even
 *    here, so the banner still gates Meta. (Bypass / banner-disabled make
 *    `isAllowed` return true anyway, so tags load + collect under those too.)
 *
 * IDs are re-sanitised here (defence in depth) before being interpolated into
 * the inline snippets. When nothing is configured, nothing loads.
 *
 * Bearer URLs: NOTHING loads on the token-landing routes (TAG_FREE_PATHS —
 * reset / invite / verify links, B2B join, unsubscribe). Elsewhere GA4 gets a
 * scrubbed `page_location` at the GLOBAL `set` scope (never config scope: a
 * config-scoped value outranks `set` and would pin every later event to the
 * landing URL — <PageLocationSync> re-`set`s it on client navigations), GTM
 * finds it pushed to the dataLayer before gtm.js (and a `gz_page_location`
 * event per path from <PageLocationSync> — fire the GA4 page_view on that event
 * with page_location = the `page_location` Data Layer Variable, event-scoped),
 * and the Meta Pixel — which always reports the real URL — has its automatic
 * pushState PageView disabled (<PageLocationSync> sends PageViews itself and
 * skips the bearer URLs: order / receipt / join…) and, when it initialises ON a
 * bearer URL, its autoConfig (automatic button-click / microdata events) off.
 */
const cleanId = (v: string | null): string => (v ? v.replace(/[^A-Za-z0-9_-]/g, "") : "");

export function TrackingScripts({ config }: { config: ClientTrackingConfig }) {
  const consent = useConsent();
  const pathname = usePathname();
  if (!config.enabled) return null;
  // Token-landing route — load no third-party tag at all (a tag loaded on an
  // earlier page can't be unloaded; PageLocationSync scrubs what it reports).
  if (isTagFreePath(pathname)) return null;

  // advanced + off load Google tags immediately; basic waits for the grant.
  // Under bypass / banner-disabled the provider makes isAllowed() true, so even
  // "basic" loads.
  const loadAlways = config.mode === "advanced" || config.mode === "off";
  const analyticsOk = loadAlways || (consent?.isAllowed("analytics") ?? false);
  const marketingGranted = consent?.isAllowed("marketing") ?? false;

  const gtmId = cleanId(config.gtmId);
  const gaId = cleanId(config.ga4Id);
  const pixelId = cleanId(config.metaPixelId);

  // Meta Pixel has its OWN consent model (it ignores Google Consent Mode), so we
  // bake the current marketing decision into init and let <ConsentModeSync>
  // flip it on later changes. It loads when consent is allowed OR tags load
  // pre-consent (advanced/off); init carries grant/revoke from the marketing
  // decision so it stays compliant even under "off".
  const showPixel = (loadAlways || marketingGranted) && pixelId;
  const pixelConsent = marketingGranted ? "grant" : "revoke";

  return (
    <>
      {analyticsOk && gtmId && (
        <Script id="tk-gtm" strategy="afterInteractive">
          {`window.dataLayer=window.dataLayer||[];window.dataLayer.push({page_location:${PAGE_LOCATION_JS}});(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtmId}');`}
        </Script>
      )}

      {/* Direct GA4 ONLY when there's no GTM container — configure GA4 inside GTM
          when a container id is set, otherwise hits are double-counted. */}
      {analyticsOk && gaId && !gtmId && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
            strategy="afterInteractive"
          />
          <Script id="tk-ga4" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('set',{page_location:${PAGE_LOCATION_JS}});gtag('js',new Date());gtag('config','${gaId}');`}
          </Script>
        </>
      )}

      {/* disablePushState: no automatic PageView on client navigations (it would
          report /order/<uuid> after checkout) — PageLocationSync sends them,
          keyed on `__GZ_META_PV__` (the last path a PageView was decided for).
          On a bearer landing (email link / QR / PSP return to /order/<uuid>…)
          autoConfig goes off BEFORE init — its automatic button-click / microdata
          hits carry the raw URL (`dl`) — and the init PageView is skipped. A
          missing helper counts as sensitive (fail-private). */}
      {showPixel && (
        <Script id="tk-meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq.disablePushState=true;fbq('consent','${pixelConsent}');(function(w){var u=w.__GZ_TRACK_URL__,s=!u||u.isSensitive(w.location.href);if(s)fbq('set','autoConfig',false,'${pixelId}');fbq('init','${pixelId}');w.__GZ_META_PV__=w.location.pathname;if(!s)fbq('track','PageView');})(window);`}
        </Script>
      )}
    </>
  );
}
