/**
 * Tax module — public surface.
 *
 *   import { taxQueries, taxService, tax_rules } from "@/modules/tax";
 *
 * Pure rate/amount math + config live in `@/lib/tax`; this module is the DB
 * layer (the `tax_rules` filter-tier CRUD + the batched place-order lookup).
 */

export * as taxQueries from "./queries";
export { taxService, type TaxService, type TaxRuleWithLabel } from "./service";
export {
  tax_rules,
  type TaxRuleRow,
  type NewTaxRuleRow,
} from "./schema";
