"use client";

import { createElement, useActionState, useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";

import { IconButton } from "@/components/admin/icon-button";
import {
  LinkTargetPicker,
  type LinkOption,
} from "@/components/admin/_components/link-target-picker";
import { linkTargetFromRow, resolveLinkHref } from "@/lib/links/link-target";
import { PROMO_ICON_NAMES, promoIcon } from "@/lib/links/promo-icons";
import { MAIN_NAV_MENU_KEY } from "@/lib/cms/nav-menus";
import { checkedNavKind } from "@/lib/cms/nav-link-liveness";
import { SelectField } from "@/components/ui/select-field";
import {
  createNavItemAction,
  updateNavItemAction,
  updateNavMenuAction,
} from "@/lib/actions/cms";
import { type ActionState } from "@/lib/actions/types";

/**
 * Shared nav-menu editor primitives.
 *
 * These were originally local to the single `/admin/cms/navigation` page. The
 * admin was split into two pages — **Nav Menu** (header `main` menu + featured
 * images) and **Footer** (the `footer-*` column menus + the footer banner) —
 * so the menu-editing pieces live here, imported by both panels. The nav-item
 * CRUD server actions are unchanged; only the rendering shells are shared.
 */

export type NavItem = {
  id: string;
  parentId: string | null;
  label: string;
  /** Optional sub-title under the label (shown by menus that offer it — the
   *  « Explorer la maison » index; see `MenuCard showDescription`). */
  description: string | null;
  href: string | null;
  internalKind: string | null;
  internalRef: string | null;
  icon: string | null;
  displayOrder: number;
  isVisible: boolean;
  openInNewTab: boolean;
};

export type Menu = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  items: NavItem[];
};

export type NavTargets = {
  systemPages: LinkOption[];
  categories: LinkOption[];
  brands: LinkOption[];
  pages: LinkOption[];
};

export function itemDestination(item: NavItem): string {
  return resolveLinkHref({
    href: item.href,
    internalKind: item.internalKind,
    internalRef: item.internalRef,
  });
}

/**
 * True when the item targets a category / brand the picker no longer offers
 * (inactive, deleted, or renamed): the storefront then drops the link
 * (`lib/api/cms.ts`), unless an active redirect still serves its URL. The picker
 * lists use the storefront's visibility rule, so the check matches.
 */
function hasDeadTarget(item: NavItem, targets: NavTargets): boolean {
  const kind = checkedNavKind({
    href: item.href,
    internal_kind: item.internalKind,
    internal_ref: item.internalRef,
  });
  if (!kind) return false;
  const ref = item.internalRef!.trim();
  const options =
    kind === "category"
      ? targets.categories
      : kind === "brand"
        ? targets.brands
        : targets.pages; // kind === "page"
  return !options.some((o) => o.value === ref);
}

/**
 * Rename a fixed-key system menu. Only the footer columns + the « Explorer la
 * maison » index offer it (their name IS the storefront heading); the key is
 * the storefront's stable lookup and system menus are never deleted, so this is
 * the one menu-level mutation. `showEyebrow` adds a « Surtitre » field bound to
 * the menu description (the small line above the heading).
 */
export function NavMenuRenameForm({
  menu,
  onDone,
  showEyebrow = false,
}: {
  menu: { id: string; key: string; name: string; description?: string | null };
  onDone: () => void;
  showEyebrow?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    async (prev, formData) => {
      const res = await updateNavMenuAction(prev, formData);
      if (res.ok) onDone();
      return res;
    },
    null,
  );
  const fieldErr = (key: string) => (state && !state.ok ? state.fieldErrors?.[key] : undefined);
  return (
    <form
      action={formAction}
      className="grid gap-3 rounded-[22px] border border-border bg-card p-4 sm:grid-cols-2"
    >
      <input type="hidden" name="id" value={menu.id} />
      {showEyebrow && (
        <Field
          label="Surtitre (optionnel)"
          name="description"
          maxLength={120}
          placeholder="Informations utiles"
          defaultValue={menu.description ?? ""}
          error={fieldErr("description")}
        />
      )}
      <Field
        label="Titre (affiché sur la boutique)"
        name="name"
        required
        maxLength={120}
        defaultValue={menu.name}
        error={fieldErr("name")}
      />
      {/* The key is the stable lookup the storefront reads — read-only. */}
      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-bold text-foreground">
          Clé (non modifiable)
        </span>
        <input
          disabled
          value={menu.key}
          className="h-11 cursor-not-allowed rounded-[14px] border-[1.5px] border-input bg-surface px-4 text-[15px] text-muted-foreground"
        />
      </label>
      {state && !state.ok && (
        <p className="text-[14px] text-destructive sm:col-span-2">{state.message}</p>
      )}
      <div className="flex items-center gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : "Enregistrer"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}

export function MenuCard({
  menu,
  targets,
  onAskDelete,
  /** Offer « Renommer » (the footer columns — their name is the storefront
   *  heading). Menus are fixed-key system menus: never created / deleted here. */
  allowRename = false,
  /** Initial collapsed state of the card body. Defaults to open. */
  defaultOpen = true,
  /** Offer the item « Sous-titre » + the menu « Surtitre » (the « Explorer la
   *  maison » index renders both). Other menus never post the fields, so their
   *  stored values are left untouched. */
  showDescription = false,
}: {
  menu: Menu;
  targets: NavTargets;
  onAskDelete: (item: NavItem) => void;
  allowRename?: boolean;
  defaultOpen?: boolean;
  showDescription?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [adding, setAdding] = useState(false);
  const [editingMenu, setEditingMenu] = useState(false);
  // The header renders the `main` menu as flat links (no dropdown for admin
  // items), so a nested sub-item there never reaches the storefront — flag it
  // rather than let it look live. Footer columns do render sub-items.
  const subItemsHidden = menu.key === MAIN_NAV_MENU_KEY;
  return (
    <section className="rounded-[28px] border border-border bg-card">
      <header className="flex items-center justify-between gap-3 p-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <div>
            <p className="text-[14px] font-bold text-foreground">{menu.name}</p>
            <p className="text-[12px] text-muted-foreground">
              <code className="rounded-[6px] bg-surface px-1.5 py-0.5">{menu.key}</code>
              {" · "}
              {menu.items.length} item(s)
            </p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {allowRename && (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                setEditingMenu((v) => !v);
              }}
              className="rounded-full px-3 py-1.5 text-[13px] font-bold text-muted-foreground transition hover:bg-surface hover:text-foreground"
            >
              {editingMenu ? "Fermer" : "Renommer"}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setAdding((v) => !v);
            }}
            className="inline-flex items-center rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
          >
            {adding ? "Fermer" : "+ Ajouter"}
          </button>
        </div>
      </header>
      {open && (
        <div className="space-y-3 border-t border-border p-4">
          {allowRename && editingMenu && (
            <NavMenuRenameForm
              menu={menu}
              showEyebrow={showDescription}
              onDone={() => setEditingMenu(false)}
            />
          )}
          {adding && (
            <NavItemForm
              mode="create"
              menuId={menu.id}
              targets={targets}
              showDescription={showDescription}
              onDone={() => setAdding(false)}
            />
          )}
          {menu.items.length === 0 && !adding ? (
            <p className="text-[14px] text-muted-foreground">
              Aucun item — cliquez « Ajouter » pour en créer.
            </p>
          ) : (
            <ul className="space-y-2">
              {menu.items
                .filter((i) => !i.parentId)
                .map((item) => (
                  <NavItemRow
                    key={item.id}
                    item={item}
                    menuId={menu.id}
                    targets={targets}
                    children={menu.items.filter((i) => i.parentId === item.id)}
                    onAskDelete={onAskDelete}
                    subItemsHidden={subItemsHidden}
                    showDescription={showDescription}
                  />
                ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function NavItemRow({
  item,
  menuId,
  targets,
  children,
  onAskDelete,
  subItemsHidden = false,
  hiddenOnStorefront = false,
  showDescription = false,
}: {
  item: NavItem;
  menuId: string;
  targets: NavTargets;
  children: NavItem[];
  onAskDelete: (item: NavItem) => void;
  /** This menu's storefront renderer ignores sub-items (the header `main` menu). */
  subItemsHidden?: boolean;
  /** This row is such a sub-item — shown with a « non affiché » chip. */
  hiddenOnStorefront?: boolean;
  /** Edit (and preview) the item's « Sous-titre ». */
  showDescription?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <li className="rounded-[16px] border border-border bg-card transition hover:border-border/80 hover:bg-[#fffbfb]">
      {editing ? (
        <div className="p-4">
          <NavItemForm
            mode="edit"
            menuId={menuId}
            targets={targets}
            initial={item}
            showDescription={showDescription}
            onDone={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:py-3.5">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-[14px] font-bold text-foreground">{item.label}</p>
            {showDescription && item.description && (
              <p className="truncate text-[13px] text-muted-foreground">{item.description}</p>
            )}
            {/* Resolved destination + order + hidden flag, broken into chips. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <code className="rounded-[6px] bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/90">
                {itemDestination(item)}
              </code>
              <span className="text-muted-foreground/40">·</span>
              <span>ordre {item.displayOrder}</span>
              {!item.isVisible && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="rounded-full bg-[#fff4e0] px-2 py-0.5 font-bold uppercase tracking-wide text-[#b45309]">
                    masqué
                  </span>
                </>
              )}
              {hasDeadTarget(item, targets) && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span
                    title="Ce lien pointe vers une catégorie / marque inactive, supprimée ou renommée : il est retiré du site (avec ses sous-items), sauf si une redirection active (Système → Redirections) couvre son URL. Choisissez une nouvelle destination."
                    className="rounded-full bg-[#fff4e0] px-2 py-0.5 font-bold uppercase tracking-wide text-[#b45309]"
                  >
                    cible inactive — masqué sauf redirection
                  </span>
                </>
              )}
              {hiddenOnStorefront && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span
                    title="Le menu du header n'affiche que les items de premier niveau."
                    className="rounded-full bg-[#f6f2ed] px-2 py-0.5 font-bold uppercase tracking-wide text-[#5b5d62]"
                  >
                    sous-item non affiché dans le header
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-full px-3 py-1.5 text-[13px] font-bold text-muted-foreground transition hover:bg-surface hover:text-foreground"
            >
              Modifier
            </button>
            <IconButton
              icon={<Trash2 className="h-3.5 w-3.5" />}
              aria-label="Supprimer"
              tone="danger"
              size="sm"
              onClick={() => onAskDelete(item)}
            />
          </div>
        </div>
      )}
      {children.length > 0 && (
        <ul className="mt-2 space-y-2 border-l-2 border-border pl-4">
          {children.map((child) => (
            <NavItemRow
              key={child.id}
              item={child}
              menuId={menuId}
              targets={targets}
              children={[]}
              onAskDelete={onAskDelete}
              hiddenOnStorefront={subItemsHidden}
              showDescription={showDescription}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function NavItemForm({
  mode,
  menuId,
  targets,
  initial,
  onDone,
  showDescription = false,
}: {
  mode: "create" | "edit";
  menuId: string;
  targets: NavTargets;
  initial?: NavItem;
  onDone: () => void;
  /** Render the « Sous-titre » field (only then is `description` posted). */
  showDescription?: boolean;
}) {
  const action = mode === "create" ? createNavItemAction : updateNavItemAction;
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    async (prev, formData) => {
      const res = await action(prev, formData);
      if (res.ok) onDone();
      return res;
    },
    null,
  );
  const fieldErr = (key: string) => (state && !state.ok ? state.fieldErrors?.[key] : undefined);
  // The link picker posts one value mapped to href / internalKind / internalRef.
  const linkErr = fieldErr("href") ?? fieldErr("internalRef") ?? fieldErr("internalKind");

  const initialTarget = linkTargetFromRow({
    href: initial?.href ?? null,
    internalKind: initial?.internalKind ?? null,
    internalRef: initial?.internalRef ?? null,
  });

  return (
    <form action={formAction} className="grid gap-3 rounded-[16px] border border-border bg-[#fbf9f8] p-4 sm:grid-cols-2">
      <input type="hidden" name="menuId" value={menuId} />
      {mode === "edit" && initial && <input type="hidden" name="id" value={initial.id} />}
      <Field
        label="Libellé"
        name="label"
        defaultValue={initial?.label}
        required
        error={fieldErr("label")}
      />
      {showDescription && (
        <Field
          label="Sous-titre (optionnel)"
          name="description"
          maxLength={160}
          placeholder="Ex. Vos données"
          defaultValue={initial?.description ?? ""}
          error={fieldErr("description")}
        />
      )}
      <div className="flex flex-col gap-1">
        <LinkTargetPicker
          initialKind={initialTarget.kind}
          initialValue={initialTarget.value}
          systemPages={targets.systemPages}
          categories={targets.categories}
          brands={targets.brands}
          pages={targets.pages}
        />
        {linkErr && <span className="text-[12px] text-destructive">{linkErr}</span>}
      </div>
      {/* The sub-title menu (the « Explorer la maison » index) renders no icon, so
          it isn't offered there — and, not posted, a stored one stays untouched. */}
      {!showDescription && <IconField defaultValue={initial?.icon ?? ""} />}
      <Field
        label="Ordre"
        name="displayOrder"
        type="number"
        defaultValue={String(initial?.displayOrder ?? 0)}
        error={fieldErr("displayOrder")}
      />
      <label className="flex items-center gap-2 text-[14px]">
        <input
          type="checkbox"
          name="isVisible"
          defaultChecked={initial?.isVisible ?? true}
          className="h-4 w-4 rounded-[4px] border-input accent-[var(--primary)]"
        />
        Visible
      </label>
      <label className="flex items-center gap-2 text-[14px]">
        <input
          type="checkbox"
          name="openInNewTab"
          defaultChecked={initial?.openInNewTab ?? false}
          className="h-4 w-4 rounded-[4px] border-input accent-[var(--primary)]"
        />
        Ouvrir dans un nouvel onglet
      </label>
      {state && !state.ok && (
        <p className="text-[13px] text-destructive sm:col-span-2">{state.message}</p>
      )}
      <div className="flex items-center gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center rounded-full bg-primary px-4 text-[13px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : mode === "create" ? "Ajouter" : "Enregistrer"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-10 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[13px] font-bold text-foreground hover:bg-surface"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}

/**
 * Optional icon picker for a nav item. Reuses the shared lucide registry
 * (PROMO_ICON_NAMES / PROMO_ICON_MAP) that the storefront renderer reads, so
 * the picker and the rendered icon can never drift. "Aucune" (empty value)
 * means no icon — the storefront then renders the label alone (hide-when-unset).
 */
function IconField({ defaultValue }: { defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  const Preview = promoIcon(value);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">
        Icône (optionnel)
      </span>
      <div className="flex items-center gap-2">
        {Preview ? (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] border border-border bg-surface text-foreground">
            {createElement(Preview, { className: "h-4 w-4", strokeWidth: 2.2 })}
          </span>
        ) : (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] border border-dashed border-border text-[10px] text-muted-foreground">
            —
          </span>
        )}
        <SelectField
          name="icon"
          ariaLabel="Icône (optionnel)"
          size="sm"
          value={value}
          onChange={setValue}
          options={[
            { value: "", label: "Aucune" },
            ...PROMO_ICON_NAMES.map((name) => ({ value: name, label: name })),
          ]}
          className="flex-1"
        />
      </div>
    </div>
  );
}

export function Field({
  label,
  name,
  defaultValue,
  required,
  type = "text",
  placeholder,
  maxLength,
  error,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  type?: string;
  placeholder?: string;
  maxLength?: number;
  /** Inline validation message (the action's `fieldErrors[name]`). */
  error?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] font-bold text-foreground">
        {label}
      </span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue ?? ""}
        required={required}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        className={`h-11 rounded-[14px] border-[1.5px] bg-[#fbf9f8] px-4 text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none ${
          error ? "border-destructive" : "border-input"
        }`}
      />
      {error && <span className="text-[12px] text-destructive">{error}</span>}
    </label>
  );
}
