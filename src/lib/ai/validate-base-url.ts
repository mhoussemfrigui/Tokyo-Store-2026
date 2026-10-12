/**
 * Validate an admin-supplied AI provider base URL (pure, unit-testable).
 *
 * The server fetches this URL with the (decrypted) provider API key in a header,
 * so a hostile base URL is an SSRF + key-exfil vector. We REQUIRE http/https and
 * BLOCK link-local / cloud-metadata hosts (169.254.0.0/16, fe80::/10,
 * metadata.google.internal, AWS IMDS over IPv6 fd00:ec2::254, Alibaba Cloud
 * 100.100.100.200) — no legitimate LLM endpoint lives there, but the cloud
 * metadata service would hand out instance credentials.
 *
 * Private/loopback hosts are deliberately ALLOWED: a self-hosted or proxied
 * OpenAI-compatible model on an internal network (or localhost in dev) is a valid
 * setup. What keeps a delegated operator from sending a stored credential to a
 * host of their choosing is the separate OWNER gate below
 * (`aiBaseUrlChangeRefusal`), not this validator: the goal here is to block the
 * genuinely-dangerous, no-legitimate-use targets, not to forbid internal
 * endpoints outright.
 *
 * Returns `null` when the URL is acceptable, else a French error message.
 */
export function validateAiBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "URL invalide.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Le protocole doit être http ou https.";
  }
  if (isLinkLocalOrMetadataHost(url.hostname)) {
    return "Cette adresse (link-local / métadonnées cloud) n'est pas autorisée.";
  }
  return null;
}

/** Cloud instance-metadata endpoints OUTSIDE 169.254/16 + fe80::/10 (canonical
 *  forms, as both the WHATWG URL parser and dns.lookup print them). */
const METADATA_IPS = new Set(["fd00:ec2::254", "100.100.100.200"]);
const METADATA_HOSTNAMES = new Set(["metadata.google.internal"]);

function isBlockedIpv4(v4: string): boolean {
  return v4.startsWith("169.254.") || METADATA_IPS.has(v4);
}

/**
 * Link-local / cloud-metadata test for a URL hostname OR a resolved IP literal
 * (shared by the write-time validator and the request-time DNS guard). Brackets,
 * an IPv6 zone id and a trailing FQDN dot are ignored. IPv4-mapped/compatible
 * IPv6 forms (`::ffff:169.254.1.1`, or the hex `::ffff:a9fe:101` the URL parser
 * normalises it to) are unwrapped to their IPv4. NOT a general private-range
 * blocklist — private/loopback stay allowed for self-hosted models.
 */
export function isLinkLocalOrMetadataHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split("%")[0]
    .replace(/\.$/, "");
  if (METADATA_HOSTNAMES.has(host) || METADATA_IPS.has(host)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isBlockedIpv4(host);
  if (!host.includes(":")) return false; // a DNS name (resolved by the request-time guard)
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
  const mapped = host.match(
    /^::(?:ffff:)?(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/,
  );
  if (mapped) {
    if (mapped[1]) return isBlockedIpv4(mapped[1]);
    const hi = parseInt(mapped[2], 16);
    const lo = parseInt(mapped[3], 16);
    return isBlockedIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/**
 * Canonical stored/resolved form of a base URL: trimmed, trailing slashes
 * removed. The client appends `/chat/completions`, `/v1/messages` or
 * `/embeddings`, so a pasted `https://api.openai.com/v1/` would otherwise yield
 * `…/v1//chat/completions` (rejected by several providers as a bare 404).
 */
export function normalizeAiBaseUrl(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

/**
 * OWNER gate for a base-URL change (pure). The resolver pairs whatever key is
 * configured — the env var, else the encrypted DB value — with the stored base
 * URL, so repointing the URL at a host you control hands you that key on the
 * next generation / embedding call. A delegated `system_ai:update` operator
 * (no `*`) therefore may NOT move a provider's destination when:
 *   • its key comes from the ENVIRONMENT (the owner's secret) — only keeping the
 *     current endpoint or going back to the provider's official default is allowed;
 *   • its key is a stored DB secret they did not just re-enter in the same save —
 *     re-keying makes the credential theirs, so the destination may follow.
 * With no key configured there is nothing to leak. `previous`/`next` are the
 * EFFECTIVE endpoints (stored value, else the provider default), normalised.
 *
 * Returns `null` when allowed, else a French refusal.
 */
export function aiBaseUrlChangeRefusal(input: {
  isOwner: boolean;
  keySource: "env" | "admin" | "none";
  newKeySubmitted: boolean;
  previous: string;
  next: string;
  providerDefault: string;
}): string | null {
  const { isOwner, keySource, newKeySubmitted, previous, next, providerDefault } = input;
  if (next === previous || isOwner) return null;
  if (keySource === "env") {
    if (next === normalizeAiBaseUrl(providerDefault)) return null;
    return "Seul un super-administrateur peut modifier l'URL de base d'un fournisseur dont la clé API est définie par variable d'environnement.";
  }
  if (keySource === "admin" && !newKeySubmitted) {
    return "Pour changer l'URL de base, saisissez à nouveau la clé API de ce fournisseur dans le même enregistrement (ou demandez à un super-administrateur).";
  }
  return null;
}
