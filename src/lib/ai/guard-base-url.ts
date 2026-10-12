import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isLinkLocalOrMetadataHost, validateAiBaseUrl } from "./validate-base-url";

/**
 * REQUEST-TIME SSRF guard for the AI provider base URL.
 *
 * The pure `validateAiBaseUrl` runs at WRITE time and only does a string check on
 * the hostname — a name that RESOLVES to the cloud-metadata endpoint
 * (169.254.169.254 → instance IAM credentials) would pass. This async guard runs
 * on EVERY outbound AI call and additionally RESOLVES DNS, rejecting any host
 * that resolves to a link-local / metadata address. It deliberately does NOT
 * block ordinary private/RFC1918/loopback IPs — a self-hosted or proxied
 * OpenAI-compatible model on an internal network is a legitimate setup the
 * validator already allows; the only no-legitimate-use target is the metadata
 * range. Pair this with `redirect: "manual"` on the fetch (a permitted public
 * host must not be allowed to 30x toward an internal address).
 *
 * Returns `null` when the base URL is safe to fetch, else a French error message.
 */
export async function assertAiBaseUrlSafe(baseUrl: string): Promise<string | null> {
  // 1. Re-run the pure validator (scheme + literal link-local/metadata host).
  const strErr = validateAiBaseUrl(baseUrl);
  if (strErr) return strErr;

  // 2. Resolve DNS and reject if ANY record is link-local / metadata.
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return "URL invalide.";
  }
  const literal = isIP(host);
  const addresses = literal
    ? [host]
    : (await dnsLookup(host, { all: true, verbatim: true }).catch(() => [])).map((r) => r.address);
  // No record resolved: let fetch surface the DNS failure itself (do not invent a
  // block — a transient resolver hiccup must not be reported as a security error).
  for (const ip of addresses) {
    if (isLinkLocalOrMetadataIp(ip)) {
      return "Cette adresse (link-local / métadonnées cloud) n'est pas autorisée.";
    }
  }
  return null;
}

/**
 * Link-local / cloud-metadata IP test for a RESOLVED address: the shared
 * {@link isLinkLocalOrMetadataHost} rules (169.254.0.0/16 incl. 169.254.169.254,
 * fe80::/10, AWS IMDS IPv6 fd00:ec2::254, Alibaba 100.100.100.200, and their
 * IPv4-mapped forms) plus any IPv6 whose dotted IPv4 tail carries one of those
 * (e.g. a NAT64 `64:ff9b::169.254.169.254`). NOT a general private-range
 * blocklist — private/loopback stay allowed for self-hosted models.
 */
function isLinkLocalOrMetadataIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 0) return false; // unparseable → leave to the validator / fetch
  if (isLinkLocalOrMetadataHost(ip)) return true;
  if (fam === 6) {
    const m = ip.toLowerCase().split("%")[0].match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m && isLinkLocalOrMetadataHost(m[1])) return true;
  }
  return false;
}
