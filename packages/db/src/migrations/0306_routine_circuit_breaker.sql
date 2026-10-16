ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "auto_pause_enabled" boolean;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "auto_pause_threshold" integer;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "consecutive_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "auto_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "auto_pause_reason" text;
