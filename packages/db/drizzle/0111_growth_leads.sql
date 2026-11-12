SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
CREATE TABLE "growth_lead_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lead_id" uuid NOT NULL,
	"sequence" varchar(40) NOT NULL,
	"step" integer NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"status" varchar(16) NOT NULL,
	"provider_message_id" varchar(128),
	CONSTRAINT "growth_lead_emails_status_check" CHECK ("growth_lead_emails"."status" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "growth_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"email" varchar(255) NOT NULL,
	"email_hash" varchar(64) NOT NULL,
	"source" varchar(32) NOT NULL,
	"anonymous_id" varchar(64),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"disclosure_version" varchar(32) NOT NULL,
	"paused_at" timestamp with time zone,
	CONSTRAINT "growth_leads_email_hash_check" CHECK ("growth_leads"."email_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "growth_leads_source_check" CHECK ("growth_leads"."source" in ('demo', 'newsletter'))
);
--> statement-breakpoint
ALTER TABLE "growth_lead_emails" ADD CONSTRAINT "growth_lead_emails_lead_id_growth_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."growth_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "growth_lead_emails_dedupe_key_uq" ON "growth_lead_emails" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "growth_lead_emails_lead_created_idx" ON "growth_lead_emails" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_leads_email_hash_uq" ON "growth_leads" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "growth_leads_source_first_seen_idx" ON "growth_leads" USING btree ("source","first_seen_at");--> statement-breakpoint
ALTER TABLE "growth_leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "growth_lead_emails" ENABLE ROW LEVEL SECURITY;
