import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { redirects } from "@/modules/redirects/schema";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import {
  normalizeSourcePath,
  ownHostsFrom,
  redirectChainHasCycle,
  redirectChainReaches,
} from "./normalize";

/**
 * Server-side redirect guards shared by the admin redirect actions, the
 * automatic slug-rename redirects (lib/redirects/auto-slug-redirect.ts) and the
 * slug checker (lib/utils/slug-conflict.ts): the store's own hosts (same-origin
 * vs off-site destinations), the multi-hop loop check over the ACTIVE rules and
 * the "would a rule shadow this entity URL" lookup. The pure logic lives in
 * ./normalize.
 */

/**
 * The store's own hosts: the public origin (`seo.site_url` → NEXT_PUBLIC_SITE_URL
 * precedence, see resolvePublicOrigin) plus the env-declared origins, each in
 * its apex + www form. Never throws (resolvePublicOrigin degrades to the env).
 */
export async function getOwnRedirectHosts(): Promise<Set<string>> {
  return ownHostsFrom([
    await resolvePublicOrigin(),
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.BETTER_AUTH_URL,
  ]);
}

/** Active source→destination edge map (optionally excluding one row being edited). */
export async function loadActiveRedirectEdges(ignoreId?: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: redirects.id, source: redirects.source_path, destination: redirects.destination })
    .from(redirects)
    .where(eq(redirects.is_active, true))
    .catch(() => [] as Array<{ id: string; source: string; destination: string }>);
  const edges = new Map<string, string>();
  for (const e of rows) if (e.id !== ignoreId) edges.set(e.source, e.destination);
  return edges;
}

/**
 * Would activating source→destination close a redirect cycle among the active
 * rules? The direct A→A case is caught at parse time; this catches A→B→A and
 * longer chains (ERR_TOO_MANY_REDIRECTS in the browser), including hops through
 * a same-origin ABSOLUTE destination (`/a → https://<store>/b`, `/b → /a`).
 */
export async function wouldLoop(
  source: string,
  destination: string,
  ownHosts: ReadonlySet<string>,
  ignoreId?: string,
): Promise<boolean> {
  const edges = await loadActiveRedirectEdges(ignoreId);
  edges.set(source, destination);
  return redirectChainHasCycle(edges, source, ownHosts);
}

/** An active rule sitting on a URL an entity claims (see {@link findShadowingRedirect}). */
export type ShadowingRedirect = { id: string; source: string; destination: string };

/**
 * The ACTIVE redirect rule that would shadow an entity served at one of `paths`:
 * the storefront resolvers run resolveRedirect BEFORE the entity lookup, so a
 * live rule on the entity's URL makes it unreachable (while the sitemap / feeds
 * list that URL). Null when none. Throws on a DB error, like the slug checker's
 * other lookups.
 *
 * `ownPaths` = the URL(s) the claimant CURRENTLY lives at (a rename). A rule
 * whose chain reaches one of them points AT the claimant — renaming back (A→B
 * left the automatic `/A → /B`, then B→A reclaims `/A`) — so it doesn't count:
 * the update workflow releases it once the rename commits (syncEntityUrlRedirects).
 */
export async function findShadowingRedirect(
  paths: ReadonlyArray<string>,
  ownPaths: ReadonlyArray<string> = [],
): Promise<ShadowingRedirect | null> {
  const wanted = [...new Set(paths.map((p) => normalizeSourcePath(p)).filter((p): p is string => !!p))];
  if (wanted.length === 0) return null;
  const rows = await db
    .select({ id: redirects.id, source: redirects.source_path, destination: redirects.destination })
    .from(redirects)
    .where(and(inArray(redirects.source_path, wanted), eq(redirects.is_active, true)));
  if (rows.length === 0) return null;
  // Report the claimant's canonical URL first (paths[0]).
  rows.sort((a, b) => wanted.indexOf(a.source) - wanted.indexOf(b.source));
  const own = new Set(ownPaths.map((p) => normalizeSourcePath(p)).filter((p): p is string => !!p));
  if (own.size === 0) return rows[0]!;
  const [edges, ownHosts] = await Promise.all([loadActiveRedirectEdges(), getOwnRedirectHosts()]);
  return rows.find((r) => !redirectChainReaches(edges, r.source, own, ownHosts)) ?? null;
}
