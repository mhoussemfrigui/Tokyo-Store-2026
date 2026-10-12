CREATE TABLE IF NOT EXISTS "ai_provider_settings" (
	"provider" text PRIMARY KEY NOT NULL,
	"api_key_enc" text,
	"base_url" text,
	"default_model" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
