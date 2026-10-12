import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  faq_categories,
  faqs,
  type FaqCategoryRow,
  type FaqRow,
  type NewFaqCategoryRow,
  type NewFaqRow,
} from "./schema";

class FaqService {
  async listCategories() {
    return db.select().from(faq_categories).orderBy(asc(faq_categories.display_order));
  }

  /**
   * Storefront — published FAQs for a product, ordered. Excludes drafts
   * and soft-deleted rows. Returns `[]` for products without FAQs (the
   * storefront component hides the section in that case).
   */
  async listByProductId(productId: string): Promise<FaqRow[]> {
    return db
      .select()
      .from(faqs)
      .where(
        and(
          eq(faqs.product_id, productId),
          eq(faqs.is_published, true),
          isNull(faqs.deleted_at),
        ),
      )
      .orderBy(asc(faqs.display_order));
  }

  /**
   * Storefront — published FAQs for a category, ordered. Same contract
   * as `listByProductId`.
   */
  async listByCategoryId(categoryId: string): Promise<FaqRow[]> {
    return db
      .select()
      .from(faqs)
      .where(
        and(
          eq(faqs.category_id, categoryId),
          eq(faqs.is_published, true),
          isNull(faqs.deleted_at),
        ),
      )
      .orderBy(asc(faqs.display_order));
  }

  /**
   * Storefront — published FAQs for a brand, ordered. Same contract as
   * `listByCategoryId`. Keyed by the rename-safe `brand_id` column (0018).
   */
  async listByBrandId(brandId: string): Promise<FaqRow[]> {
    return db
      .select()
      .from(faqs)
      .where(
        and(
          eq(faqs.brand_id, brandId),
          eq(faqs.is_published, true),
          isNull(faqs.deleted_at),
        ),
      )
      .orderBy(asc(faqs.display_order));
  }

  /**
   * Admin — every FAQ (published + draft) for a product so the admin
   * tab can render drafts alongside live rows. Soft-deleted rows still
   * excluded.
   */
  async listForAdminProduct(productId: string): Promise<FaqRow[]> {
    return db
      .select()
      .from(faqs)
      .where(and(eq(faqs.product_id, productId), isNull(faqs.deleted_at)))
      .orderBy(asc(faqs.display_order));
  }

  /** Admin — every FAQ (published + draft) for a category. */
  async listForAdminCategory(categoryId: string): Promise<FaqRow[]> {
    return db
      .select()
      .from(faqs)
      .where(and(eq(faqs.category_id, categoryId), isNull(faqs.deleted_at)))
      .orderBy(asc(faqs.display_order));
  }

  /** Admin — every FAQ (published + draft) for a brand. */
  async listForAdminBrand(brandId: string): Promise<FaqRow[]> {
    return db
      .select()
      .from(faqs)
      .where(and(eq(faqs.brand_id, brandId), isNull(faqs.deleted_at)))
      .orderBy(asc(faqs.display_order));
  }

  async listAll(): Promise<FaqRow[]> {
    return db
      .select()
      .from(faqs)
      .where(isNull(faqs.deleted_at))
      .orderBy(asc(faqs.scope), asc(faqs.display_order));
  }

  /**
   * Bulk: which of the given product ids already have ≥1 live (non-deleted) FAQ.
   * Used by the bulk content generator's keep-mode (don't overwrite a product
   * that already has FAQs) without an N+1 per product.
   */
  async productIdsWithFaqs(productIds: string[]): Promise<Set<string>> {
    if (productIds.length === 0) return new Set();
    const rows = await db
      .select({ pid: faqs.product_id })
      .from(faqs)
      .where(and(inArray(faqs.product_id, productIds), isNull(faqs.deleted_at)));
    return new Set(rows.map((r) => r.pid).filter((v): v is string => Boolean(v)));
  }

  /** Bulk: which of the given category ids already have ≥1 live FAQ. Used by the
   *  generalized bulk content generator's keep-mode. Twin of productIdsWithFaqs. */
  async categoryIdsWithFaqs(categoryIds: string[]): Promise<Set<string>> {
    if (categoryIds.length === 0) return new Set();
    const rows = await db
      .select({ cid: faqs.category_id })
      .from(faqs)
      .where(and(inArray(faqs.category_id, categoryIds), isNull(faqs.deleted_at)));
    return new Set(rows.map((r) => r.cid).filter((v): v is string => Boolean(v)));
  }

  /** Bulk: which of the given brand ids already have ≥1 live FAQ. Twin of
   *  categoryIdsWithFaqs. */
  async brandIdsWithFaqs(brandIds: string[]): Promise<Set<string>> {
    if (brandIds.length === 0) return new Set();
    const rows = await db
      .select({ bid: faqs.brand_id })
      .from(faqs)
      .where(and(inArray(faqs.brand_id, brandIds), isNull(faqs.deleted_at)));
    return new Set(rows.map((r) => r.bid).filter((v): v is string => Boolean(v)));
  }

  /** Insert a single FAQ row. Used by the demo seed (help-scoped rows). */
  async insert(input: NewFaqRow) {
    const [row] = await db.insert(faqs).values(input).returning();
    return row;
  }

  /**
   * Idempotent replacement of FAQs for a product. Soft-deletes every
   * existing FAQ for the product and inserts the provided items inside a
   * single transaction. The caller owns the ordering — `displayOrder` is
   * stored verbatim. Empty `items` array soft-deletes everything (lets an
   * admin clear the section without a separate "remove all" button).
   */
  async replaceForProduct(
    productId: string,
    items: Array<{
      question: string;
      answer: string;
      displayOrder: number;
      isPublished: boolean;
    }>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(faqs)
        .set({ deleted_at: new Date(), updated_at: sql`now()` })
        .where(and(eq(faqs.product_id, productId), isNull(faqs.deleted_at)));
      if (items.length === 0) return;
      await tx.insert(faqs).values(
        items.map((item) => ({
          product_id: productId,
          category_id: null,
          question: item.question,
          answer: item.answer,
          display_order: item.displayOrder,
          is_published: item.isPublished,
          scope: "help",
        })),
      );
    });
  }

  /** Idempotent replacement of FAQs for a category — twin of `replaceForProduct`. */
  async replaceForCategory(
    categoryId: string,
    items: Array<{
      question: string;
      answer: string;
      displayOrder: number;
      isPublished: boolean;
    }>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(faqs)
        .set({ deleted_at: new Date(), updated_at: sql`now()` })
        .where(and(eq(faqs.category_id, categoryId), isNull(faqs.deleted_at)));
      if (items.length === 0) return;
      await tx.insert(faqs).values(
        items.map((item) => ({
          category_id: categoryId,
          product_id: null,
          question: item.question,
          answer: item.answer,
          display_order: item.displayOrder,
          is_published: item.isPublished,
          scope: "help",
        })),
      );
    });
  }

  /** Idempotent replacement of FAQs for a brand — twin of `replaceForCategory`. */
  async replaceForBrand(
    brandId: string,
    items: Array<{
      question: string;
      answer: string;
      displayOrder: number;
      isPublished: boolean;
    }>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(faqs)
        .set({ deleted_at: new Date(), updated_at: sql`now()` })
        .where(and(eq(faqs.brand_id, brandId), isNull(faqs.deleted_at)));
      if (items.length === 0) return;
      await tx.insert(faqs).values(
        items.map((item) => ({
          brand_id: brandId,
          product_id: null,
          category_id: null,
          question: item.question,
          answer: item.answer,
          display_order: item.displayOrder,
          is_published: item.isPublished,
          scope: "help",
        })),
      );
    });
  }

  // ──────────────────────────────────────── categories CRUD
  async findCategoryBySlug(slug: string): Promise<FaqCategoryRow | null> {
    const [row] = await db
      .select()
      .from(faq_categories)
      .where(eq(faq_categories.slug, slug))
      .limit(1);
    return row ?? null;
  }

  async insertCategory(input: NewFaqCategoryRow): Promise<FaqCategoryRow> {
    const [row] = await db.insert(faq_categories).values(input).returning();
    return row;
  }

  // ──────────────────────────────────────── question-keyed lookups
  /**
   * Returns the set of FAQ questions currently in the database (live rows
   * only). Used by bulk import to detect existing seeds without N+1.
   */
  async listLiveQuestions(): Promise<string[]> {
    const rows = await db
      .select({ q: faqs.question })
      .from(faqs)
      .where(isNull(faqs.deleted_at));
    return rows.map((r) => r.q);
  }

  /**
   * Hard-delete EVERY FAQ row regardless of target/scope (help + product +
   * category + brand), including soft-deleted ones. Returns the
   * deleted ids so callers can report counts. Used by the segmented `clean`
   * flow, which wipes all rows of a content type rather than the demo-keyed
   * question set.
   */
  async deleteAllFaqs(): Promise<string[]> {
    const rows = await db.delete(faqs).returning({ id: faqs.id });
    return rows.map((r) => r.id);
  }

  /**
   * Hard-delete EVERY FAQ category. Returns the deleted ids so callers can
   * report counts. FAQs themselves are FK-less against this table — the
   * segmented `clean` flow wipes the FAQ rows first via `deleteAllFaqs`.
   */
  async deleteAllCategories(): Promise<string[]> {
    const rows = await db
      .delete(faq_categories)
      .returning({ id: faq_categories.id });
    return rows.map((r) => r.id);
  }
}

export const faqService = new FaqService();
