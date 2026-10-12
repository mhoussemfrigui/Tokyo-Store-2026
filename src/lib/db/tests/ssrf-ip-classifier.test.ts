/**
 * The SHARED SSRF IP classifier (`isBlockedIp`, src/lib/media/fetch-remote-image.ts)
 * — NO database, NO network. It is the single allow/deny decision behind BOTH
 * outbound guards: the admin « importer une image par URL » fetch AND the signed
 * outbound-webhook transport (src/lib/net/ssrf-fetch.ts). The IPv6 normalisation
 * (`expandV6`) is the security-critical part: an IPv4-mapped / NAT64 / 6to4 /
 * IPv4-compatible encoding of a private address must classify exactly like the
 * dotted IPv4 it wraps, in every notation, or it re-opens an SSRF bypass to the
 * loopback / RFC1918 / cloud-metadata (169.254.169.254) ranges.
 *
 * Also pins the pre-network URL gate of `fetchRemoteImage` for LITERAL hosts
 * (scheme, credentials, port, and literal internal IPs incl. the WHATWG URL
 * normalisations `0177.0.0.1` / `2130706433` / `[::ffff:127.0.0.1]`) — a literal
 * IP never reaches DNS, so these assertions stay offline.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/ssrf-ip-classifier.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchRemoteImage, isBlockedIp, RemoteImageError } from "@/lib/media/fetch-remote-image";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function expectBlocked(group: string, ips: string[]) {
  for (const ip of ips) check(`${group}: ${JSON.stringify(ip)} → blocked`, isBlockedIp(ip));
}
function expectAllowed(group: string, ips: string[]) {
  for (const ip of ips) check(`${group}: ${JSON.stringify(ip)} → allowed`, !isBlockedIp(ip));
}

/** The RemoteImageError code a URL is refused with BEFORE any socket/DNS work. */
async function refusalCode(url: string): Promise<string> {
  try {
    await fetchRemoteImage(url, 1024);
    return "NOT_REFUSED";
  } catch (err) {
    return err instanceof RemoteImageError ? err.code : `unexpected:${String(err)}`;
  }
}

async function main() {
  // ── IPv4 ──────────────────────────────────────────────────────────────────
  console.log("IPv4 private / reserved ranges:");
  expectBlocked("0/8 this-host", ["0.0.0.0", "0.1.2.3"]);
  expectBlocked("10/8 private", ["10.0.0.1", "10.255.255.255"]);
  expectBlocked("127/8 loopback", ["127.0.0.1", "127.255.255.254"]);
  expectBlocked("169.254/16 link-local + cloud metadata", ["169.254.169.254", "169.254.0.1"]);
  expectBlocked("172.16/12 private (both edges)", ["172.16.0.1", "172.31.255.255"]);
  expectBlocked("192.168/16 private", ["192.168.0.1", "192.168.255.255"]);
  expectBlocked("100.64/10 CGNAT (both edges)", ["100.64.0.1", "100.127.255.255"]);
  expectBlocked("192.0.0/24 IETF", ["192.0.0.1"]);
  expectBlocked("TEST-NETs", ["192.0.2.1", "198.51.100.7", "203.0.113.9"]);
  expectBlocked("198.18/15 benchmark (both edges)", ["198.18.0.1", "198.19.255.255"]);
  expectBlocked("multicast / reserved / broadcast", ["224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255"]);

  console.log("IPv4 public (incl. the addresses right OUTSIDE each blocked range):");
  expectAllowed("public resolvers", ["8.8.8.8", "1.1.1.1", "9.9.9.9"]);
  expectAllowed("range edges", [
    "9.255.255.255",
    "11.0.0.1",
    "126.255.255.255",
    "128.0.0.1",
    "169.253.255.255",
    "169.255.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.167.255.255",
    "192.169.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.255",
  ]);

  // ── IPv6 ──────────────────────────────────────────────────────────────────
  console.log("IPv6 unspecified / loopback:");
  expectBlocked("::/128 + ::1/128", ["::", "::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001"]);

  console.log("IPv4-mapped ::ffff:0:0/96 — the embedded IPv4 decides, in EVERY notation:");
  expectBlocked("mapped loopback", [
    "::ffff:127.0.0.1", // dotted
    "::ffff:7f00:1", // hex
    "0:0:0:0:0:ffff:127.0.0.1", // fully expanded + dotted
    "0:0:0:0:0:ffff:7f00:0001", // fully expanded + hex
    "::FFFF:127.0.0.1", // upper-case
  ]);
  expectBlocked("mapped private / metadata", ["::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:192.168.1.1", "::ffff:c0a8:101"]);
  expectAllowed("mapped PUBLIC stays reachable", ["::ffff:8.8.8.8", "::ffff:808:808"]);

  console.log("IPv4-compatible ::a.b.c.d (deprecated) — also embeds an IPv4:");
  expectBlocked("compatible private", ["::127.0.0.1", "::a00:1", "::169.254.169.254"]);
  expectAllowed("compatible public", ["::8.8.8.8"]);

  console.log("ULA fc00::/7 (incl. fd00::/8), link-local fe80::/10, multicast, documentation:");
  expectBlocked("ULA", ["fc00::1", "fd00::1", "fd12:3456:789a::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]);
  expectBlocked("link-local fe80::/10 (both edges)", ["fe80::1", "febf:ffff::1"]);
  expectBlocked("multicast ff00::/8", ["ff02::1", "ff05::2"]);
  expectBlocked("documentation 2001:db8::/32", ["2001:db8::1", "2001:0db8:ffff::1"]);

  console.log("NAT64 64:ff9b::/96 + 64:ff9b:1::/48 — the low 32 bits are an IPv4:");
  expectBlocked("NAT64 wrapping a private v4", [
    "64:ff9b::a9fe:a9fe", // 169.254.169.254 (hex)
    "64:ff9b::169.254.169.254", // same, dotted
    "64:ff9b::7f00:1", // 127.0.0.1
    "64:ff9b::10.0.0.1",
    "64:ff9b:1::a00:1", // RFC 8215 local-use prefix, 10.0.0.1
  ]);
  expectAllowed("NAT64 wrapping a PUBLIC v4", ["64:ff9b::808:808", "64:ff9b::8.8.8.8"]);

  console.log("6to4 2002::/16 — bits 16..47 are an IPv4:");
  expectBlocked("6to4 wrapping a private v4", [
    "2002:c0a8::", // 192.168.0.0
    "2002:c0a8:0101::1", // 192.168.1.1
    "2002:7f00:1::", // 127.0.0.1
    "2002:a9fe:a9fe::1", // 169.254.169.254
  ]);
  expectAllowed("6to4 wrapping a PUBLIC v4", ["2002:808:808::1"]);

  console.log("IPv6 public:");
  expectAllowed("global unicast", ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4007:80e::200e"]);

  // ── Unparseable → blocked (fail closed) ────────────────────────────────────
  console.log("unparseable input fails CLOSED:");
  expectBlocked("garbage", [
    "",
    "not-an-ip",
    "localhost",
    "256.1.1.1",
    "1.2.3",
    "1.2.3.4.5",
    " 127.0.0.1",
    "[::1]", // bracketed URL form (the caller strips brackets before classifying)
    "0177.0.0.1", // octal-looking — never parsed as the public 177.0.0.1
    "0x7f.0.0.1",
    "2130706433", // integer form of 127.0.0.1
    "::ffff:999.1.1.1",
    "1::2::3",
    "gggg::1",
    "1:2:3:4:5:6:7:8:9",
  ]);

  // ── fetchRemoteImage: refused before any network I/O ───────────────────────
  console.log("fetchRemoteImage refuses literal internal hosts / bad URLs offline:");
  const cases: [string, string][] = [
    ["not a url", "invalid_url"],
    ["ftp://example.com/a.png", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["http://user:pass@example.com/a.png", "credentials"],
    ["http://example.com:8080/a.png", "port"],
    ["http://127.0.0.1/a.png", "blocked_host"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_host"],
    ["http://10.0.0.5/a.png", "blocked_host"],
    ["http://[::1]/a.png", "blocked_host"],
    ["http://[::ffff:127.0.0.1]/a.png", "blocked_host"], // URL → [::ffff:7f00:1]
    ["http://[fd00::1]/a.png", "blocked_host"],
    ["http://[64:ff9b::a9fe:a9fe]/a.png", "blocked_host"],
    ["http://0177.0.0.1/a.png", "blocked_host"], // WHATWG URL → 127.0.0.1
    ["http://2130706433/a.png", "blocked_host"], // WHATWG URL → 127.0.0.1
    ["http://0x7f.1/a.png", "blocked_host"], // WHATWG URL → 127.0.0.1
  ];
  for (const [url, code] of cases) {
    const got = await refusalCode(url);
    check(`${url} → ${code}${got === code ? "" : ` (got ${got})`}`, got === code);
  }

  // ── One shared classifier ──────────────────────────────────────────────────
  console.log("the outbound-webhook transport reuses this classifier:");
  const ssrfFetchSrc = readFileSync(join(process.cwd(), "src", "lib", "net", "ssrf-fetch.ts"), "utf8");
  check(
    "src/lib/net/ssrf-fetch.ts imports isBlockedIp from @/lib/media/fetch-remote-image",
    /import\s*\{[^}]*\bisBlockedIp\b[^}]*\}\s*from\s*["']@\/lib\/media\/fetch-remote-image["']/.test(ssrfFetchSrc),
  );
  check(
    "…and defines no second IP classifier of its own",
    !/function\s+isBlocked(?:Ip|V4|V6)\b/.test(ssrfFetchSrc),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
