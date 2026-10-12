import "server-only";

import { z } from "zod";

import { bannerService } from "@/modules/cms/banner/service";
import { bus } from "@/events/bus";
import { safeHrefSchema } from "@/lib/utils/safe-href";
import { parseBannerButtons, serializeBannerButtons } from "@/lib/cms/banner-model";
import { parseStoreLocalDateTime } from "@/lib/time/store-tz";
import { fail, ok, workflow, ZOD_FR, zodValidationFail } from "../shared";
import type { CmsActorCtx } from "./setting";

/** Re-parse + sanitise the posted buttons JSON into a clean stored string (bad entries dropped,
 *  hrefs safe-href'd, capped). The field ABSENT (undefined — a placement whose form has no buttons
 *  editor) stores NULL, so effectiveBannerButtons() keeps falling back to the legacy cta_* columns.
 *  A SUBMITTED editor (even emptied to "[]") stores an authoritative array — this is what lets an
 *  operator CLEAR a hero's CTAs: a non-null "[]" wins over the legacy columns at render. */
const cleanButtons = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  return serializeBannerButtons(parseBannerButtons(raw));
};

// Banner CTA hrefs are rendered as <a href>/<Link href> on the storefront.
// safeHrefSchema enforces http(s)/mailto/tel/relative — blocks javascript:
// stored-XSS that plain z.string().url() would silently accept.
const optionalUrl = safeHrefSchema.optional();

// The admin form posts `<input type="datetime-local">` values like
// "2026-06-09T14:30" (no seconds, no timezone) which z.string().datetime()
// rejects. Accept any string the JS Date parser understands (covers both
// datetime-local and full ISO).
// ABSENT (undefined) and PRESENT-BUT-EMPTY ("") must stay distinct: absent =
// leave the stored date untouched (partial update), "" = the operator CLEARED
// the input → null → the column is cleared (a banner made permanent / a
// future start removed). Collapsing "" to undefined made a cleared schedule
// silently keep the old dates while the save reported success. (zod 4 runs an
// optional-input transform on undefined too, so it must be handled explicitly.)
const optionalDateInput = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined ? undefined : v.length ? v : null))
  .refine((v) => v == null || !Number.isNaN(Date.parse(v)), "Date invalide");

const bannerBaseSchema = z.object({
  // `checkout` is not offered (no storefront consumer); the DB enum keeps it only for
  // any theoretical legacy row. The generic create/update form only reaches home_hero /
  // header_strip / category_grid / footer, so those are the only values it accepts.
  placement: z.enum(["home_hero", "header_strip", "category_grid", "footer"]),
  name: z.string().trim().min(1).max(120),
  eyebrow: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  ctaLabel: z.string().optional(),
  ctaHref: optionalUrl,
  imageMediaId: z.string().uuid().nullable().optional(),
  // Optional art-directed MOBILE visual (portrait crop). null clears it.
  imageMobileMediaId: z.string().uuid().nullable().optional(),
  // Optional HOSTED video URL (home hero) — safe-href validated (blocks javascript:).
  // "" / absent → cleared. A plain URL, not a média id.
  videoUrl: optionalUrl,
  // home_hero: false = pure image/video link (no text overlay). OPTIONAL (no default) so
  // the form only sends it for the hero; the create mapper defaults a missing value to
  // true and the update mapper leaves the column untouched — a non-hero save never writes
  // show_text=false (which would make the banner text-less if later retargeted to a hero).
  showText: z.boolean().optional(),
  // Editable CTAs as a JSON array string — re-parsed + sanitised in the mapper via
  // parseBannerButtons (bad entries dropped, hrefs safe-href'd, capped). "" / absent → null.
  buttons: z.string().optional(),
  startAt: optionalDateInput,
  endAt: optionalDateInput,
  displayOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  // In-grid (category_grid) targeting + cadence — only meaningful for the
  // category_grid placement; ignored by the other placements at render.
  targetKind: z.enum(["none", "category", "brand", "filter"]).default("none"),
  // Target category/brand slug or filter attribute-value id. Empty → unset.
  targetRef: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length ? v : undefined)),
  // Appear after every N "Charger plus" blocks (1 = every load-more).
  afterLoadMoreCount: z.number().int().min(1).max(20).default(2),
  // category_grid position: top | after_load_more | after_rows.
  gridPosition: z.enum(["top", "after_load_more", "after_rows"]).default("after_rows"),
  // header_strip style. showCountdown OPTIONAL (like showText) so a non-strip save never
  // writes show_countdown=false. stripIcon up to 16 UTF-16 units — a single multi-codepoint
  // ZWJ emoji (e.g. 👨‍👩‍👧‍👦 = 11 units) must fit.
  stripTone: z.enum(["olive", "dark", "gold", "burgundy"]).default("olive"),
  stripIcon: z.string().trim().max(16).optional(),
  showCountdown: z.boolean().optional(),
});

// A scoped target (category/brand/filter) is meaningless without a ref, and a
// 'none' target must NOT carry a stale ref (it would index a global banner under
// a slug). Only cross-checks when targetKind is present in the submission so a
// partial update touching unrelated fields isn't blocked.
const targetRefConsistent = (d: { targetKind?: string; targetRef?: string }): boolean => {
  if (d.targetKind === undefined) return true;
  if (d.targetKind === "none") return true; // ref is cleared in the mapper below
  return Boolean(d.targetRef && d.targetRef.length > 0);
};
const targetRefIssue = {
  message: "Sélectionnez la cible (catégorie, marque ou filtre) pour ce ciblage.",
  path: ["targetRef"],
};

// A schedule with end <= start would make `listLive` (start <= now AND
// end > now) NEVER match — a silent "campaign that never shows". Reject it.
// Only fires when BOTH dates are set in the submission (a partial update
// touching just one can't cross-check the stored value without a DB read; a
// cleared date is open-ended, so it can't invert the window).
const endAfterStart = (d: { startAt?: string | null; endAt?: string | null }): boolean =>
  !d.startAt || !d.endAt || Date.parse(d.endAt) > Date.parse(d.startAt);
const endAfterStartIssue = {
  message: "La date de fin doit être postérieure à la date de début.",
  path: ["endAt"],
};

/** French field labels for the validation banner (zodValidationFail). */
const BANNER_FIELD_LABELS: Record<string, string> = {
  id: "Bannière",
  placement: "Emplacement",
  name: "Nom interne",
  eyebrow: "Surtitre",
  title: "Titre",
  subtitle: "Sous-titre",
  description: "Description",
  ctaLabel: "Bouton — texte",
  ctaHref: "Bouton — lien",
  imageMediaId: "Visuel",
  imageMobileMediaId: "Visuel mobile",
  videoUrl: "Vidéo (URL)",
  showText: "Afficher le texte",
  buttons: "Boutons",
  isActive: "Active",
  startAt: "Début",
  endAt: "Fin",
  displayOrder: "Ordre d'affichage",
  targetKind: "Cibler",
  targetRef: "Cible",
  afterLoadMoreCount: "Répéter tous les N blocs",
  gridPosition: "Position dans la liste",
  stripTone: "Couleur du bandeau",
  stripIcon: "Icône / emoji",
  showCountdown: "Compte à rebours",
};

export const createBannerSchema = bannerBaseSchema
  .refine(endAfterStart, endAfterStartIssue)
  .refine(targetRefConsistent, targetRefIssue);

export const createBannerWorkflow = workflow<
  [z.input<typeof createBannerSchema>, CmsActorCtx?],
  { id: string }
>("cms.banner.create", async (input, ctx = {}) => {
  const parsed = createBannerSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, BANNER_FIELD_LABELS);
  const d = parsed.data;
  // The footer banner is a SINGLETON (CMS → Footer edits the one row). Guard against a
  // second create (e.g. two stale create-mode tabs racing) so the storefront never has
  // ambiguous `footerBanners[0]` rows — the operator edits the existing one instead.
  if (d.placement === "footer" && (await bannerService.findAnyByPlacement("footer"))) {
    return fail("conflict", "Un bandeau footer existe déjà — modifiez-le dans CMS → Footer.");
  }
  const row = await bannerService.insert({
    placement: d.placement,
    name: d.name,
    eyebrow: d.eyebrow ?? null,
    title: d.title,
    subtitle: d.subtitle ?? null,
    description: d.description ?? null,
    cta_label: d.ctaLabel ?? null,
    cta_href: d.ctaHref ?? null,
    image_media_id: d.imageMediaId ?? null,
    image_mobile_media_id: d.imageMobileMediaId ?? null,
    video_url: d.videoUrl ?? null,
    // Absent (non-hero create) → the column default true, never a surprise false.
    show_text: d.showText ?? true,
    buttons: cleanButtons(d.buttons),
    start_at: parseStoreLocalDateTime(d.startAt),
    end_at: parseStoreLocalDateTime(d.endAt),
    display_order: d.displayOrder,
    is_active: d.isActive,
    // A 'none' target stores no ref; a scoped target stores its slug/id.
    target_kind: d.targetKind,
    target_ref: d.targetKind === "none" ? null : (d.targetRef ?? null),
    after_load_more_count: d.afterLoadMoreCount,
    grid_position: d.gridPosition,
    strip_tone: d.stripTone,
    strip_icon: d.stripIcon ?? null,
    // Absent (non-strip create) → the column default false.
    show_countdown: d.showCountdown ?? false,
  });
  await bus.emit("banner.created", { bannerId: row.id, placement: row.placement }, ctx);
  return ok({ id: row.id });
});

export const updateBannerSchema = bannerBaseSchema
  .partial()
  .extend({ id: z.string().uuid() })
  .refine(endAfterStart, endAfterStartIssue)
  .refine(targetRefConsistent, targetRefIssue);

export const updateBannerWorkflow = workflow<
  [z.input<typeof updateBannerSchema>, CmsActorCtx?],
  { id: string }
>("cms.banner.update", async (input, ctx = {}) => {
  const parsed = updateBannerSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, BANNER_FIELD_LABELS);
  const d = parsed.data;

  const patch: Parameters<typeof bannerService.update>[1] = {};
  if (d.placement !== undefined) patch.placement = d.placement;
  if (d.name !== undefined) patch.name = d.name;
  if (d.eyebrow !== undefined) patch.eyebrow = d.eyebrow ?? null;
  if (d.title !== undefined) patch.title = d.title;
  if (d.subtitle !== undefined) patch.subtitle = d.subtitle ?? null;
  if (d.description !== undefined) patch.description = d.description ?? null;
  if (d.ctaLabel !== undefined) patch.cta_label = d.ctaLabel ?? null;
  if (d.ctaHref !== undefined) patch.cta_href = d.ctaHref ?? null;
  if (d.imageMediaId !== undefined) patch.image_media_id = d.imageMediaId;
  if (d.imageMobileMediaId !== undefined) patch.image_mobile_media_id = d.imageMobileMediaId;
  if (d.videoUrl !== undefined) patch.video_url = d.videoUrl ?? null;
  if (d.showText !== undefined) patch.show_text = d.showText;
  if (d.buttons !== undefined) patch.buttons = cleanButtons(d.buttons);
  if (d.startAt !== undefined) patch.start_at = parseStoreLocalDateTime(d.startAt);
  if (d.endAt !== undefined) patch.end_at = parseStoreLocalDateTime(d.endAt);
  if (d.displayOrder !== undefined) patch.display_order = d.displayOrder;
  if (d.isActive !== undefined) patch.is_active = d.isActive;
  // Targeting: when kind is set, also (re)write the ref — clearing it for
  // 'none' so a banner switched back to global never keeps a stale slug.
  if (d.targetKind !== undefined) {
    patch.target_kind = d.targetKind;
    patch.target_ref = d.targetKind === "none" ? null : (d.targetRef ?? null);
  } else if (d.targetRef !== undefined) {
    patch.target_ref = d.targetRef ?? null;
  }
  if (d.afterLoadMoreCount !== undefined) patch.after_load_more_count = d.afterLoadMoreCount;
  if (d.gridPosition !== undefined) patch.grid_position = d.gridPosition;
  if (d.stripTone !== undefined) patch.strip_tone = d.stripTone;
  if (d.stripIcon !== undefined) patch.strip_icon = d.stripIcon ?? null;
  if (d.showCountdown !== undefined) patch.show_countdown = d.showCountdown;

  if (Object.keys(patch).length === 0) return ok({ id: d.id });
  const updated = await bannerService.update(d.id, patch);
  // A null row means the id vanished between load and save — don't fabricate a
  // "home_hero" placement (would bust the wrong cache); fail not_found instead.
  if (!updated) return fail("not_found", "Bannière introuvable.");
  await bus.emit(
    "banner.updated",
    {
      bannerId: updated.id,
      placement: updated.placement,
      changedFields: Object.keys(patch),
    },
    ctx,
  );
  return ok({ id: updated.id });
});

/**
 * Featured panel of a mega-menu dropdown — the five `nav_*` placements, each a
 * SINGLETON banner edited only from CMS → Nav Menu (image + eyebrow / title /
 * link per nav root). They're deliberately NOT in the create/update zod enum
 * above (an admin-curated set, not a freeform campaign), so this dedicated
 * workflow owns the upsert: patch the existing row whatever its active/schedule
 * state, else create a minimal active one seeded from the root label. Emits
 * `banner.updated` / `banner.created` like every other banner write, so the
 * change reaches the audit log, webhooks and the banner cache busting.
 */
export const NAV_FEATURED_PLACEMENTS = {
  nav_boutique: "Boutique",
  nav_marques: "Marques",
  nav_maison: "Maison",
} as const;
export type NavFeaturedPlacement = keyof typeof NAV_FEATURED_PLACEMENTS;

const NAV_FEATURED_KEYS = Object.keys(NAV_FEATURED_PLACEMENTS) as [
  NavFeaturedPlacement,
  ...NavFeaturedPlacement[],
];

const NAV_FEATURED_FIELD_LABELS: Record<string, string> = {
  placement: "Emplacement",
  imageMediaId: "Image",
  eyebrow: "Surtitre",
  title: "Titre",
  ctaHref: "Lien",
};

// Every field but the placement is optional: ABSENT = leave the stored value
// untouched; "" (eyebrow / link) = clear it; null image = remove the image
// (the dropdown then renders without its featured panel — hide-when-unset).
export const setNavFeaturedSchema = z.object({
  placement: z.enum(NAV_FEATURED_KEYS),
  imageMediaId: z.string().uuid().nullable().optional(),
  eyebrow: z.string().trim().max(120).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  // Rendered as the panel's <Link href> → same XSS guard as every banner CTA.
  // Blank → the storefront links the panel to the dropdown's own root.
  ctaHref: safeHrefSchema.optional(),
});

export const setNavFeaturedWorkflow = workflow<
  [z.input<typeof setNavFeaturedSchema>, CmsActorCtx?],
  { id: string }
>("cms.banner.nav_featured", async (input, ctx = {}) => {
  const parsed = setNavFeaturedSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, NAV_FEATURED_FIELD_LABELS);
  const d = parsed.data;
  const eyebrow = d.eyebrow === undefined ? undefined : d.eyebrow || null;
  const ctaHref = d.ctaHref === undefined ? undefined : d.ctaHref || null;

  const existing = await bannerService.findAnyByPlacement(d.placement);
  if (existing) {
    // Only REAL changes are written + reported, so an identical re-save is a
    // no-op (no write, no event, no audit row) and `changedFields` is truthful.
    const patch: Parameters<typeof bannerService.update>[1] = {};
    if (d.imageMediaId !== undefined && d.imageMediaId !== existing.image_media_id) {
      patch.image_media_id = d.imageMediaId;
    }
    if (eyebrow !== undefined && eyebrow !== existing.eyebrow) patch.eyebrow = eyebrow;
    if (d.title !== undefined && d.title !== existing.title) patch.title = d.title;
    if (ctaHref !== undefined && ctaHref !== existing.cta_href) patch.cta_href = ctaHref;
    if (Object.keys(patch).length === 0) return ok({ id: existing.id });
    const updated = await bannerService.update(existing.id, patch);
    if (!updated) return fail("not_found", "Bannière introuvable.");
    await bus.emit(
      "banner.updated",
      { bannerId: updated.id, placement: updated.placement, changedFields: Object.keys(patch) },
      ctx,
    );
    return ok({ id: updated.id });
  }
  const label = NAV_FEATURED_PLACEMENTS[d.placement];
  const row = await bannerService.insert({
    placement: d.placement,
    name: `Image vedette — ${label}`,
    title: d.title ?? label,
    eyebrow: eyebrow ?? null,
    cta_href: ctaHref ?? null,
    image_media_id: d.imageMediaId ?? null,
    is_active: true,
  });
  await bus.emit("banner.created", { bannerId: row.id, placement: row.placement }, ctx);
  return ok({ id: row.id });
});

export const deleteBannerWorkflow = workflow<[{ id: string }, CmsActorCtx?], { id: string }>(
  "cms.banner.delete",
  async ({ id }, ctx = {}) => {
    const existing = await bannerService.findById(id);
    await bannerService.softDelete(id);
    if (existing) {
      await bus.emit("banner.deleted", { bannerId: id, placement: existing.placement }, ctx);
    }
    return ok({ id });
  },
);
