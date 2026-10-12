import "server-only";

/**
 * Slug helpers. The normalisation algorithm + schema live in the ISOMORPHIC
 * `src/lib/slug.ts` so the admin client-side preview (attribute panel) shares
 * the exact rules and can never drift from what the server stores. Re-exported
 * here for the server-only category/brand/product workflows that import from
 * `@/workflows/helpers`.
 */
export { slugify, slugSchema } from "@/lib/slug";
