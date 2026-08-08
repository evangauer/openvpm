CREATE TYPE "public"."visit_charge_disposition" AS ENUM('paid', 'accounts_receivable', 'no_charge');--> statement-breakpoint
CREATE TYPE "public"."visit_closeout_status" AS ENUM('draft', 'clinical_finalized', 'completed');--> statement-breakpoint
CREATE TYPE "public"."visit_follow_up_disposition" AS ENUM('none', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."visit_handoff_method" AS ENUM('print', 'verbal', 'declined');--> statement-breakpoint
CREATE TYPE "public"."visit_prescription_disposition" AS ENUM('prescribed', 'not_needed');--> statement-breakpoint
CREATE TABLE "visit_closeouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"status" "visit_closeout_status" DEFAULT 'draft' NOT NULL,
	"diagnosis_summary" text,
	"discharge_instructions" text,
	"warning_signs" text,
	"no_instructions_reason" text,
	"prescription_disposition" "visit_prescription_disposition",
	"follow_up_disposition" "visit_follow_up_disposition",
	"follow_up_notes" text,
	"follow_up_appointment_id" uuid,
	"follow_up_scheduled_at" timestamp with time zone,
	"medication_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amendment_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"documentation_exception_reason" text,
	"clinical_finalized_at" timestamp with time zone,
	"clinical_finalized_by" uuid,
	"clinical_finalizer_name" text,
	"charge_disposition" "visit_charge_disposition",
	"invoice_id" uuid,
	"no_charge_reason" text,
	"handoff_method" "visit_handoff_method",
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "visit_closeouts_revision_check" CHECK ("visit_closeouts"."revision" >= 1),
	CONSTRAINT "visit_closeouts_clinical_state_check" CHECK ("visit_closeouts"."status" = 'draft'
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
            or (
              "visit_closeouts"."follow_up_disposition" = 'scheduled'
              and "visit_closeouts"."follow_up_appointment_id" is not null
              and "visit_closeouts"."follow_up_scheduled_at" is not null
            )
          )
        )),
	CONSTRAINT "visit_closeouts_completed_state_check" CHECK ("visit_closeouts"."status" <> 'completed'
        or (
          "visit_closeouts"."completed_at" is not null
          and "visit_closeouts"."completed_by" is not null
          and "visit_closeouts"."charge_disposition" is not null
          and "visit_closeouts"."handoff_method" is not null
          and (
            "visit_closeouts"."charge_disposition" = 'no_charge'
            and "visit_closeouts"."invoice_id" is null
            and length(btrim(coalesce("visit_closeouts"."no_charge_reason", ''))) > 0
            or "visit_closeouts"."charge_disposition" in ('paid', 'accounts_receivable')
            and "visit_closeouts"."invoice_id" is not null
          )
        ))
);
--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "source_prescription_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_follow_up_appointment_id_appointments_id_fk" FOREIGN KEY ("follow_up_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_clinical_finalized_by_users_id_fk" FOREIGN KEY ("clinical_finalized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_closeouts" ADD CONSTRAINT "visit_closeouts_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_closeouts_appointment_uq" ON "visit_closeouts" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "visit_closeouts_practice_status_idx" ON "visit_closeouts" USING btree ("practice_id","status","updated_at");--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "soap_notes_appointment_idx" ON "soap_notes" USING btree ("practice_id","appointment_id","deleted_at");--> statement-breakpoint
CREATE INDEX "prescriptions_appointment_idx" ON "prescriptions" USING btree ("practice_id","appointment_id","deleted_at");--> statement-breakpoint
CREATE INDEX "invoice_items_source_prescription_idx" ON "invoice_items" USING btree ("source_prescription_id","deleted_at");--> statement-breakpoint
CREATE INDEX "invoices_appointment_idx" ON "invoices" USING btree ("practice_id","appointment_id","deleted_at","is_estimate","status");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "invoices"
    WHERE "appointment_id" IS NOT NULL
      AND "is_estimate" = false
      AND "status" <> 'void'
      AND "deleted_at" IS NULL
    GROUP BY "practice_id", "appointment_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot create invoices_active_appointment_uq: duplicate active visit invoices require audited reconciliation.',
      HINT = 'Run the OpenVPM duplicate active visit invoice preflight and reconcile each appointment before retrying this migration.';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_active_appointment_uq" ON "invoices" USING btree ("practice_id","appointment_id") WHERE "invoices"."appointment_id" is not null
          and "invoices"."is_estimate" = false
          and "invoices"."status" <> 'void'
          and "invoices"."deleted_at" is null;
