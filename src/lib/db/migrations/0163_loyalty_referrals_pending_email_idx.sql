-- 0163 — index the « Invitations reçues » lookup by recipient email.
--
-- listPendingByEmail (src/associations/loyalty-referral.service.ts) runs
--   SELECT ... FROM loyalty_referrals
--   WHERE consent_state = 'invited' AND lower(referred_email) = $1
--   ORDER BY created_at DESC
-- on EVERY authenticated /account render while the loyalty program is on (the in-app
-- « Invitations reçues » accept flow). No existing index covered lower(referred_email):
-- loyalty_referrals_pending_email_uq is on (referrer_user_id, referred_email) over the
-- RAW column with referrer_user_id leading, so it cannot serve an email-only,
-- case-insensitive lookup. Without this index the query scans every outstanding pending
-- invite (+ a sort) on a hot page. This partial functional index matches the predicate
-- exactly and scans only the small pending subset — consistent with the codebase's
-- lower(email) index convention (users, orders.contact_email, newsletter, email_logs…).
CREATE INDEX IF NOT EXISTS "loyalty_referrals_pending_email_lower_idx"
  ON "loyalty_referrals" (lower("referred_email"))
  WHERE "consent_state" = 'invited' AND "referred_email" IS NOT NULL;
