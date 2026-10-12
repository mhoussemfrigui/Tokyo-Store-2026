/**
 * Pure normalizers for the admin-editable SEO settings that feed robots.txt, the
 * sitemap, and the Organization schema. The single place that turns free-text
 * admin input into safe, validated values — consumed by getSeoConfig (config.ts)
 * so robots.ts / sitemap.ts / jsonld.ts receive clean data and can't emit a
 * malformed rule or URL. Dependency-free → unit-tested in db/tests/seo-settings.test.ts.
 */

/** schema.org Organization subtypes we let an admin pick for the brand entity. */
export const ORG_TYPES = ["Organization", "OnlineStore", "Store"] as const;
export type OrgType = (typeof ORG_TYPES)[number];

/** Map an allowed type to its admin-facing French label (UI select options). */
export const ORG_TYPE_LABELS: Record<OrgType, string> = {
  Organization: "Organisation (générique)",
  OnlineStore: "Boutique en ligne (OnlineStore)",
  Store: "Magasin physique (Store)",
};

/** Coerce a stored value to an allowed Organization @type; default Organization. */
export function normalizeOrgType(raw: string | null | undefined): OrgType {
  const t = (raw ?? "").trim();
  return (ORG_TYPES as readonly string[]).includes(t) ? (t as OrgType) : "Organization";
}

/**
 * Parse a stored geo coordinate (latitude or longitude) to a finite number within
 * ±`max` (90 for latitude, 180 for longitude), or null. Rejects blanks, non-numeric
 * text, and out-of-range values so the LocalBusiness GeoCoordinates can never carry
 * garbage (an invalid lat/lng would fail Google's rich-result validation).
 */
export function parseGeoCoord(raw: string | null | undefined, max: number): number | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  return n;
}

export const MAX_ROBOTS_PATHS = 50;

/**
 * Extra robots.txt Disallow paths. Keeps only site-root paths (must start with
 * "/"), strips internal whitespace (a path can't contain spaces), dedupes, and
 * caps the count. Rejects absolute URLs / bare words so a stray line can't
 * produce a broken `Disallow:` directive.
 */
export function normalizeDisallowPaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\n,]+/)) {
    let p = token.trim();
    if (!p.startsWith("/")) continue;
    if (/\s/.test(p)) p = p.replace(/\s+/g, "");
    if (p.length < 1 || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_ROBOTS_PATHS) break;
  }
  return out;
}

export const MAX_SITEMAP_URLS = 100;

/**
 * Extra sitemap URLs. Accepts an absolute http(s) URL OR a site-root path
 * ("/promo") which is resolved against `siteUrl`. Drops anything else
 * (relative, other schemes, garbage), dedupes, caps. Returns absolute URLs
 * ready to emit in the sitemap.
 */
export function normalizeSitemapUrls(
  raw: string | null | undefined,
  siteUrl: string,
): string[] {
  if (!raw) return [];
  const base = (siteUrl || "").replace(/\/$/, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\n,]+/)) {
    const t = token.trim();
    if (!t) continue;
    let url: string | null = null;
    if (t.startsWith("/")) {
      if (base) url = `${base}${t}`;
    } else {
      try {
        const u = new URL(t);
        if (u.protocol === "http:" || u.protocol === "https:") url = u.toString();
      } catch {
        /* not a URL → drop */
      }
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_SITEMAP_URLS) break;
  }
  return out;
}
