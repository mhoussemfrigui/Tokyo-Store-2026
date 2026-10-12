import "server-only";

import { redirectQueries, redirectService } from "@/modules/redirects";
import { isPermanentStatus, normalizeSourcePath } from "./normalize";
import { isRedirectsEnabled } from "./config";

/**
 * Resolve the current storefront path against the admin redirects table and, if
 * an active rule matches, issue a real HTTP redirect BEFORE the page renders.
 *
 * Called at the TOP of the storefront `[slug]` / `[slug]/[sub]` page components
 * and the 3+-segment catch-all `[slug]/[sub]/[...rest]` (node RSC — the edge
 * proxy is deliberately DB-free), plus the blog / aide / brand / collection(s) /
 * marques / promo routes. Covers the flat URL namespace where retired / migrated
 * URLs live, for both live and dead paths. Sources it never sees (home, dedicated
 * static pages, application routes) are flagged in the admin — see
 * `redirectSourceCoverage` in ./normalize.
 *
 * Status mapping: 301/308 → `permanentRedirect` (308 on the wire), 302/307 →
 * `redirect` (307) — both SEO-equivalent to the classic 301/302.
 *
 * CONTRACT: `redirect()` / `permanentRedirect()` throw `NEXT_REDIRECT`, so they
 * are called OUTSIDE the try/catch (a catch would swallow the redirect) and the
 * caller must NOT wrap this in try/catch. A DB hiccup degrades to "no redirect"
 * (the page renders normally) — never a 500.
 */
export async function resolveRedirect(pathname: string): Promise<void> {
  const src = normalizeSourcePath(pathname);
  if (!src) return;

  let target: { id: string; destination: string; status: number } | null = null;
  try {
    if (!(await isRedirectsEnabled())) return;
    const row = await redirectQueries.findActiveBySource(src);
    if (row) target = { id: row.id, destination: row.destination, status: row.status_code };
  } catch {
    return; // settings/DB unavailable → render the page normally, never 500
  }
  if (!target) return;

  // Fire-and-forget analytics — never blocks or fails the redirect itself.
  void redirectService.recordHit(target.id).catch(() => {});

  // Lazy import (outside the try/catch above) so this server module doesn't
  // eagerly load next/navigation's client app-router-context at import time,
  // which breaks react-server test imports. The dynamic import cannot throw
  // NEXT_REDIRECT; only the redirect calls below do — the contract is preserved.
  const { permanentRedirect, redirect } = await import("next/navigation");
  // NEXT_REDIRECT throwers — must stay outside the try/catch above.
  if (isPermanentStatus(target.status)) permanentRedirect(target.destination);
  redirect(target.destination);
}
