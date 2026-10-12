import "server-only";

import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { orders, order_items } from "@/modules/order/schema";
import { reviewService, getReviewConfig, type ReviewSource, type ReviewStatus } from "@/modules/catalog/review";
import { productService } from "@/modules/catalog/product/service";
import { fail, ok, workflow } from "../shared";

/**
 * Order statuses that do NOT make a purchase "verified": not yet paid
 * (`pending`), called off (`cancelled`) or fully paid back (`refunded`). Every
 * other status (paid → preparing → shipped → delivered) counts — deliberately
 * not only `delivered`, so a buyer can review as soon as the order is paid.
 */
export const UNVERIFIED_ORDER_STATUSES = ["pending", "cancelled", "refunded"] as const;

/**
 * Has this user actually bought this product? True when an order they own
 * contains the product and its status isn't in UNVERIFIED_ORDER_STATUSES.
 * Drives the "Achat vérifié" badge and the "buyers_only" policy gate.
 */
async function hasPurchased(userId: string, productId: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(order_items)
    // order_items.order_id + orders.id are both uuid, so a plain
    // column=column join is valid and index-friendly.
    .innerJoin(orders, eq(orders.id, order_items.order_id))
    .where(
      and(
        eq(orders.user_id, userId),
        eq(order_items.product_id, productId),
        notInArray(orders.status, [...UNVERIFIED_ORDER_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const createReviewSchema = z.object({
  productId: z.string().uuid(),
  rating: z.coerce.number().int().min(1).max(5),
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(10).max(4000),
});

export const createReviewWorkflow = workflow<
  [z.input<typeof createReviewSchema>, { userId: string; authorName: string }],
  { id: string; status: ReviewStatus }
>("catalog.review.create", async (input, ctx) => {
  const cfg = await getReviewConfig();
  if (!cfg.enabled) return fail("disabled", "Les avis sont actuellement désactivés.");
  if (!ctx?.userId) return fail("auth", "Connectez-vous pour laisser un avis.");

  const parsed = createReviewSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Avis invalide : note de 1 à 5, titre et texte requis.");
  }
  const { productId, rating, title, body } = parsed.data;

  // The product must be one a shopper can actually see on the storefront: live
  // (not soft-deleted — findById filters deleted_at) and published. The FK alone
  // accepts drafts and tombstones, so a stale PDP tab or a crafted POST could
  // otherwise attach a review — and, with moderation off, rewrite the hidden
  // product's rating.
  const product = await productService.findById(productId);
  if (!product || !product.is_published) {
    return fail("not_found", "Produit introuvable.");
  }

  const existing = await reviewService.findByUserAndProduct(ctx.userId, productId);
  // A REJECTED review must NOT lock the buyer out forever: only a still-live
  // (pending/approved) review counts as a duplicate. A rejected one is resubmitted
  // in place below (the partial-unique index caps one row per user+product).
  if (existing && existing.status !== "rejected") {
    return fail("duplicate", "Vous avez déjà laissé un avis sur ce produit.");
  }

  const verified = await hasPurchased(ctx.userId, productId);
  if (cfg.policy === "buyers_only" && !verified) {
    return fail("not_buyer", "Seuls les acheteurs de ce produit peuvent laisser un avis.");
  }

  const status: ReviewStatus = cfg.requireApproval ? "pending" : "approved";
  const values = { rating, title, body, status, verified_purchase: verified, author_name: ctx.authorName };
  let row;
  if (existing) {
    // existing.status === "rejected" → overwrite it, re-opening for moderation.
    const updated = await reviewService.resubmitRejected(ctx.userId, productId, values);
    if (!updated) return fail("duplicate", "Vous avez déjà laissé un avis sur ce produit.");
    row = updated;
  } else {
    try {
      row = await reviewService.insert({ product_id: productId, user_id: ctx.userId, ...values });
    } catch (e) {
      // Race: a near-simultaneous double-submit slips past the findByUserAndProduct
      // check and hits the partial-unique index. Drizzle wraps the PG code under
      // .cause, so use the shared helper (a top-level e.code check would never match).
      if (isUniqueViolation(e)) {
        // If the pre-existing row was REJECTED, resubmit over it; otherwise it's
        // a genuine live duplicate.
        const updated = await reviewService.resubmitRejected(ctx.userId, productId, values);
        if (updated) row = updated;
        else return fail("duplicate", "Vous avez déjà laissé un avis sur ce produit.");
      } else {
        throw e;
      }
    }
  }

  if (status === "approved") await reviewService.recomputeProduct(productId);
  await bus.emit(
    "catalog.review.created",
    {
      reviewId: row.id,
      productId,
      rating,
      status,
      // `product` is already loaded above — no extra query for the ERP identifiers.
      sku: product.sku,
      gtin: product.gtin,
      externalRef: product.external_ref,
    },
    { actorUserId: ctx.userId },
  );
  return ok({ id: row.id, status });
});

const setStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "approved", "rejected"]),
});

export const setReviewStatusWorkflow = workflow<
  [z.input<typeof setStatusSchema>, { actorUserId?: string | null }],
  { id: string }
>("catalog.review.set_status", async (input, { actorUserId }) => {
  const parsed = setStatusSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Statut invalide.");
  const row = await reviewService.setStatus(parsed.data.id, parsed.data.status);
  if (!row) return fail("not_found", "Avis introuvable.");
  // Approving/rejecting changes which reviews feed the aggregate.
  await reviewService.recomputeProduct(row.product_id);
  const ids = await productService.findIdentifiers(row.product_id).catch(() => null);
  await bus.emit(
    "catalog.review.status_changed",
    {
      reviewId: row.id,
      productId: row.product_id,
      status: parsed.data.status,
      sku: ids?.sku ?? null,
      gtin: ids?.gtin ?? null,
      externalRef: ids?.externalRef ?? null,
    },
    { actorUserId: actorUserId ?? null },
  );
  return ok({ id: row.id });
});

export const deleteReviewWorkflow = workflow<
  [{ id: string }, { actorUserId?: string | null }],
  { id: string }
>("catalog.review.delete", async ({ id }, { actorUserId }) => {
  const row = await reviewService.delete(id);
  if (!row) return fail("not_found", "Avis introuvable.");
  await reviewService.recomputeProduct(row.product_id);
  const ids = await productService.findIdentifiers(row.product_id).catch(() => null);
  await bus.emit(
    "catalog.review.deleted",
    {
      reviewId: row.id,
      productId: row.product_id,
      sku: ids?.sku ?? null,
      gtin: ids?.gtin ?? null,
      externalRef: ids?.externalRef ?? null,
    },
    { actorUserId: actorUserId ?? null },
  );
  return ok({ id });
});

// ─────────────────────────────────────────────── manual (admin-authored) avis
const createManualSchema = z.object({
  productId: z.string().uuid(),
  authorName: z.string().trim().min(1).max(80),
  rating: z.coerce.number().int().min(1).max(5),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  status: z.enum(["pending", "approved"]).default("pending"),
  verifiedPurchase: z.boolean().default(false),
  /** Optional backdate (ISO). Clamped to ≤ now so a fake never lands in the future. */
  createdAt: z.string().datetime().optional(),
});

/**
 * Create a MANUAL (admin-authored / fake) review for a product. `user_id` is
 * NULL — so the partial unique (user_id, product_id) never fires and any number
 * of manual reviews can be added — and `source='manual'` tags it for the
 * moderation filter + bulk cleanup. Recomputes the aggregate only when approved.
 */
export const createManualReviewWorkflow = workflow<
  [z.input<typeof createManualSchema>, { actorUserId?: string | null }],
  { id: string; status: ReviewStatus; slug: string }
>("catalog.review.create_manual", async (input, { actorUserId }) => {
  const parsed = createManualSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Avis invalide : produit, note (1–5), auteur, titre et texte requis.");
  }
  const d = parsed.data;
  const product = await productService.findById(d.productId);
  if (!product) return fail("not_found", "Produit introuvable.");

  // Clamp an optional backdate to the past (never future).
  let createdAt: Date | undefined;
  if (d.createdAt) {
    const t = new Date(d.createdAt);
    if (!Number.isNaN(t.getTime())) createdAt = t.getTime() > Date.now() ? new Date() : t;
  }

  const row = await reviewService.insert({
    product_id: d.productId,
    user_id: null,
    author_name: d.authorName,
    rating: d.rating,
    title: d.title,
    body: d.body,
    status: d.status,
    source: "manual",
    verified_purchase: d.verifiedPurchase,
    ...(createdAt ? { created_at: createdAt } : {}),
  });
  if (d.status === "approved") await reviewService.recomputeProduct(d.productId);
  await bus.emit(
    "catalog.review.created_manual",
    {
      reviewId: row.id,
      productId: d.productId,
      rating: d.rating,
      status: d.status,
      // `product` is already loaded above — no extra query for the ERP identifiers.
      sku: product.sku,
      gtin: product.gtin,
      externalRef: product.external_ref,
    },
    { actorUserId: actorUserId ?? null },
  );
  return ok({ id: row.id, status: d.status, slug: product.slug });
});

/**
 * Bulk-delete every fake review of a given origin (manual / ai) — admin cleanup.
 * Refuses `customer` so real submissions can never be wiped through this path.
 * Recomputes each affected product's aggregate.
 */
export const deleteReviewsBySourceWorkflow = workflow<
  [{ source: ReviewSource }, { actorUserId?: string | null }],
  { deletedProducts: number; deletedCount: number }
>("catalog.review.delete_by_source", async ({ source }, { actorUserId }) => {
  if (source !== "manual" && source !== "ai") {
    return fail("validation", "Source invalide (manual | ai uniquement).");
  }
  const { productIds, deletedCount } = await reviewService.deleteBySource(source);
  // Resolve the public-rating source once for the batch (one settings read, not
  // one per product).
  const ratingSource = productIds.length ? (await getReviewConfig()).ratingSource : "all";
  for (const pid of productIds) await reviewService.recomputeProduct(pid, db, ratingSource);
  // Emit the actual number of deleted review ROWS (not the distinct-product
  // count) — several reviews can share a product, so the two differ.
  await bus.emit(
    "catalog.review.bulk_deleted",
    { source, deletedCount },
    { actorUserId: actorUserId ?? null },
  );
  return ok({ deletedProducts: productIds.length, deletedCount });
});
