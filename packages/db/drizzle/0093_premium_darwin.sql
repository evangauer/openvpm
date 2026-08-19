CREATE TABLE "payment_processor_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'stripe_connect' NOT NULL,
	"connected_account_id" varchar(128) NOT NULL,
	"external_payout_id" varchar(128) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" varchar(24) NOT NULL,
	"automatic" boolean NOT NULL,
	"reconciliation_complete" boolean DEFAULT false NOT NULL,
	"arrival_at" timestamp with time zone NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"failure_code" varchar(64),
	"failure_message" varchar(500),
	"last_synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_processor_payouts_amount_check" CHECK ("payment_processor_payouts"."amount_cents" > 0 and "payment_processor_payouts"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "payment_processor_payouts_status_check" CHECK ("payment_processor_payouts"."status" in ('pending', 'in_transit', 'paid', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "payment_processor_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"settlement_id" uuid,
	"original_payment_id" uuid NOT NULL,
	"refund_payment_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'stripe_connect' NOT NULL,
	"connected_account_id" varchar(128),
	"external_refund_id" varchar(128) NOT NULL,
	"balance_transaction_id" varchar(128),
	"currency" varchar(3) NOT NULL,
	"amount_cents" integer NOT NULL,
	"balance_amount_cents" integer,
	"balance_fee_cents" integer,
	"balance_net_cents" integer,
	"status" varchar(24) NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_processor_refunds_amount_check" CHECK ("payment_processor_refunds"."amount_cents" > 0
        and "payment_processor_refunds"."currency" ~ '^[a-z]{3}$'
        and ("payment_processor_refunds"."balance_amount_cents" is null or "payment_processor_refunds"."balance_amount_cents" <= 0)
        and ("payment_processor_refunds"."balance_fee_cents" is null or "payment_processor_refunds"."balance_fee_cents" >= 0)
        and ("payment_processor_refunds"."balance_net_cents" is null or "payment_processor_refunds"."balance_net_cents" <= 0)),
	CONSTRAINT "payment_processor_refunds_status_check" CHECK ("payment_processor_refunds"."status" in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "payment_processor_payouts" ADD CONSTRAINT "payment_processor_payouts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_processor_refunds" ADD CONSTRAINT "payment_processor_refunds_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_processor_refunds" ADD CONSTRAINT "payment_processor_refunds_settlement_id_payment_processor_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."payment_processor_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_processor_refunds" ADD CONSTRAINT "payment_processor_refunds_original_payment_id_payments_id_fk" FOREIGN KEY ("original_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_processor_refunds" ADD CONSTRAINT "payment_processor_refunds_refund_payment_id_payments_id_fk" FOREIGN KEY ("refund_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_payouts_external_uq" ON "payment_processor_payouts" USING btree ("provider","connected_account_id","external_payout_id");--> statement-breakpoint
CREATE INDEX "payment_processor_payouts_practice_date_idx" ON "payment_processor_payouts" USING btree ("practice_id","provider_created_at","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_refunds_payment_uq" ON "payment_processor_refunds" USING btree ("refund_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_processor_refunds_external_uq" ON "payment_processor_refunds" USING btree ("provider","external_refund_id");--> statement-breakpoint
CREATE INDEX "payment_processor_refunds_practice_date_idx" ON "payment_processor_refunds" USING btree ("practice_id","provider_created_at");