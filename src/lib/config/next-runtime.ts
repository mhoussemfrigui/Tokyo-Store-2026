/**
 * Pure, side-effect-free Next.js runtime tunables — the SINGLE SOURCE shared by
 * `next.config.ts` AND the admin Infrastructure → Performance tab, so the
 * displayed configuration can never drift from what's actually served. This is
 * the same single-source pattern already used for security headers
 * (src/lib/security/headers.ts is imported by both next.config.ts and the
 * Security tab).
 *
 * Only literal, statically-knowable values live here. Function-derived config
 * (`cacheComponents`, `dangerouslyAllowLocalIP`, `remotePatterns`) stays computed
 * inside next.config.ts — it depends on env at build time and isn't a fixed value
 * the admin tab can meaningfully mirror.
 */

/** Client-router cache freshness (seconds) — Next `experimental.staleTimes`. */
export const STALE_TIMES = { dynamic: 30, static: 300 } as const;

/** Max request body Next accepts before truncating — `experimental.proxyClientMaxBodySize`. */
export const PROXY_CLIENT_MAX_BODY = "16mb" as const;

/**
 * Server Action body limit — `experimental.serverActions.bodySizeLimit`. Next's
 * default is 1 MB, which 413s the Médiathèque dropzone (`uploadMediaAction`) and
 * the catalogue import (`startProductImportAction`) far below their advertised
 * 8 MB. ALIASED to the proxy cap on purpose: it must never exceed it (the proxy
 * truncates the body above that), and the admin `max_upload_mb` ceiling
 * (MAX_UPLOAD_MB_CEILING in src/modules/media/limits.ts) is pinned to the same
 * 16 MB. The per-feature limits (media settings, import MAX_FILE_BYTES) remain
 * the user-facing gates; this is only the outer ceiling.
 */
export const SERVER_ACTION_BODY_LIMIT = PROXY_CLIENT_MAX_BODY;

/** Image optimizer output formats — `images.formats`. */
export const IMAGE_FORMATS = ["image/avif", "image/webp"] as const;

/**
 * Minimum cache TTL (seconds) for optimized images — `images.minimumCacheTTL`.
 * 30 days: product media is content-addressed (hashed storage keys) and rarely
 * re-uploaded, so the default 60s caused needless re-encodes on the 4-vCPU box.
 * Aligns with the immutable 1-year caching the /cdn route already sets.
 */
export const IMAGE_MIN_CACHE_TTL = 2_592_000;

/** Build output mode — `output`. */
export const NEXT_OUTPUT = "standalone" as const;

/** HTTP response compression — `compress`. */
export const NEXT_COMPRESS = true as const;

/**
 * Cache Components (`experimental.cacheComponents`) is intentionally OFF — the
 * storefront uses force-dynamic + revalidateTag (see the long rationale in
 * next.config.ts). Exposed as a literal so the Performance tab states it without
 * importing next.config.ts (which app code can't import).
 */
export const CACHE_COMPONENTS = false as const;
