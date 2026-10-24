/**
 * Best-effort client IP from proxy headers, for per-IP rate limiting + audit.
 *
 * Trusts the entries our OWN reverse proxies appended, never the client-controlled
 * leading ones (an attacker rotates a fake leading XFF to get a fresh rate-limit
 * bucket each request). Each trusted proxy appends the IP that connected to it, so
 * with `hops` trusted proxies in front of the app the real client is the
 * `hops`-th entry from the RIGHT — i.e. `parts[length - hops]`.
 *
 * `TRUSTED_PROXY_HOPS` (default 1 = the documented single Coolify/Traefik hop) sets
 * that count; bump it when a CDN or extra proxy sits in front, so neither the
 * per-IP limits nor the audit IPs can be spoofed or mis-attributed. A chain
 * shorter than configured clamps to the leftmost entry.
 *
 * Falls back to `X-Real-IP`. Returns null when neither is present.
 */
function trustedProxyHops(): number {
  const raw = Number.parseInt((process.env.TRUSTED_PROXY_HOPS ?? "").trim(), 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

export function getClientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - trustedProxyHops());
      return parts[idx] ?? parts[parts.length - 1];
    }
  }
  const real = headers.get("x-real-ip")?.trim();
  return real || null;
}
