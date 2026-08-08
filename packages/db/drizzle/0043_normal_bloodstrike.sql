CREATE TYPE "public"."visit_follow_up_resolution" AS ENUM('scheduled', 'completed', 'not_needed');--> statement-breakpoint
ALTER TABLE "visit_closeouts" DROP CONSTRAINT "visit_closeouts_clinical_state_check";--> statement-breakpoint
ALTER TYPE "public"."visit_follow_up_disposition" RENAME TO "visit_follow_up_disposition_old";--> statement-breakpoint
CREATE TYPE "public"."visit_follow_up_disposition" AS ENUM('none', 'needed', 'scheduled');--> statement-breakpoint
ALTER TABLE "visit_closeouts" ALTER COLUMN "follow_up_disposition" TYPE "public"."visit_follow_up_disposition" USING "follow_up_disposition"::text::"public"."visit_follow_up_disposition";--> statement-breakpoint
DROP TYPE "public"."visit_follow_up_disposition_old";--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD COLUMN "operation_key" varchar(160);--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD COLUMN "balance_after" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_due_date" date;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_assignee_name" text;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_resolution" "visit_follow_up_resolution";--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_resolution_appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_resolution_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_resolution_notes" text;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "follow_up_resolver_name" text;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD COLUMN "amendment_draft" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_source_prescription_id_prescriptions_id_fk" FOREIGN KEY ("source_prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_follow_up_assigned_to_users_id_fk" FOREIGN KEY ("follow_up_assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_follow_up_resolved_by_users_id_fk" FOREIGN KEY ("follow_up_resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_resolution_appointment_fk" FOREIGN KEY ("follow_up_resolution_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prescriptions_practice_operation_uq" ON "prescriptions" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_adjustments_operation_key_uq" ON "invoice_adjustments" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_items_source_prescription_invoice_uq" ON "invoice_items" USING btree ("invoice_id","source_prescription_id") WHERE "invoice_items"."source_prescription_id" is not null and "invoice_items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "visit_closeouts_pending_follow_up_idx" ON "visit_closeouts" USING btree ("practice_id","follow_up_disposition","follow_up_resolved_at","follow_up_due_date");--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_operation_result_check" CHECK (("invoice_adjustments"."operation_key" is null and "invoice_adjustments"."balance_after" is null)
        or ("invoice_adjustments"."operation_key" is not null and "invoice_adjustments"."balance_after" is not null and "invoice_adjustments"."balance_after" >= 0));--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_amendment_draft_check" CHECK (("visit_closeouts"."status" = 'draft' and "visit_closeouts"."amendment_draft" is null)
        or (
          "visit_closeouts"."status" in ('clinical_finalized', 'completed')
          and (
            "visit_closeouts"."amendment_draft" is null
            or jsonb_typeof("visit_closeouts"."amendment_draft") = 'object'
          )
        ));--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_follow_up_resolution_check" CHECK ("visit_closeouts"."follow_up_resolved_at" is null
        and "visit_closeouts"."follow_up_resolution" is null
        and "visit_closeouts"."follow_up_resolution_appointment_id" is null
        and "visit_closeouts"."follow_up_resolution_scheduled_at" is null
        and "visit_closeouts"."follow_up_resolution_notes" is null
        and "visit_closeouts"."follow_up_resolved_by" is null
        and "visit_closeouts"."follow_up_resolver_name" is null
        or (
          "visit_closeouts"."follow_up_disposition" = 'needed'
          and "visit_closeouts"."follow_up_resolved_at" is not null
          and "visit_closeouts"."follow_up_resolution" is not null
          and "visit_closeouts"."follow_up_resolved_by" is not null
          and length(btrim(coalesce("visit_closeouts"."follow_up_resolver_name", ''))) > 0
          and (
            "visit_closeouts"."follow_up_resolution" = 'scheduled'
            and "visit_closeouts"."follow_up_resolution_appointment_id" is not null
            and "visit_closeouts"."follow_up_resolution_scheduled_at" is not null
            or "visit_closeouts"."follow_up_resolution" in ('completed', 'not_needed')
            and "visit_closeouts"."follow_up_resolution_appointment_id" is null
            and "visit_closeouts"."follow_up_resolution_scheduled_at" is null
            and length(btrim(coalesce("visit_closeouts"."follow_up_resolution_notes", ''))) > 0
          )
        ));--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_clinical_state_check" CHECK ("visit_closeouts"."status" = 'draft'
        or (
          "visit_closeouts"."clinical_finalized_at" is not null
          and "visit_closeouts"."clinical_finalized_by" is not null
          and length(btrim(coalesce("visit_closeouts"."clinical_finalizer_name", ''))) > 0
          and "visit_closeouts"."prescription_disposition" is not null
          and (
            "visit_closeouts"."prescription_disposition" = 'prescribed'
            and jsonb_array_length("visit_closeouts"."medication_snapshot") > 0
            or "visit_closeouts"."prescription_disposition" = 'not_needed'
            and jsonb_array_length("visit_closeouts"."medication_snapshot") = 0
          )
          and (
            length(btrim(coalesce("visit_closeouts"."discharge_instructions", ''))) > 0
            or length(btrim(coalesce("visit_closeouts"."no_instructions_reason", ''))) > 0
          )
          and "visit_closeouts"."follow_up_disposition" is not null
          and (
            "visit_closeouts"."follow_up_disposition" = 'none'
            and "visit_closeouts"."follow_up_appointment_id" is null
            and "visit_closeouts"."follow_up_scheduled_at" is null
            and "visit_closeouts"."follow_up_due_date" is null
            and "visit_closeouts"."follow_up_assigned_to" is null
            and "visit_closeouts"."follow_up_assignee_name" is null
            or (
              "visit_closeouts"."follow_up_disposition" = 'scheduled'
              and "visit_closeouts"."follow_up_appointment_id" is not null
              and "visit_closeouts"."follow_up_scheduled_at" is not null
              and "visit_closeouts"."follow_up_due_date" is null
              and "visit_closeouts"."follow_up_assigned_to" is null
              and "visit_closeouts"."follow_up_assignee_name" is null
            )
            or (
              "visit_closeouts"."follow_up_disposition" = 'needed'
              and "visit_closeouts"."follow_up_appointment_id" is null
              and "visit_closeouts"."follow_up_scheduled_at" is null
              and "visit_closeouts"."follow_up_due_date" is not null
              and "visit_closeouts"."follow_up_assigned_to" is not null
              and length(btrim(coalesce("visit_closeouts"."follow_up_assignee_name", ''))) > 0
            )
          )
        ));
