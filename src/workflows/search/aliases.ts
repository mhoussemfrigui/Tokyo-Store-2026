import "server-only";

import { z } from "zod";

import { searchService } from "@/modules/search";
import type { SearchAliasRow } from "@/modules/search";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Search ALIAS / SYNONYM mutations (0114) — the workflow layer over the
 * searchService alias CRUD. The rules reshape what every storefront search
 * returns, so each change lands in the audit journal (and the `search` webhook
 * domain): `search_alias.created` / `.updated` / `.deleted` / `.seeded`. The
 * service still does the normalisation (same folding as a live query), the
 * duplicate handling and the alias-cache bust; the actions
 * (lib/actions/search-aliases.ts) gate on `system_search:manage`.
 */

type Ctx = { actorUserId: string };

/** The alias table is small (curated rules + the catalogue seed) — a list scan
 *  keeps the service surface unchanged while giving the events a readable term. */
async function findAlias(id: string): Promise<SearchAliasRow | null> {
  return (await searchService.listAliases()).find((a) => a.id === id) ?? null;
}

const createSchema = z.object({
  term: z.string(),
  expansion: z.string(),
});

export const createSearchAliasWorkflow = workflow<
  [z.input<typeof createSchema>, Ctx],
  { id: string }
>("search.createAlias", async (input, { actorUserId }) => {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const res = await searchService.createAlias(parsed.data);
  if (!res.ok) return fail("validation", res.error);
  // The STORED (normalised) pair — what a shopper's query is actually matched on.
  await bus.emit(
    "search_alias.created",
    {
      aliasId: res.id,
      term: searchService.normalizeQuery(parsed.data.term).slice(0, 120),
      expansion: searchService.normalizeQuery(parsed.data.expansion).slice(0, 120),
    },
    { actorUserId },
  );
  return ok({ id: res.id });
});

const updateSchema = z.object({
  id: z.string().min(1),
  term: z.string().optional(),
  expansion: z.string().optional(),
  isActive: z.boolean().optional(),
});

/** Patch a rule (today: the active toggle). A patch that changes nothing is a
 *  no-op — no write, no audit row. */
export const updateSearchAliasWorkflow = workflow<
  [z.input<typeof updateSchema>, Ctx],
  { changedFields: string[] }
>("search.updateAlias", async (input, { actorUserId }) => {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Alias introuvable.");
  const { id, term, expansion, isActive } = parsed.data;

  const before = await findAlias(id);
  if (!before) return fail("not_found", "Alias introuvable.");

  const changedFields: string[] = [];
  if (term !== undefined && searchService.normalizeQuery(term).slice(0, 120) !== before.term)
    changedFields.push("term");
  if (
    expansion !== undefined &&
    searchService.normalizeQuery(expansion).slice(0, 120) !== before.expansion
  )
    changedFields.push("expansion");
  if (isActive !== undefined && isActive !== before.is_active) changedFields.push("is_active");
  if (changedFields.length === 0) return ok({ changedFields });

  const res = await searchService.updateAlias(id, { term, expansion, isActive });
  if (!res.ok) return fail("validation", res.error);
  await bus.emit(
    "search_alias.updated",
    {
      aliasId: id,
      term: term !== undefined ? searchService.normalizeQuery(term).slice(0, 120) : before.term,
      ...(isActive !== undefined ? { isActive } : {}),
      changedFields,
    },
    { actorUserId },
  );
  return ok({ changedFields });
});

const deleteSchema = z.object({ id: z.string().min(1) });

/** Hard-delete a rule. Idempotent: an already-gone id is a silent no-op. */
export const deleteSearchAliasWorkflow = workflow<
  [z.input<typeof deleteSchema>, Ctx],
  { deleted: boolean }
>("search.deleteAlias", async (input, { actorUserId }) => {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Alias introuvable.");
  const before = await findAlias(parsed.data.id);
  if (!before) return ok({ deleted: false });
  await searchService.deleteAlias(before.id);
  await bus.emit("search_alias.deleted", { aliasId: before.id, term: before.term }, { actorUserId });
  return ok({ deleted: true });
});

/** Seed the catalogue-derived defaults (idempotent — only missing rules are
 *  added); audited only when something was actually inserted. */
export const seedDefaultSearchAliasesWorkflow = workflow<[Ctx], { added: number }>(
  "search.seedDefaultAliases",
  async ({ actorUserId }) => {
    const added = await searchService.seedDefaultAliases();
    if (added > 0) await bus.emit("search_alias.seeded", { count: added }, { actorUserId });
    return ok({ added });
  },
);
