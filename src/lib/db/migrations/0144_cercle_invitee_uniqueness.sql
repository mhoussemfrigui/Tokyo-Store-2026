-- 0144 — Cercle de Famille: one referrer per invitee (anti-farming backstop)
--
-- Migration 0140 gave loyalty_referrals a self-referral CHECK (loyalty_referrals_no_self_chk)
-- and a per-PAIR edge unique (loyalty_referrals_edge_uq), but NOT a per-INVITEE
-- GLOBAL unique. Without it a farmer could stand up N sock "referrers" who each
-- refer one throwaway invitee — each a distinct row → distinct credit source_ref →
-- each grants « Proche ajouté ». This closes that: an account can be the ACCEPTED
-- referred party of AT MOST ONE referrer, ever (first-touch-wins, mirroring Game
-- Zone's referrals_invitee_uniq).
--
-- Partial on (referred_user_id IS NOT NULL): a pending 'invited' row carries a NULL
-- referred_user_id (the invitee is only bound on accept), and many referrers may
-- legitimately invite the same email — those pending rows must not collide on NULL.
CREATE UNIQUE INDEX "loyalty_referrals_invitee_uq"
  ON "loyalty_referrals" ("referred_user_id")
  WHERE "referred_user_id" IS NOT NULL;--> statement-breakpoint

-- Invite-spam hygiene: at most one PENDING invite per (referrer, email). A second
-- invite to the same address refreshes the existing row (service re-issues the
-- token) rather than piling up dead 'invited' rows. Partial on the pending state.
CREATE UNIQUE INDEX "loyalty_referrals_pending_email_uq"
  ON "loyalty_referrals" ("referrer_user_id", "referred_email")
  WHERE "consent_state" = 'invited' AND "referred_email" IS NOT NULL;--> statement-breakpoint
