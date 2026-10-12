import "server-only";

import { z } from "zod";

import { bus } from "@/events/bus";
import { taxService } from "@/modules/tax";
import { fail, ok, workflow } from "../shared";

/**
 * Tax-rule workflows — the FILTER tier of the tax cascade
 * (product → tax_rules(filter) → brand → category → global). A rule keys a TVA rate
 * (basis points) onto a single attribute VALUE (e.g. "Matière = Or"). One
 * rule per value, enforced by `tax_rules_attribute_value_uq`, so the upsert is
 * idempotent.
 *
 * `rateBps` is already in basis points — the admin enters a PERCENT and the
 * action converts via `bpsFromPercent` BEFORE calling this. Keeping the
 * workflow in bps mirrors how every other tax surface stores rates.
 */

const upsertSchema = z.object({
  attributeValueId: z.string().uuid(),
  // Basis points. 0–100000 (= 0 %–1000 %) is a generous sane ceiling; the
  // resolver / compute treat <= 0 as "no tax", but a rule row implies intent
  // so we require a positive rate (delete the rule to clear it instead).
  rateBps: z.number().int().min(1).max(100000),
});

const deleteSchema = z.object({
  attributeValueId: z.string().uuid(),
});

/**
 * Create-or-update the tax rule for one attribute value. Idempotent on
 * `attribute_value_id`.
 */
export const upsertTaxRuleWorkflow = workflow<
  [z.input<typeof upsertSchema>, { actorUserId: string }],
  { attributeValueId: string }
>("tax.rule.upsert", async (input, { actorUserId }) => {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const row = await taxService.upsert(parsed.data.attributeValueId, parsed.data.rateBps);
  await bus.emit("tax.rule.upserted", { ruleId: row.id }, { actorUserId });
  return ok({ attributeValueId: parsed.data.attributeValueId });
});

/** Remove the tax rule for an attribute value (falls back to category/global). */
export const deleteTaxRuleWorkflow = workflow<
  [z.input<typeof deleteSchema>, { actorUserId: string }],
  { attributeValueId: string }
>("tax.rule.delete", async (input, { actorUserId }) => {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  // Resolve the rule id BEFORE deleting so the audit event can name it (and we
  // skip the emit when there was no rule to remove — keeps delete idempotent).
  const existing = await taxService.findByAttributeValueId(parsed.data.attributeValueId);
  await taxService.deleteByAttributeValueId(parsed.data.attributeValueId);
  if (existing) {
    await bus.emit("tax.rule.deleted", { ruleId: existing.id }, { actorUserId });
  }
  return ok({ attributeValueId: parsed.data.attributeValueId });
});
