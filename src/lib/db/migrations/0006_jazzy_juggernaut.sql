CREATE TABLE IF NOT EXISTS "ai_feature_prompts" (
	"feature" text NOT NULL,
	"task" text NOT NULL,
	"provider" text,
	"model" text,
	"system_prompt" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_feature_prompts_feature_task_pk" PRIMARY KEY("feature","task")
);
