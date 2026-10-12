import "server-only";

import QRCode from "qrcode";

import { resolvePublicOrigin } from "@/lib/url/public-origin";

/**
 * Order QR encoder.
 *
 * The QR encodes a URL pointing at `/order/verify/<orderId>` — the public
 * shopper view. That view is intentionally limited: status, total, item
 * summary — enough for a delivery rider to confirm what they're handing over,
 * not enough to enumerate the customer's full profile. The verify page itself
 * is responsible for the data-shape filtering.
 *
 * Tuned to Tokyo Store's palette and the `/cdn` proxy + Next.js Image
 * pipeline (so the QR can be embedded as a data URL in HTML — no second
 * round-trip).
 */

export type GenerateOrderQROptions = {
  /** Output PNG dimension in px. Defaults to 220 — fits the confirmation card. */
  width?: number;
  /** Quiet-zone margin in modules. Defaults to 2. */
  margin?: number;
};

/**
 * Build the ABSOLUTE verification URL the QR encodes — the QR is scanned by an
 * external device (delivery rider's phone) so it MUST be absolute + on the
 * canonical host. Uses the shared `resolvePublicOrigin()` (seo.site_url runtime
 * override aware), the same source of truth as emails / sitemap / robots, so a
 * runtime domain change doesn't print stale QR links.
 */
async function verifyUrlFor(orderId: string): Promise<string> {
  const base = await resolvePublicOrigin();
  return `${base}/order/verify/${orderId}`;
}

/**
 * Render a QR for a given order ID, returning a base64 PNG data URL ready
 * to drop into `<img src=...>` or a Next.js `<Image>` with `unoptimized`.
 *
 * The palette matches Tokyo Store's foreground/background tokens — dark
 * navy on white — so the printed receipt stays high-contrast in any
 * lighting and survives photocopying.
 */
export async function generateOrderQrDataUrl(
  orderId: string,
  opts: GenerateOrderQROptions = {},
): Promise<string> {
  const url = await verifyUrlFor(orderId);
  return QRCode.toDataURL(url, {
    width: opts.width ?? 220,
    margin: opts.margin ?? 2,
    errorCorrectionLevel: "M",
    color: { dark: "#0F172A", light: "#FFFFFF" },
  });
}
