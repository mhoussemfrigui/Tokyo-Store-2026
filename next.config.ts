import type { NextConfig } from "next";

import { buildSecurityHeaders } from "./src/lib/security/headers";
import {
  STALE_TIMES,
  PROXY_CLIENT_MAX_BODY,
  SERVER_ACTION_BODY_LIMIT,
  IMAGE_FORMATS,
  IMAGE_MIN_CACHE_TTL,
  NEXT_OUTPUT,
  NEXT_COMPRESS,
} from "./src/lib/config/next-runtime";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // compress / output / staleTimes / image formats / body cap are sourced from
  // src/lib/config/next-runtime.ts so the admin Performance tab can display the
  // SAME values without drift (mirrors the security-headers single-source).
  compress: NEXT_COMPRESS,

  // Emit a standalone server bundle for Docker (small image, fast boot).
  output: NEXT_OUTPUT,

  // ── Build memory: keep bundling and type-checking as SEPARATE processes
  //    so their peak memory never stacks. By default `next build` type-checks
  //    inside the same process as the bundler, which contributed to the
  //    bundler being OOM-killed on a memory-constrained Coolify VPS.
  //
  //    The Dockerfile runs `tsc --noEmit` as its own layer AFTER the build
  //    (when the generated `next-env.d.ts` + `.next/types` exist), so type
  //    safety is still enforced at deploy time — just not inside the
  //    bundler's address space. Lint is a separate `pnpm lint` step — Next 16
  //    doesn't run ESLint during builds.
  typescript: { ignoreBuildErrors: true },

  // ── Keep jsdom-backed packages OUT of the webpack server bundle.
  //    `isomorphic-dompurify` loads `jsdom` on the server, and jsdom
  //    reads internal assets (e.g. `default-stylesheet.css`) via
  //    `fs.readFileSync(__dirname + …)`. Webpack rewrites `__dirname`,
  //    so the bundled copy can't find those files and page-data
  //    collection dies with `ENOENT: default-stylesheet.css`. Marking it
  //    external makes Next `require()` it from node_modules at runtime
  //    (Next's standalone tracer still copies it into the image), so
  //    jsdom's file paths resolve normally.
  serverExternalPackages: ["isomorphic-dompurify", "jsdom"],

  /**
   * URL restructure — categories and products now live at the top level
   * (`/consoles`, `/playstation-5-slim`) instead of nested under
   * `/category/...` / `/product/...`. Old URLs permanently redirect to the
   * new ones so bookmarks, search-engine index, and external backlinks keep
   * working.
   *
   * The 308 (permanent + method-preserving) is the right semantic — old
   * pages have permanently moved, and we want POSTs (rare here but
   * possible via crawler quirks) to retain their method.
   */
  async redirects() {
    return [
      {
        source: "/category/:slug",
        destination: "/:slug",
        permanent: true,
      },
      {
        source: "/category/:slug/:sub",
        destination: "/:slug/:sub",
        permanent: true,
      },
      {
        source: "/product/:slug",
        destination: "/:slug",
        permanent: true,
      },
      // NOTE: the old `/niveaux-avantages → /fidelite` redirect was removed —
      // the loyalty subsystem was dropped (migration 0204) and `/fidelite`
      // does not exist, so the redirect 308'd straight into a 404.
    ];
  },

  // Security headers — sensible e-commerce defaults.
  // CSP is built from env so object-store host + YouTube embeds are allowed without
  // manual updates per environment. Evaluated at `next build`: production
  // serves the header from routes-manifest.json, so S3_PUBLIC_URL,
  // MEDIA_CDN_URL and CSP_EXTRA_HOSTS must be BUILD ARGUMENTS (Dockerfile) —
  // changing them needs a rebuild, a restart alone does nothing.
  async headers() {
    // Header set (incl. the dynamic CSP) lives in @/lib/security/headers — the
    // SAME source the admin Security tab reads, so the displayed policy can't
    // drift from what's served.
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders(),
      },
    ];
  },

  // Image optimization config.
  // `S3_PUBLIC_URL` (object store / Coolify) is auto-trusted at build time so
  // <Image src> works for uploaded media without manual entries.
  //
  // `dangerouslyAllowLocalIP` is auto-enabled when S3_PUBLIC_URL points at a
  // local hostname (localhost, 127.0.0.1, *.localhost, docker internal
  // names). Next.js 16 blocks loopback / private IPs in the image
  // optimizer by default as an SSRF guard — fine for prod (real CDN
  // domain) but breaks dev/staging where the object store is reachable only on
  // localhost:9100. The flag stays off for any real public domain.
  images: {
    formats: [...IMAGE_FORMATS],
    // Long minimum TTL — product media is content-addressed (hashed keys) so an
    // optimized variant stays valid; avoids needless re-encodes on the small box.
    minimumCacheTTL: IMAGE_MIN_CACHE_TTL,
    remotePatterns: buildRemotePatterns(),
    dangerouslyAllowLocalIP: s3PublicUrlIsLocal(),
  },

  // Canonical public origin, inlined at build time (sitemap, OG tags,
  // email links). Defaults to localhost for local builds.
  env: {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    // Build-time SNAPSHOT of the host allow-list inputs baked into the served
    // CSP (headers() below) and images.remotePatterns — production serves those
    // compiled values, so runtime checks must compare against THESE, not the
    // runtime env (which can drift from the build). Read by
    // src/modules/media/cdn-allowlist.ts (CDN-base gate + the admin media
    // settings warning); BUILD_CSP_EXTRA_HOSTS lets diagnostics show the
    // compiled extra CSP hosts. Public values (they appear in every media URL /
    // the CSP header), so inlining them into client bundles leaks nothing.
    BUILD_S3_PUBLIC_URL: process.env.S3_PUBLIC_URL ?? "",
    BUILD_MEDIA_CDN_URL: process.env.MEDIA_CDN_URL ?? "",
    BUILD_CSP_EXTRA_HOSTS: process.env.CSP_EXTRA_HOSTS ?? "",
  },

  // Cache Components (`cacheComponents: true`) is intentionally OFF.
  //
  // Enabling it would require a coordinated refactor across the codebase:
  //   - every page-level `export const dynamic`, `revalidate`, `runtime` is
  //     rejected;
  //   - every `new Date()` on a server hot path triggers a prerender error
  //     unless the function is `'use cache'`-marked or the page opts into
  //     dynamic data via `cookies()`/`headers()`/`connection()`;
  //   - admin pages that read uncached data without `<Suspense>` boundaries
  //     fail the "uncached data accessed outside Suspense" check.
  //
  // The legacy pattern (`force-dynamic` on DB-driven pages, ISR via
  // `revalidate`, single-arg `revalidateTag`) is still fully supported in
  // Next.js 16 and is what most of the deployment relies on.
  //
  // INCREMENTAL `'use cache'` ADOPTION HAS BEGUN via `experimental.useCache`
  // (below) — WITHOUT the full Cache Components model, so the directives in this
  // comment (force-dynamic, new Date(), no-Suspense admin reads) all still hold.
  // First migrated loader: the blog listing (src/modules/blog/queries.ts
  // `listPublishedPosts`), tagged so the existing invalidate-blog-cache
  // subscriber busts it. Migrate further read-mostly loaders one at a time the
  // same way; only the eventual full Cache Components switch requires the
  // coordinated refactor described above.

  experimental: {
    // Enable the `'use cache'` directive WITHOUT the full Cache Components model
    // (cacheComponents stays OFF — see the long note above; it would reject our
    // `export const dynamic`/`new Date()` patterns). `useCache` ONLY makes the
    // directive available; code without it is unaffected. We adopt it
    // incrementally, one read-mostly loader at a time (first: the blog listing),
    // tagged via `cacheTag` so the existing invalidate-*-cache subscribers'
    // `revalidateTag` calls bust it.
    useCache: true,

    // Reduce peak Webpack heap during `next build` (trades a little build time).
    // Coolify builds on the SAME host already running Postgres + SeaweedFS + the
    // live app, so free RAM at build time is well under the box's nominal size;
    // this keeps the bundler's working set down so it doesn't get OOM-killed.
    // Works WITH the `--max-old-space-size` ceiling set in the Dockerfile.
    webpackMemoryOptimizations: true,

    // Allow image uploads up to 16 MB before Next.js truncates the body.
    // Workflow-level enforcement (`getMaxUploadBytes()` — default 8 MB) is
    // the user-facing limit; this is just the outer ceiling so the route
    // handler gets a chance to return a friendly 413 instead of Next.js
    // throwing during FormData parsing.
    //
    // COUPLING: the admin-configurable `max_upload_mb` setting is capped to
    // this same 16 MB ceiling (MAX_UPLOAD_MB_CEILING in
    // src/modules/media/limits.ts) so an operator can't set an
    // unachievable limit above what Next will accept. If you raise this value,
    // raise that constant to match.
    proxyClientMaxBodySize: PROXY_CLIENT_MAX_BODY,

    // Server Actions have their OWN body limit (Next default: 1 MB), separate
    // from the proxy cap above. The Médiathèque dropzone (`uploadMediaAction`)
    // and the catalogue import (`startProductImportAction`) post files through
    // Server Actions, so without this any photo / feed over 1 MB 413s while the
    // UI advertises 8 MB. SERVER_ACTION_BODY_LIMIT is aliased to the proxy cap
    // (never above it — the proxy truncates past that); the per-feature limits
    // stay the user-facing gates.
    serverActions: {
      bodySizeLimit: SERVER_ACTION_BODY_LIMIT,
    },

    // Tunes how long client-side cached router payloads stay fresh before the
    // app re-requests them. Static (link-prefetched) chunks get 5min; the
    // dynamic data payload re-fetches on focus / after 30 seconds. Strikes
    // the balance between snappy nav and stale content for an admin-edit
    // surface.
    staleTimes: {
      dynamic: STALE_TIMES.dynamic,
      static: STALE_TIMES.static,
    },

    // Hint to the bundler that these packages should be tree-shaken per-import
    // rather than treated as opaque modules. lucide-react ships 1k+ icons; we
    // import 5-30 per page — guarantee only the used ones make it to the
    // client bundle.
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;

/**
 * Build the `images.remotePatterns` list from env so the same code works
 * in dev (localhost SeaweedFS), staging, and prod (Coolify-managed SeaweedFS or
 * external S3) without code changes.
 */
function buildRemotePatterns() {
  type Pattern = NonNullable<NextConfig["images"]>["remotePatterns"];
  const patterns: Pattern = [
    { protocol: "https", hostname: "www.youtube.com" },
    { protocol: "https", hostname: "i.ytimg.com" },
  ];

  // Whitelist the S3 public host (where generated URLs live) AND any
  // CDN host the app serves media through. Both are read from env so the same
  // code works across dev/staging/prod. Without the CDN host here, a media URL
  // pointing at e.g. https://cdn.example.tn/… would 400 through next/image
  // with "hostname not configured".
  //
  // `MEDIA_CDN_URL` is an optional comma-separated list of base URLs
  // (e.g. "https://cdn.tokyostore.tn"). It is the BUILD-TIME source for this
  // whitelist AND the runtime FALLBACK CDN base.
  //
  // PRIMARY runtime CDN base note: the active CDN base is the admin-editable
  // DB field `media_settings.cdn_base_url` (see modules/media/cdn-base.ts),
  // which `MEDIA_CDN_URL` falls back to when empty. This list is compiled at
  // `next build` (the standalone server embeds it) and CANNOT read the DB — so
  // when an admin sets `cdn_base_url` to a NEW host, `MEDIA_CDN_URL` MUST list
  // that same host as a BUILD ARGUMENT and the image be REBUILT (a restart is
  // not enough) for next/image to allow it. Until then cdn-base.ts ignores a
  // base outside the baked list (falls back to the /cdn proxy) and the admin
  // media settings form warns. The DB field wins for URL building; this env
  // list governs next/image host allow-listing.
  const hostSources = [
    process.env.S3_PUBLIC_URL,
    ...(process.env.MEDIA_CDN_URL?.split(",") ?? []),
  ].filter((v): v is string => Boolean(v && v.trim()));

  for (const src of hostSources) {
    try {
      const u = new URL(src.trim());
      patterns!.push({
        protocol: u.protocol.replace(":", "") as "http" | "https",
        hostname: u.hostname,
        port: u.port || undefined,
        // S3_PUBLIC_URL carries a bucket path we scope to; a bare CDN base
        // (no path) gets a wildcard so any key under it is allowed.
        pathname:
          u.pathname && u.pathname !== "/"
            ? `${u.pathname.replace(/\/$/, "")}/**`
            : "/**",
      });
    } catch {
      // Ignore malformed URL — env validation catches it elsewhere.
    }
  }

  return patterns;
}

/**
 * Detect when `S3_PUBLIC_URL` points at a hostname Next.js's image optimizer
 * treats as private (loopback, RFC1918, docker internal). Used to opt-in to
 * `dangerouslyAllowLocalIP` *only* in dev/staging, never for a real domain.
 */
function s3PublicUrlIsLocal(): boolean {
  const publicUrl = process.env.S3_PUBLIC_URL;
  if (!publicUrl) return false;
  try {
    const host = new URL(publicUrl).hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return true;
    // RFC1918 v4 ranges + link-local
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    // Docker / k8s internal naming conventions — no dots, or .local / .svc
    if (!host.includes(".")) return true;
    if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".svc")) return true;
    return false;
  } catch {
    return false;
  }
}

// CSP + security headers now live in @/lib/security/headers (imported above by
// the `headers()` hook). Kept there as the single source so the admin Security
// diagnostics tab renders the exact policy that is served.
