/**
 * PURE image helpers for the product feeds. No DB / no server-only → unit-testable.
 * Two jobs the feed mapper relies on:
 *   - absolutize relative URLs against the public origin;
 *   - treat the catalogue PLACEHOLDER as "no image" — a feed item REQUIRES a real
 *     raster image (Google Merchant rejects placeholder/SVG, ACP needs a genuine
 *     product image), so a placeholder-only product must be skipped, not emitted.
 */

/** Join a relative URL onto the origin; pass absolute http(s) URLs through. */
export function absolutize(url: string | null | undefined, origin: string): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (!origin) return null;
  return `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
}

/** Absolutize a candidate image, returning null for an empty or placeholder source. */
export function realImage(
  raw: string | null | undefined,
  origin: string,
  placeholder: string,
): string | null {
  if (!raw || raw === placeholder) return null;
  return absolutize(raw, origin);
}

/**
 * Build the additional-image gallery: absolutize, drop empties + the placeholder,
 * dedupe against `primary` (so the main image never repeats as an additional one),
 * and cap at 10 (Google's limit).
 */
export function feedGallery(
  images: ReadonlyArray<unknown>,
  origin: string,
  primary: string | null,
  placeholder: string,
): string[] {
  return images
    .map((i) => realImage(typeof i === "string" ? i : null, origin, placeholder))
    .filter((u): u is string => Boolean(u) && u !== primary)
    .slice(0, 10);
}
