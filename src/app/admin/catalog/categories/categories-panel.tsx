"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  FolderTree,
  List,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { AdminCallout, AdminNote } from "@/components/admin/_components/filter-bar";
import {
  deleteCategoryAction,
  reorderCategoriesAction,
  setCategoryActiveAction,
} from "@/lib/actions/catalog";

type Cat = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  isActive: boolean;
  displayOrder: number;
  /**
   * Storefront-REACHABLE: this node AND every ancestor active. A category left
   * active under a DEACTIVATED parent is not reachable — it 404s at /[slug] — so
   * the "Voir sur la boutique" link is hidden and a "parent désactivé" hint shown
   * (isActive alone would offer a link that 404s). Computed when the page projects
   * the tree.
   */
  reachable: boolean;
};
// Recursive — a category nests its children to ANY depth (root → child →
// grandchild → …).
export type CategoryTreeNode = Cat & { children: CategoryTreeNode[] };

type View = "drilldown" | "flat";

const NEW_HREF = "/admin/catalog/categories/new";

// In-list view toggle (Navigation / Liste), rendered as a light underline strip.
const VIEW_TABS = [
  { id: "drilldown" as const, label: "Navigation", icon: FolderTree },
  { id: "flat" as const, label: "Liste", icon: List },
];

/** Flatten the whole tree depth-first into rows carrying their ancestor path label. */
function flattenTree(
  tree: CategoryTreeNode[],
): Array<{ node: CategoryTreeNode; pathLabel: string }> {
  const out: Array<{ node: CategoryTreeNode; pathLabel: string }> = [];
  const walk = (nodes: CategoryTreeNode[], prefix: string) => {
    for (const n of nodes) {
      const pathLabel = prefix ? `${prefix} › ${n.name}` : n.name;
      out.push({ node: n, pathLabel });
      if (n.children.length > 0) walk(n.children, pathLabel);
    }
  };
  walk(tree, "");
  return out;
}

export function CategoriesPanel({
  tree,
  canCreate,
  canUpdate,
  canDelete,
}: {
  tree: CategoryTreeNode[];
  /** Category CRUD gates — hide controls whose server action would 404 for a view-only role. */
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>("drilldown");
  const [toDelete, setToDelete] = useState<{ cat: Cat; childCount: number } | null>(null);
  // Drill-down location: ids root→…→current parent. Empty = show root categories.
  const [path, setPath] = useState<string[]>([]);

  // Inline active-toggle + reorder: one pending indicator each, plus a shared
  // error line (both actions are server-gated on categories:update).
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [togglePending, startToggle] = useTransition();
  const [reorderPending, startReorder] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  // Resolve the current drill-down level + breadcrumb.
  const breadcrumb: CategoryTreeNode[] = [];
  let cursor = tree;
  for (const id of path) {
    const node = cursor.find((n) => n.id === id);
    if (!node) break;
    breadcrumb.push(node);
    cursor = node.children;
  }
  const currentParent = breadcrumb[breadcrumb.length - 1] ?? null;
  const currentLevel = currentParent ? currentParent.children : tree;
  // Only walked for the flat view — memoised so a view toggle / drill / modal
  // open doesn't re-walk the whole tree.
  const flat = useMemo(() => flattenTree(tree), [tree]);

  // "Nouvelle catégorie" goes to the dedicated create page; in drill-down it
  // pre-fills the parent to the current level so the new node lands there.
  const newHref =
    view === "drilldown" && currentParent ? `${NEW_HREF}?parent=${currentParent.id}` : NEW_HREF;

  const handleToggleActive = (node: CategoryTreeNode, childCount: number) => {
    // is_active cascades to the WHOLE subtree on the storefront — warn before
    // hiding a node that has children.
    if (node.isActive && childCount > 0) {
      const confirmed = window.confirm(
        `Désactiver « ${node.name} » la masquera de la boutique, ainsi que ses ${childCount} sous-catégorie(s) et tous leurs produits. Continuer ?`,
      );
      if (!confirmed) return;
    }
    setActionError(null);
    setTogglingId(node.id);
    startToggle(async () => {
      const res = await setCategoryActiveAction(node.id, !node.isActive);
      if (!res.ok) setActionError(res.message ?? "Action impossible.");
      setTogglingId(null);
      router.refresh();
    });
  };

  const handleMove = (
    parentId: string | null,
    siblings: CategoryTreeNode[],
    index: number,
    dir: -1 | 1,
  ) => {
    const target = index + dir;
    if (target < 0 || target >= siblings.length) return;
    const ids = siblings.map((s) => s.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setActionError(null);
    startReorder(async () => {
      const res = await reorderCategoriesAction(parentId, ids);
      if (!res.ok) setActionError(res.message ?? "Réordonnancement impossible.");
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      <AdminNote className="max-w-3xl">
        Arborescence du catalogue — sous-catégories sur plusieurs niveaux.
      </AdminNote>

      {actionError && <AdminCallout tone="danger">{actionError}</AdminCallout>}

      {(tree.length > 0 || canCreate) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
          {/* In-list view toggle (Navigation / Liste) — a light underline strip. */}
          {tree.length > 0 ? <ListViewToggle view={view} onSelect={setView} /> : <div />}
          {canCreate && (
            <Link
              href={newHref}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
            >
              <Plus className="h-4 w-4" /> Nouvelle catégorie
            </Link>
          )}
        </div>
      )}
      {tree.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          Aucune catégorie pour l&apos;instant. Créez la première pour démarrer le catalogue.
        </div>
      ) : view === "flat" ? (
        // ─── Flat view: every category, with its full ancestor path. ───────
        <ul className="space-y-2">
          {flat.map(({ node, pathLabel }) => (
            <li key={node.id} className="rounded-[16px] border border-border bg-card px-4 py-3 sm:px-5">
              <CategoryRow
                node={node}
                subtitle={pathLabel}
                childCount={node.children.length}
                canCreate={canCreate}
                canUpdate={canUpdate}
                canDelete={canDelete}
                onToggleActive={handleToggleActive}
                togglePending={togglePending && togglingId === node.id}
                onAskDelete={(cat, childCount) => setToDelete({ cat, childCount })}
              />
            </li>
          ))}
        </ul>
      ) : (
        // ─── Drill-down view: one level at a time, with a breadcrumb. ──────
        <div className="space-y-4">
          <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Fil d'Ariane">
            <button
              type="button"
              onClick={() => setPath([])}
              className={`rounded-full px-3 py-1 transition ${
                path.length === 0 ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]" : "font-semibold text-muted-foreground hover:text-foreground"
              }`}
            >
              Toutes les catégories
            </button>
            {breadcrumb.map((b, i) => (
              <span key={b.id} className="flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => setPath(path.slice(0, i + 1))}
                  className={`rounded-full px-3 py-1 transition ${
                    i === breadcrumb.length - 1 ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]" : "font-semibold text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {b.name}
                </button>
              </span>
            ))}
          </nav>

          {currentLevel.length === 0 ? (
            <div className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-8 text-center text-[14px] text-muted-foreground">
              Aucune sous-catégorie ici. Utilisez « Nouvelle catégorie » pour en ajouter une.
            </div>
          ) : (
            <ul className="space-y-2">
              {currentLevel.map((node, i) => (
                <li key={node.id} className="rounded-[16px] border border-border bg-card px-4 py-3 sm:px-5">
                  <CategoryRow
                    node={node}
                    subtitle={`/${node.slug}`}
                    childCount={node.children.length}
                    onDrill={node.children.length > 0 ? () => setPath([...path, node.id]) : undefined}
                    canCreate={canCreate}
                    canUpdate={canUpdate}
                    canDelete={canDelete}
                    onToggleActive={handleToggleActive}
                    togglePending={togglePending && togglingId === node.id}
                    onAskDelete={(cat, childCount) => setToDelete({ cat, childCount })}
                    order={
                      canUpdate && currentLevel.length > 1
                        ? {
                            canMoveUp: i > 0,
                            canMoveDown: i < currentLevel.length - 1,
                            pending: reorderPending,
                            onMoveUp: () =>
                              handleMove(currentParent?.id ?? null, currentLevel, i, -1),
                            onMoveDown: () =>
                              handleMove(currentParent?.id ?? null, currentLevel, i, 1),
                          }
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer cette catégorie ?"
          description={
            toDelete.childCount > 0
              ? `Ses ${toDelete.childCount} sous-catégorie(s) seront rattachées au niveau supérieur ; les produits associés seront déplacés vers la catégorie parente.`
              : "Les produits associés seront déplacés vers la catégorie parente (ou détachés s'il s'agit d'une catégorie racine)."
          }
          preview={
            <div className="rounded-[16px] border border-border bg-[#fbf9f8] p-3">
              <p className="truncate text-[13px] font-bold">{toDelete.cat.name}</p>
              <p className="text-[12px] text-muted-foreground">/{toDelete.cat.slug}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteCategoryAction(toDelete.cat.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

/**
 * In-list view toggle (« Navigation » / « Liste ») — a light underline strip
 * that switches how the category tree is presented.
 */
function ListViewToggle({ view, onSelect }: { view: View; onSelect: (v: View) => void }) {
  return (
    <div className="flex items-center gap-5">
      {VIEW_TABS.map((t) => {
        const active = view === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 border-b-2 pb-1.5 text-xs font-bold transition ${
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One category row used by BOTH views. Shows name + subtitle (slug or full
 * path), an optional child-count chip, and the reorder / activate / edit /
 * add-sub-category / delete actions — each gated on the viewer's grants.
 * When `onDrill` is set (drill-down view, node has children) the name area + a
 * chevron navigate into that node's children. When `order` is set (drill-down,
 * >1 sibling, update grant) up/down arrows renumber the sibling group.
 */
function CategoryRow({
  node,
  subtitle,
  childCount,
  onDrill,
  onAskDelete,
  canCreate,
  canUpdate,
  canDelete,
  onToggleActive,
  togglePending,
  order,
}: {
  node: CategoryTreeNode;
  subtitle: string;
  childCount: number;
  onDrill?: () => void;
  onAskDelete: (cat: Cat, childCount: number) => void;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onToggleActive: (node: CategoryTreeNode, childCount: number) => void;
  togglePending: boolean;
  order?: {
    canMoveUp: boolean;
    canMoveDown: boolean;
    pending: boolean;
    onMoveUp: () => void;
    onMoveDown: () => void;
  };
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      {onDrill ? (
        <button
          type="button"
          onClick={onDrill}
          className="min-w-0 flex-1 text-left"
          title={`Voir les sous-catégories de ${node.name}`}
        >
          <RowText node={node} subtitle={subtitle} />
        </button>
      ) : (
        <div className="min-w-0 flex-1">
          <RowText node={node} subtitle={subtitle} />
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1">
        {childCount > 0 && (
          <span className="mr-1 inline-flex items-center rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold text-[#5b5d62]">
            {childCount} sous-cat.
          </span>
        )}
        {order && (
          <div className="mr-0.5 flex items-center">
            <button
              type="button"
              onClick={order.onMoveUp}
              disabled={!order.canMoveUp || order.pending}
              aria-label="Monter"
              title="Monter"
              className="grid h-8 w-7 place-items-center rounded-l-full text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-30"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={order.onMoveDown}
              disabled={!order.canMoveDown || order.pending}
              aria-label="Descendre"
              title="Descendre"
              className="grid h-8 w-7 place-items-center rounded-r-full text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-30"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        )}
        {canUpdate && (
          <button
            type="button"
            onClick={() => onToggleActive(node, childCount)}
            disabled={togglePending}
            aria-pressed={node.isActive}
            aria-label={node.isActive ? "Désactiver" : "Activer"}
            title={
              node.isActive
                ? "Visible sur la boutique — cliquer pour désactiver"
                : "Masquée — cliquer pour activer"
            }
            className={`grid h-8 w-8 place-items-center rounded-[11px] bg-surface transition hover:bg-secondary disabled:opacity-40 ${
              node.isActive ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {node.isActive ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </button>
        )}
        {/* Storefront link only for REACHABLE categories — an inactive one, OR one
            active under a deactivated ancestor, 404s at /<slug>. */}
        {node.reachable && (
          <Link
            href={`/${node.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="grid h-8 w-8 place-items-center rounded-[11px] bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Voir sur la boutique"
            title="Voir sur la boutique"
          >
            <ExternalLink className="h-4 w-4" />
          </Link>
        )}
        {canUpdate && (
          <Link
            href={`/admin/catalog/categories/${node.id}`}
            className="grid h-8 w-8 place-items-center rounded-[11px] bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Modifier"
          >
            <Pencil className="h-4 w-4" />
          </Link>
        )}
        {canCreate && (
          <Link
            href={`${NEW_HREF}?parent=${node.id}`}
            className="grid h-8 w-8 place-items-center rounded-[11px] bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Ajouter une sous-catégorie"
            title="Ajouter une sous-catégorie"
          >
            <Plus className="h-4 w-4" />
          </Link>
        )}
        {canDelete && (
          <IconButton
            icon={<Trash2 className="h-4 w-4" />}
            aria-label="Supprimer"
            tone="danger"
            onClick={() => onAskDelete(node, childCount)}
          />
        )}
        {onDrill && <ChevronRight className="ml-0.5 h-4 w-4 text-muted-foreground" />}
      </div>
    </div>
  );
}

function RowText({ node, subtitle }: { node: CategoryTreeNode; subtitle: string }) {
  return (
    <>
      <p className="truncate text-[14px] font-bold text-foreground">{node.name}</p>
      <p className="truncate text-[12px] text-muted-foreground">
        {subtitle}
        {!node.isActive
          ? " · désactivée"
          : // Active itself but hidden on the storefront because an ancestor is off.
            !node.reachable && " · masquée (parent désactivé)"}
      </p>
    </>
  );
}
