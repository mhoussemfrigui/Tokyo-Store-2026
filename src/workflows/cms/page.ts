import "server-only";

import { z } from "zod";

import { pageService } from "@/modules/cms/page/service";
import { bus } from "@/events/bus";
import { safeHrefSchema } from "@/lib/utils/safe-href";
import { checkSlugAvailability } from "@/lib/utils/slug-conflict";
import { syncEntityUrlRedirects } from "@/lib/redirects/auto-slug-redirect";
import { parsePageBlocks, serializePageBlocks } from "@/lib/pages/page-blocks";
import { getSystemPageDefault } from "@/lib/legal/system-page-content";
import { fail, ok, workflow, ZOD_FR, zodValidationFail } from "../shared";
import type { CmsActorCtx } from "./setting";

const slugSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "Lettres minuscules, chiffres et tirets uniquement (ex. a-propos).",
  );

/** French field labels for the validation banner (zodValidationFail). */
const PAGE_FIELD_LABELS: Record<string, string> = {
  slug: "Slug (URL)",
  title: "Titre",
  metaTitle: "Meta title",
  metaDescription: "Meta description",
  ogImageMediaId: "Image de partage",
};

export const createPageSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1, "Champ requis.").max(200),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
});

export const createPageWorkflow = workflow<
  [z.input<typeof createPageSchema>, CmsActorCtx?],
  { id: string }
>("cms.page.create", async (input, ctx = {}) => {
  const parsed = createPageSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, PAGE_FIELD_LABELS);

  // Cross-entity slug check — `/[slug]` resolves to category, product,
  // brand, or page in that order, so colliding with any of those (or with
  // a static storefront route) would make the page unreachable. `forKind:
  // "page"` also reports a soft-deleted page still holding the slug (the
  // pages index is total — the insert would otherwise hit a bare 23505).
  const availability = await checkSlugAvailability(parsed.data.slug, { forKind: "page" });
  if (!availability.ok) {
    return fail("conflict", availability.message, { slug: availability.message });
  }

  // A brand-new page always starts as a DRAFT: it has no blocks and no sections yet, so
  // publishing it at creation would serve a blank public page + list a thin slug in the
  // sitemap. The operator adds content in the composer, then publishes — togglePagePublish
  // enforces the has-content guard at that point.
  const row = await pageService.insert({
    slug: parsed.data.slug,
    title: parsed.data.title,
    meta_title: parsed.data.metaTitle ?? null,
    meta_description: parsed.data.metaDescription ?? null,
    is_published: false,
    published_at: null,
  });
  await bus.emit("page.created", { pageId: row.id, slug: row.slug }, ctx);
  return ok({ id: row.id });
});

/**
 * Idempotent patch for a CMS page's metadata (slug, title, meta tags,
 * og image). Workflow only touches fields the caller provides.
 */
export const updatePageSchema = z.object({
  pageId: z.string().uuid(),
  slug: slugSchema.optional(),
  title: z.string().trim().min(1, "Champ requis.").max(200).optional(),
  metaTitle: z.string().nullable().optional(),
  metaDescription: z.string().nullable().optional(),
  ogImageMediaId: z.string().uuid().nullable().optional(),
  // Per-page SEO (migration 0175). canonicalUrl is rendered as <link rel=canonical> and
  // must be a safe URL; noindex keeps a thin/duplicate page out of search.
  canonicalUrl: safeHrefSchema.nullable().optional(),
  noindex: z.boolean().optional(),
});

export const updatePageWorkflow = workflow<
  [z.input<typeof updatePageSchema>, CmsActorCtx?],
  { id: string }
>("cms.page.update", async (input, ctx = {}) => {
  const parsed = updatePageSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, PAGE_FIELD_LABELS);

  const existing = await pageService.findById(parsed.data.pageId);
  if (!existing) return fail("not_found", "Page introuvable.");

  // A system page's slug is wired to a hardcoded route — renaming it would
  // orphan the route. Editable in every other way (title/meta/sections).
  if (
    existing.is_system &&
    parsed.data.slug !== undefined &&
    parsed.data.slug !== existing.slug
  ) {
    return fail("forbidden", "Page système — le slug ne peut pas être modifié.");
  }

  // Slug change must remain unique across the whole `/[slug]` namespace.
  // Exclude the current page so renaming to its own slug is a no-op rather
  // than a self-collision.
  if (parsed.data.slug !== undefined && parsed.data.slug !== existing.slug) {
    const availability = await checkSlugAvailability(parsed.data.slug, {
      excludeKind: "page",
      excludeId: existing.id,
      forKind: "page",
    });
    if (!availability.ok) {
      return fail("conflict", availability.message, { slug: availability.message });
    }
  }

  const patch: Parameters<typeof pageService.update>[1] = {};
  if (parsed.data.slug !== undefined) patch.slug = parsed.data.slug;
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.metaTitle !== undefined) patch.meta_title = parsed.data.metaTitle;
  if (parsed.data.metaDescription !== undefined)
    patch.meta_description = parsed.data.metaDescription;
  if (parsed.data.ogImageMediaId !== undefined)
    patch.og_image_media_id = parsed.data.ogImageMediaId;
  if (parsed.data.canonicalUrl !== undefined)
    patch.canonical_url = parsed.data.canonicalUrl || null;
  if (parsed.data.noindex !== undefined) patch.noindex = parsed.data.noindex;

  if (Object.keys(patch).length === 0) {
    return ok({ id: existing.id });
  }

  const updated = await pageService.update(parsed.data.pageId, patch);
  if (!updated) return fail("not_found", "Page introuvable.");
  // Page-level fields (slug / title / SEO meta) → `page.updated` (curated audit
  // row + cache bust of the page's tags). Block-layout saves emit it too (with
  // changedFields ["blocks"], see savePageBlocksWorkflow).
  await bus.emit(
    "page.updated",
    { pageId: updated.id, slug: updated.slug, changedFields: Object.keys(patch) },
    ctx,
  );
  // Renaming a page keeps its OLD URL working (301 in the `/[slug]` namespace) and frees the
  // new URL from any shadowing redirect — parity with category/brand/collection renames.
  if (parsed.data.slug !== undefined && parsed.data.slug !== existing.slug) {
    await syncEntityUrlRedirects(
      {
        wasLive: existing.is_published,
        isLive: updated.is_published,
        before: [`/${existing.slug}`],
        after: [`/${updated.slug}`],
      },
      { actorUserId: ctx.actorUserId ?? "", label: `slug de la page « ${updated.title} » modifié` },
    );
  }
  return ok({ id: updated.id });
});

/**
 * Persist the page's block-composer layout (the JSON the admin composer posts). Re-validated
 * + cleaned server-side through parsePageBlocks (unknown types dropped, every field coerced,
 * stable ids, 40-block cap) before it is stored in `pages.blocks`, so a crafted payload can
 * never persist bad data. Once saved, this drives the storefront page render.
 */
export const savePageBlocksWorkflow = workflow<
  [{ pageId: string; blocks: string }, CmsActorCtx?],
  { id: string }
>("cms.page.save_blocks", async ({ pageId, blocks }, ctx = {}) => {
  const existing = await pageService.findById(pageId);
  if (!existing) return fail("not_found", "Page introuvable.");
  const parsed = parsePageBlocks(blocks);
  // A PUBLISHED page must never be blanked into a live 200 placeholder (still indexed +
  // in the sitemap). togglePagePublish enforces "has visible content" at publish time;
  // enforce the SAME invariant on a block save so an operator can't clear every block of
  // an already-published custom page. A draft (unpublished) may be blanked freely.
  if (existing.is_published) {
    const hasBlocks = parsed.some((b) => b.visible);
    const hasSections =
      !hasBlocks && (await pageService.listSectionsForPage(pageId)).some((s) => s.is_visible);
    const hasSystemDefault = Boolean(getSystemPageDefault(existing.slug));
    if (!hasBlocks && !hasSections && !hasSystemDefault) {
      return fail(
        "validation",
        "Cette page est publiée : gardez au moins un bloc visible, ou dépubliez-la avant de tout retirer.",
      );
    }
  }
  const clean = serializePageBlocks(parsed);
  const updated = await pageService.update(pageId, { blocks: clean });
  if (!updated) return fail("not_found", "Page introuvable.");
  await bus.emit(
    "page.updated",
    { pageId: updated.id, slug: updated.slug, changedFields: ["blocks"] },
    ctx,
  );
  return ok({ id: updated.id });
});

export const togglePagePublishWorkflow = workflow<
  [{ pageId: string; publish: boolean }, CmsActorCtx?],
  { id: string }
>("cms.page.toggle_publish", async ({ pageId, publish }, ctx = {}) => {
  const existing = await pageService.findById(pageId);
  if (!existing) return fail("not_found", "Page introuvable.");
  // Publishing a page with nothing to show serves a blank public page. A page has content
  // when it carries composer BLOCKS, or legacy visible SECTIONS, or (for a system legal
  // slug) a built-in default the renderer falls back to. Only a truly empty custom page is
  // refused.
  if (publish) {
    // Count only VISIBLE blocks — a layout whose every block is hidden renders blank,
    // exactly like the all-hidden legacy-sections case below.
    const hasBlocks = parsePageBlocks(existing.blocks).some((b) => b.visible);
    const hasSections =
      !hasBlocks && (await pageService.listSectionsForPage(pageId)).some((s) => s.is_visible);
    const hasSystemDefault = Boolean(getSystemPageDefault(existing.slug));
    if (!hasBlocks && !hasSections && !hasSystemDefault) {
      return fail(
        "validation",
        "Ajoutez au moins un bloc visible avant de publier cette page.",
      );
    }
  }
  await pageService.update(pageId, {
    is_published: publish,
    published_at: publish ? new Date() : existing.published_at,
  });
  await bus.emit(
    publish ? "page.published" : "page.unpublished",
    { pageId, slug: existing.slug },
    ctx,
  );
  return ok({ id: pageId });
});

export const deletePageWorkflow = workflow<[{ pageId: string }, CmsActorCtx?], { id: string }>(
  "cms.page.delete",
  async ({ pageId }, ctx = {}) => {
    // Existence check before the soft delete so a stale admin click on an
    // already-removed page returns a clean not_found instead of a silent
    // success that still emits a `page.deleted` event.
    const existing = await pageService.findById(pageId);
    if (!existing) return fail("not_found", "Page introuvable.");
    // System pages (help + legal, seeded in 0061) are protected — the routes
    // depend on their slugs, so deletion is refused.
    if (existing.is_system) {
      return fail("forbidden", "Page système — suppression interdite.");
    }

    await pageService.softDelete(pageId);
    await bus.emit("page.deleted", { pageId }, ctx);
    return ok({ id: pageId });
  },
);
