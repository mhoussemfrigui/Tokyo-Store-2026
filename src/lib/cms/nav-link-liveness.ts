/**
 * Dead-link pruning for the storefront menus (header `main` + footer columns).
 *
 * A nav item that targets a category / brand stores only its slug
 * (`internal_kind` + `internal_ref`), and `resolveLinkHref` turns it into a URL
 * blindly. Once that target is deactivated or deleted, the link keeps rendering
 * on every page and 404s. The storefront reader (`lib/api/cms.ts`) checks those
 * refs against the LIVE storefront-visible slug sets and drops the dead items
 * (with their sub-items, like a hidden item). Pure: the caller supplies the sets.
 *
 * Exception: a ref an ACTIVE redirect still serves is not dead. `internal_ref`
 * is never rewritten on a slug rename, but the rename 301 (or an operator rule)
 * keeps the old URL working — the caller re-admits those refs with
 * `admitNavRefs` (candidates from `listDeadNavItems`) before pruning.
 */

/** Storefront-visible slugs per checked kind (active and not deleted). `page` =
 *  published, non-deleted CMS page slugs the `/[slug]` route renders. `system` =
 *  VISIBLE showcase slugs (Catalogues → pages.<slug>.visible) — a hidden showcase
 *  page hard-404s (no built-in default), so a nav link to it must be pruned. */
export type LiveNavTargets = {
  category: ReadonlySet<string>;
  brand: ReadonlySet<string>;
  page: ReadonlySet<string>;
  system: ReadonlySet<string>;
};

type NavTargetFields = {
  href: string | null;
  internal_kind: string | null;
  internal_ref: string | null;
};

type NavTreeNode<T> = NavTargetFields & { children: T[] };

/**
 * The kind to check for an item, or null when it can't go dead this way: a manual `href`
 * wins over the internal ref in `resolveLinkHref` (so a legal/maison link stored as a plain
 * `/cgv` href is NEVER checked here — it stays even if the page row is unpublished, which is
 * correct since its system default still renders). A `page` ref (internal_kind='page') IS
 * checked against the PUBLISHED slug set — note this prunes the link once the page is
 * unpublished even for a slug that still renders via a built-in default; use a manual href
 * for a system-default page you want to keep linked. A `system` ref (the showcase slugs —
 * Nouveautés / Top ventes / Promotions) IS checked against the VISIBLE-showcase set: a hidden
 * showcase page hard-404s (no built-in default), so its nav link must be pruned. Legacy
 * product refs are not checked.
 */
export function checkedNavKind(item: NavTargetFields): keyof LiveNavTargets | null {
  if (item.href?.trim()) return null;
  if (!item.internal_ref?.trim()) return null;
  const kind = item.internal_kind?.trim();
  return kind === "category" ||
    kind === "brand" ||
    kind === "page" ||
    kind === "system"
    ? kind
    : null;
}

/** True when any item in the tree carries a checked internal ref, so the
 *  caller only loads the live sets when there is something to check. */
export function hasCheckedNavRef<T extends NavTreeNode<T>>(items: readonly T[]): boolean {
  return items.some((it) => checkedNavKind(it) !== null || hasCheckedNavRef(it.children));
}

/**
 * Every item, at any depth, whose checked ref is NOT in `live` — the prune
 * candidates the caller may re-admit (e.g. a URL an active redirect serves).
 * Sub-items of a dead item are included: they survive if the parent is
 * re-admitted, so they need their own check.
 */
export function listDeadNavItems<T extends NavTreeNode<T>>(
  items: readonly T[],
  live: LiveNavTargets,
): T[] {
  const out: T[] = [];
  for (const it of items) {
    const kind = checkedNavKind(it);
    if (kind && !live[kind].has(it.internal_ref!.trim())) out.push(it);
    out.push(...listDeadNavItems(it.children, live));
  }
  return out;
}

/**
 * A copy of `live` that also admits the (kind, ref) of each given item, so
 * `pruneDeadNavItems` keeps them. Items outside the checked kinds are ignored;
 * `live` itself is never mutated (it is the shared cached set).
 */
export function admitNavRefs(
  live: LiveNavTargets,
  items: readonly NavTargetFields[],
): LiveNavTargets {
  if (items.length === 0) return live;
  const next = {
    category: new Set(live.category),
    brand: new Set(live.brand),
    page: new Set(live.page),
    system: new Set(live.system),
  };
  for (const it of items) {
    const kind = checkedNavKind(it);
    if (kind) next[kind].add(it.internal_ref!.trim());
  }
  return next;
}

/**
 * Drop every item whose category / brand ref is not in `live`
 * (its sub-items go with it). `live = null` means "unknown" (build phase or a
 * failed lookup): the tree is returned unchanged, so a lookup hiccup never
 * blanks a menu.
 */
export function pruneDeadNavItems<T extends NavTreeNode<T>>(
  items: readonly T[],
  live: LiveNavTargets | null,
): T[] {
  if (!live) return [...items];
  const out: T[] = [];
  for (const it of items) {
    const kind = checkedNavKind(it);
    if (kind && !live[kind].has(it.internal_ref!.trim())) continue;
    out.push({ ...it, children: pruneDeadNavItems(it.children, live) });
  }
  return out;
}
