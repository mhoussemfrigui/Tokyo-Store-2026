-- 0146 — Cercle de Famille: supporting index for the admin monitor reads
--
-- The Fidélité → « Cercle de Famille » monitor (force-dynamic, loaded per staff
-- visit) runs three consent_state-scoped reads on loyalty_referrals:
--   listByState('accepted')       — WHERE consent_state = ? ORDER BY accepted_at DESC
--   countsByState()               — GROUP BY consent_state
--   acceptedCountsByReferrer()    — WHERE consent_state = 'accepted' GROUP BY referrer_user_id
-- The table's existing indexes cover referrer/referred/token only, so all three
-- fell back to a seq scan + sort. A composite on (consent_state, accepted_at DESC)
-- serves the state filter AND the accepted_at sort for the list, and its leading
-- column serves the state grouping/filter for the two aggregates. Low-volume table
-- (family invites), so this is a small, write-cheap index.
CREATE INDEX "loyalty_referrals_state_accepted_idx"
  ON "loyalty_referrals" ("consent_state", "accepted_at" DESC);--> statement-breakpoint
