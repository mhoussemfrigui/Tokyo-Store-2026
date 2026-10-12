/**
 * BUILD-TIME media host allow-list — the hosts next/image `remotePatterns` and
 * the CSP img-src / media-src were COMPILED with.
 *
 * next.config.ts reads S3_PUBLIC_URL + MEDIA_CDN_URL at `next build`, and the
 * production server serves those baked values (routes-manifest headers + the
 * standalone config) — a runtime env change or an admin `cdn_base_url` can't
 * extend them. A CDN base outside this list makes every storefront image fail
 * (/_next/image 400 "hostname not configured" + CSP block) until the image is
 * REBUILT with the host as a build argument.
 *
 * next.config.ts snapshots the build values into `BUILD_S3_PUBLIC_URL` /
 * `BUILD_MEDIA_CDN_URL` (its `env` block → inlined into server AND client
 * bundles). Outside a Next build (tsx scripts / tests) those are undefined and we
 * fall back to the runtime env — the values a build from this process would bake.
 *
 * Matching pins SCHEME + host(:port) AND the base's path under the entry's path
 * prefix (S3_PUBLIC_URL carries the bucket, e.g. https://host/tokyo; a bare CDN
 * origin allows any path). Scheme + port matter because next/image
 * `remotePatterns` and the CSP `img-src`/`media-src` origins pin them — an
 * `http://` base on an https-baked host 400s at next/image and is CSP-blocked, so
 * it must NOT validate. Same shape + rule as validation.ts's `allowedMediaBases`
 * (which gates the per-row url_override). Pure + client-safe (the settings form
 * uses it). settings.ts's cdn_base_url save-guard resolves through here too, so
 * the save-rejection, the form's amber warning, the runtime resolver gate, and
 * url_override all agree on ONE build-snapshot allow-list.
 */

export type MediaHostEntry = { protocol: string; host: string; prefix: string };

/** Raw allow-list sources: the build-time S3_PUBLIC_URL + MEDIA_CDN_URL entries. */
export function bakedMediaHostSources(): string[] {
  // Literal `process.env.X` reads — required for Next's build-time inlining.
  const bakedS3 = process.env.BUILD_S3_PUBLIC_URL;
  const bakedCdn = process.env.BUILD_MEDIA_CDN_URL;
  const inBuild = bakedS3 !== undefined || bakedCdn !== undefined;
  const s3 = inBuild ? bakedS3 : process.env.S3_PUBLIC_URL;
  const cdn = inBuild ? bakedCdn : process.env.MEDIA_CDN_URL;
  return [s3, ...(cdn?.split(",") ?? [])]
    .map((v) => v?.trim() ?? "")
    .filter(Boolean);
}

/** Parse allow-list sources into scheme + host(:port) + path-prefix entries (malformed skipped). */
export function parseMediaHostEntries(sources: readonly string[]): MediaHostEntry[] {
  const out: MediaHostEntry[] = [];
  for (const src of sources) {
    try {
      const u = new URL(src);
      out.push({
        protocol: u.protocol,
        host: u.host.toLowerCase(),
        prefix: u.pathname.replace(/\/+$/, ""),
      });
    } catch {
      /* skip a malformed entry */
    }
  }
  return out;
}

/** Whether a CDN base (absolute URL) sits under one of the allow-list entries —
 *  matching SCHEME + host(:port) + path prefix (see the header for why scheme). */
export function isCdnBaseAllowed(base: string, entries: readonly MediaHostEntry[]): boolean {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  const host = u.host.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  return entries.some(
    (a) =>
      a.protocol === u.protocol &&
      a.host === host &&
      (a.prefix === "" || path === a.prefix || path.startsWith(`${a.prefix}/`)),
  );
}

let memo: { key: string; entries: MediaHostEntry[] } | null = null;

/** Parsed build-time allow-list (memoised — the CDN base is resolved per media row). */
export function bakedMediaHostEntries(): MediaHostEntry[] {
  const sources = bakedMediaHostSources();
  const key = sources.join("\n");
  if (memo?.key !== key) memo = { key, entries: parseMediaHostEntries(sources) };
  return memo.entries;
}

/**
 * Display label for an entry, e.g. "s3.example.com/tokyo". Now that matching
 * pins the scheme, a NON-https entry shows its scheme ("http://host/prefix") so an
 * operator debugging a rejected cdn_base_url can see a scheme-only mismatch; the
 * common https case stays clean (host + prefix).
 */
export function describeMediaHostEntry(entry: MediaHostEntry): string {
  const scheme = entry.protocol === "https:" ? "" : `${entry.protocol}//`;
  return `${scheme}${entry.host}${entry.prefix}`;
}
