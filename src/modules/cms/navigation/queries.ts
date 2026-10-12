import "server-only";

import { navigationService } from "./service";
import { resolveLinkHref } from "@/lib/links/link-target";
import type { NavItemRow } from "./schema";

export type NavItemNode = NavItemRow & {
  resolvedHref: string;
  children: NavItemNode[];
};

/**
 * Build a nav tree (parent_id nesting + resolvedHref) from a flat row list.
 * Shared by getMenu and the batched footer path so they can't drift.
 */
export function buildNavTree(rows: NavItemRow[]): NavItemNode[] {
  const byParent = new Map<string | null, NavItemRow[]>();
  for (const it of rows) {
    const p = it.parent_id ?? null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(it);
  }
  const build = (parentId: string | null): NavItemNode[] =>
    (byParent.get(parentId) ?? []).map((it) => ({
      ...it,
      resolvedHref: resolveLinkHref({
        href: it.href,
        internalKind: it.internal_kind,
        internalRef: it.internal_ref,
      }),
      children: build(it.id),
    }));
  return build(null);
}

/**
 * Returns the menu items for a given menu key, resolved into a tree with
 * `resolvedHref` filled in (internal refs resolve to the flat /<slug>
 * namespace — brands included; see resolveLinkHref).
 */
export async function getMenu(key: string): Promise<NavItemNode[]> {
  const menu = await navigationService.findMenuByKey(key);
  if (!menu) return [];
  return buildNavTree(await navigationService.listItemsForMenu(menu.id));
}
