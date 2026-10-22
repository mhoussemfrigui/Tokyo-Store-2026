/**
 * REELS content — the storefront « Nos vidéos » (/reels) library, editable by the
 * operator in the admin (Contenu & Design → Vidéos / Reels). Mirrors the
 * contact-list / social-list model: ONE ordered JSON array stored under a single
 * settings key, parsed/serialized by this isomorphic (client-safe, no server
 * imports) module shared by the admin editor, the save builder and the storefront
 * reader.
 *
 * There is NO fabricated content and NO invented engagement metric: a reel is a
 * REAL post (its public URL on TikTok/Instagram/Facebook), an optional poster
 * image, a topic and the catalogue products it features. View/like/follower counts
 * were removed — they were never backed by anything. When the operator has added
 * no reels, /reels shows an honest empty state (the SHOP accounts, from
 * « Identité & contact » → social links, still render so visitors can follow).
 */

/** The platforms a reel can live on (a subset of the social platforms). */
export const REEL_PLATFORMS = ["tiktok", "instagram", "facebook"] as const;
export type ReelPlatform = (typeof REEL_PLATFORMS)[number];

export const REEL_PLATFORM_LABELS: Record<ReelPlatform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
};

/** The editorial topics a reel can be filed under (also the storefront filter chips). */
export const REEL_TOPICS = [
  "Unboxing",
  "Tests & avis",
  "Comparatifs",
  "Astuces",
  "Gaming",
  "Nouveautés",
] as const;
export type ReelTopic = (typeof REEL_TOPICS)[number];

/** One reel. `videoUrl` is the public post URL (opened on « Voir sur … »);
 *  `posterUrl` is an optional thumbnail (a /cdn or absolute image URL);
 *  `productSlugs` are the catalogue products featured (resolved live by the page). */
export type ReelVideo = {
  id: string;
  title: string;
  platform: ReelPlatform;
  topic: ReelTopic;
  videoUrl: string;
  posterUrl: string;
  productSlugs: string[];
};

/** The one stored key for the ordered reels array. */
export const REELS_VIDEOS_KEY = "reels.videos";

function isReelPlatform(v: unknown): v is ReelPlatform {
  return typeof v === "string" && (REEL_PLATFORMS as readonly string[]).includes(v);
}
function isReelTopic(v: unknown): v is ReelTopic {
  return typeof v === "string" && (REEL_TOPICS as readonly string[]).includes(v);
}

/** Parse one loosely-typed entry into a ReelVideo, or null if it has no usable
 *  video URL (the one required field). Tolerant of missing/invalid optionals. */
function toReel(e: unknown, i: number): ReelVideo | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const videoUrl = typeof o.videoUrl === "string" ? o.videoUrl.trim() : "";
  if (!videoUrl) return null;
  const slugs = Array.isArray(o.productSlugs)
    ? o.productSlugs.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
    : [];
  return {
    id: typeof o.id === "string" && o.id ? o.id : `reel-${i}`,
    title: typeof o.title === "string" ? o.title.trim() : "",
    platform: isReelPlatform(o.platform) ? o.platform : "tiktok",
    topic: isReelTopic(o.topic) ? o.topic : "Nouveautés",
    videoUrl,
    posterUrl: typeof o.posterUrl === "string" ? o.posterUrl.trim() : "",
    productSlugs: slugs,
  };
}

/** Parse the stored `reels.videos` value into an ordered ReelVideo[]. A non-array
 *  or unparseable value yields [] (honest empty state). */
export function parseReelsVideos(raw: string | null | undefined): ReelVideo[] {
  const t = (raw ?? "").trim();
  if (!t || !t.startsWith("[")) return [];
  try {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr)) return [];
    return arr.map(toReel).filter((r): r is ReelVideo => r !== null);
  } catch {
    return [];
  }
}

/** Serialize a ReelVideo[] back to the stored JSON string (empty array → ""). */
export function serializeReelsVideos(videos: ReelVideo[]): string {
  const clean = videos
    .map((v, i) => toReel(v, i))
    .filter((v): v is ReelVideo => v !== null);
  return clean.length > 0 ? JSON.stringify(clean) : "";
}

/** Read the reels from a settings map (the storefront + admin reader). */
export function resolveReelsVideos(settings: Record<string, string | null | undefined>): ReelVideo[] {
  return parseReelsVideos(settings[REELS_VIDEOS_KEY]);
}
