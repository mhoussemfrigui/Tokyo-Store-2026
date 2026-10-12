/**
 * Builder leaf DEFAULTS parity (Phase 6j) — PURE. Asserts every OFFERED_LEAF_KIND's
 * default params (defaultLeaf) pass that kind's own validator, so a condition the
 * admin adds in the tree builder is valid the instant it appears (and the save gate,
 * isValidRuleTree, never rejects a freshly-built default). Also checks a compound
 * default tree validates. Run:
 *   tsx --conditions=react-server src/lib/db/tests/segment-leaf-defaults.test.ts
 */
import { LEAVES, OFFERED_LEAF_KINDS, isValidRuleTree } from "@/lib/promotions/rule-leaves";
import { defaultLeaf } from "@/lib/promotions/segment-leaf-defaults";
import type { RuleNode } from "@/lib/promotions/rule-tree";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

// Every offered kind's default must satisfy its validator.
for (const kind of OFFERED_LEAF_KINDS) {
  const leaf = defaultLeaf(kind);
  check(`defaultLeaf(${kind}) → kind preserved`, leaf.kind === kind);
  check(`defaultLeaf(${kind}) → passes LEAVES[${kind}].validate`, LEAVES[kind].validate(leaf) === true);
  // A single-leaf tree must also be a valid rule tree (bounds/structure).
  check(`defaultLeaf(${kind}) → valid one-leaf tree`, isValidRuleTree(leaf as RuleNode));
}

// A compound tree built from three defaults (AND) validates.
const compound: RuleNode = {
  op: "and",
  children: [defaultLeaf("cart_total_gte"), defaultLeaf("gender"), defaultLeaf("has_orders")],
};
check("compound AND of defaults → valid", isValidRuleTree(compound));

// A NOT group wrapping a default validates.
check(
  "NOT group over a default → valid",
  isValidRuleTree({ op: "and", negate: true, children: [defaultLeaf("marketing_opted_in")] } as RuleNode),
);

console.log(`\n=== segment-leaf-defaults: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
