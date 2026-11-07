SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "practices" ADD COLUMN "preview_ends_at" timestamp with time zone;
