import "server-only";

import { z } from "zod";

import { faqService } from "@/modules/cms/faq/service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";
import type { CmsActorCtx } from "./setting";

// ─── Per-target bulk upserts ─────────────────────────────────────────────
// The product/category FAQ admin tabs submit the entire list at once.
// `replaceForProduct` / `replaceForCategory` soft-delete the prior set and
// re-insert in one transaction, so the admin can reorder, edit, add, or
// drop items in a single save without juggling per-row CRUD endpoints.
//
// (Legacy single-row create/update/delete workflows were removed — every FAQ
// admin surface submits the full list through these bulk upserts, and the demo
// seed inserts help-scoped rows via `faqService.insert` directly. Only the
// `faq.updated` cache-bust event is emitted now.)

const faqItemSchema = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(5000),
  displayOrder: z.number().int().min(0).default(0),
  isPublished: z.boolean().default(true),
});

export const upsertProductFaqsSchema = z.object({
  productId: z.string().uuid(),
  items: z.array(faqItemSchema).max(50),
});

export const upsertProductFaqsWorkflow = workflow<
  [z.input<typeof upsertProductFaqsSchema>, CmsActorCtx?],
  { productId: string; count: number }
>("cms.faq.upsertProductFaqs", async (input, ctx = {}) => {
  const parsed = upsertProductFaqsSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  await faqService.replaceForProduct(parsed.data.productId, parsed.data.items);
  // Use the same `faq.updated` event the CMS cache subscriber already
  // listens to. The scope string carries enough context to bust the
  // matching cache tag.
  await bus.emit(
    "faq.updated",
    { faqId: parsed.data.productId, scope: `product:${parsed.data.productId}` },
    ctx,
  );
  return ok({ productId: parsed.data.productId, count: parsed.data.items.length });
});

export const upsertCategoryFaqsSchema = z.object({
  categoryId: z.string().uuid(),
  items: z.array(faqItemSchema).max(50),
});

export const upsertCategoryFaqsWorkflow = workflow<
  [z.input<typeof upsertCategoryFaqsSchema>, CmsActorCtx?],
  { categoryId: string; count: number }
>("cms.faq.upsertCategoryFaqs", async (input, ctx = {}) => {
  const parsed = upsertCategoryFaqsSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  await faqService.replaceForCategory(parsed.data.categoryId, parsed.data.items);
  await bus.emit(
    "faq.updated",
    { faqId: parsed.data.categoryId, scope: `category:${parsed.data.categoryId}` },
    ctx,
  );
  return ok({ categoryId: parsed.data.categoryId, count: parsed.data.items.length });
});

export const upsertBrandFaqsSchema = z.object({
  brandId: z.string().uuid(),
  items: z.array(faqItemSchema).max(50),
});

export const upsertBrandFaqsWorkflow = workflow<
  [z.input<typeof upsertBrandFaqsSchema>, CmsActorCtx?],
  { brandId: string; count: number }
>("cms.faq.upsertBrandFaqs", async (input, ctx = {}) => {
  const parsed = upsertBrandFaqsSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  await faqService.replaceForBrand(parsed.data.brandId, parsed.data.items);
  await bus.emit(
    "faq.updated",
    { faqId: parsed.data.brandId, scope: `brand:${parsed.data.brandId}` },
    ctx,
  );
  return ok({ brandId: parsed.data.brandId, count: parsed.data.items.length });
});
