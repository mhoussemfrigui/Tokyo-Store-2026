import "server-only";

import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF-hardened remote-image fetch.
 *
 * Used by the "import image from URL" feature: the admin pastes a URL and we
 * download the bytes server-side, then hand them to the SAME media pipeline a
 * file upload uses (processImage → webp/avif → S3 → media row).
 *
 * Defenses (an admin can be phished into pasting a malicious URL, and this runs
 * server-side with network access, so SSRF is the headline risk):
 *   1. Scheme allow-list: http/https only.
 *   2. No embedded credentials (user:pass@host).
 *   3. DNS resolved up-front; EVERY resolved A/AAAA record must be a PUBLIC IP
 *      (blocks loopback, RFC1918 private, CGNAT, link-local incl. the
 *      169.254.169.254 cloud-metadata endpoint, ULA, multicast, reserved).
 *   4. The TCP connection is PINNED to the validated IP via a custom `lookup`,
 *      so DNS can't be rebound to an internal host between our resolve and the
 *      socket connect (TOCTOU / DNS-rebinding). SNI/cert validation still uses
 *      the hostname.
 *   5. Redirects are NOT followed (a 3xx could point at an internal host).
 *   6. Hard timeout + streamed size cap (abort once the body exceeds the limit
 *      — no buffering an unbounded/decompression-bomb response).
 *   7. Content-Type must be one of the accepted image MIMEs; sharp is the final
 *      arbiter downstream (it rejects non-image bytes regardless of the header).
 */

export type RemoteImage = { buffer: Buffer; mime: string; filename: string };

export class RemoteImageError extends Error {
  constructor(
    public readonly code: string,
    /** French, admin-facing. */
    message: string,
  ) {
    super(message);
    this.name = "RemoteImageError";
  }
}

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

const FETCH_TIMEOUT_MS = 10_000;

// ───────────────────────────────────────────────────────── IP allow checks
/**
 * True when the IP must NOT be reached (private / loopback / link-local /
 * reserved). The ONE shared classifier: also imported by the outbound-webhook
 * transport (src/lib/net/ssrf-fetch.ts). Pinned by
 * src/lib/db/tests/ssrf-ip-classifier.test.ts — every private range, the
 * IPv6-encoded forms (`::ffff:127.0.0.1` / `::ffff:7f00:1`, `fd00::1`,
 * `fe80::1`, NAT64 `64:ff9b::a9fe:a9fe`, 6to4 `2002:c0a8::`) and unparseable
 * input (blocked) — without standing up a server.
 */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // unparseable → block
}

function isBlockedV4(ip: string): boolean {
  const o = ip.split(".").map((p) => Number(p));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/**
 * Fully expand any valid IPv6 string (handles `::` compression AND a trailing
 * embedded IPv4 in ANY notation, e.g. `::ffff:127.0.0.1` and the equivalent
 * `0:0:0:0:0:ffff:127.0.0.1`) to exactly 8 16-bit groups. Returns null if it
 * can't parse — callers treat that as "blocked". Normalising before the range
 * checks is what closes the expanded-IPv4-mapped SSRF bypass.
 */
function expandV6(input: string): number[] | null {
  let s = input.toLowerCase().split("%")[0]; // strip zone id
  // Fold a trailing dotted-IPv4 tail into two hextets so the rest is pure hex.
  const dotted = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const o = dotted[2].split(".").map((p) => Number(p));
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${dotted[1]}${(((o[0] << 8) | o[1]) >>> 0).toString(16)}:${(((o[2] << 8) | o[3]) >>> 0).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : null;
  let groups: string[];
  if (right === null) {
    groups = left;
  } else {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null; // "::" must stand for ≥1 group
    groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  }
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function v4FromHextets(hi: number, lo: number): string {
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isBlockedV6(ip: string): boolean {
  const h = expandV6(ip);
  if (!h) return true; // unparseable → block
  // :: (unspecified) and ::1 (loopback)
  if (h.slice(0, 7).every((x) => x === 0) && (h[7] === 0 || h[7] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d (ANY notation) → validate the embedded IPv4.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isBlockedV4(v4FromHextets(h[6], h[7]));
  }
  // IPv4-compatible ::a.b.c.d (deprecated) → also embeds an IPv4.
  if (h.slice(0, 6).every((x) => x === 0) && (h[6] !== 0 || h[7] !== 0)) {
    return isBlockedV4(v4FromHextets(h[6], h[7]));
  }
  if (h[0] >= 0xfc00 && h[0] <= 0xfdff) return true; // fc00::/7 ULA (incl. fd00::/8)
  if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (h[0] >= 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    // NAT64: the IANA Well-Known 64:ff9b::/96 AND the RFC 8215 Local-Use
    // 64:ff9b:1::/48 both embed an IPv4 in the LOW 32 bits — validate it so a
    // private v4 (e.g. 64:ff9b::169.254.169.254) can't tunnel through.
    return isBlockedV4(v4FromHextets(h[6], h[7]));
  }
  if (h[0] === 0x2002) return isBlockedV4(v4FromHextets(h[1], h[2])); // 6to4 2002::/16 → embedded v4
  return false;
}

/**
 * Resolve the hostname and return EVERY validated public IP. We pin the socket
 * to these pre-validated addresses (the custom `lookup` below NEVER re-resolves),
 * so DNS can't be rebound to an internal host between our check and the connect.
 * Returning ALL of them — not just the first — lets Node's Happy-Eyeballs fall
 * through to the next address when one is unreachable (e.g. an AAAA record on a
 * host with no IPv6 egress) instead of hard-failing.
 */
async function resolvePublicIps(
  hostname: string,
): Promise<{ address: string; family: number }[]> {
  // `url.hostname` keeps the brackets for IPv6 literals ("[::1]") — strip them so
  // a literal goes through the blocklist instead of failing DNS resolution.
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  const literal = isIP(host);
  const candidates: { address: string; family: number }[] = literal
    ? [{ address: host, family: literal }]
    : (await dnsLookup(host, { all: true, verbatim: true }).catch(() => [])).map((r) => ({
        address: r.address,
        family: r.family,
      }));
  if (candidates.length === 0) {
    throw new RemoteImageError("dns", "Nom d'hôte introuvable.");
  }
  // STRICT: if ANY record is internal, refuse (defeats split-horizon / multi-A tricks).
  for (const c of candidates) {
    if (isBlockedIp(c.address)) {
      throw new RemoteImageError("blocked_host", "URL refusée : hôte interne ou privé.");
    }
  }
  return candidates;
}

function streamWithCap(res: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        reject(new RemoteImageError("too_large", "Image trop volumineuse."));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", (e) => reject(e));
  });
}

function deriveFilename(url: URL, mime: string): string {
  // decodeURIComponent throws URIError on a malformed %-escape; fall back to the
  // raw segment so a download that already succeeded isn't reported as failed.
  // The sanitiser below strips any leftover '%' regardless.
  const seg = url.pathname.split("/").pop() || "";
  let raw: string;
  try {
    raw = decodeURIComponent(seg).trim();
  } catch {
    raw = seg.trim();
  }
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 100);
  if (cleaned && /\.[a-z0-9]+$/i.test(cleaned)) return cleaned;
  const ext = (mime.split("/")[1] || "img").replace("jpeg", "jpg");
  return `${cleaned || "image"}.${ext}`;
}

export async function fetchRemoteImage(rawUrl: string, maxBytes: number): Promise<RemoteImage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RemoteImageError("invalid_url", "URL invalide.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteImageError("scheme", "Seules les URL http(s) sont acceptées.");
  }
  if (url.username || url.password) {
    throw new RemoteImageError("credentials", "URL avec identifiants non autorisée.");
  }
  // Constrain the port: even a public host should not be probed on an arbitrary
  // port via this admin-triggered server-side fetch. Allow only the standard web
  // ports (empty `port` = the scheme default 80/443).
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new RemoteImageError("port", "Port non autorisé (seuls 80 et 443 le sont).");
  }

  const pinned = await resolvePublicIps(url.hostname);
  const lib = url.protocol === "https:" ? https : http;

  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        // Pin to the pre-validated public IP(s) — closes the DNS-rebinding
        // window (this lookup NEVER re-resolves). SNI / certificate validation
        // still uses the hostname (servername).
        //
        // CRITICAL: honour `opts.all`. Node 20+ enables Happy-Eyeballs
        // (`autoSelectFamily`) on outgoing sockets, so it calls the custom
        // lookup with `{ all: true }` and expects an ARRAY result. Returning the
        // legacy `(address, family)` form in that case made Node read an
        // `undefined` address → `ERR_INVALID_IP_ADDRESS`, silently breaking
        // EVERY https URL import. Branch on `opts.all` to satisfy both forms.
        lookup: (_hostname, opts, cb) => {
          if (opts && (opts as { all?: boolean }).all) {
            (
              cb as unknown as (
                err: NodeJS.ErrnoException | null,
                addresses: { address: string; family: number }[],
              ) => void
            )(null, pinned);
          } else {
            (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
              null,
              pinned[0].address,
              pinned[0].family,
            );
          }
        },
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
          "user-agent": "TokyoStore-MediaImporter/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      resolve,
    );
    req.on("error", (e) => reject(e));
    req.end();
  });

  const status = res.statusCode ?? 0;
  // Do NOT follow redirects — a 3xx Location could target an internal host.
  if (status >= 300 && status < 400) {
    res.destroy();
    throw new RemoteImageError(
      "redirect",
      "Les redirections ne sont pas suivies — fournissez l'URL finale de l'image.",
    );
  }
  if (status < 200 || status >= 300) {
    res.destroy();
    throw new RemoteImageError("http_status", `Téléchargement échoué (HTTP ${status}).`);
  }

  const ctype = String(res.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ACCEPTED_MIME.has(ctype)) {
    res.destroy();
    throw new RemoteImageError(
      "content_type",
      "Le contenu n'est pas une image supportée (JPG, PNG, WebP, AVIF, GIF).",
    );
  }
  const declaredLen = Number(res.headers["content-length"]);
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    res.destroy();
    throw new RemoteImageError("too_large", "Image trop volumineuse.");
  }

  const buffer = await streamWithCap(res, maxBytes);
  if (buffer.length === 0) {
    throw new RemoteImageError("empty", "La réponse ne contient aucune donnée.");
  }
  return { buffer, mime: ctype, filename: deriveFilename(url, ctype) };
}
