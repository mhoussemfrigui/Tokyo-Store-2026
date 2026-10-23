"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission, requirePermissionAny } from "@/lib/auth/session";
import { bannerService } from "@/modules/cms/banner/service";
import { type ActionState } from "@/lib/actions/types";
import { parseFaqItemsJson } from "@/lib/cms/faq-items";
import { parseJsonArrayField } from "@/lib/pages/boutique-landing-parse";
import { TRUST_BADGE_SETTING_KEYS } from "@/lib/cms/trust-badge-appearance";

// ─────────────────────────────────────────── trust badges (buy-box strip)
export async function createTrustBadgeAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("trust_badges", "create");
  const result = await workflows.cms.createTrustBadge(
    {
      label: String(formData.get("label") ?? ""),
      icon: optional(formData, "icon") ?? "ShieldCheck",
      // "" (Personnalisé) → null; otherwise the chosen kind.
      kind: (optional(formData, "kind") as never) ?? null,
      visibility: (optional(formData, "visibility") as never) ?? "always",
      displayOrder: optionalInt(formData, "displayOrder") ?? 0,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/trust-badges");
  revalidatePath("/", "layout");
  return { ok: true, message: "Badge créé." };
}

export async function updateTrustBadgeAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("trust_badges", "update");
  const id = optional(formData, "id");
  if (!id) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.cms.updateTrustBadge(
    {
      id,
      label: optional(formData, "label"),
      icon: optional(formData, "icon"),
      // The kind select always submits → set it (blank = Personnalisé = null).
      kind: formData.has("kind") ? ((optional(formData, "kind") as never) ?? null) : undefined,
      visibility: optional(formData, "visibility") as never,
      displayOrder: optionalInt(formData, "displayOrder"),
      isActive: formData.get("isActive") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/trust-badges");
  revalidatePath("/", "layout");
  return { ok: true, message: "Badge mis à jour." };
}

export async function toggleTrustBadgeActiveAction(
  id: string,
  isActive: boolean,
): Promise<ActionState> {
  const session = await requirePermission("trust_badges", "update");
  const result = await workflows.cms.updateTrustBadge(
    { id, isActive },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/trust-badges");
  revalidatePath("/", "layout");
  return { ok: true, message: isActive ? "Badge activé." : "Badge désactivé." };
}

export async function deleteTrustBadgeAction(id: string): Promise<ActionState> {
  const session = await requirePermission("trust_badges", "delete");
  const result = await workflows.cms.deleteTrustBadge(
    { id },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/trust-badges");
  revalidatePath("/", "layout");
  return { ok: true, message: "Badge supprimé." };
}

// Appearance + placement of the whole strip (one style for all badges; per-surface
// toggles). Stored as `storefront.trust_badges.*` settings. Enum/boolean values are
// re-validated by getTrustBadgeAppearance's coercers at read time, so a bad value
// can never select an invalid variant.
const TRUST_BADGE_SETTING_FIELDS: { key: string; type: "text" | "boolean"; label: string }[] = [
  { key: TRUST_BADGE_SETTING_KEYS.style, type: "text", label: "Badges de confiance — style" },
  { key: TRUST_BADGE_SETTING_KEYS.iconStyle, type: "text", label: "Badges de confiance — style d'icône" },
  { key: TRUST_BADGE_SETTING_KEYS.showOnProduct, type: "boolean", label: "Badges de confiance — fiche produit" },
  { key: TRUST_BADGE_SETTING_KEYS.showOnCart, type: "boolean", label: "Badges de confiance — panier" },
  { key: TRUST_BADGE_SETTING_KEYS.showOnCheckout, type: "boolean", label: "Badges de confiance — checkout" },
];

export async function saveTrustBadgeSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("trust_badges", "update");
  // One ATOMIC batch (mirrors footer/theme/site) — no half-saved appearance.
  const settings = TRUST_BADGE_SETTING_FIELDS.map((field) => ({
    key: field.key,
    value:
      field.type === "boolean"
        ? formData.get(field.key) === "on"
          ? "true"
          : "false"
        : (() => {
            const raw = formData.get(field.key);
            return raw === null ? null : String(raw).trim() || null;
          })(),
    type: field.type,
    groupKey: "storefront",
    label: field.label,
  }));
  const res = await workflows.cms.upsertSettingsBatch({ settings }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/cms/trust-badges");
  revalidatePath("/", "layout");
  return { ok: true, message: "Apparence enregistrée." };
}

// ─────────────────────────────────────────── FAQs (per-product / per-category)
// The legacy global FAQ admin (/admin/cms/faq) is gone — FAQs are now
// edited from the product / category form. Each save submits the entire
// list as a JSON-encoded array via a hidden input; the workflow soft-
// deletes the prior rows and inserts the new ones in one transaction.

export async function upsertProductFaqsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("products", "update");
  const productId = optional(formData, "productId");
  if (!productId) {
    return { ok: false, error: "validation", message: "productId requis." };
  }
  const items = parseFaqItemsJson(optional(formData, "itemsJson"));
  const result = await workflows.cms.upsertProductFaqs(
    { productId, items },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath(`/admin/catalog/products/${productId}`);
  // Storefront path is keyed by slug — look it up so we can revalidate
  // the exact route. Failing the lookup is harmless: the wildcard
  // revalidation below already covers it.
  const slugRaw = optional(formData, "productSlug");
  if (slugRaw) {
    revalidatePath(`/${slugRaw}`);
  }
  // Layout-level revalidate so nav / footer don't cache stale snippets.
  revalidatePath("/", "layout");
  return { ok: true, message: "FAQ enregistrées." };
}

export async function upsertCategoryFaqsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("categories", "update");
  const categoryId = optional(formData, "categoryId");
  if (!categoryId) {
    return { ok: false, error: "validation", message: "categoryId requis." };
  }
  const items = parseFaqItemsJson(optional(formData, "itemsJson"));
  const result = await workflows.cms.upsertCategoryFaqs(
    { categoryId, items },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath(`/admin/catalog/categories/${categoryId}`);
  const slugRaw = optional(formData, "categorySlug");
  if (slugRaw) {
    revalidatePath(`/${slugRaw}`);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "FAQ enregistrées." };
}

export async function upsertBrandFaqsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("brands", "update");
  const brandId = optional(formData, "brandId");
  if (!brandId) {
    return { ok: false, error: "validation", message: "brandId requis." };
  }
  const items = parseFaqItemsJson(optional(formData, "itemsJson"));
  const result = await workflows.cms.upsertBrandFaqs(
    { brandId, items },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath(`/admin/catalog/brands/${brandId}`);
  const slugRaw = optional(formData, "brandSlug");
  if (slugRaw) {
    revalidatePath(`/${slugRaw}`);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "FAQ enregistrées." };
}

// ─────────────────────────────────────────── banners
// Banner writes gate on the owning surface's EDIT right (home_hero→home:update,
// footer/nav_*→navigation:update — both VIEW_EDIT, so no :create/:delete key;
// legacy header_strip/category_grid→the banners CRUD resource). update & delete
// resolve the placement from the DB row, never client input (ISSUE-18). Gates are
// inlined with literal keys so they stay statically analysable (internal-api catalog).
//
// update/delete must READ the banner (to learn its real placement) before the
// precise per-surface gate, so they open with a BASELINE any-of gate first — the
// caller must hold at least one banner-editing right before any DB read (so a
// no-permission caller never reaches `findById`). The exact surface check still
// runs after the placement is resolved.
const BANNER_EDIT_GRANTS = [
  { module: "home", action: "update" },
  { module: "navigation", action: "update" },
  { module: "banners", action: "update" },
] as const;
const BANNER_DELETE_GRANTS = [
  { module: "home", action: "update" },
  { module: "navigation", action: "update" },
  { module: "banners", action: "delete" },
] as const;

/** Create a banner on a surface the caller is allowed to edit. */
export async function createBannerAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const placement = String(formData.get("placement") ?? "");
  // Create gates on the TARGET surface (choosing where to create is legitimate):
  // home/nav → their `:update`, legacy placements → `banners:create`.
  const session =
    placement === "home_hero"
      ? await requirePermission("home", "update")
      : placement === "footer" || placement.startsWith("nav_")
        ? await requirePermission("navigation", "update")
        : await requirePermission("banners", "create");
  const result = await workflows.cms.createBanner(
    {
      placement: placement as never,
      name: String(formData.get("name") ?? ""),
      title: String(formData.get("title") ?? ""),
      eyebrow: optional(formData, "eyebrow"),
      subtitle: optional(formData, "subtitle"),
      description: optional(formData, "description"),
      ctaLabel: optional(formData, "ctaLabel"),
      ctaHref: optional(formData, "ctaHref"),
      imageMediaId: optionalUuid(formData, "imageMediaId"),
      imageMobileMediaId: optionalUuid(formData, "imageMobileMediaId"),
      videoUrl: optional(formData, "videoUrl"),
      // Only the hero form posts showText (marker field) — absent elsewhere → schema
      // default (true), so a non-hero create never stores show_text=false.
      showText: formData.has("showTextField") ? formData.get("showText") === "on" : undefined,
      buttons: optional(formData, "buttons"),
      startAt: optional(formData, "startAt"),
      endAt: optional(formData, "endAt"),
      displayOrder: optionalInt(formData, "displayOrder") ?? 0,
      isActive: formData.get("isActive") === "on",
      targetKind: (optional(formData, "targetKind") as never) ?? "none",
      targetRef: optional(formData, "targetRef"),
      afterLoadMoreCount: optionalInt(formData, "afterLoadMoreCount") ?? 2,
      gridPosition: (optional(formData, "gridPosition") as never) ?? "after_rows",
      stripTone: (optional(formData, "stripTone") as never) ?? "olive",
      stripIcon: optional(formData, "stripIcon"),
      // Only the strip form posts showCountdown (marker field) — absent elsewhere → default.
      showCountdown: formData.has("showCountdownField")
        ? formData.get("showCountdown") === "on"
        : undefined,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/home");
  revalidatePath("/admin/cms/footer");
  revalidatePath("/", "layout");
  return { ok: true, message: "Bannière créée." };
}

export async function updateBannerAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const id = optional(formData, "id");
  if (!id) return { ok: false, error: "validation", message: "ID requis." };
  // Baseline gate BEFORE any DB read: the caller must hold at least one
  // banner-editing right (the precise per-surface check runs below).
  await requirePermissionAny(BANNER_EDIT_GRANTS);
  // SECURITY (ISSUE-18): resolve the banner's REAL placement from the DB — NEVER
  // trust the client-posted `placement` for the RBAC gate, or a caller could edit a
  // surface they can't by posting a placement they can. Gate on the owning surface.
  const existing = await bannerService.findById(id);
  if (!existing) return { ok: false, error: "not_found", message: "Bannière introuvable." };
  const session =
    existing.placement === "home_hero"
      ? await requirePermission("home", "update")
      : existing.placement === "footer" || existing.placement.startsWith("nav_")
        ? await requirePermission("navigation", "update")
        : await requirePermission("banners", "update");
  // Moving a banner to a DIFFERENT surface also requires edit rights on the target.
  const movedTo = optional(formData, "placement");
  if (movedTo && movedTo !== existing.placement) {
    if (movedTo === "home_hero") await requirePermission("home", "update");
    else if (movedTo === "footer" || movedTo.startsWith("nav_"))
      await requirePermission("navigation", "update");
    else await requirePermission("banners", "update");
  }
  const result = await workflows.cms.updateBanner(
    {
      id,
      placement: (optional(formData, "placement") as never) ?? undefined,
      name: optional(formData, "name"),
      title: optional(formData, "title"),
      eyebrow: formData.has("eyebrow") ? (optional(formData, "eyebrow") ?? "") : undefined,
      subtitle: formData.has("subtitle") ? (optional(formData, "subtitle") ?? "") : undefined,
      description: formData.has("description")
        ? (optional(formData, "description") ?? "")
        : undefined,
      ctaLabel: formData.has("ctaLabel") ? (optional(formData, "ctaLabel") ?? "") : undefined,
      ctaHref: formData.has("ctaHref") ? (optional(formData, "ctaHref") ?? "") : undefined,
      imageMediaId: formData.has("imageMediaId")
        ? (optionalUuid(formData, "imageMediaId") ?? null)
        : undefined,
      imageMobileMediaId: formData.has("imageMobileMediaId")
        ? (optionalUuid(formData, "imageMobileMediaId") ?? null)
        : undefined,
      videoUrl: formData.has("videoUrl") ? (optional(formData, "videoUrl") ?? "") : undefined,
      // Marker-gated (see createBannerAction): only the hero/strip form posts these, so a
      // save from another placement leaves show_text / show_countdown untouched.
      showText: formData.has("showTextField") ? formData.get("showText") === "on" : undefined,
      buttons: formData.has("buttons") ? (optional(formData, "buttons") ?? "") : undefined,
      startAt: formData.has("startAt") ? (optional(formData, "startAt") ?? "") : undefined,
      endAt: formData.has("endAt") ? (optional(formData, "endAt") ?? "") : undefined,
      displayOrder: optionalInt(formData, "displayOrder"),
      isActive: formData.get("isActive") === "on",
      targetKind: formData.has("targetKind")
        ? ((optional(formData, "targetKind") as never) ?? "none")
        : undefined,
      targetRef: formData.has("targetRef") ? (optional(formData, "targetRef") ?? "") : undefined,
      afterLoadMoreCount: optionalInt(formData, "afterLoadMoreCount"),
      gridPosition: formData.has("gridPosition")
        ? ((optional(formData, "gridPosition") as never) ?? "after_rows")
        : undefined,
      stripTone: formData.has("stripTone")
        ? ((optional(formData, "stripTone") as never) ?? "olive")
        : undefined,
      stripIcon: formData.has("stripIcon") ? (optional(formData, "stripIcon") ?? "") : undefined,
      showCountdown: formData.has("showCountdownField")
        ? formData.get("showCountdown") === "on"
        : undefined,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/home");
  revalidatePath("/admin/cms/footer");
  revalidatePath("/", "layout");
  return { ok: true, message: "Bannière mise à jour." };
}

export async function deleteBannerAction(id: string): Promise<ActionState> {
  // Baseline gate BEFORE any DB read (the precise per-surface check runs below).
  await requirePermissionAny(BANNER_DELETE_GRANTS);
  // Resolve the placement server-side (never trust a client-passed placement) so
  // the delete gates on the surface that owns it — the hero carousel on `home`,
  // the footer banner on `navigation` (both VIEW_EDIT → `:update`), legacy on `banners`.
  const banner = await bannerService.findById(id);
  if (!banner) return { ok: false, error: "not_found", message: "Bannière introuvable." };
  const session =
    banner.placement === "home_hero"
      ? await requirePermission("home", "update")
      : banner.placement === "footer" || banner.placement.startsWith("nav_")
        ? await requirePermission("navigation", "update")
        : await requirePermission("banners", "delete");
  const result = await workflows.cms.deleteBanner({ id }, { actorUserId: session.user.id });
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/home");
  revalidatePath("/admin/cms/footer");
  revalidatePath("/", "layout");
  return { ok: true, message: "Bannière supprimée." };
}

// ─────────────────────────────────────────── pages
export async function createPageAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("pages", "create");
  const result = await workflows.cms.createPage(
    {
      slug: String(formData.get("slug") ?? ""),
      title: String(formData.get("title") ?? ""),
      metaTitle: optional(formData, "metaTitle"),
      metaDescription: optional(formData, "metaDescription"),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/pages");
  return { ok: true, message: "Page créée (brouillon) — ajoutez du contenu puis publiez." };
}

export async function togglePagePublishAction(
  pageId: string,
  publish: boolean,
): Promise<ActionState> {
  const session = await requirePermission("pages", "update");
  const result = await workflows.cms.togglePagePublish(
    { pageId, publish },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/pages");
  return { ok: true, message: publish ? "Page publiée." : "Page dépubliée." };
}

export async function updatePageAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("pages", "update");
  const pageId = optional(formData, "pageId");
  if (!pageId) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.cms.updatePage(
    {
      pageId,
      slug: optional(formData, "slug"),
      title: optional(formData, "title"),
      metaTitle: formData.has("metaTitle")
        ? (optional(formData, "metaTitle") ?? null)
        : undefined,
      metaDescription: formData.has("metaDescription")
        ? (optional(formData, "metaDescription") ?? null)
        : undefined,
      ogImageMediaId: formData.has("ogImageMediaId")
        ? (optionalUuid(formData, "ogImageMediaId") ?? null)
        : undefined,
      canonicalUrl: formData.has("canonicalUrl")
        ? (optional(formData, "canonicalUrl") ?? null)
        : undefined,
      // The meta form always renders the noindex checkbox, so read it unconditionally
      // (an unchecked box is ABSENT from FormData → false = indexable).
      noindex: formData.get("noindex") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/pages");
  revalidatePath(`/admin/cms/pages/${pageId}`);
  revalidatePath("/", "layout");
  return { ok: true, message: "Métadonnées enregistrées." };
}

/** Persist the page block-composer layout (JSON) posted by the admin composer. */
export async function savePageBlocksAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("pages", "update");
  const pageId = optional(formData, "pageId");
  if (!pageId) return { ok: false, error: "validation", message: "ID requis." };
  // Reject a PRESENT-but-unparseable payload (truncated POST / tampered request)
  // instead of storing [] — a garbled save would otherwise blank the page while
  // reporting success. A genuinely-empty layout still posts "[]" and passes.
  const rawBlocks = formData.get("blocks");
  if (parseJsonArrayField(rawBlocks).malformed) {
    return { ok: false, error: "validation", message: "Données de mise en page invalides. Rechargez la page puis réessayez." };
  }
  const result = await workflows.cms.savePageBlocks(
    { pageId, blocks: String(rawBlocks ?? "") },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/pages");
  revalidatePath(`/admin/cms/pages/${pageId}`);
  revalidatePath("/", "layout");
  return { ok: true, message: "Page enregistrée." };
}

export async function deletePageAction(pageId: string): Promise<ActionState> {
  const session = await requirePermission("pages", "delete");
  const result = await workflows.cms.deletePage({ pageId }, { actorUserId: session.user.id });
  if (!result.ok) return failState(result);
  revalidatePath("/admin/cms/pages");
  return { ok: true, message: "Page supprimée." };
}

// ─────────────────────────────────────────── navigation
// The single "Navigation" admin was split into TWO pages: Nav Menu (header
// `main` menu + featured images) and Footer (the `footer-*` column menus + the
// footer banner). The nav-item / nav-menu CRUD below is shared by both, so each
// mutation revalidates BOTH admin pages (a footer item edit must refresh the
// Footer page, a header item edit the Nav Menu page) plus the storefront layout.
function revalidateNavAdmin() {
  revalidatePath("/admin/cms/nav-menu");
  revalidatePath("/admin/cms/footer");
}

/**
 * Restore the system footer menus (the three link columns, seeded with the
 * footer's built-in links) + the « Explorer la maison » index — one click after a
 * « Nettoyer › Navigation » or a fresh install where they are missing. Reuses the
 * boot-time seeder, which is idempotent and never clobbers an existing (edited or
 * deliberately emptied) menu, so re-running only fills in what is absent.
 */
export async function restoreFooterColumnsAction(): Promise<ActionState> {
  await requirePermission("navigation", "update");
  const { ensureSystemNavMenus } = await import("@/lib/bootstrap/system-nav-menus");
  await ensureSystemNavMenus();
  revalidateNavAdmin();
  revalidatePath("/", "layout");
  return { ok: true, message: "Colonnes du footer restaurées." };
}

export async function createNavMenuAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("navigation", "update");
  const result = await workflows.cms.createNavMenu(
    {
      key: String(formData.get("key") ?? ""),
      name: String(formData.get("name") ?? ""),
      description: optional(formData, "description"),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidateNavAdmin();
  revalidatePath("/", "layout");
  return { ok: true, message: "Menu créé." };
}

/**
 * Rename a system menu (CMS → Footer « Renommer » — a footer column's name is
 * its storefront heading). The key is immutable and menus can't be deleted
 * (fixed-key system menus, see lib/cms/nav-menus.ts).
 */
export async function updateNavMenuAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("navigation", "update");
  const id = optional(formData, "id");
  if (!id) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.cms.updateNavMenu(
    {
      id,
      // Present-but-blank reaches the workflow as "" so its « Champ requis »
      // fires (instead of silently keeping the old name).
      name: formData.has("name") ? String(formData.get("name") ?? "").trim() : undefined,
      // Present → set/clear; absent → leave untouched.
      description: formData.has("description") ? (optional(formData, "description") ?? null) : undefined,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidateNavAdmin();
  revalidatePath("/", "layout");
  return { ok: true, message: "Menu renommé." };
}

export async function createNavItemAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("navigation", "update");
  const menuId = optional(formData, "menuId");
  if (!menuId) return { ok: false, error: "validation", message: "Menu requis." };
  const target = readLinkTarget(formData);
  const result = await workflows.cms.createNavItem(
    {
      menuId,
      parentId: optionalUuid(formData, "parentId") ?? null,
      label: String(formData.get("label") ?? ""),
      description: optional(formData, "description") ?? null,
      href: target.href ?? undefined,
      internalKind: target.internalKind,
      internalRef: target.internalRef,
      icon: optional(formData, "icon") ?? null,
      displayOrder: optionalInt(formData, "displayOrder") ?? 0,
      isVisible: formData.get("isVisible") === "on",
      openInNewTab: formData.get("openInNewTab") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidateNavAdmin();
  revalidatePath("/", "layout");
  return { ok: true, message: "Item créé." };
}

export async function updateNavItemAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("navigation", "update");
  const id = optional(formData, "id");
  if (!id) return { ok: false, error: "validation", message: "ID requis." };
  const target = readLinkTarget(formData);
  const result = await workflows.cms.updateNavItem(
    {
      id,
      label: optional(formData, "label"),
      // Present (the « Sous-titre » field) → set or clear; absent (a form that
      // doesn't offer it, e.g. the header / footer column editors) → untouched.
      description: formData.has("description") ? (optional(formData, "description") ?? null) : undefined,
      href: target.href,
      internalKind: target.internalKind,
      internalRef: target.internalRef,
      // Present (select always submits) → set or clear; absent → leave untouched.
      icon: formData.has("icon") ? (optional(formData, "icon") ?? null) : undefined,
      displayOrder: optionalInt(formData, "displayOrder"),
      isVisible: formData.get("isVisible") === "on",
      openInNewTab: formData.get("openInNewTab") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return failState(result);
  revalidateNavAdmin();
  revalidatePath("/", "layout");
  return { ok: true, message: "Item mis à jour." };
}

export async function deleteNavItemAction(id: string): Promise<ActionState> {
  const session = await requirePermission("navigation", "update");
  const result = await workflows.cms.deleteNavItem({ id }, { actorUserId: session.user.id });
  if (!result.ok) return failState(result);
  revalidateNavAdmin();
  revalidatePath("/", "layout");
  return { ok: true, message: "Item supprimé." };
}

// (Removed) setNavFeaturedAction + saveNavLabelsAction. The composable Nav Menu
// builder (saveHeaderNavAction) now owns the header: root labels live in
// nav_items.label and dropdown imagery in nav_items.config image blocks, so the
// legacy `nav.*` label overrides and the `nav_*` featured-banner action are no
// longer wired to any admin UI or boot seed. The setNavFeaturedWorkflow itself is
// now DORMANT — NO production path calls it; it is retained only as an isolated,
// injection-safety-tested guard (cms-admin.test) in case a manual nav_* row ever
// needs servicing. Safe to delete wholesale (workflow + its test) if desired.

// ──────────────────────────────────────── helpers
/**
 * Map a failed workflow result to the ActionState shape, KEEPING its
 * per-field `fieldErrors` (they used to be dropped, so forms only ever saw the
 * banner message).
 */
function failState(r: {
  error: string;
  message: string;
  fieldErrors?: Record<string, string>;
}): ActionState {
  return { ok: false, error: r.error, message: r.message, fieldErrors: r.fieldErrors };
}
function optional(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
function optionalInt(form: FormData, key: string): number | undefined {
  const v = optional(form, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function optionalUuid(form: FormData, key: string): string | undefined {
  const v = optional(form, key);
  return v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined;
}

/**
 * Read the shared LinkTargetPicker fields (`linkKind` + `linkValue`) and map
 * them to the storage shape: a manual `href` (url kind) OR an internal
 * `(internalKind, internalRef)` target. Workflow-side zod re-validates both.
 */
function readLinkTarget(form: FormData): {
  href: string | null | undefined;
  internalKind: "system" | "category" | "brand" | "page" | null | undefined;
  internalRef: string | null | undefined;
} {
  const kind = optional(form, "linkKind") ?? "url";
  const value = optional(form, "linkValue");
  // No value at all → leave the target untouched: on UPDATE the workflow skips
  // these (preserving the prior link); on CREATE the hasTarget refine rejects it.
  if (value === undefined) {
    return { href: undefined, internalKind: undefined, internalRef: undefined };
  }
  if (
    kind === "system" ||
    kind === "category" ||
    kind === "brand" ||
    kind === "page"
  ) {
    return { href: null, internalKind: kind, internalRef: value };
  }
  return { href: value, internalKind: null, internalRef: null };
}
