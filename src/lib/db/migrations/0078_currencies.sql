-- Currency registry (Commandes → Devises). ONE global active currency labels
-- prices across the storefront / JSON-LD / new-order snapshots; it does NOT
-- convert stored amounts (money stays integer minor units of the base — see
-- src/lib/price.ts). Seed TND active so existing installs are unchanged.
CREATE TABLE IF NOT EXISTS "currencies" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT uuid_generate_v7(),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "symbol" text NOT NULL,
  "symbol_position" text NOT NULL DEFAULT 'after',
  "decimals" integer NOT NULL DEFAULT 3,
  "is_active" boolean NOT NULL DEFAULT false,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "currencies_code_unique" ON "currencies" USING btree ("code");--> statement-breakpoint
-- AT MOST one active currency (indexes only the `true` rows).
CREATE UNIQUE INDEX IF NOT EXISTS "currencies_one_active_idx" ON "currencies" USING btree ("is_active") WHERE "is_active";--> statement-breakpoint
INSERT INTO "currencies" ("code","name","symbol","symbol_position","decimals","is_active","display_order")
VALUES ('TND','Dinar tunisien','TND','after',3,true,0)
ON CONFLICT ("code") DO NOTHING;
