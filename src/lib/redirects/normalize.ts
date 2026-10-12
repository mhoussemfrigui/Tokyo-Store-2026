/**
 * Pure normalizers + CSV parsing for the admin redirects manager. The single
 * place that turns free-text admin / CSV input into safe values — consumed by
 * the service (writes), the resolver (lookup), and the CSV import. No DB →
 * unit-tested in db/tests/redirects.test.ts.
 */

import { REDIRECT_STATUS_CODES, type RedirectStatusCode } from "@/modules/redirects/schema";
import {
  APP_ROUTE_SHAPES,
  REDIRECT_AWARE_STATIC_ROUTES,
  STATIC_SINGLE_SEGMENT_ROUTES,
} from "@/lib/pages/reserved-routes";

export const DEFAULT_STATUS: RedirectStatusCode = 301;

/**
 * Normalize a source path for storage + matching: must be a site-root path.
 * Strips the query string + hash, collapses to a single leading slash, drops a
 * trailing slash (except root "/"), and trims. Returns null for anything that
 * isn't a usable path (empty, no leading slash, absolute URL) so callers can
 * reject it. Case is preserved (URLs are case-sensitive past the host).
 */
export function normalizeSourcePath(raw: string | null | undefined): string | null {
  let p = (raw ?? "").trim();
  if (!p) return null;
  // Strip query/hash — redirects match on the path only.
  p = p.split(/[?#]/)[0]!;
  // Decode percent-encoding so a stored source matches Next's already-decoded
  // incoming param (a pre-encoded paste like /caf%C3%A9 ⇒ /café). Malformed
  // encoding (a lone %) is kept verbatim.
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  if (!p.startsWith("/")) return null;
  // Collapse duplicate leading slashes, then trailing slash (keep root).
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (/\s/.test(p)) return null; // a path can't contain whitespace
  return p || "/";
}

/**
 * Normalize a destination: an absolute http(s) URL (kept verbatim) OR a
 * site-root path (leading slash). Returns null for anything else (relative,
 * mailto:, javascript:, garbage) so a redirect can never point somewhere unsafe.
 */
export function normalizeDestination(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (t.startsWith("/")) {
    if (/\s/.test(t)) return null;
    // Same slash normalization as the source (collapse dups, strip trailing,
    // keep root) so a `/a → /a/` rule reduces to source === destination and is
    // caught by the self-loop guard instead of becoming an infinite 308 bounce
    // (Next's trailingSlash:false would ping-pong /a/ ↔ /a).
    let d = t.replace(/\/{2,}/g, "/");
    if (d.length > 1) d = d.replace(/\/+$/, "");
    return d;
  }
  try {
    const u = new URL(t);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* not a URL */
  }
  return null;
}

/** Coerce to one of the allowed redirect status codes; default 301. */
export function normalizeStatusCode(raw: string | number | null | undefined): RedirectStatusCode {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? "").trim(), 10);
  return (REDIRECT_STATUS_CODES as readonly number[]).includes(n)
    ? (n as RedirectStatusCode)
    : DEFAULT_STATUS;
}

/** A 301/308 is permanent; 302/307 is temporary. Drives the resolver's choice. */
export function isPermanentStatus(code: number): boolean {
  return code === 301 || code === 308;
}

// ── Same-origin vs off-site destinations ────────────────────────────────────

/**
 * The store's OWN hosts, from its configured origins (the public origin /
 * `seo.site_url`, NEXT_PUBLIC_SITE_URL, BETTER_AUTH_URL — gathered server-side by
 * lib/redirects/guard.ts). Each host also counts in its `www.`-toggled form (apex
 * and www serve the same store). A non-default port stays part of the host.
 */
export function ownHostsFrom(origins: ReadonlyArray<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const o of origins) {
    const t = (o ?? "").trim();
    if (!t) continue;
    try {
      const host = new URL(t).host.toLowerCase();
      if (!host) continue;
      out.add(host);
      out.add(host.startsWith("www.") ? host.slice(4) : `www.${host}`);
    } catch {
      /* not a URL — ignore */
    }
  }
  return out;
}

/** Lower-cased host of an absolute http(s) destination; null for a site path. */
function absoluteHost(dest: string): string | null {
  if (dest.startsWith("/")) return null;
  try {
    const u = new URL(dest);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The INTERNAL path a destination lands on, normalized like a source so it can be
 * compared with one / followed through the redirect graph: a site path as-is
 * (query/hash dropped — the resolver matches on the path only), and an absolute
 * URL on one of the store's own hosts mapped to its pathname
 * (`https://<store>/a` ≡ `/a`: the browser comes straight back into this table).
 * Null for an off-site URL — it cannot chain internally.
 */
export function internalDestinationPath(dest: string, ownHosts: ReadonlySet<string>): string | null {
  if (dest.startsWith("/")) return normalizeSourcePath(dest);
  const host = absoluteHost(dest);
  if (!host || !ownHosts.has(host)) return null;
  return normalizeSourcePath(new URL(dest).pathname);
}

/** An absolute destination whose host is NOT one of the store's own. */
export function isOffsiteDestination(dest: string, ownHosts: ReadonlySet<string>): boolean {
  const host = absoluteHost(dest);
  return host !== null && !ownHosts.has(host);
}

/**
 * The status actually stored for a destination: an off-site target is never a
 * PERMANENT redirect (301/308 → 307) — the store's link equity must not be
 * consolidated onto another domain, and a temporary hop is dropped by clients
 * and crawlers as soon as the rule is removed.
 */
export function effectiveStatusFor(
  dest: string,
  status: RedirectStatusCode,
  ownHosts: ReadonlySet<string>,
): RedirectStatusCode {
  return isOffsiteDestination(dest, ownHosts) && isPermanentStatus(status) ? 307 : status;
}

/**
 * Pure cycle walk: follow source→destination edges from `start`; a revisited
 * node (or returning to `start`) is a loop. A same-origin absolute destination is
 * followed as its path (`/a → https://<store>/a` IS a loop); an off-site URL
 * can't chain internally, so it terminates the walk.
 */
export function redirectChainHasCycle(
  edges: ReadonlyMap<string, string>,
  start: string,
  ownHosts: ReadonlySet<string> = new Set(),
): boolean {
  const seen = new Set<string>();
  let cur: string | undefined = start;
  let hops = 0;
  while (cur && hops < 100) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const raw = edges.get(cur);
    if (raw === undefined) return false;
    const next = internalDestinationPath(raw, ownHosts);
    if (!next) return false;
    cur = next;
    hops += 1;
  }
  return true; // exceeded the hop cap → treat as a loop
}

/**
 * Does the chain starting at `start` (its own rule included) pass through one of
 * `targets`? Same walk as {@link redirectChainHasCycle}: a same-origin absolute
 * hop is followed as its path; an off-site URL, a missing rule, a revisited node
 * or the hop cap end it (false).
 */
export function redirectChainReaches(
  edges: ReadonlyMap<string, string>,
  start: string,
  targets: ReadonlySet<string>,
  ownHosts: ReadonlySet<string> = new Set(),
): boolean {
  const seen = new Set<string>([start]);
  let cur = start;
  for (let hops = 0; hops < 100; hops++) {
    const raw = edges.get(cur);
    if (raw === undefined) return false;
    const next = internalDestinationPath(raw, ownHosts);
    if (!next) return false;
    if (targets.has(next)) return true;
    if (seen.has(next)) return false;
    seen.add(next);
    cur = next;
  }
  return false;
}

/**
 * Does the chain starting at `start` end on ANOTHER domain — its own rule is
 * off-site, or it hops (through internal / same-origin rules) into one that is?
 * A loop or the hop cap ends it without leaving the site (false).
 */
export function redirectChainEndsOffsite(
  edges: ReadonlyMap<string, string>,
  start: string,
  ownHosts: ReadonlySet<string> = new Set(),
): boolean {
  const seen = new Set<string>();
  let cur = start;
  for (let hops = 0; hops < 100; hops++) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    const raw = edges.get(cur);
    if (raw === undefined) return false;
    if (isOffsiteDestination(raw, ownHosts)) return true;
    const next = internalDestinationPath(raw, ownHosts);
    if (!next) return false;
    cur = next;
  }
  return false;
}

/**
 * The OWNER gate (`*`) for a redirect write — the admin form (create / edit) and
 * the activation toggle. A rule needs the owner when it sends visitors to another
 * domain: directly (an off-site destination, even saved inactive — the toggle is
 * the only way back on), or, once ACTIVE, by chaining into an off-site rule (a
 * delegate's `/best-seller → /partenaire` riding the owner's
 * `/partenaire → https://partner.tn`). Keeping an existing rule's exact edge
 * (same source AND destination) without re-activating it stays open to delegates
 * (notes, deactivation…) — moving the owner's off-site rule onto another source
 * does not.
 *
 * `activeEdges` = the active rules EXCLUDING the one being written.
 */
export function redirectWriteNeedsOwner(input: {
  source: string;
  destination: string;
  isActive: boolean;
  prev?: { source: string; destination: string; isActive: boolean } | null;
  activeEdges: ReadonlyMap<string, string>;
  ownHosts: ReadonlySet<string>;
}): boolean {
  const { source, destination, isActive, prev, activeEdges, ownHosts } = input;
  const keepsEdge =
    prev != null &&
    prev.source === source &&
    prev.destination === destination &&
    (prev.isActive || !isActive);
  if (keepsEdge) return false;
  if (isOffsiteDestination(destination, ownHosts)) return true;
  if (!isActive) return false;
  const edges = new Map(activeEdges);
  edges.set(source, destination);
  return redirectChainEndsOffsite(edges, source, ownHosts);
}

// ── Coverage: which sources the storefront actually resolves ────────────────

/**
 * Where a source path is looked up. `resolveRedirect` runs at the top of the
 * dynamic storefront routes — `/[slug]`, `/[slug]/[sub]`, the 3+-segment
 * catch-all `/[slug]/[sub]/[...rest]`, blog / brand / collection(s) /
 * marques / promo — so most paths are `covered`. It never runs for:
 *   - `home`   — `/` (the home page);
 *   - `static` — a dedicated single-segment page (`/about`, `/cgu`, `/login`…),
 *     which always wins over `/[slug]`;
 *   - `app`    — a multi-segment URL an application / machine route or a legacy
 *     next.config 308 answers first (`/order/<id>`, `/account/orders/<id>`,
 *     `/login/2fa`, `/category/<x>`, `/product/<x>`, `/admin/…`, `/api/…` — the
 *     exact shapes are APP_ROUTE_SHAPES). A deeper or different path under the
 *     same prefix (`/product/<cat>/<slug>`, `/login/x`…) reaches the resolver.
 * A rule on those saves fine but never fires — the admin warns about it.
 */
export type RedirectSourceCoverage = "covered" | "home" | "static" | "app";

/** Does `segs` match an APP_ROUTE_SHAPES entry (`*` = one segment, trailing `**` = one or more)? */
function matchesRouteShape(segs: ReadonlyArray<string>, shape: string): boolean {
  const parts = shape.split("/");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "**") return segs.length > i;
    if (i >= segs.length) return false;
    if (p !== "*" && p !== segs[i]) return false;
  }
  return segs.length === parts.length;
}

export function redirectSourceCoverage(source: string): RedirectSourceCoverage {
  // Routes are case-sensitive (`/About` is NOT the /about page → it reaches /[slug]).
  const segs = source.split("/").filter(Boolean);
  if (segs.length === 0) return "home";
  const first = segs[0]!;
  if (segs.length === 1) {
    return STATIC_SINGLE_SEGMENT_ROUTES.has(first) && !REDIRECT_AWARE_STATIC_ROUTES.has(first)
      ? "static"
      : "covered";
  }
  return APP_ROUTE_SHAPES.some((shape) => matchesRouteShape(segs, shape)) ? "app" : "covered";
}

/** French operator warning for a source the storefront never resolves (null = covered). */
export function redirectCoverageWarning(source: string): string | null {
  switch (redirectSourceCoverage(source)) {
    case "home":
      return "la page d'accueil (/) ne passe pas par le moteur de redirections : cette règle ne s'appliquera jamais.";
    case "static":
      return `« ${source} » est une page dédiée du site : elle s'affiche toujours, cette règle ne s'appliquera jamais.`;
    case "app":
      return `« ${source} » relève d'une route applicative ou système (compte, commande, connexion, administration, API…) : cette règle ne s'appliquera jamais.`;
    default:
      return null;
  }
}

export type ParsedRedirect = {
  source: string;
  destination: string;
  status: RedirectStatusCode;
};
export type CsvParseResult = {
  rows: ParsedRedirect[];
  errors: Array<{ line: number; message: string }>;
};

/** Cap on rows accepted from one CSV import (guards a giant paste). */
export const MAX_CSV_ROWS = 5000;

/** Split one CSV line into fields, honoring double-quoted fields with "" escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse a redirects CSV into validated rows + per-line errors. Columns:
 * `source, destination, status` (status optional → defaults 301). A header row
 * (first cell ~ "source"/"from"/"old") is detected + skipped; blank lines are
 * ignored. Invalid source/destination rows are reported, not silently dropped.
 * De-dupes by source (last wins) so a CSV can't carry two rows for one path.
 * `ownHosts` (see {@link ownHostsFrom}) lets the self-loop check see through a
 * same-origin absolute destination.
 */
export function parseRedirectsCsv(
  text: string | null | undefined,
  ownHosts: ReadonlySet<string> = new Set(),
): CsvParseResult {
  const rows: ParsedRedirect[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  if (!text) return { rows, errors };
  const bySource = new Map<string, number>(); // source → index in rows (last wins)

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let seenContent = false; // first NON-BLANK line — where the header may sit
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const cells = splitCsvLine(raw);
    const c0 = (cells[0] ?? "").toLowerCase();
    // Skip a header row — detected on the first non-blank line (a leading blank
    // line must not push the header to a data row).
    if (!seenContent) {
      seenContent = true;
      if (c0 === "source" || c0 === "from" || c0 === "old" || c0 === "source_path") continue;
    }
    const source = normalizeSourcePath(cells[0]);
    const destination = normalizeDestination(cells[1]);
    if (!source) {
      errors.push({ line: i + 1, message: `Source invalide : « ${cells[0] ?? ""} » (doit commencer par /)` });
      continue;
    }
    if (!destination) {
      errors.push({ line: i + 1, message: `Destination invalide : « ${cells[1] ?? ""} » (chemin / ou URL http(s))` });
      continue;
    }
    // Reject a self-redirect (source === destination, incl. a same-origin absolute
    // URL or a query-string variant of the source) — it 301s a URL to itself, an
    // infinite client loop. The single-row form already blocks this; mirror it
    // here so the CSV bulk path can't smuggle one in.
    if (internalDestinationPath(destination, ownHosts) === source) {
      errors.push({ line: i + 1, message: `Boucle ignorée : la source et la destination sont identiques (« ${source} »)` });
      continue;
    }
    const status = normalizeStatusCode(cells[2]);
    const existing = bySource.get(source);
    if (existing !== undefined) {
      rows[existing] = { source, destination, status };
    } else {
      bySource.set(source, rows.length);
      rows.push({ source, destination, status });
      if (rows.length >= MAX_CSV_ROWS) {
        // Surface the truncation so the operator knows rows were dropped
        // (was a silent break).
        errors.push({
          line: i + 1,
          message: `Limite de ${MAX_CSV_ROWS} lignes atteinte — les lignes suivantes sont ignorées.`,
        });
        break;
      }
    }
  }
  return { rows, errors };
}

/** Example CSV offered for download in the admin (template for bulk import). */
export const EXAMPLE_REDIRECTS_CSV = [
  "source,destination,status",
  "/ancienne-page,/nouvelle-page,301",
  "/ancien-iphone,/telephonie,301",
  "/promo-noel,/promotions,302",
  "/old-brand,https://tokyostore.tn/,301",
].join("\n");
