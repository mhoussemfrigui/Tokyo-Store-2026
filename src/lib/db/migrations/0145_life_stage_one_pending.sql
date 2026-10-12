-- 0145 — Événements de vie: at most one PENDING life-stage claim per member
--
-- submitLifeStageAction pre-checks "already a pending declaration", but a bare
-- read-then-insert is racy (a double-submit reads pending=0 twice and inserts
-- twice). This is the DB backstop: a partial-unique on user_id restricted to the
-- pending state, so a member can have at most ONE open declaration at a time
-- (verified/rejected rows are unconstrained — they can accumulate). The action
-- catches the 23505 and surfaces the same friendly "already pending" refusal.
CREATE UNIQUE INDEX "loyalty_life_stage_pending_uq"
  ON "loyalty_life_stage_claims" ("user_id")
  WHERE "status" = 'pending';--> statement-breakpoint
