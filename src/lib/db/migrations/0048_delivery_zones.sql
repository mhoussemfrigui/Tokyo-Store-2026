-- 0048 — Delivery region pricing (optional, behind delivery.zone_pricing_enabled).
-- Two new tables; idempotent. FKs created VALID inline (tables are empty here).

CREATE TABLE IF NOT EXISTS "delivery_zones" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "name" text NOT NULL,
  "governorates" text NOT NULL DEFAULT '',
  "enabled" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "delivery_zones_enabled_idx" ON "delivery_zones" ("enabled","display_order");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "delivery_agent_zone_rates" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "agent_id" uuid NOT NULL REFERENCES "delivery_agents"("id") ON DELETE CASCADE,
  "zone_id" uuid NOT NULL REFERENCES "delivery_zones"("id") ON DELETE CASCADE,
  "fee_cents" integer NOT NULL,
  "free_threshold_cents" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "delivery_agent_zone_rates_uniq" ON "delivery_agent_zone_rates" ("agent_id","zone_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_agent_zone_rates_zone_idx" ON "delivery_agent_zone_rates" ("zone_id");
