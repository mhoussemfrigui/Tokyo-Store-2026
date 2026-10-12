-- 0197 — Mailing campaigns: inline rule-tree targeting (full parity with promotions).
-- A campaign can now carry an ad-hoc compound audience rule (the SAME RuleNode shape
-- promotions persist in `promotions.audience_rule_tree`), resolved through the shared
-- segment SQL engine (`segmentMemberIdsSql`) — so a blast can target loyalty tier /
-- spend / order count / birthday & life-events ad-hoc without first saving a segment,
-- and the mailing audience ⇔ promotion eligibility stay one engine. New
-- `audience_kind` value `'rule'`.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + drop/recreate the audience CHECK (original in
-- 0045_mailing_system). Widening the CHECK can't fail against existing rows (they all
-- carry one of the prior four kinds).
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "audience_rule_tree" jsonb;

ALTER TABLE "email_campaigns" DROP CONSTRAINT IF EXISTS "email_campaigns_audience_chk";
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_audience_chk"
  CHECK ("audience_kind" IN ('segment', 'newsletter', 'marketing_optin', 'addresses', 'rule'));
