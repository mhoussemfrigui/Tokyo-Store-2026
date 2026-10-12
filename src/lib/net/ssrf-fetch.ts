import "server-only";

import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isBlockedIp } from "@/lib/media/fetch-remote-image";

/**
 * SSRF-hardened OUTBOUND request (POST/GET) — the generic sibling of
 * `fetchRemoteImage`. Used to deliver outbound webhooks to admin-supplied URLs.
 *
 * It reuses the battle-tested IP classifier `isBlockedIp` (loopback / RFC1918 /
 * CGNAT / link-local incl. 169.254.169.254 / ULA / IPv4-mapped / NAT64 / 6to4)
 * and applies the same defenses: http/https only, no embedded credentials, DNS
 * resolved up-front with EVERY record required public, the socket PINNED to the
 * validated IP via a custom `lookup` (anti-DNS-rebinding), no redirects, hard
 * timeout, and a bounded response read.
 *
 * Errors split so the caller can retry sensibly:
 *   - `SsrfError` (bad/blocked/unresolvable URL) → a CONFIG problem = terminal.
 *   - any other thrown error (ECONNREFUSED, timeout, socket) → transient = retry.
 * A returned `{ status }` is the endpoint's real HTTP status (the caller decides
 * 2xx = success vs. retry on 5xx), never an exception.
 */
export class SsrfError extends Error {
  constructor(
    public readonly code: "invalid_url" | "scheme" | "credentials" | "dns" | "blocked_host",
    message: string,
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

export type SsrfResponse = { status: number; bodyText: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024; // enough to log an error body
const DNS_TIMEOUT_MS = 5_000;

/** Sentinel thrown when the resolver itself is too slow (transient, NOT SsrfError). */
const DNS_TIMEOUT = Symbol("dns_timeout");

/**
 * `dns.lookup` with a hard timeout. An unbounded `getaddrinfo` on a black-holed
 * authoritative DNS would otherwise stall the (concurrency-bounded) drain and can
 * starve the libuv threadpool app-wide — the request `AbortSignal` covers only the
 * HTTP phase, not resolution. A timeout is TRANSIENT (rethrown → the caller retries
 * with backoff), distinct from a real resolution failure (empty → terminal `dns`).
 */
async function lookupWithTimeout(host: string): Promise<{ address: string; family: number }[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      dnsLookup(host, { all: true, verbatim: true }).catch((e: NodeJS.ErrnoException) => {
        // A DEFINITIVE miss (host doesn't exist / has no A/AAAA record) → empty →
        // terminal `dns` (a retry can't help). But a TRANSIENT resolver error —
        // EAI_AGAIN ("temporary failure in name resolution"), ESERVFAIL from a flaky
        // authoritative server, a network blip — must NOT dead-letter every in-flight
        // delivery: rethrow a plain Error (NOT SsrfError) so the drain retries with
        // backoff, matching the DNS-timeout classification above.
        const code = e?.code;
        if (code === "ENOTFOUND" || code === "ENODATA") return [];
        throw new Error(`Résolution DNS échouée (${code ?? "inconnue"}).`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(DNS_TIMEOUT), DNS_TIMEOUT_MS);
      }),
    ]);
    return records.map((r) => ({ address: r.address, family: r.family }));
  } catch (err) {
    if (err === DNS_TIMEOUT) throw new Error("Résolution DNS expirée."); // transient → retry
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve + validate every A/AAAA record as public; return the pinned set. */
async function resolvePinnedIps(hostname: string): Promise<{ address: string; family: number }[]> {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  const literal = isIP(host);
  const candidates: { address: string; family: number }[] = literal
    ? [{ address: host, family: literal }]
    : await lookupWithTimeout(host);
  if (candidates.length === 0) throw new SsrfError("dns", "Nom d'hôte introuvable.");
  // STRICT: if ANY resolved record is internal, refuse (defeats split-horizon).
  for (const c of candidates) {
    if (isBlockedIp(c.address)) {
      throw new SsrfError("blocked_host", "URL refusée : hôte interne ou privé.");
    }
  }
  return candidates;
}

/**
 * Read the response body up to `maxBytes`, then stop. Settles EXACTLY once and
 * never depends on 'end': `res.destroy()` without an error emits neither 'end'
 * nor 'error' (only 'close'), so the over-cap path resolves BEFORE destroying,
 * and 'close' is the backstop for every other teardown (abort signal, socket
 * reset). A promise that never settles here pins a drain worker forever — the
 * row is never finalized, re-POSTed on every stale recovery, and the job run is
 * never logged.
 */
function readCapped(res: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    res.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = maxBytes - total;
      if (room > 0) chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      total += chunk.length;
      if (total > maxBytes) {
        finish();
        res.destroy(); // stop reading once we have enough for a log line
      }
    });
    res.on("end", finish);
    // A read error after we already have the status is non-fatal for our purpose.
    res.on("error", finish);
    res.on("close", finish);
  });
}

type RequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Request body (already-serialized string, e.g. JSON). */
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export async function ssrfSafeRequest(opts: { url: string } & RequestOptions): Promise<SsrfResponse> {
  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    throw new SsrfError("invalid_url", "URL invalide.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("scheme", "Seules les URL http(s) sont acceptées.");
  }
  if (url.username || url.password) {
    throw new SsrfError("credentials", "URL avec identifiants non autorisée.");
  }

  const pinned = await resolvePinnedIps(url.hostname);
  return requestPinned(url, pinned, opts);
}

/**
 * The HTTP phase: connect to the PRE-VALIDATED `pinned` IPs only. Performs NO
 * SSRF validation itself — only `ssrfSafeRequest` (after `resolvePinnedIps`)
 * may call it.
 */
async function requestPinned(
  url: URL,
  pinned: { address: string; family: number }[],
  opts: RequestOptions,
): Promise<SsrfResponse> {
  const lib = url.protocol === "https:" ? https : http;
  const method = opts.method ?? "POST";
  const body = opts.body ?? "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        // Pin to the pre-validated public IP(s) — closes the DNS-rebinding
        // window. Honour Node 20+ Happy-Eyeballs' `{ all: true }` array form.
        lookup: (_hostname, lookupOpts, cb) => {
          if (lookupOpts && (lookupOpts as { all?: boolean }).all) {
            (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, pinned);
          } else {
            (cb as (e: null, a: string, f: number) => void)(null, pinned[0].address, pinned[0].family);
          }
        },
        headers: {
          ...(body ? { "content-length": Buffer.byteLength(body).toString() } : {}),
          ...opts.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      resolve,
    );
    req.on("error", (e) => reject(e)); // network error → transient (caller retries)
    if (body) req.write(body);
    req.end();
  });

  const status = res.statusCode ?? 0;
  const bodyText = await readCapped(res, maxResponseBytes);
  return { status, bodyText };
}

/**
 * TEST SEAM ONLY (src/lib/db/tests/ssrf-fetch.test.ts): drives the read/HTTP
 * phase against a loopback server WITHOUT loosening the IP guard. `requestPinned`
 * skips SSRF validation by design — app code must always use `ssrfSafeRequest`.
 */
export const __testing = { readCapped, requestPinned };
