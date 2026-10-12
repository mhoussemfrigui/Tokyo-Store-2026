import "server-only";

import { z } from "zod";

/**
 * French zod messages, process-wide. The admin (and storefront) UI is French
 * only, yet most workflow schemas carry no custom message (`z.string().max(120)`),
 * so zod's built-in English ("Too big: expected string to have <=120
 * characters") leaked through flattenZodError into the forms. Every workflow
 * (hence nearly every action) loads this module, and zod's config is
 * process-global, so it applies to every parse from the first load on.
 *
 * Set as `customError`, NOT `z.config(z.locales.fr())` (= `localeError`): zod
 * keeps its config on `globalThis`, and EVERY evaluation of the zod package runs
 * `config(en())` — Next.js loads several zod instances (RSC / SSR / route
 * bundles), so a `localeError` set here would be silently reset to English by
 * whichever one loads next. `en()` never touches `customError`, which zod
 * resolves right before `localeError`; a schema's own message and a per-parse
 * `error` (ZOD_FR below) still win over it. Pinned by zod-locale.test.ts.
 */
z.config({ customError: z.locales.fr().localeError });

/**
 * Workflow result discriminator.
 *
 * Workflows never throw for *expected* failures (validation, business
 * rules). They throw only for genuine bugs / infrastructure outages — those
 * surface to Next.js's error boundary and the audit log.
 *
 * Use `ok({...})` and `fail("error code", "human message")` for expected
 * paths.
 */

export type WorkflowOk<T> = { ok: true; data: T };
export type WorkflowFail = {
  ok: false;
  error: string;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type WorkflowResult<T = void> = WorkflowOk<T> | WorkflowFail;

export function ok(): WorkflowOk<void>;
export function ok<T>(data: T): WorkflowOk<T>;
export function ok<T>(data?: T): WorkflowOk<T | undefined> {
  return { ok: true, data };
}

export function fail(
  error: string,
  message: string,
  fieldErrors?: Record<string, string>,
): WorkflowFail {
  return { ok: false, error, message, fieldErrors };
}

/**
 * Tiny `workflow()` helper — wraps a function so:
 *   - thrown errors become `fail("internal", ...)` instead of crashing
 *   - the workflow name is captured for logs / debugging
 *
 * Use bare `async function` when you want full control; use this when you
 * want a safety net + consistent error shape.
 */
export function workflow<Args extends unknown[], T>(
  name: string,
  fn: (...args: Args) => Promise<WorkflowResult<T>>,
): (...args: Args) => Promise<WorkflowResult<T>> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (err) {
      // A Postgres unique-violation that slipped past a proactive check (or a
      // constraint with no proactive check, e.g. SKU/GTIN) should read as a
      // friendly conflict, not "une erreur inattendue". Foreseeable BAD-INPUT
      // errors (a non-UUID id, a nonexistent referenced entity) map to a 400
      // validation rather than a 500 — an ERP/API caller must see a clean 4xx,
      // not an opaque server error it will retry forever.
      const mapped = uniqueViolationFail(err) ?? dbContentionFail(err) ?? foreseeableInputFail(err);
      if (mapped) return mapped;
      console.error(`[workflow:${name}] threw`, err);
      return fail("internal", "Une erreur inattendue est survenue.");
    }
  };
}

/**
 * Maps a violated UNIQUE index/constraint name to the form field it belongs to
 * and a human message. Lets the generic workflow() catch turn a raw 23505 into
 * a structured conflict (so a duplicate SKU/GTIN says so, instead of a generic
 * crash message). Unknown constraints fall back to a generic "déjà utilisée".
 */
const UNIQUE_VIOLATION_MESSAGES: Record<string, { field: string; message: string }> = {
  products_slug_unique: { field: "slug", message: "Ce slug est déjà utilisé par un autre produit." },
  products_sku_unique: { field: "sku", message: "Ce SKU est déjà utilisé par un autre produit." },
  products_gtin_unique: { field: "gtin", message: "Ce code-barres (GTIN) est déjà utilisé par un autre produit." },
  products_external_ref_unique: { field: "externalRef", message: "Cette référence externe est déjà utilisée par un autre produit." },
  product_variants_sku_unique: { field: "sku", message: "Ce SKU de variante est déjà utilisé." },
  product_variants_gtin_unique: { field: "gtin", message: "Ce code-barres (GTIN) de variante est déjà utilisé." },
  brands_slug_unique: { field: "slug", message: "Ce slug est déjà utilisé par une autre marque." },
  brands_external_ref_unique: { field: "externalRef", message: "Cette référence externe est déjà utilisée par une autre marque." },
  categories_root_slug_unique: { field: "slug", message: "Ce slug est déjà utilisé par une autre catégorie racine." },
  categories_external_ref_unique: { field: "externalRef", message: "Cette référence externe est déjà utilisée par une autre catégorie." },
  // Collections: partial-unique among live rows. external_ref has NO proactive
  // pre-check (the workflow relies on the index, like brands), so a duplicate ref
  // via /api/collections always trips this; slug is the create-race backstop.
  collections_slug_unique: { field: "slug", message: "Ce slug est déjà utilisé par une autre collection." },
  collections_external_ref_unique: { field: "externalRef", message: "Cette référence externe est déjà utilisée par une autre collection." },
  // ERP two-way links now written by the API order-push / customer-upsert paths —
  // a same-ref race that slips past the proactive pre-check trips these indexes.
  orders_external_ref_uniq: { field: "externalRef", message: "Cette référence externe est déjà utilisée par une autre commande." },
  customer_profiles_external_ref_uniq: { field: "externalRef", message: "Cette référence externe est déjà utilisée par un autre client." },
  product_attributes_slug_unique: { field: "slug", message: "Ce slug d'attribut est déjà utilisé." },
  // A value-slug race past createValue/updateValue's proactive check (or an
  // attribute create whose seed values collide) — per-attribute unique.
  product_attribute_values_attribute_slug_unique: {
    field: "slug",
    message: "Ce slug de valeur est déjà utilisé pour cet attribut.",
  },
  product_categories_one_primary_per_product: {
    field: "primaryCategoryId",
    message: "Un produit ne peut avoir qu'une seule catégorie principale.",
  },
  // Promotions: the partial-unique indexes only exclude soft-deleted rows, so a
  // code/slug held by an INACTIVE (not deleted) promo escapes the workflow's
  // live-row pre-check yet trips the index — and a generated-code race can too.
  // Field-key these so the form highlights the right input instead of a bare banner.
  promotions_code_lower_unique: { field: "code", message: "Ce code coupon est déjà utilisé." },
  promotions_url_slug_unique: { field: "urlSlug", message: "Ce slug URL est déjà utilisé." },
  // CMS pages: the index is TOTAL (a soft-deleted page keeps its slug — the
  // system-pages bootstrap relies on that tombstone), so a slug held by a
  // DELETED page trips it too. checkSlugAvailability reports that case upfront;
  // this is the race / bypass backstop.
  pages_slug_unique: {
    field: "slug",
    message: "Ce slug est déjà utilisé par une autre page (éventuellement supprimée).",
  },
};

/**
 * Returns a structured conflict fail for a Postgres 23505, else null. Drizzle
 * wraps the driver error, so the `code` / `constraint` may sit on `err` OR on
 * `err.cause` (any depth) — walk the chain to find them.
 */
export function uniqueViolationFail(err: unknown): WorkflowFail | null {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    const pg = e as { code?: string; constraint?: string; cause?: unknown };
    if (pg.code === "23505") {
      const hit = pg.constraint ? UNIQUE_VIOLATION_MESSAGES[pg.constraint] : undefined;
      if (hit) return fail("conflict", hit.message, { [hit.field]: hit.message });
      return fail("conflict", "Cette valeur est déjà utilisée.");
    }
    e = pg.cause;
  }
  return null;
}

/**
 * Maps Postgres errors that are NOT bugs but FORESEEABLE contention / invariant
 * hits into a retryable 409-style conflict instead of an opaque 500:
 *   23514 on a *_stock_qty_nonneg CHECK → "Stock insuffisant." (an unguarded
 *          stock decrement that would go negative — a lost race, not a crash).
 *   40P01 (deadlock) / 55P03 (lock_timeout) → "réessayez" (hot-SKU contention).
 * Walks the drizzle-wrapped cause chain like uniqueViolationFail.
 */
export function dbContentionFail(err: unknown): WorkflowFail | null {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    const pg = e as { code?: string; constraint?: string; cause?: unknown };
    if (pg.code === "23514" && /stock_qty_nonneg/.test(pg.constraint ?? "")) {
      return fail("conflict", "Stock insuffisant.", { stockQty: "Stock insuffisant." });
    }
    if (pg.code === "40P01" || pg.code === "55P03") {
      return fail("conflict", "Produit très demandé — veuillez réessayer.");
    }
    e = pg.cause;
  }
  return null;
}

/**
 * Maps FORESEEABLE bad-input Postgres errors — the ones a validation gap lets
 * reach the DB — into a `validation` fail (HTTP 400) instead of a 500:
 *   22P02 (invalid text representation) → a non-UUID id / non-numeric bound the
 *          caller passed that hit a `uuid`/`numeric` column (e.g. a DELETE by a
 *          bad `id`, an attribute id that isn't a UUID).
 *   23503 (foreign-key violation) → the row references a parent that doesn't
 *          exist (a product syncing against a category/brand/media/attribute the
 *          ERP hasn't created yet). That's a bad REFERENCE, not a server fault.
 *   22007 (invalid datetime format) / 22008 (datetime field overflow) → a date
 *          the caller sent that JS accepted but Postgres rejects (`2025-02-30`
 *          — V8 silently rolls it over to March 2). Bad input, not a crash.
 * Walks the drizzle-wrapped cause chain like uniqueViolationFail.
 */
export function foreseeableInputFail(err: unknown): WorkflowFail | null {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    const pg = e as { code?: string; cause?: unknown };
    if (pg.code === "22P02") {
      return fail("validation", "Identifiant invalide (format UUID/numérique attendu).");
    }
    if (pg.code === "22007" || pg.code === "22008") {
      return fail("validation", "Date invalide (format AAAA-MM-JJ et jour existant attendus).");
    }
    if (pg.code === "23503") {
      return fail(
        "validation",
        "Référence introuvable : une entité liée (catégorie, marque, média, attribut, variante…) n'existe pas.",
      );
    }
    e = pg.cause;
  }
  return null;
}

/**
 * Flatten a `ZodError` into a `{ field: message }` map keyed by the first path
 * segment — the shape `fail()` expects for `fieldErrors`. Several catalog
 * workflows declared this locally as `flatten()`; this is the shared copy.
 */
export function flattenZodError(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) out[i.path[0]?.toString() ?? "form"] = i.message;
  return out;
}

/**
 * `safeParse` options that localise zod's BUILT-IN issue messages to French
 * ("Trop petit : …", "URL invalide") for operator-facing forms. A schema's own
 * custom message always wins over the locale, so hand-written copy is kept.
 * Now redundant with the process-wide `z.config` at the top of this module
 * (kept so the existing call sites stay explicit).
 */
export const ZOD_FR = { error: z.locales.fr().localeError };

/**
 * `validation` fail that keeps zod's detail instead of a bare "Validation
 * échouée": the FIRST issue becomes the banner message — prefixed with the
 * field's French label when `labels` names it, so an operator sees WHICH field
 * is wrong even in a form that only renders `message` — and every issue lands in
 * `fieldErrors` (flattenZodError) for forms that render per-field errors.
 * Parse with `ZOD_FR` so un-customised messages read in French too.
 */
export function zodValidationFail(
  err: z.ZodError,
  labels: Record<string, string> = {},
): WorkflowFail {
  const first = err.issues[0];
  if (!first) return fail("validation", "Validation échouée");
  const key = first.path[0]?.toString();
  const label = key ? labels[key] : undefined;
  return fail(
    "validation",
    label ? `${label} : ${first.message}` : first.message,
    flattenZodError(err),
  );
}
