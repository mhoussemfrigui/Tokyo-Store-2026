import "server-only";

import { z } from "zod";

import { navigationService } from "@/modules/cms/navigation/service";
import { bus } from "@/events/bus";
import { safeHrefSchema } from "@/lib/utils/safe-href";
import { fail, ok, workflow, ZOD_FR, zodValidationFail } from "../shared";
import type { CmsActorCtx } from "./setting";

/** French field labels for the validation banner (zodValidationFail). */
const NAV_FIELD_LABELS: Record<string, string> = {
  key: "Clé",
  name: "Nom",
  description: "Description",
  label: "Libellé",
  href: "Lien",
  internalKind: "Type de lien",
  internalRef: "Cible du lien",
  icon: "Icône",
  displayOrder: "Ordre",
};

// ─── menus ──────────────────────────────────────────────────────────────────

export const createNavMenuSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "Lettres minuscules, chiffres et tirets uniquement."),
  name: z.string().trim().min(1, "Champ requis.").max(120),
  description: z.string().trim().max(500).optional(),
});

export const createNavMenuWorkflow = workflow<
  [z.input<typeof createNavMenuSchema>, CmsActorCtx?],
  { id: string }
>("cms.nav_menu.create", async (input, ctx = {}) => {
  const parsed = createNavMenuSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, NAV_FIELD_LABELS);
  const existing = await navigationService.findMenuByKey(parsed.data.key);
  if (existing) return fail("conflict", "Une menu avec cette clé existe déjà.");
  const row = await navigationService.insertMenu({
    key: parsed.data.key,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
  });
  await bus.emit("nav.menu.created", { menuId: row.id, key: row.key }, ctx);
  return ok({ id: row.id });
});

// Rename only — the menus are fixed-key SYSTEM menus (`main` + the footer
// columns, see lib/cms/nav-menus.ts): a footer column's name is its storefront
// heading (CMS → Footer « Renommer »). There is deliberately no menu delete —
// the storefront looks these up by key, so deleting one would only blank a
// header row / footer column.
export const updateNavMenuSchema = z.object({
  id: z.string().uuid(),
  // `key` is intentionally absent — it's the stable lookup the storefront reads.
  name: z.string().trim().min(1, "Champ requis.").max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const updateNavMenuWorkflow = workflow<
  [z.input<typeof updateNavMenuSchema>, CmsActorCtx?],
  { id: string }
>("cms.nav_menu.update", async (input, ctx = {}) => {
  const parsed = updateNavMenuSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, NAV_FIELD_LABELS);
  const patch: Parameters<typeof navigationService.updateMenu>[1] = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.description !== undefined) patch.description = parsed.data.description;
  const row = await navigationService.updateMenu(parsed.data.id, patch);
  if (!row) return fail("not_found", "Menu introuvable.");
  await bus.emit("nav.menu.updated", { menuId: row.id, key: row.key }, ctx);
  return ok({ id: row.id });
});

// ─── items ──────────────────────────────────────────────────────────────────

export const createNavItemSchema = z
  .object({
    menuId: z.string().uuid(),
    parentId: z.string().uuid().nullable().optional(),
    label: z.string().trim().min(1, "Champ requis.").max(120),
    // Optional sub-title under the label (the « Explorer la maison » hint).
    description: z.string().trim().max(160).nullable().optional(),
    // safeHrefSchema enforces http(s)/mailto/tel/relative — never javascript:.
    href: safeHrefSchema.optional(),
    internalKind: z.enum(["category", "page", "product", "brand", "system"]).nullable().optional(),
    internalRef: z.string().trim().max(120).nullable().optional(),
    icon: z.string().trim().max(40).nullable().optional(),
    displayOrder: z.number().int().min(0).default(0),
    isVisible: z.boolean().default(true),
    openInNewTab: z.boolean().default(false),
  })
  .refine(
    (data) =>
      Boolean(data.href) || (Boolean(data.internalKind) && Boolean(data.internalRef)),
    {
      message: "Renseignez soit un lien (href) soit un type interne + référence.",
    },
  );

export const createNavItemWorkflow = workflow<
  [z.input<typeof createNavItemSchema>, CmsActorCtx?],
  { id: string }
>("cms.nav_item.create", async (input, ctx = {}) => {
  const parsed = createNavItemSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, NAV_FIELD_LABELS);
  const row = await navigationService.insertItem({
    menu_id: parsed.data.menuId,
    parent_id: parsed.data.parentId ?? null,
    label: parsed.data.label,
    // Blank → null (no sub-title), never an empty string.
    description: parsed.data.description || null,
    href: parsed.data.href ?? null,
    internal_kind: parsed.data.internalKind ?? null,
    internal_ref: parsed.data.internalRef ?? null,
    icon: parsed.data.icon ?? null,
    display_order: parsed.data.displayOrder,
    is_visible: parsed.data.isVisible,
    open_in_new_tab: parsed.data.openInNewTab,
  });
  await bus.emit("nav.item.created", { itemId: row.id, menuId: row.menu_id }, ctx);
  return ok({ id: row.id });
});

export const updateNavItemSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1, "Champ requis.").max(120).optional(),
  // undefined → untouched; null / blank → cleared.
  description: z.string().trim().max(160).nullable().optional(),
  href: safeHrefSchema.nullable().optional(),
  internalKind: z.enum(["category", "page", "product", "brand", "system"]).nullable().optional(),
  internalRef: z.string().trim().max(120).nullable().optional(),
  icon: z.string().trim().max(40).nullable().optional(),
  displayOrder: z.number().int().min(0).optional(),
  isVisible: z.boolean().optional(),
  openInNewTab: z.boolean().optional(),
});

export const updateNavItemWorkflow = workflow<
  [z.input<typeof updateNavItemSchema>, CmsActorCtx?],
  { id: string }
>("cms.nav_item.update", async (input, ctx = {}) => {
  const parsed = updateNavItemSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, NAV_FIELD_LABELS);
  const patch: Parameters<typeof navigationService.updateItem>[1] = {};
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.description !== undefined) patch.description = parsed.data.description || null;
  if (parsed.data.href !== undefined) patch.href = parsed.data.href;
  if (parsed.data.internalKind !== undefined) patch.internal_kind = parsed.data.internalKind;
  if (parsed.data.internalRef !== undefined) patch.internal_ref = parsed.data.internalRef;
  if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon;
  if (parsed.data.displayOrder !== undefined) patch.display_order = parsed.data.displayOrder;
  if (parsed.data.isVisible !== undefined) patch.is_visible = parsed.data.isVisible;
  if (parsed.data.openInNewTab !== undefined) patch.open_in_new_tab = parsed.data.openInNewTab;
  const row = await navigationService.updateItem(parsed.data.id, patch);
  if (!row) return fail("not_found", "Item introuvable.");
  await bus.emit("nav.item.updated", { itemId: row.id, menuId: row.menu_id }, ctx);
  return ok({ id: row.id });
});

export const deleteNavItemWorkflow = workflow<[{ id: string }, CmsActorCtx?], { id: string }>(
  "cms.nav_item.delete",
  async ({ id }, ctx = {}) => {
    // Existence check first so a stale admin click returns a clean not_found
    // instead of a silent success that still emits `nav.item.deleted`.
    const existing = await navigationService.findItemById(id);
    if (!existing) return fail("not_found", "Item introuvable.");
    await navigationService.deleteItem(id);
    await bus.emit("nav.item.deleted", { itemId: id }, ctx);
    return ok({ id });
  },
);
