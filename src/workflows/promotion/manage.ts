import "server-only";

import { randomInt } from "node:crypto";
import { z } from "zod";

import { promotionService } from "@/modules/promotion";
import { segmentService } from "@/modules/customer/segment.service";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { parseStoreLocalDateTime } from "@/lib/time/store-tz";
import { pgErrorCode, pgErrorConstraint } from "@/lib/db/pg-errors";
import { bus } from "@/events/bus";
import { isFlowEnabled } from "@/modules/mailing";
import { marketingSendBlocked } from "@/lib/mailing/automation-gate";
import { isValidRuleTree } from "@/lib/promotions/rule-leaves";
import type { RuleNode } from "@/lib/promotions/rule-tree";
import type { PromotionRow, PromotionTargetType } from "@/modules/promotion/schema";
import { fail, ok, workflow } from "../shared";

/**
 * Promotion CRUD workflows.
 *
 * Validation strategy
 * ───────────────────
 * The base Zod schema is permissive about the trigger/scope/value combos
 * (the DB CHECK constraints enforce them too), but we still cross-check
 * here so admin form errors are precise field-level messages instead of
 * a generic "constraint violation" coming back from Postgres.
 */

/** The mailing flow/template key for a promotion announcement (gate + dedup share it). */
const ANNOUNCE_FLOW = "promotion_announcement";

// ─────────────────────────── shared Zod pieces ───────────────────────────
const couponCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, "Le code ne peut contenir que des lettres, chiffres, tirets et underscores");

const urlSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug invalide (lettres minuscules, chiffres, tirets uniquement)");

const baseSchema = z.object({
  name: z.string().trim().min(2).max(160),

  /** Targeting (code/URL promos only) — restricts the promo to the chosen
   *  buyers. ALL empty = PUBLIC promo. Targeting flows through
   *  promotion_targets (see promotion/service.ts). */
  targetSegmentIds: z.array(z.string().uuid()).optional().default([]),
  /** Raw customer emails (lower-cased by the action). Resolved to profile ids
   *  in the workflow body; emails with no account/profile are dropped with a
   *  warning — and the save is REFUSED when no target at all survives (it would
   *  otherwise turn the promo public). */
  targetCustomerEmails: z.array(z.string()).optional().default([]),

  triggerKind: z.enum(["auto", "code", "url"]),
  code: couponCodeSchema.optional().nullable(),
  urlSlug: urlSlugSchema.optional().nullable(),

  scope: z.enum(["product", "category", "brand", "cart", "targeted"]),
  scopeId: z.string().uuid().nullable().optional(),
  /** MULTI-target product set (scope='targeted'): any mix of products / categories
   *  / brands the promo applies to. Ignored for the single-scope kinds (their one
   *  target is synthesised from scopeId). includeDescendants is categories-only
   *  (default true = cascade to subcategory products). Refined + persisted below. */
  scopeTargets: z
    .array(
      z.object({
        targetType: z.enum(["product", "category", "brand"]),
        targetId: z.string().uuid(),
        includeDescendants: z.boolean().optional(),
        /** Product targets only (migration 0173): narrow to a single variant. */
        variantId: z.string().uuid().optional(),
      }),
    )
    .optional()
    .default([]),

  discountType: z.enum(["percent", "fixed"]),
  /** Percent (1..100) or millimes (>=1) — but 0 is allowed for a
   *  free-shipping-only promo. Refined below. */
  discountValue: z.coerce.number().int().min(0),
  /** Optional cap on a PERCENT discount's value (millimes). NULL = uncapped. */
  maxDiscountCents: z.coerce.number().int().min(1).nullable().optional(),

  minCartCents: z.coerce.number().int().min(0).default(0),
  /** Optional UPPER cart bound (millimes). NULL = no upper bound. */
  maxCartCents: z.coerce.number().int().min(1).nullable().optional(),
  maxUses: z.coerce.number().int().min(1).nullable().optional(),
  maxUsesPerUser: z.coerce.number().int().min(1).nullable().optional(),

  // ISO date-time strings from the admin form (datetime-local inputs).
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  /** Scheduled email-announcement instant (datetime-local, store-TZ). NULL = none.
   *  A cron sweep fires the announce when due; mutually exclusive with the immediate
   *  `announceByEmail` (create-time) checkbox. Set/changed/cleared on create AND edit. */
  announceAt: z.string().nullable().optional(),

  isActive: z.boolean().default(true),
  isStackable: z.boolean().default(false),
  /** When true a cart coupon's discount excludes already-on-sale lines. */
  excludeDiscountedItems: z.boolean().default(false),
  /** The promo zeroes shipping (code/URL cart coupon perk). */
  grantsFreeShipping: z.boolean().default(false),
  /** New-customer WELCOME coupon — applies only to a buyer's FIRST order. Code/URL
   *  triggers only (an auto promo has no buyer to check). */
  firstOrderOnly: z.boolean().default(false),
  /** Inline audience rule (compound rule_tree over buyer facts). Validated by
   *  `isValidRuleTree` in the refine; code/URL triggers only. NULL/undefined = none. */
  audienceRuleTree: z.custom<RuleNode>().nullable().optional(),
  displayPriority: z.coerce.number().int().min(0).max(100).default(0),

  /** Announce this promotion by email to its audience (on CREATE only). The
   *  actual blast is fired via the `promotion.announce_requested` event so it
   *  never re-fires on edit. */
  announceByEmail: z.boolean().optional().default(false),
});

/**
 * Cross-field refine that mirrors the DB CHECK constraints.
 *
 * Generic over the inner schema's shape so it composes with both the
 * `baseSchema` (create) and `baseSchema.extend({ promotionId })` (update).
 */
type RefinableShape = {
  discountType: "percent" | "fixed";
  discountValue: number;
  scope: "product" | "category" | "brand" | "cart" | "targeted";
  scopeId?: string | null;
  scopeTargets: Array<{
    targetType: "product" | "category" | "brand";
    targetId: string;
    includeDescendants?: boolean;
    variantId?: string;
  }>;
  triggerKind: "auto" | "code" | "url";
  code?: string | null;
  urlSlug?: string | null;
  targetSegmentIds: string[];
  targetCustomerEmails: string[];
  grantsFreeShipping: boolean;
  firstOrderOnly: boolean;
  audienceRuleTree?: RuleNode | null;
  minCartCents: number;
  maxCartCents?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  announceAt?: string | null;
  announceByEmail: boolean;
};
function refineCombo<T extends z.ZodType<RefinableShape>>(schema: T) {
  return schema.superRefine((d, ctx) => {
    // discount bounds.
    // A free-shipping-ONLY promo carries discount_value 0 (no line discount);
    // every other promo needs a real value (percent 1-100, fixed >= 1 millime).
    if (d.grantsFreeShipping && d.discountValue === 0) {
      // OK — the shipping perk IS the discount. Skip the lower-bound check.
    } else if (d.discountType === "percent" && (d.discountValue < 1 || d.discountValue > 100)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountValue"],
        message: "Le pourcentage doit être compris entre 1 et 100",
      });
    } else if (d.discountType === "fixed" && d.discountValue < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountValue"],
        message: "Le montant doit être d'au moins 1 millime",
      });
    }

    // scope_id / scope-targets shape
    //   cart      → no scopeId, no scopeTargets (whole cart)
    //   targeted  → no scopeId, ≥1 scopeTargets (the multi-target set)
    //   product/category/brand → exactly one scopeId (single target)
    if ((d.scope === "cart" || d.scope === "targeted") && d.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message:
          d.scope === "cart"
            ? "Une promo panier ne peut pas avoir de cible — laissez vide"
            : "Un ciblage multiple n'utilise pas de cible unique — laissez vide",
      });
    }
    if (d.scope === "targeted" && d.scopeTargets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeTargets"],
        message: "Ajoutez au moins un produit, une catégorie ou une marque à cibler.",
      });
    }
    // Per-variant targeting (migration 0173) is honoured only on the AUTO / per-line
    // price path. The coupon + URL eligibility path matches products by id with no
    // variant facts (matchProductIdsToEffTargets / CouponCartLine carry no variant),
    // so a variant-pinned target on a code/url promo would silently discount NOTHING.
    // Reject it at authoring time instead of shipping a dead coupon.
    if (d.triggerKind !== "auto" && d.scopeTargets.some((t) => t.variantId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeTargets"],
        message:
          "Le ciblage par variante n'est disponible que pour les promotions automatiques — retirez la variante ou passez le déclencheur sur « automatique ».",
      });
    }
    if (d.scope !== "cart" && d.scope !== "targeted" && !d.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "Choisissez une cible pour ce type de promotion",
      });
    }

    // trigger / surface
    if (d.triggerKind === "code" && !d.code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["code"],
        message: "Le code coupon est requis quand le déclencheur est « code »",
      });
    }
    if (d.triggerKind === "url" && !d.urlSlug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["urlSlug"],
        message: "Le slug URL est requis quand le déclencheur est « URL »",
      });
    }
    if (d.triggerKind === "auto" && (d.code || d.urlSlug)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerKind"],
        message: "Une promo auto ne peut pas avoir de code ni de slug URL",
      });
    }

    // Targeting is meaningless on an AUTO promo: the auto-apply query has no
    // buyer identity (anonymous PDP/checkout-auto path), so a targeted auto
    // promo would NEVER fire — silently inert. Reject ANY targeting so the
    // admin picks a code/URL trigger (where eligibility is actually checked).
    if (
      d.triggerKind === "auto" &&
      (d.targetSegmentIds.length > 0 || d.targetCustomerEmails.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerKind"],
        message:
          "Une promo automatique ne peut pas être ciblée. Choisissez un déclencheur « Code » ou « URL ».",
      });
    }

    // Free shipping is a cart-coupon perk applied at checkout once the buyer
    // chose a code/URL promo; an AUTO promo has no checkout coupon surface to
    // attach it to. Reject it so the admin picks a code/URL trigger.
    if (d.triggerKind === "auto" && d.grantsFreeShipping) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerKind"],
        message:
          "La livraison offerte est réservée aux coupons (code/URL). Choisissez un déclencheur « Code » ou « URL ».",
      });
    }

    // A « première commande » gate needs a buyer identity to check prior orders —
    // the auto-apply path has none. Reject it on auto (same as targeting / free-ship).
    if (d.triggerKind === "auto" && d.firstOrderOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerKind"],
        message:
          "Une offre « première commande » ne peut être qu'un coupon (code/URL). Choisissez un déclencheur « Code » ou « URL ».",
      });
    }

    // Inline audience rule: must be a valid, non-empty tree (fail-closed — an
    // empty group would match everybody), and — like every buyer-aware gate —
    // reserved for code/URL coupons (the auto-apply path has no buyer to match).
    if (d.audienceRuleTree != null) {
      if (!isValidRuleTree(d.audienceRuleTree)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audienceRuleTree"],
          message: "La règle d'audience est invalide (groupe vide ou condition non reconnue).",
        });
      }
      if (d.triggerKind === "auto") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["triggerKind"],
          message:
            "Une règle d'audience ne peut cibler qu'un coupon (code/URL). Choisissez un déclencheur « Code » ou « URL ».",
        });
      }
    }

    // A SCOPED coupon (code/URL trigger + product/category/brand scope) is now
    // supported: it discounts ONLY the matching cart lines at checkout (the
    // coupon-eligibility engine resolves the matching-lines base — see
    // lib/promotions/scoped-coupon + coupon-eligibility). No constraint needed
    // here beyond the scope/scopeId shape already enforced above.

    // Cart spend band: the upper bound must be ≥ the minimum, else NO cart can
    // satisfy both and the coupon is permanently inert (silently soft-dropped).
    // The DB only checks max_cart_cents > 0, so guard the cross-field here.
    if (d.maxCartCents != null && d.minCartCents > 0 && d.maxCartCents < d.minCartCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxCartTnd"],
        message: "Le plafond du panier doit être supérieur ou égal au minimum.",
      });
    }

    // schedule order
    if (d.startsAt && d.endsAt) {
      const s = Date.parse(d.startsAt);
      const e = Date.parse(d.endsAt);
      if (Number.isFinite(s) && Number.isFinite(e) && e <= s) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endsAt"],
          message: "La fin doit être après le début",
        });
      }
    }

    // Scheduled announce: mutually exclusive with the immediate create-time announce
    // (pick ONE — announce now OR at a scheduled time), and it must fire while the
    // promo is still live, so an announce_at at/after ends_at is inert (rejected).
    if (d.announceAt) {
      if (d.announceByEmail) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["announceAt"],
          message:
            "Choisissez soit l'annonce immédiate, soit une annonce programmée — pas les deux.",
        });
      }
      if (d.endsAt) {
        const a = Date.parse(d.announceAt);
        const e = Date.parse(d.endsAt);
        if (Number.isFinite(a) && Number.isFinite(e) && a >= e) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["announceAt"],
            message: "L'annonce doit être programmée avant la fin de la promotion.",
          });
        }
      }
    }
  });
}

// `datetime-local` fields are naked wall-clock strings — interpret them in the
// STORE zone (Africa/Tunis), NOT the container's UTC runtime, or every schedule
// drifts +1h in prod. See src/lib/time/store-tz.ts.
const parseDate = parseStoreLocalDateTime;

type TargetRow = { target_type: PromotionTargetType; target_id: string };

/** The scope-target (product-set) rows to persist for a promo, derived uniformly
 *  from the parsed input: the explicit multi-target set for scope='targeted', ONE
 *  synthesised row for a single-scope kind (so a form-created legacy promo carries
 *  the same uniform representation as the 0170 backfill), or none for cart. Kept in
 *  sync on every create/update via setScopeTargets. */
type ScopeTargetRow = {
  target_type: "product" | "category" | "brand";
  target_id: string;
  include_descendants: boolean;
  /** Product targets only (migration 0173): a specific variant, or null = all variants. */
  variant_id: string | null;
};

function scopeTargetRowsFor(d: {
  scope: "product" | "category" | "brand" | "cart" | "targeted";
  scopeId?: string | null;
  scopeTargets: Array<{
    targetType: "product" | "category" | "brand";
    targetId: string;
    includeDescendants?: boolean;
    variantId?: string;
  }>;
}): ScopeTargetRow[] {
  if (d.scope === "targeted") {
    // De-dupe (type,id,variant) — the DB unique index (NULLS NOT DISTINCT) would drop
    // repeats, but a clean set keeps the stored rows tidy. A product may appear once
    // per variant PLUS once whole-product.
    const seen = new Set<string>();
    const out: ScopeTargetRow[] = [];
    for (const t of d.scopeTargets) {
      const variantId = t.targetType === "product" ? (t.variantId ?? null) : null;
      const key = `${t.targetType}:${t.targetId}:${variantId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        target_type: t.targetType,
        target_id: t.targetId,
        // includeDescendants is meaningful for categories only; store true otherwise.
        include_descendants: t.targetType === "category" ? (t.includeDescendants ?? true) : true,
        variant_id: variantId,
      });
    }
    return out;
  }
  if (d.scope !== "cart" && d.scopeId) {
    return [{ target_type: d.scope, target_id: d.scopeId, include_descendants: true, variant_id: null }];
  }
  return [];
}

/** The admin's submitted picks that could NOT be persisted as targets.
 *  `emails` = no account / no linked profile; `archivedEmails` = the linked
 *  customer profile is archived (it can never match — buyer context reads live
 *  profiles only). */
type DroppedTargets = {
  segments: string[];
  emails: string[];
  archivedEmails: string[];
};

/**
 * Resolve the admin's raw targeting picks into validated promotion_targets rows.
 *   - segment: only ids that are live (segmentService.filterLiveIds).
 *   - customer: each email → auth user → linked customer profile id; emails
 *     with no account or no linked profile can't be targeted, nor can an
 *     ARCHIVED profile (dropped + reported, so the P1 « no valid target →
 *     refuse » guard also covers a set made only of archived customers).
 *
 * FAIL-CLOSED on edit: a pick that is ALREADY one of the promo's targets is kept
 * as-is, never re-validated away — the edit page re-renders a disabled targeted
 * segment precisely so a routine save keeps it, and dropping it would silently
 * WIDEN the promo (an empty set = PUBLIC). Only NEW picks are validated.
 *
 * Returns the persistable target set PLUS every submitted pick that was dropped,
 * so the caller can refuse a save that would turn a targeted promo public and
 * warn about partial drops (never a silent discard).
 */
async function resolveTargets(
  input: {
    targetSegmentIds: string[];
    targetCustomerEmails: string[];
  },
  opts: { existingTargets?: TargetRow[] } = {},
): Promise<{ targets: TargetRow[]; dropped: DroppedTargets }> {
  const targets: TargetRow[] = [];
  const dropped: DroppedTargets = { segments: [], emails: [], archivedEmails: [] };
  const existing = opts.existingTargets ?? [];
  const existingIds = (type: PromotionTargetType) =>
    new Set(existing.filter((t) => t.target_type === type).map((t) => t.target_id));
  const existingSegmentIds = existingIds("segment");

  // Segments — existing targets kept as-is; NEW ones only when live.
  const submittedSegmentIds = [...new Set(input.targetSegmentIds)];
  const liveNewSegmentIds = await segmentService.filterLiveIds(
    submittedSegmentIds.filter((id) => !existingSegmentIds.has(id)),
  );
  for (const id of submittedSegmentIds) {
    if (existingSegmentIds.has(id) || liveNewSegmentIds.has(id)) {
      targets.push({ target_type: "segment", target_id: id });
    } else {
      dropped.segments.push(id);
    }
  }

  // Customer emails → profile ids. Emails with no account / no profile link are
  // reported as dropped.
  const emails = new Set(input.targetCustomerEmails.map((e) => e.trim().toLowerCase()));
  for (const email of emails) {
    if (!email) continue;
    const user = await authService.findByEmail(email);
    // findByEmail is an ILIKE match (`_` / `%` are wildcards) — only an EXACT
    // (case-insensitive) hit may be targeted, never a look-alike account.
    const link =
      user && user.email.toLowerCase() === email
        ? await customerUserLink.findByUserId(user.id)
        : null;
    if (!link) {
      dropped.emails.push(email);
      continue;
    }
    // findProfileById reads LIVE profiles only — an archived one is dropped.
    if (!(await customerService.findProfileById(link.customer_profile_id))) {
      dropped.archivedEmails.push(email);
      continue;
    }
    targets.push({ target_type: "customer", target_id: link.customer_profile_id });
  }

  return { targets, dropped };
}

/**
 * Existing targets the edit form CANNOT render — so the admin could never have
 * re-submitted them: a soft-deleted segment, or a customer profile no longer
 * linked to an account (no email to show). They
 * match nobody today, so pruning them on save only narrows the audience… EXCEPT
 * when they are the last targets left: then dropping them would silently turn
 * the promo PUBLIC. The update workflow keeps them in that case (fail closed).
 */
async function findOrphanedTargets(existing: TargetRow[]): Promise<TargetRow[]> {
  const orphaned: TargetRow[] = [];
  const customerProfileIds: string[] = [];
  for (const t of existing) {
    if (t.target_type === "segment") {
      if (!(await segmentService.get(t.target_id))) orphaned.push(t);
    } else if (t.target_type === "customer") {
      customerProfileIds.push(t.target_id);
    }
  }
  if (customerProfileIds.length > 0) {
    const profileToUser = await customerUserLink.findByProfileIds(customerProfileIds);
    const userIds = [...new Set(profileToUser.values())];
    const users = userIds.length > 0 ? await authService.findUsersByIds(userIds) : new Map();
    for (const pid of customerProfileIds) {
      const uid = profileToUser.get(pid);
      if (!uid || !users.get(uid)?.email) orphaned.push({ target_type: "customer", target_id: pid });
    }
  }
  return orphaned;
}

/** Total number of targeting picks the admin submitted (both buckets). */
function requestedTargetCount(d: {
  targetSegmentIds: string[];
  targetCustomerEmails: string[];
}): number {
  return (
    d.targetSegmentIds.length +
    d.targetCustomerEmails.filter((e) => e.trim().length > 0).length
  );
}

/**
 * The admin asked for a TARGETED promo but none of the picks survived
 * resolution — saving would make it PUBLIC (every customer; the create-time
 * announcement would even mail the code to every opt-in client). Refuse.
 */
function noValidTargetsFail(dropped: DroppedTargets) {
  const message =
    "Aucune cible valide : la promotion deviendrait publique (tous les clients). Corrigez les cibles, ou retirez-les toutes pour la rendre publique volontairement.";
  const fieldErrors: Record<string, string> = { targets: message };
  const emailErrors: string[] = [];
  if (dropped.emails.length > 0) {
    emailErrors.push(`Aucun compte client pour : ${dropped.emails.join(", ")}`);
  }
  if (dropped.archivedEmails.length > 0) {
    emailErrors.push(`Client(s) archivé(s) : ${dropped.archivedEmails.join(", ")}`);
  }
  if (emailErrors.length > 0) fieldErrors.targetCustomerEmails = emailErrors.join(" — ");
  return fail("validation", message, fieldErrors);
}

/** Non-blocking notices for picks dropped from an otherwise-valid target set. */
function droppedTargetWarnings(dropped: DroppedTargets): string[] {
  const out: string[] = [];
  if (dropped.emails.length > 0) {
    out.push(`Emails ignorés (aucun compte client) : ${dropped.emails.join(", ")}.`);
  }
  if (dropped.archivedEmails.length > 0) {
    out.push(`Emails ignorés (client archivé) : ${dropped.archivedEmails.join(", ")}.`);
  }
  if (dropped.segments.length > 0) {
    out.push(`${dropped.segments.length} segment(s) désactivé(s) ou supprimé(s) ignoré(s).`);
  }
  return out;
}

// ─────────────────────────── create ────────────────────────────
export const createPromotionSchema = refineCombo(baseSchema);

export const createPromotionWorkflow = workflow<
  [z.input<typeof createPromotionSchema>, { actorUserId: string }],
  { promotionId: string; warnings: string[] }
>("promotion.create", async (input, { actorUserId }) => {
  const parsed = createPromotionSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const p = issue.path.join(".");
      if (p) fieldErrors[p] = issue.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }
  const d = parsed.data;

  // Code / url-slug uniqueness across LIVE rows. The DB has partial unique
  // indexes that will also reject duplicates — we pre-check so the admin
  // sees a friendly field error instead of a 500.
  if (d.triggerKind === "code" && d.code) {
    const existing = await promotionService.findLiveByCode(d.code);
    if (existing) {
      return fail("conflict", "Ce code coupon est déjà utilisé.", {
        code: "Ce code est déjà utilisé",
      });
    }
  }
  if (d.triggerKind === "url" && d.urlSlug) {
    const existing = await promotionService.findLiveByUrlSlug(d.urlSlug);
    if (existing) {
      return fail("conflict", "Ce slug URL est déjà utilisé.", {
        urlSlug: "Ce slug est déjà utilisé",
      });
    }
  }

  // Resolve targeting (validated against live segments/profiles).
  // Fail closed: picks that ALL fail to resolve must not yield a public promo.
  const { targets, dropped } = await resolveTargets(d);
  if (requestedTargetCount(d) > 0 && targets.length === 0) return noValidTargetsFail(dropped);
  const warnings = droppedTargetWarnings(dropped);

  const row = await promotionService.insert({
    name: d.name,
    trigger_kind: d.triggerKind,
    code: d.triggerKind === "code" ? d.code ?? null : null,
    url_slug: d.triggerKind === "url" ? d.urlSlug ?? null : null,
    scope: d.scope,
    scope_id: d.scope === "cart" || d.scope === "targeted" ? null : (d.scopeId ?? null),
    discount_type: d.discountType,
    discount_value: d.discountValue,
    max_discount_cents: d.discountType === "percent" ? (d.maxDiscountCents ?? null) : null,
    min_cart_cents: d.minCartCents,
    max_cart_cents: d.maxCartCents ?? null,
    max_uses: d.maxUses ?? null,
    max_uses_per_user: d.maxUsesPerUser ?? null,
    starts_at: parseDate(d.startsAt),
    ends_at: parseDate(d.endsAt),
    announce_at: parseDate(d.announceAt),
    is_active: d.isActive,
    is_stackable: d.isStackable,
    exclude_discounted_items: d.excludeDiscountedItems,
    grants_free_shipping: d.grantsFreeShipping,
    first_order_only: d.firstOrderOnly,
    audience_rule_tree: d.audienceRuleTree ?? null,
    display_priority: d.displayPriority,
  });

  await promotionService.setTargets(row.id, targets);
  // The product-set (WHAT): the multi-target rows for 'targeted', or one
  // synthesised row for a single-scope kind (kept uniform with the 0170 backfill).
  await promotionService.setScopeTargets(row.id, scopeTargetRowsFor(d));

  await bus.emit(
    "promotion.created",
    { promotionId: row.id, scope: row.scope, scopeId: row.scope_id },
    { actorUserId },
  );
  // Mass-email announcement (opt-in). IMMEDIATE (announceByEmail) fires now via the
  // event; SCHEDULED (announce_at, set on the insert above) is left for the cron
  // sweep. The two are mutually exclusive (refine). Stamp announced_at ONLY when the
  // announce can actually go out (same gate the blast + sweep use) — a marketing-/
  // flow-off announce sends nothing, so stamping would be a false « Annoncée le … ».
  if (d.announceByEmail) {
    await bus.emit("promotion.announce_requested", { promotionId: row.id }, { actorUserId });
    if ((await isFlowEnabled(ANNOUNCE_FLOW)) && !(await marketingSendBlocked(ANNOUNCE_FLOW))) {
      await promotionService.markAnnounced(row.id).catch(() => {});
    } else {
      warnings.push(
        "L'annonce par email n'a pas été envoyée : le marketing ou ce flux d'e-mails est désactivé.",
      );
    }
  }
  return ok({ promotionId: row.id, warnings });
});

// ─────────────────────────── update ────────────────────────────
export const updatePromotionSchema = refineCombo(
  baseSchema.extend({ promotionId: z.string().uuid() }),
);

export const updatePromotionWorkflow = workflow<
  [z.input<typeof updatePromotionSchema>, { actorUserId: string }],
  { promotionId: string; warnings: string[] }
>("promotion.update", async (input, { actorUserId }) => {
  const parsed = updatePromotionSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const p = issue.path.join(".");
      if (p) fieldErrors[p] = issue.message;
    }
    return fail("validation", "Validation échouée", fieldErrors);
  }
  const d = parsed.data;
  const existing = await promotionService.findById(d.promotionId);
  if (!existing) return fail("not_found", "Promotion introuvable.");

  // Code / url-slug uniqueness on rename.
  if (d.triggerKind === "code" && d.code && d.code.toLowerCase() !== existing.code?.toLowerCase()) {
    const dup = await promotionService.findLiveByCode(d.code);
    if (dup && dup.id !== existing.id) {
      return fail("conflict", "Ce code coupon est déjà utilisé.", {
        code: "Ce code est déjà utilisé",
      });
    }
  }
  if (d.triggerKind === "url" && d.urlSlug && d.urlSlug !== existing.url_slug) {
    const dup = await promotionService.findLiveByUrlSlug(d.urlSlug);
    if (dup && dup.id !== existing.id) {
      return fail("conflict", "Ce slug URL est déjà utilisé.", {
        urlSlug: "Ce slug est déjà utilisé",
      });
    }
  }

  // Resolve targeting (validated against live segments/profiles).
  // Existing targets are passed so a re-submitted (e.g. since-disabled) target is
  // kept (dropping it would silently widen the promo — see resolveTargets).
  const existingTargets: TargetRow[] = (await promotionService.listTargets(d.promotionId)).map(
    (t) => ({ target_type: t.target_type as PromotionTargetType, target_id: t.target_id }),
  );
  const resolved = await resolveTargets(d, { existingTargets });
  // Fail closed: picks that ALL fail to resolve must not yield a public promo.
  if (requestedTargetCount(d) > 0 && resolved.targets.length === 0) {
    return noValidTargetsFail(resolved.dropped);
  }
  let targets = resolved.targets;
  const warnings = droppedTargetWarnings(resolved.dropped);
  // Re-schedule → re-arm: setting a NEW / changed `announce_at` on an ALREADY-announced
  // promo (announced_at stamped, whether by an immediate create-time announce, a prior
  // sweep, or « Annoncer maintenant ») must clear announced_at so the sweep fires the new
  // schedule — otherwise the sweep's `announced_at IS NULL` gate silently drops it and no
  // email ever goes out. A routine edit that leaves announce_at unchanged keeps the stamp
  // (never re-fires); clearing announce_at (null) leaves the stamp as the « was announced » marker.
  const newAnnounceAt = parseDate(d.announceAt);
  const reArmAnnounce =
    newAnnounceAt != null &&
    (existing.announce_at == null || existing.announce_at.getTime() !== newAnnounceAt.getTime());
  // Nothing submitted and nothing kept: either the admin deliberately cleared
  // every target (→ public, the documented contract) or the only targets left
  // are ones the form can't render (deleted segment, unlinked client) and so
  // could never be re-submitted. Keep the latter — never widen to public.
  if (targets.length === 0 && d.triggerKind !== "auto" && existingTargets.length > 0) {
    const orphaned = await findOrphanedTargets(existingTargets);
    if (orphaned.length > 0) {
      targets = orphaned;
      warnings.push(
        "Ciblage conservé : les cibles restantes (segment supprimé, client sans compte) ne sont plus modifiables ici — la promotion reste réservée et ne s'applique à personne.",
      );
    }
  }

  const updated = await promotionService.update(d.promotionId, {
    name: d.name,
    trigger_kind: d.triggerKind,
    code: d.triggerKind === "code" ? d.code ?? null : null,
    url_slug: d.triggerKind === "url" ? d.urlSlug ?? null : null,
    scope: d.scope,
    scope_id: d.scope === "cart" || d.scope === "targeted" ? null : (d.scopeId ?? null),
    discount_type: d.discountType,
    discount_value: d.discountValue,
    max_discount_cents: d.discountType === "percent" ? (d.maxDiscountCents ?? null) : null,
    min_cart_cents: d.minCartCents,
    max_cart_cents: d.maxCartCents ?? null,
    max_uses: d.maxUses ?? null,
    max_uses_per_user: d.maxUsesPerUser ?? null,
    starts_at: parseDate(d.startsAt),
    ends_at: parseDate(d.endsAt),
    announce_at: newAnnounceAt,
    // Clear the sent-stamp ONLY on a genuine re-schedule (re-arm the sweep).
    ...(reArmAnnounce ? { announced_at: null } : {}),
    is_active: d.isActive,
    is_stackable: d.isStackable,
    exclude_discounted_items: d.excludeDiscountedItems,
    grants_free_shipping: d.grantsFreeShipping,
    first_order_only: d.firstOrderOnly,
    audience_rule_tree: d.audienceRuleTree ?? null,
    display_priority: d.displayPriority,
  });

  await promotionService.setTargets(d.promotionId, targets);
  // Re-sync the product-set to the new scope (a promo re-scoped product A → category
  // B, or single → multi-target, replaces its scope_targets wholesale).
  await promotionService.setScopeTargets(d.promotionId, scopeTargetRowsFor(d));

  // Carry the POST-update target: a promo re-scoped from product A to category B
  // must tell webhook / audit consumers « B », not the row read before the write.
  const newScope = updated?.scope ?? d.scope;
  const newScopeId = updated ? updated.scope_id : d.scope === "cart" ? null : (d.scopeId ?? null);
  await bus.emit(
    "promotion.updated",
    { promotionId: existing.id, scope: newScope, scopeId: newScopeId },
    { actorUserId },
  );
  return ok({ promotionId: existing.id, warnings });
});

// ─────────────────────────── delete ────────────────────────────
export const deletePromotionWorkflow = workflow<
  [{ promotionId: string }, { actorUserId: string }],
  void
>("promotion.delete", async (input, { actorUserId }) => {
  const existing = await promotionService.findById(input.promotionId);
  if (!existing) return fail("not_found", "Promotion introuvable.");

  await promotionService.softDelete(input.promotionId);
  await bus.emit(
    "promotion.deleted",
    { promotionId: existing.id, scope: existing.scope, scopeId: existing.scope_id },
    { actorUserId },
  );
  return ok();
});

// ─────────────────────────── toggle active ─────────────────────
export const togglePromotionActiveWorkflow = workflow<
  [{ promotionId: string; isActive: boolean }, { actorUserId: string }],
  void
>("promotion.toggle_active", async (input, { actorUserId }) => {
  const existing = await promotionService.findById(input.promotionId);
  if (!existing) return fail("not_found", "Promotion introuvable.");

  await promotionService.update(input.promotionId, { is_active: input.isActive });
  await bus.emit(
    input.isActive ? "promotion.activated" : "promotion.deactivated",
    { promotionId: existing.id, scope: existing.scope, scopeId: existing.scope_id },
    { actorUserId },
  );
  return ok();
});

// ─────────────────────────── duplicate ─────────────────────────
const COPY_NAME_SUFFIX = " (copie)";
// Uppercase, no ambiguous chars (I/L/O/0/1) — mirrors the form's code generator.
const COPY_SUFFIX_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const COPY_ATTEMPTS = 5;

function randomCopySuffix(len = 4): string {
  let s = "";
  for (let i = 0; i < len; i++) s += COPY_SUFFIX_ALPHABET[randomInt(COPY_SUFFIX_ALPHABET.length)];
  return s;
}

/** `BLACKFRIDAY` → `BLACKFRIDAY-COPIE-7KQ2`, clipped to the form's 40-char code limit. */
function placeholderCode(code: string, suffix: string): string {
  const tail = `-COPIE-${suffix}`;
  return `${code.slice(0, 40 - tail.length)}${tail}`;
}

/** `early-bird` → `early-bird-copie-7kq2`, clipped to the 80-char slug limit (no `--`). */
function placeholderSlug(slug: string, suffix: string): string {
  const tail = `-copie-${suffix.toLowerCase()}`;
  return `${slug.slice(0, 80 - tail.length).replace(/-+$/, "")}${tail}`;
}

/** Postgres unique violation on the promo code / URL-slug partial-unique indexes. */
function isSurfaceCollision(err: unknown): boolean {
  if (pgErrorCode(err) !== "23505") return false;
  const c = pgErrorConstraint(err);
  return c === "promotions_code_lower_unique" || c === "promotions_url_slug_unique";
}

/**
 * Duplicate a promotion (and its targeting) as a fresh INACTIVE draft.
 *
 * Trigger / surface decision
 * ──────────────────────────
 * The source trigger_kind is KEPT, so a « BLACKFRIDAY » coupon clones as another
 * coupon (not a silently-different auto promo). A code/URL promo can't carry a
 * NULL surface (`promotions_trigger_surface_chk`), and its code/slug must stay
 * unique among non-deleted rows — so the clone gets a generated PLACEHOLDER
 * (`<CODE>-COPIE-XXXX` / `<slug>-copie-xxxx`, retried on a collision) that the
 * admin replaces on the edit screen. Created inactive, so the placeholder never
 * goes live by itself.
 *
 * Targeting is copied VERBATIM for code/URL sources (never re-validated away: a
 * dead target keeps the clone fail-closed rather than turning it PUBLIC). An
 * AUTO source clones with no targets — auto promos can't be targeted.
 */
export const duplicatePromotionWorkflow = workflow<
  [{ promotionId: string }, { actorUserId: string }],
  { promotionId: string; code: string | null; urlSlug: string | null }
>("promotion.duplicate", async (input, { actorUserId }) => {
  const src = await promotionService.findById(input.promotionId);
  if (!src) return fail("not_found", "Promotion introuvable.");

  const targets: TargetRow[] = [];
  if (src.trigger_kind !== "auto") {
    for (const t of await promotionService.listTargets(src.id)) {
      targets.push({ target_type: t.target_type as PromotionTargetType, target_id: t.target_id });
    }
  }

  let clone: PromotionRow | null = null;
  for (let attempt = 0; attempt < COPY_ATTEMPTS && !clone; attempt++) {
    const suffix = randomCopySuffix();
    try {
      clone = await promotionService.insert({
        name: `${src.name.slice(0, 160 - COPY_NAME_SUFFIX.length)}${COPY_NAME_SUFFIX}`,
        trigger_kind: src.trigger_kind,
        code: src.trigger_kind === "code" ? placeholderCode(src.code ?? "CODE", suffix) : null,
        url_slug: src.trigger_kind === "url" ? placeholderSlug(src.url_slug ?? "promo", suffix) : null,
        scope: src.scope,
        scope_id: src.scope_id,
        discount_type: src.discount_type,
        discount_value: src.discount_value,
        max_discount_cents: src.max_discount_cents,
        min_cart_cents: src.min_cart_cents,
        max_cart_cents: src.max_cart_cents,
        max_uses: src.max_uses,
        max_uses_per_user: src.max_uses_per_user,
        starts_at: src.starts_at,
        ends_at: src.ends_at,
        // Always start a clone disabled — its placeholder code/slug must be
        // reviewed before it can go live.
        is_active: false,
        is_stackable: src.is_stackable,
        exclude_discounted_items: src.exclude_discounted_items,
        grants_free_shipping: src.grants_free_shipping,
        first_order_only: src.first_order_only,
        audience_rule_tree: src.audience_rule_tree,
        display_priority: src.display_priority,
      });
    } catch (err) {
      if (isSurfaceCollision(err)) continue; // placeholder taken → new suffix
      if (pgErrorCode(err) === "23514") {
        return fail(
          "validation",
          "La copie enfreint une contrainte de la promotion (déclencheur, code ou réduction). Vérifiez la promotion d'origine.",
        );
      }
      throw err;
    }
  }
  if (!clone) {
    return fail("conflict", "Impossible de générer un code unique pour la copie. Réessayez.");
  }

  try {
    await promotionService.setTargets(clone.id, targets);
    // Copy the product-set (WHAT) verbatim — a multi-target promo clones with the
    // same products/categories/brands; a single-scope one carries its scope_id row.
    const srcScopeTargets = await promotionService.listScopeTargets(src.id);
    await promotionService.setScopeTargets(
      clone.id,
      srcScopeTargets.map((t) => ({
        target_type: t.target_type as "product" | "category" | "brand",
        target_id: t.target_id,
        include_descendants: t.include_descendants,
        variant_id: t.variant_id ?? null,
      })),
    );
  } catch (err) {
    // Never leave an UNTARGETED copy of a targeted promo behind (activating it
    // would make it public) — compensate by discarding the half-made clone.
    await promotionService.softDelete(clone.id).catch(() => {});
    throw err;
  }

  await bus.emit(
    "promotion.created",
    { promotionId: clone.id, scope: clone.scope, scopeId: clone.scope_id },
    { actorUserId },
  );
  return ok({ promotionId: clone.id, code: clone.code, urlSlug: clone.url_slug });
});
