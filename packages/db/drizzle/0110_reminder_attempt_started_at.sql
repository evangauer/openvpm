SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "reminder_attempt_started_at" timestamp with time zone;
