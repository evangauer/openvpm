SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "visit_closeouts" DROP CONSTRAINT "visit_closeouts_completed_state_check";--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_completed_state_check" CHECK ("visit_closeouts"."status" <> 'completed'
        or (
          "visit_closeouts"."completed_at" is not null
          and "visit_closeouts"."completed_by" is not null
          and "visit_closeouts"."charge_disposition" is not null
          and "visit_closeouts"."handoff_method" is not null
          and (
            "visit_closeouts"."charge_disposition" = 'no_charge'
            and length(btrim(coalesce("visit_closeouts"."no_charge_reason", ''))) > 0
            or "visit_closeouts"."charge_disposition" in ('paid', 'accounts_receivable')
            and "visit_closeouts"."invoice_id" is not null
          )
        )) NOT VALID;--> statement-breakpoint
ALTER TABLE "visit_closeouts" VALIDATE CONSTRAINT "visit_closeouts_completed_state_check";
