-- 0161 — compound segment rule tree.
--
-- Phase 6: a dynamic segment's targeting becomes a boolean AND/OR tree of leaf
-- conditions (src/lib/promotions/rule-tree.ts), stored as jsonb. NULL = a manual
-- segment OR a legacy single-`rule` dynamic one — those keep working, read at resolve
-- time via legacyRuleToTree(rule) when rule_tree IS NULL. NO backfill: existing
-- segments resolve through the SAME new engine untouched, and re-saving in the new
-- builder materializes rule_tree. Validation is application-level (isValidRuleTree,
-- fail-closed) — a jsonb column can't enforce the tree grammar.
ALTER TABLE "customer_segments" ADD COLUMN "rule_tree" jsonb;
