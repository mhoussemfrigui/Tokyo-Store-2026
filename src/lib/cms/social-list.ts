/**
 * Multi-value SOCIAL LINKS for « Identité & contact » — the operator can now add
 * MORE THAN ONE link per platform (e.g. two Facebook pages, two Instagram
 * accounts). Mirrors the contact-list model (phones/emails/addresses):
 *
 *   - stored as ONE ordered JSON array under `social.links`:
 *       [{ p: platform, u: url, l?: label }, …]
 *   - the legacy single keys (`social.instagram` … `social.linkedin`) are
 *     back-compat-read when `social.links` is absent (so an un-migrated DB still
 *     renders), and a one-shot migration folds them into the array.
 *
 * Isomorphic + client-safe: pure string/JSON logic, no server imports — the admin
 * editor, the save builder, the storefront footer/scene/reels, the e-mail brand
 * and the SEO `sameAs` all share this one model.
 */

export const SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "x",
  "youtube",
  "tiktok",
  "linkedin",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** A single social link. `label` is an optional operator caption (a handle or a
 *  page name like « Tokyo Gaming ») shown beside the icon; null = just the icon. */
export type SocialLink = { platform: SocialPlatform; url: string; label: string | null };

/** Display names (also the admin platform-selector option labels). */
export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  x: "X",
  youtube: "YouTube",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
};

/** The one stored key for the ordered links array. */
export const SOCIAL_LINKS_KEY = "social.links";

/** The legacy single-value keys, in canonical display order, for the back-compat
 *  read + the one-shot migration backfill. */
export const LEGACY_SOCIAL_KEYS: Record<SocialPlatform, string> = {
  instagram: "social.instagram",
  facebook: "social.facebook",
  x: "social.x",
  youtube: "social.youtube",
  tiktok: "social.tiktok",
  linkedin: "social.linkedin",
};

function isPlatform(p: unknown): p is SocialPlatform {
  return typeof p === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(p);
}

/**
 * A social link must be an absolute http(s) URL — the ONLY schemes ever rendered
 * into an `<a href>`. Rejects `javascript:`, `data:`, protocol-relative and
 * relative values (mirrors the save-time validator in social-list-save.ts). This
 * is the CENTRAL guard: every consumer reads the list through parseSocialList /
 * resolveSocialList, so a legacy `social.<platform>` value (which was stored RAW)
 * or a 0213-backfilled value can never smuggle a script scheme into a rendered
 * link, regardless of which consumer renders it.
 */
function isHttpUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

/** One link from a loosely-typed stored value ({p,u,l?}). Drops unknown platforms + non-http(s) urls. */
function toLink(e: unknown): SocialLink | null {
  if (!e || typeof e !== "object") return null;
  const o = e as { p?: unknown; u?: unknown; l?: unknown };
  const url = typeof o.u === "string" ? o.u.trim() : "";
  if (!isPlatform(o.p) || !isHttpUrl(url)) return null;
  const label = typeof o.l === "string" && o.l.trim() ? o.l.trim() : null;
  return { platform: o.p, url, label };
}

/** Parse a stored `social.links` value (a JSON array of {p,u,l?}) → links. */
export function parseSocialList(raw: string | null | undefined): SocialLink[] {
  const t = (raw ?? "").trim();
  if (!t || !t.startsWith("[")) return [];
  try {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr)) return [];
    return arr.map(toLink).filter((x): x is SocialLink => x !== null);
  } catch {
    return [];
  }
}

/** Serialize links back to the stored JSON form (empty urls dropped). */
export function serializeSocialList(links: SocialLink[]): string {
  const clean = links
    .map((l) => ({ p: l.platform, u: l.url.trim(), ...(l.label?.trim() ? { l: l.label.trim() } : {}) }))
    .filter((l) => l.u);
  return clean.length ? JSON.stringify(clean) : "";
}

/**
 * Resolve the social links from a settings map: the `social.links` array when
 * the operator has USED the editor, else a back-compat backfill from the 6
 * legacy single keys (one each, in canonical order) — so a site that never
 * touched the new editor still renders.
 *
 * Presence (not non-emptiness) of `social.links` is authoritative: once the key
 * exists — even set to "" because the operator removed every row — we return
 * that empty list rather than resurrecting the stale legacy keys below. Only a
 * site where the key was NEVER written (undefined) falls back. Migration 0213
 * materialises the key for every pre-existing site, so the fallback is a
 * defensive net, not the common path.
 */
export function resolveSocialList(settings: Record<string, string | null>): SocialLink[] {
  const raw = settings[SOCIAL_LINKS_KEY];
  if (raw !== undefined) return parseSocialList(raw);
  const out: SocialLink[] = [];
  for (const platform of SOCIAL_PLATFORMS) {
    const url = (settings[LEGACY_SOCIAL_KEYS[platform]] ?? "").trim();
    // Legacy single keys were stored RAW — scheme-check them too (see isHttpUrl).
    if (isHttpUrl(url)) out.push({ platform, url, label: null });
  }
  return out;
}

/**
 * Read social links from submitted FormData. The admin editor posts ONE hidden
 * input per row named `social.links[]` whose value is JSON `{p,u,l?}` — order
 * preserved, no index-misalignment.
 */
export function readSocialListFromForm(formData: FormData): SocialLink[] {
  return formData.getAll(`${SOCIAL_LINKS_KEY}[]`).flatMap((raw) => {
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
      const link = toLink(JSON.parse(raw));
      return link ? [link] : [];
    } catch {
      return [];
    }
  });
}

/** Distinct social URLs (SEO `sameAs`), order preserved. */
export function socialUrls(links: SocialLink[]): string[] {
  return [...new Set(links.map((l) => l.url).filter(Boolean))];
}

/** First URL per platform (for consumers that still key by platform, e.g. reels). */
export function firstUrlByPlatform(links: SocialLink[]): Partial<Record<SocialPlatform, string>> {
  const out: Partial<Record<SocialPlatform, string>> = {};
  for (const l of links) if (!out[l.platform]) out[l.platform] = l.url;
  return out;
}
