import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { redirects } from "@/modules/redirects/schema";
import { redirectService } from "@/modules/redirects";
import { normalizeSourcePath } from "./normalize";
import { getOwnRedirectHosts, wouldLoop } from "./guard";

/** One old → new URL of a renamed entity (site paths, e.g. `/old` → `/new`). */
export type SlugRenameEdge = { from: string; to: string };

/**
 * Free the URL(s) an entity is served at: deactivate every ACTIVE rule whose
 * source is one of `paths` — the storefront resolvers run resolveRedirect BEFORE
 * the entity lookup, so such a rule makes the entity unreachable at its own URL
 * (and the sitemap / feeds list a URL that redirects). Each deactivation emits
 * `redirect.updated` (audit + webhooks). Best-effort: never throws — the entity
 * write already committed, so a failure only logs.
 */
export async function releaseRedirectShadows(
  paths: ReadonlyArray<string>,
  ctx: { actorUserId: string },
): Promise<void> {
  try {
    const wanted = [...new Set(paths.map((p) => normalizeSourcePath(p)).filter((p): p is string => !!p))];
    if (wanted.length === 0) return;
    const shadows = await db
      .select({ id: redirects.id, source: redirects.source_path, destination: redirects.destination })
      .from(redirects)
      .where(and(inArray(redirects.source_path, wanted), eq(redirects.is_active, true)));
    for (const shadow of shadows) {
      await redirectService.setActive(shadow.id, false);
      await bus.emit(
        "redirect.updated",
        {
          redirectId: shadow.id,
          source: shadow.source,
          changedFields: ["is_active"],
          destination: shadow.destination,
        },
        { actorUserId: ctx.actorUserId },
      );
    }
  } catch (err) {
    console.error("[auto-slug-redirect] shadowing redirect not released", paths, err);
  }
}

/**
 * Keep a renamed entity's old URL alive. When a LIVE entity (published product,
 * active category / brand / collection) changes slug, every indexed URL,
 * backlink, menu / banner href and already-sent email (back-in-stock, price-drop
 * embed `/${slug}`) pointing at the old slug would otherwise 404. This inserts a
 * 301 old → new rule in the admin redirects table (Système → Redirections), which
 * the storefront resolvers consult before the entity lookup.
 *
 * Called POST-COMMIT through {@link syncEntityUrlRedirects}. Best-effort: it never
 * throws — the rename already succeeded, so a failure only logs.
 *
 * Rules, per edge:
 *   - an ACTIVE rule whose source is the NEW path is deactivated
 *     ({@link releaseRedirectShadows}) — typically renaming back: A→B leaves
 *     `/A → /B`, then B→A must free `/A`;
 *   - an existing rule on the OLD source (active or not) is the operator's and is
 *     never overwritten;
 *   - a rule that would close a loop among the active rules is skipped.
 * The automatic rule then blocks the old slug for any OTHER entity until the
 * operator deactivates it: checkSlugAvailability refuses a slug whose URL carries
 * an active redirect.
 */
export async function createSlugRenameRedirects(
  edges: ReadonlyArray<SlugRenameEdge>,
  ctx: { actorUserId: string; label: string },
): Promise<void> {
  let ownHosts: Set<string> | null = null;
  for (const edge of edges) {
    try {
      const from = normalizeSourcePath(edge.from);
      const to = normalizeSourcePath(edge.to);
      if (!from || !to || from === to) continue;

      // 1. Free the new URL from a rule that would shadow the renamed entity.
      await releaseRedirectShadows([to], ctx);

      // 2. Never overwrite the operator's own rule for the old URL.
      const [existing] = await db
        .select({ id: redirects.id })
        .from(redirects)
        .where(eq(redirects.source_path, from))
        .limit(1);
      if (existing) continue;

      // 3. Loop guard over the active rules (same detector as the admin form).
      ownHosts ??= await getOwnRedirectHosts();
      if (await wouldLoop(from, to, ownHosts)) continue;

      const row = await redirectService.create({
        sourcePath: from,
        destination: to,
        statusCode: 301,
        isActive: true,
        notes: `Automatique — ${ctx.label}`.slice(0, 500),
      });
      if (!row) continue; // a concurrent rule claimed the source first
      await bus.emit(
        "redirect.created",
        { redirectId: row.id, source: from, destination: to },
        { actorUserId: ctx.actorUserId },
      );
    } catch (err) {
      console.error("[auto-slug-redirect] redirect not created", edge, err);
    }
  }
}

/**
 * Post-commit redirect upkeep after an update of a URL-bearing entity — the one
 * call the product / category / brand / collection update workflows make.
 * `before` / `after` are the entity's URLs (CANONICAL first; a sub-category also
 * lists its nested `/parent/<slug>`), `wasLive` / `isLive` its public state
 * (published / active) around the update.
 *
 *   1. Free its URLs from an active rule that would shadow it
 *      ({@link releaseRedirectShadows}):
 *        - when it just went LIVE (publication / re-activation): all its URLs —
 *          a rule left on them while it was offline (e.g. the operator
 *          redirected a withdrawn product to its successor) would otherwise hide
 *          it; going live is the operator saying « serve this URL »;
 *        - on a slug change: its NEW URLs, live or not. The slug checker only let
 *          through a rule leading back to the entity itself (renaming back), so
 *          releasing it is always safe — and a later publication through any
 *          path is not left shadowed;
 *        - a LIVE sub-category re-parented: its new nested `/parent/slug`.
 *   2. When it was AND stays live and its canonical URL changed: 301 each old URL
 *      → the new canonical one ({@link createSlugRenameRedirects}).
 */
export async function syncEntityUrlRedirects(
  change: {
    wasLive: boolean;
    isLive: boolean;
    before: ReadonlyArray<string>;
    after: ReadonlyArray<string>;
  },
  ctx: { actorUserId: string; label: string },
): Promise<void> {
  const { wasLive, isLive, before, after } = change;
  const canonicalChanged = before[0] !== after[0];
  const fresh = after.filter((p) => !before.includes(p));
  // Just went live → all its URLs; otherwise only URLs it did not have before
  // (a rename, or a live sub-category's new nested path after a re-parent).
  const toRelease = isLive && !wasLive ? after : canonicalChanged || isLive ? fresh : [];
  if (toRelease.length > 0) await releaseRedirectShadows(toRelease, ctx);
  if (wasLive && isLive && canonicalChanged && after[0]) {
    const to = after[0];
    await createSlugRenameRedirects(
      before.filter((from) => !after.includes(from)).map((from) => ({ from, to })),
      ctx,
    );
  }
}
