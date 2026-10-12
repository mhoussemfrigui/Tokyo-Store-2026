/**
 * Best-effort client IP from proxy headers, for per-IP rate limiting + audit.
 *
 * Takes the LAST `X-Forwarded-For` entry — the hop appended by our own trusted
 * reverse proxy (Coolify/Traefik) — NOT the first, which is client-controlled
 * and trivially spoofable to evade per-IP limits (an attacker rotates a fake
 * leading XFF to get a fresh bucket each request). Assumes a single trusted
 * proxy in front of the app (the documented Coolify topology); behind N chained
 * trusted proxies you'd trust the (N+1)-th-from-left entry instead.
 *
 * Falls back to `X-Real-IP`. Returns null when neither is present.
 */
export function getClientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const real = headers.get("x-real-ip")?.trim();
  return real || null;
}
