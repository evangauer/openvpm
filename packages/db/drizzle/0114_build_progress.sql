SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "growth_leads" DROP CONSTRAINT "growth_leads_source_check";--> statement-breakpoint
ALTER TABLE "growth_leads" ADD COLUMN "build_progress" jsonb;--> statement-breakpoint
ALTER TABLE "growth_leads" ADD CONSTRAINT "growth_leads_source_check" CHECK ("growth_leads"."source" in ('demo', 'newsletter', 'build'));
