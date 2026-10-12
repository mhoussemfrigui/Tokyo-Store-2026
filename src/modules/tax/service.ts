import "server-only";

import { asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { product_attribute_values } from "@/modules/catalog/attribute/schema";
import { tax_rules, type TaxRuleRow } from "./schema";

/**
 * A tax rule joined with its attribute-value label + parent attribute id, for
 * the admin list (so the row reads "Matière = Or → 19 %" without a second
 * query). `attribute_label` is null only if the FK target vanished, which the
 * ON DELETE CASCADE on `attribute_value_id` normally prevents.
 */
export type TaxRuleWithLabel = TaxRuleRow & {
  attribute_label: string | null;
  attribute_id: string | null;
};

class TaxService {
  /** Single rule by its own id. */
  async findById(id: string): Promise<TaxRuleRow | null> {
    const [row] = await db
      .select()
      .from(tax_rules)
      .where(eq(tax_rules.id, id))
      .limit(1);
    return row ?? null;
  }

  /** Single rule by the attribute value it targets (the unique key). */
  async findByAttributeValueId(
    attributeValueId: string,
  ): Promise<TaxRuleRow | null> {
    const [row] = await db
      .select()
      .from(tax_rules)
      .where(eq(tax_rules.attribute_value_id, attributeValueId))
      .limit(1);
    return row ?? null;
  }

  /**
   * How many tax rules target ANY of these attribute values — the delete guard
   * for attribute/value removal. `tax_rules.attribute_value_id` CASCADEs on the
   * value, so without this a value (or its parent attribute) carrying a per-value
   * TVA override would be deletable and the rule silently dropped (wrong tax then
   * charged). Mirrors attributeService.countAssignmentsUsingValues /
   * productQueries.countLiveVariantsUsingValues.
   */
  async countRulesUsingValues(valueIds: string[]): Promise<number> {
    if (valueIds.length === 0) return 0;
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tax_rules)
      .where(inArray(tax_rules.attribute_value_id, valueIds));
    return Number(row?.n ?? 0);
  }

  /**
   * All rules with the attribute-value label joined, ordered by label. Drives
   * the admin tax-rules panel.
   */
  async listWithLabels(): Promise<TaxRuleWithLabel[]> {
    return db
      .select({
        id: tax_rules.id,
        attribute_value_id: tax_rules.attribute_value_id,
        rate_bps: tax_rules.rate_bps,
        created_at: tax_rules.created_at,
        updated_at: tax_rules.updated_at,
        attribute_label: product_attribute_values.label,
        attribute_id: product_attribute_values.attribute_id,
      })
      .from(tax_rules)
      .leftJoin(
        product_attribute_values,
        eq(product_attribute_values.id, tax_rules.attribute_value_id),
      )
      .orderBy(asc(product_attribute_values.label));
  }

  /**
   * Create-or-update a rule keyed on `attribute_value_id` (one rule per value,
   * enforced by `tax_rules_attribute_value_uq`). Idempotent — calling twice
   * with the same value just updates the rate.
   */
  async upsert(attributeValueId: string, rateBps: number): Promise<TaxRuleRow> {
    const [row] = await db
      .insert(tax_rules)
      .values({ attribute_value_id: attributeValueId, rate_bps: rateBps })
      .onConflictDoUpdate({
        target: tax_rules.attribute_value_id,
        set: { rate_bps: rateBps, updated_at: new Date() },
      })
      .returning();
    return row;
  }

  /** Hard-delete a rule by its own id. */
  async delete(id: string): Promise<void> {
    await db.delete(tax_rules).where(eq(tax_rules.id, id));
  }

  /** Hard-delete a rule by the attribute value it targets. */
  async deleteByAttributeValueId(attributeValueId: string): Promise<void> {
    await db
      .delete(tax_rules)
      .where(eq(tax_rules.attribute_value_id, attributeValueId));
  }
}

export const taxService = new TaxService();
export type { TaxService };
