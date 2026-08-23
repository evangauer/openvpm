CREATE TABLE "financial_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"closed_by" uuid NOT NULL,
	"payment_count" integer NOT NULL,
	"gross_receipts_cents" integer NOT NULL,
	"refunds_cents" integer NOT NULL,
	"net_receipts_cents" integer NOT NULL,
	"cash_cents" integer NOT NULL,
	"check_cents" integer NOT NULL,
	"card_and_online_cents" integer NOT NULL,
	"other_cents" integer NOT NULL,
	"processor_gross_cents" integer NOT NULL,
	"processor_fee_cents" integer NOT NULL,
	"application_fee_cents" integer NOT NULL,
	"clinic_net_cents" integer NOT NULL,
	"paid_out_cents" integer NOT NULL,
	"open_dispute_cents" integer NOT NULL,
	"unreconciled_count" integer NOT NULL,
	CONSTRAINT "financial_closes_counts_check" CHECK ("financial_closes"."payment_count" >= 0 and "financial_closes"."unreconciled_count" >= 0),
	CONSTRAINT "financial_closes_nonnegative_check" CHECK ("financial_closes"."gross_receipts_cents" >= 0
        and "financial_closes"."refunds_cents" >= 0
        and "financial_closes"."processor_gross_cents" >= 0
        and "financial_closes"."processor_fee_cents" >= 0
        and "financial_closes"."application_fee_cents" >= 0
        and "financial_closes"."clinic_net_cents" >= 0
        and "financial_closes"."paid_out_cents" >= 0
        and "financial_closes"."open_dispute_cents" >= 0),
	CONSTRAINT "financial_closes_receipt_identity_check" CHECK ("financial_closes"."net_receipts_cents" = "financial_closes"."gross_receipts_cents" - "financial_closes"."refunds_cents"),
	CONSTRAINT "financial_closes_processor_identity_check" CHECK ("financial_closes"."processor_gross_cents" = "financial_closes"."processor_fee_cents" + "financial_closes"."application_fee_cents" + "financial_closes"."clinic_net_cents")
);
--> statement-breakpoint
CREATE TABLE "payment_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'stripe_connect' NOT NULL,
	"external_dispute_id" varchar(128) NOT NULL,
	"charge_id" varchar(128) NOT NULL,
	"status" varchar(48) NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reason" varchar(64),
	"evidence_due_by" timestamp with time zone,
	"provider_created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_disputes_amount_check" CHECK ("payment_disputes"."amount_cents" > 0 and "payment_disputes"."currency" ~ '^[a-z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "payment_processor_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'stripe_connect' NOT NULL,
	"connected_account_id" varchar(128) NOT NULL,
	"checkout_session_id" varchar(128) NOT NULL,
	"payment_intent_id" varchar(128) NOT NULL,
	"charge_id" varchar(128) NOT NULL,
	"balance_transaction_id" varchar(128) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"gross_amount_cents" integer NOT NULL,
	"processor_fee_cents" integer NOT NULL,
	"application_fee_cents" integer NOT NULL,
	"clinic_net_cents" integer NOT NULL,
	"balance_status" varchar(24) NOT NULL,
	"available_on" timestamp with time zone,
	"payout_id" varchar(128),
	"payout_status" varchar(24) DEFAULT 'unassigned' NOT NULL,
	"reconciled_at" timestamp with time zone NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_processor_settlements_currency_check" CHECK ("payment_processor_settlements"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "payment_processor_settlements_amounts_check" CHECK ("payment_processor_settlements"."gross_amount_cents" > 0
        and "payment_processor_settlements"."processor_fee_cents" >= 0
        and "payment_processor_settlements"."application_fee_cents" >= 0
        and "payment_processor_settlements"."clinic_net_cents" >= 0
        and "payment_processor_settlements"."gross_amount_cents" = "payment_processor_settlements"."processor_fee_cents" + "payment_processor_settlements"."application_fee_cents" + "payment_processor_settlements"."clinic_net_cents"),
	CONSTRAINT "payment_processor_settlements_status_check" CHECK ("payment_processor_settlements"."balance_status" in ('pending', 'available')
        and "payment_processor_settlements"."payout_status" in ('unassigned', 'pending', 'paid', 'failed', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_settlement_id_payment_processor_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."payment_processor_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" ADD CONSTRAINT "payment_processor_settlements_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" ADD CONSTRAINT "payment_processor_settlements_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_processor_settlements" ADD CONSTRAINT "payment_processor_settlements_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_closes_practice_day_uq" ON "financial_closes" USING btree ("practice_id","business_date");--> statement-breakpoint
CREATE INDEX "financial_closes_practice_cutoff_idx" ON "financial_closes" USING btree ("practice_id","cutoff_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_disputes_external_uq" ON "payment_disputes" USING btree ("provider","external_dispute_id");--> statement-breakpoint
CREATE INDEX "payment_disputes_practice_status_idx" ON "payment_disputes" USING btree ("practice_id","status","provider_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_settlements_payment_uq" ON "payment_processor_settlements" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_settlements_checkout_uq" ON "payment_processor_settlements" USING btree ("provider","connected_account_id","checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_settlements_charge_uq" ON "payment_processor_settlements" USING btree ("provider","connected_account_id","charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_settlements_balance_transaction_uq" ON "payment_processor_settlements" USING btree ("provider","connected_account_id","balance_transaction_id");--> statement-breakpoint
CREATE INDEX "payment_processor_settlements_practice_date_idx" ON "payment_processor_settlements" USING btree ("practice_id","reconciled_at");--> statement-breakpoint
CREATE INDEX "payment_processor_settlements_payout_idx" ON "payment_processor_settlements" USING btree ("practice_id","payout_id","payout_status");