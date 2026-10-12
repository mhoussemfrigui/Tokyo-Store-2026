-- 0111 — AI call log (transport-level record of every provider call).
--
-- One append-only row per provider call (chat generation AND embedding calls),
-- powering a future « Journal » sub-tab of Système → IA and letting an operator
-- diagnose a provider failure (e.g. an OpenRouter 400) without server logs.
-- Written best-effort by the AI chokepoints; a logging failure never surfaces in
-- the calling path. Purely additive + idempotent.

CREATE TABLE IF NOT EXISTS "ai_call_logs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "feature" text,
  "task" text,
  "provider" text NOT NULL,
  "model" text,
  "status" text NOT NULL,
  "error" text,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "web_search" boolean NOT NULL DEFAULT false,
  "actor_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ai_call_logs_created_idx" ON "ai_call_logs" ("created_at" DESC);
