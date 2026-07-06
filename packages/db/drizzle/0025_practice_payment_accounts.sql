CREATE TYPE "public"."payment_account_status" AS ENUM('pending', 'active', 'action_required', 'disabled');--> statement-breakpoint
CREATE TABLE "practice_payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'stripe_connect' NOT NULL,
	"stripe_account_id" varchar(128) NOT NULL,
	"onboarding_status" "payment_account_status" DEFAULT 'pending' NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"requirements_currently_due" jsonb,
	"requirements_disabled_reason" varchar(255),
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "practice_payment_accounts" ADD CONSTRAINT "practice_payment_accounts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "practice_payment_accounts_practice_provider_uq" ON "practice_payment_accounts" USING btree ("practice_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_payment_accounts_stripe_account_uq" ON "practice_payment_accounts" USING btree ("stripe_account_id");--> statement-breakpoint
CREATE INDEX "practice_payment_accounts_status_idx" ON "practice_payment_accounts" USING btree ("practice_id","deleted_at","onboarding_status");
