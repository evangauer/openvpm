CREATE TYPE "public"."messaging_business_entity_type" AS ENUM('PRIVATE_PROFIT', 'NON_PROFIT');--> statement-breakpoint
CREATE TABLE "messaging_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"provider" varchar(16) DEFAULT 'telnyx' NOT NULL,
	"entity_type" "messaging_business_entity_type" NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"legal_name" varchar(100) NOT NULL,
	"tax_id_encrypted" text NOT NULL,
	"tax_id_last4" varchar(4) NOT NULL,
	"contact_first_name" varchar(100) NOT NULL,
	"contact_last_name" varchar(100) NOT NULL,
	"contact_email" varchar(100) NOT NULL,
	"business_phone" varchar(20) NOT NULL,
	"street" varchar(100) NOT NULL,
	"city" varchar(100) NOT NULL,
	"state" varchar(2) NOT NULL,
	"postal_code" varchar(10) NOT NULL,
	"country" varchar(2) DEFAULT 'US' NOT NULL,
	"website" varchar(100) NOT NULL,
	"privacy_policy_url" varchar(500) NOT NULL,
	"terms_url" varchar(500) NOT NULL,
	"campaign_usecase" varchar(50) DEFAULT 'MIXED' NOT NULL,
	"status" "messaging_registration_status" DEFAULT 'not_started' NOT NULL,
	"status_detail" text,
	"provider_brand_id" varchar(128),
	"provider_brand_status" varchar(64),
	"provider_campaign_id" varchar(128),
	"provider_campaign_status" varchar(64),
	"submission_lock_id" uuid,
	"submission_lock_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_submitted_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "messaging_registrations" ADD CONSTRAINT "messaging_registrations_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_registrations_practice_idx" ON "messaging_registrations" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "messaging_registrations_status_idx" ON "messaging_registrations" USING btree ("status","updated_at");