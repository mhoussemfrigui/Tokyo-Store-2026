/**
 * Security headers + Content-Security-Policy — the SINGLE source of truth.
 *
 * `next.config.ts` applies these to every response via its `headers()` hook,
 * and the admin Security diagnostics tab imports the SAME functions to display
 * the live policy — so what's shown can never drift from what's served.
 *
 * Pure module: only reads `process.env` and builds strings (no `server-only`,
 * no DB, no React), so it's safe to import from next.config (build/boot) AND
 * from a server component (request time).
 */

export type HeaderEntry = { key: string; value: string };

/** Static security headers (everything except the dynamic CSP). */
export const SECURITY_HEADERS: HeaderEntry[] = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

/**
 * Build a strict Content-Security-Policy from env + known hosts. The object-store
 * host (`S3_PUBLIC_URL`) AND any external CDN host(s) (`MEDIA_CDN_URL`, the same
 * env next.config uses for images.remotePatterns) are interpolated into img-src
 * so media served through a real CDN isn't CSP-blocked. YouTube embeds and the
 * Google Maps embed (the /help showroom map) are allowed in the frame-src.
 *
 * `'unsafe-inline'` on script-src is intentional for Next.js's RSC stream
 * payload (inline scripts that hydrate the document); production hardening
 * would migrate to a per-request nonce via the proxy.
 */
export function buildCsp(): string {
  const mediaHost = (() => {
    try {
      const u = new URL(process.env.S3_PUBLIC_URL ?? "http://localhost:8333/tokyo");
      return `${u.protocol}//${u.host}`;
    } catch {
      return "";
    }
  })();

  // 'unsafe-eval' is only needed by the dev HMR runtime; keep it OUT of the
  // production CSP. 'unsafe-inline' must stay for Next's RSC hydration inline
  // scripts (a per-request nonce via the proxy is the eventual hardening).
  const scriptSrc =
    process.env.NODE_ENV === "production"
      ? ["'self'", "'unsafe-inline'"]
      : ["'self'", "'unsafe-inline'", "'unsafe-eval'"];

  // Consent-gated analytics/marketing tags (GTM, GA4, Meta Pixel) load from
  // these hosts. They MUST be allow-listed or the browser blocks every tag
  // even after the visitor consents (the tags load via Consent Mode v2 — see
  // src/components/tracking/tracking-scripts.tsx + custom-tracking-html.tsx).
  // Listing a host here is PERMISSION, not activation.
  // Google Ads / DoubleClick — conversion tracking + remarketing. Separate from
  // the analytics hosts above: a GA4/GTM setup that enables a Google Ads
  // conversion or remarketing tag (or advanced Consent Mode once ad_storage is
  // granted) pings THESE hosts. Omitting them makes Ads conversions + audiences
  // SILENTLY under-report (the pings are CSP-blocked) while GA4 looks fine.
  // googleadservices serves the conversion-linker script, so it's also in script.
  const adsHosts = [
    "https://www.googleadservices.com",
    "https://googleads.g.doubleclick.net",
    "https://*.g.doubleclick.net",
    "https://pagead2.googlesyndication.com",
    "https://www.google.com",
  ];
  const analyticsScript = [
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
    "https://connect.facebook.net",
    "https://www.googleadservices.com",
  ];
  const analyticsConnect = [
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://connect.facebook.net",
    "https://www.facebook.com",
    ...adsHosts,
  ];
  const analyticsImg = [
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
    "https://*.google-analytics.com",
    "https://www.facebook.com",
    ...adsHosts,
  ];

  // Common custom-tag vendors named in the Suivi & Analytics "Code personnalisé"
  // tab — allow-listed (script + connect + img) so a pasted TikTok / Hotjar /
  // Clarity / LinkedIn snippet isn't SILENTLY CSP-blocked. Any OTHER vendor host
  // goes in CSP_EXTRA_HOSTS (below).
  const customVendorHosts = [
    "https://analytics.tiktok.com",
    "https://*.hotjar.com",
    "https://*.hotjar.io",
    "https://*.clarity.ms",
    "https://snap.licdn.com",
    "https://px.ads.linkedin.com",
  ];
  // Operator escape hatch for any other custom-tag host. buildCsp() runs at
  // build/boot in next.config (no DB), so this is an env var like MEDIA_CDN_URL.
  // Comma-separated origins or bare hosts → normalized to scheme+host.
  const extraHosts = (process.env.CSP_EXTRA_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      try {
        const u = new URL(h.includes("://") ? h : `https://${h}`);
        return `${u.protocol}//${u.host}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const customTag = [...customVendorHosts, ...extraHosts];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [...scriptSrc, ...analyticsScript, ...customTag],
    "style-src": ["'self'", "'unsafe-inline'"], // styled-jsx + Tailwind dev
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      "https://*.youtube.com",
      "https://i.ytimg.com",
      ...analyticsImg,
      ...customTag,
    ],
    // <video>/<audio> element loads are governed by media-src (NOT img-src or
    // connect-src). Without it they fall back to default-src 'self', which blocks
    // an admin-set hosted video (`products.video_url` and the home-hero banner
    // `video_url` → raw <video src>) living on the S3 / CDN media host. The media
    // hosts are appended below; `customTag` (CSP_EXTRA_HOSTS) is the operator
    // escape hatch for a hero video served from a third-party CDN that is neither
    // the S3 host nor a MEDIA_CDN_URL host (already trusted for img/script/connect).
    "media-src": ["'self'", "blob:", ...customTag],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...analyticsConnect, ...customTag],
    "frame-src": [
      "https://www.youtube.com",
      "https://www.youtube-nocookie.com",
      "https://www.googletagmanager.com",
      // Google Maps embed — the store-locator page block's per-store map
      // (`mapEmbedUrl`, validated on write by `isGoogleMapsEmbedUrl` to an https
      // Google Maps EMBED URL only). maps.google covers the legacy
      // `/maps?…&output=embed` form.
      "https://www.google.com",
      "https://maps.google.com",
    ],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
    "upgrade-insecure-requests": [],
  };

  if (mediaHost) {
    directives["img-src"].push(mediaHost);
    directives["connect-src"].push(mediaHost);
    directives["media-src"].push(mediaHost);
  }

  // External CDN host(s) — admin may set media_settings.cdn_base_url to one of
  // these; it must also be in MEDIA_CDN_URL (next/image remotePatterns) AND here
  // (CSP) or the browser blocks the image. Comma-separated, matches next.config.
  for (const entry of (process.env.MEDIA_CDN_URL ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      const origin = `${u.protocol}//${u.host}`;
      directives["img-src"].push(origin);
      directives["connect-src"].push(origin);
      directives["media-src"].push(origin);
    } catch {
      /* ignore a malformed MEDIA_CDN_URL entry */
    }
  }

  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
}

/** Full header set applied to `/(.*)` — static headers + the dynamic CSP. */
export function buildSecurityHeaders(): HeaderEntry[] {
  return [
    ...SECURITY_HEADERS,
    { key: "Content-Security-Policy", value: buildCsp() },
  ];
}
