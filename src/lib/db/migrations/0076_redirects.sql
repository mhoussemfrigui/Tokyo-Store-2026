-- Admin-managed URL redirects (Système → Redirections & 404). The storefront
-- [slug] / [slug]/[sub] pages resolve the current path against this table
-- (point lookup on the unique source_path index) and issue a 301/302/307/308
-- before rendering. source_path is stored normalized; destination is a path or
-- absolute http(s) URL; hits/last_hit_at are bumped on each resolve.
CREATE TABLE IF NOT EXISTS "redirects" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT uuid_generate_v7(),
  "source_path" text NOT NULL,
  "destination" text NOT NULL,
  "status_code" integer NOT NULL DEFAULT 301,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "hits" integer NOT NULL DEFAULT 0,
  "last_hit_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "redirects_source_unique" ON "redirects" USING btree ("source_path");
