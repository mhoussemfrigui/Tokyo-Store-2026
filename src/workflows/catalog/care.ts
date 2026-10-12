import "server-only";

import { z } from "zod";

import { careService } from "@/modules/catalog/care/service";
import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { slugSchema, slugify } from "../helpers";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * Tokyo Care plan workflows — create / update / delete a bonus-warranty plan and
 * (re)assign its scope (products + categories). Everything is admin-controlled;
 * the plan row carries the pricing/eligibility parameters. The scope set is
 * persisted via careService.setScopeTargets (replace-semantics) inside the SAME
 * transaction as the plan write. Money arrives already in MILLIMES / basis points
 * (converted at the action edge). Charging is a separate surface (place-order).
 */

const CONDITIONS = ["new", "used", "refurbished"] as const;

// Activation scope is CATEGORY-based. Per-PRODUCT activation is handled separately
// by `product_care` (include/exclude) from the product form's Tokyo Care tab — the
// offer resolver reads that, not product-type scope targets — so no product scope
// here.
const scopeFields = {
  scopeCategoryIds: z.array(z.string().uuid()).optional(),
  scopeIncludeDescendants: z.boolean().optional().default(true),
};

const uniqueRefField = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const createCarePlanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  externalRef: uniqueRefField(120),
  description: z.string().trim().max(2000).nullable().optional(),
  durationMonths: z.number().int().min(1).max(600),
  pricingMode: z.enum(["flat", "percent"]),
  priceCents: z.number().int().min(0).max(1_000_000_000),
  priceBps: z.number().int().min(0).max(100_000),
  priceRoundToCents: z.number().int().min(0).max(100_000_000).optional().default(0),
  minChargeCents: z.number().int().min(0).max(1_000_000_000).optional().default(0),
  minProductPriceCents: z.number().int().min(0).max(1_000_000_000).optional().default(0),
  requireWarranty: z.boolean().optional().default(true),
  applicableConditions: z.array(z.enum(CONDITIONS)).nullable().optional(),
  perks: z.array(z.string().trim().max(300)).max(20).nullable().optional(),
  icon: z.string().trim().max(60).nullable().optional(),
  isActive: z.boolean().optional().default(true),
  displayPriority: z.number().int().min(0).optional().default(0),
  ...scopeFields,
});

export const createCarePlanWorkflow = workflow<
  [z.input<typeof createCarePlanSchema>, { actorUserId: string }],
  { planId: string; slug: string }
>("care.plan.create", async (input, { actorUserId }) => {
  const parsed = createCarePlanSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  const d = parsed.data;
  const slug = d.slug ?? slugify(d.name);
  if (await careService.findBySlug(slug)) {
    return fail("conflict", "Ce slug est déjà utilisé par un autre plan Tokyo Care.", {
      slug: "Slug déjà utilisé",
    });
  }

  const plan = await db.transaction(async (tx) => {
    const row = await careService.insert(
      {
        name: d.name,
        slug,
        external_ref: d.externalRef ?? null,
        description: d.description ?? null,
        duration_months: d.durationMonths,
        pricing_mode: d.pricingMode,
        price_cents: d.priceCents,
        price_bps: d.priceBps,
        price_round_to_cents: d.priceRoundToCents,
        min_charge_cents: d.minChargeCents,
        min_product_price_cents: d.minProductPriceCents,
        require_warranty: d.requireWarranty,
        applicable_conditions: d.applicableConditions ?? null,
        perks: d.perks ?? null,
        icon: d.icon ?? null,
        is_active: d.isActive,
        display_priority: d.displayPriority,
      },
      tx,
    );
    await careService.setScopeTargets(
      row.id,
      {
        categoryIds: d.scopeCategoryIds ?? [],
        includeDescendants: d.scopeIncludeDescendants,
      },
      tx,
    );
    return row;
  });

  await bus.emit("care.plan.created", { planId: plan.id, slug: plan.slug }, { actorUserId });
  await bus.emit("care.assignment.changed", { planId: plan.id, productId: null }, { actorUserId });
  return ok({ planId: plan.id, slug: plan.slug });
});

export const updateCarePlanSchema = createCarePlanSchema.partial().extend({
  planId: z.string().uuid(),
});

export const updateCarePlanWorkflow = workflow<
  [z.input<typeof updateCarePlanSchema>, { actorUserId: string }],
  { planId: string }
>("care.plan.update", async (input, { actorUserId }) => {
  const parsed = updateCarePlanSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  const d = parsed.data;
  const existing = await careService.findById(d.planId);
  if (!existing) return fail("not_found", "Plan Tokyo Care introuvable.");

  if (d.slug && d.slug !== existing.slug) {
    const taken = await careService.findBySlug(d.slug);
    if (taken && taken.id !== existing.id) {
      return fail("conflict", "Ce slug est déjà utilisé par un autre plan Tokyo Care.", {
        slug: "Slug déjà utilisé",
      });
    }
  }

  const patch: Parameters<typeof careService.update>[1] = {};
  const changed: string[] = [];
  const set = <K extends keyof typeof patch>(key: K, val: (typeof patch)[K], field: string) => {
    patch[key] = val;
    changed.push(field);
  };
  if (d.name !== undefined && d.name !== existing.name) set("name", d.name, "name");
  if (d.slug !== undefined && d.slug !== existing.slug) set("slug", d.slug, "slug");
  if (d.externalRef !== undefined) set("external_ref", d.externalRef, "external_ref");
  if (d.description !== undefined) set("description", d.description, "description");
  if (d.durationMonths !== undefined) set("duration_months", d.durationMonths, "duration_months");
  if (d.pricingMode !== undefined) set("pricing_mode", d.pricingMode, "pricing_mode");
  if (d.priceCents !== undefined) set("price_cents", d.priceCents, "price_cents");
  if (d.priceBps !== undefined) set("price_bps", d.priceBps, "price_bps");
  if (d.priceRoundToCents !== undefined) set("price_round_to_cents", d.priceRoundToCents, "price_round_to_cents");
  if (d.minChargeCents !== undefined) set("min_charge_cents", d.minChargeCents, "min_charge_cents");
  if (d.minProductPriceCents !== undefined) set("min_product_price_cents", d.minProductPriceCents, "min_product_price_cents");
  if (d.requireWarranty !== undefined) set("require_warranty", d.requireWarranty, "require_warranty");
  if (d.applicableConditions !== undefined) set("applicable_conditions", d.applicableConditions ?? null, "applicable_conditions");
  if (d.perks !== undefined) set("perks", d.perks ?? null, "perks");
  if (d.icon !== undefined) set("icon", d.icon ?? null, "icon");
  if (d.isActive !== undefined) set("is_active", d.isActive, "is_active");
  if (d.displayPriority !== undefined) set("display_priority", d.displayPriority, "display_priority");

  // Scope is replaced only when the caller sent at least one scope field (the
  // admin form always sends both, so a save always re-applies the scope).
  const sendsScope = d.scopeCategoryIds !== undefined;

  await db.transaction(async (tx) => {
    if (Object.keys(patch).length > 0) await careService.update(existing.id, patch, tx);
    if (sendsScope) {
      await careService.setScopeTargets(
        existing.id,
        {
          categoryIds: d.scopeCategoryIds ?? [],
          includeDescendants: d.scopeIncludeDescendants ?? true,
        },
        tx,
      );
      changed.push("scope");
    }
  });

  if (changed.length > 0) {
    await bus.emit("care.plan.updated", { planId: existing.id, changedFields: changed }, { actorUserId });
    await bus.emit("care.assignment.changed", { planId: existing.id, productId: null }, { actorUserId });
  }
  return ok({ planId: existing.id });
});

export const deleteCarePlanWorkflow = workflow<
  [{ planId: string }, { actorUserId: string }],
  { planId: string }
>("care.plan.delete", async ({ planId }, { actorUserId }) => {
  const existing = await careService.findById(planId);
  if (!existing) return fail("not_found", "Plan Tokyo Care introuvable.");
  // Soft delete — the plan stops being offered/charged; already-issued care on
  // past orders is snapshotted and unaffected.
  await careService.softDelete(planId);
  await bus.emit("care.plan.deleted", { planId }, { actorUserId });
  await bus.emit("care.assignment.changed", { planId, productId: null }, { actorUserId });
  return ok({ planId });
});
