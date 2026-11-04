SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "reminder_attempt" integer;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "reminder_automated_attempts" integer;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "reminder_outcome" varchar(32);--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_reminder_outcome_check" CHECK ("communications"."reminder_outcome" is null or "communications"."reminder_outcome" in ('staff_failure', 'automated_failure', 'outcome_unknown')) NOT VALID;--> statement-breakpoint
ALTER TABLE "communications" VALIDATE CONSTRAINT "communications_reminder_outcome_check";
