CREATE TABLE "lab_report_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"patient_id" uuid,
	"reason" varchar(500),
	CONSTRAINT "lab_report_decisions_version_check" CHECK ("lab_report_decisions"."version" > 0),
	CONSTRAINT "lab_report_decisions_state_check" CHECK (("lab_report_decisions"."state" in ('matched', 'reviewed') and "lab_report_decisions"."patient_id" is not null) or ("lab_report_decisions"."state" in ('unmatched', 'dismissed') and "lab_report_decisions"."patient_id" is null and "lab_report_decisions"."reason" is not null and length(trim("lab_report_decisions"."reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "lab_report_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_id" uuid NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"received_by" uuid NOT NULL,
	"source" varchar(32) DEFAULT 'manual_upload' NOT NULL,
	"supersedes_id" uuid,
	CONSTRAINT "lab_report_receipts_digest_check" CHECK ("lab_report_receipts"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "lab_report_receipts_source_check" CHECK ("lab_report_receipts"."source" = 'manual_upload'),
	CONSTRAINT "lab_report_receipts_previous_check" CHECK ("lab_report_receipts"."supersedes_id" is null or "lab_report_receipts"."supersedes_id" <> "lab_report_receipts"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lab_report_receipts_tenant_id_uq" ON "lab_report_receipts" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "lab_report_decisions" ADD CONSTRAINT "lab_report_decisions_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_decisions" ADD CONSTRAINT "lab_report_decisions_report_tenant_fk" FOREIGN KEY ("practice_id","report_id") REFERENCES "public"."lab_report_receipts"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_decisions" ADD CONSTRAINT "lab_report_decisions_patient_tenant_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_decisions" ADD CONSTRAINT "lab_report_decisions_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_receipts" ADD CONSTRAINT "lab_report_receipts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_receipts" ADD CONSTRAINT "lab_report_receipts_supersedes_id_lab_report_receipts_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."lab_report_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_receipts" ADD CONSTRAINT "lab_report_receipts_file_tenant_fk" FOREIGN KEY ("practice_id","file_id") REFERENCES "public"."files"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_receipts" ADD CONSTRAINT "lab_report_receipts_actor_tenant_fk" FOREIGN KEY ("practice_id","received_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_receipts" ADD CONSTRAINT "lab_report_receipts_previous_tenant_fk" FOREIGN KEY ("practice_id","supersedes_id") REFERENCES "public"."lab_report_receipts"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lab_report_decisions_version_uq" ON "lab_report_decisions" USING btree ("report_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_report_decisions_operation_uq" ON "lab_report_decisions" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE INDEX "lab_report_decisions_patient_idx" ON "lab_report_decisions" USING btree ("practice_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_report_receipts_digest_uq" ON "lab_report_receipts" USING btree ("practice_id","checksum_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_report_receipts_file_uq" ON "lab_report_receipts" USING btree ("practice_id","file_id");--> statement-breakpoint
CREATE INDEX "lab_report_receipts_inbox_idx" ON "lab_report_receipts" USING btree ("practice_id","created_at","id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_lab_report_intake_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
		AND current_user = (
			SELECT pg_catalog.pg_get_userbyid(class.relowner)
			FROM pg_catalog.pg_class class
			JOIN pg_catalog.pg_namespace namespace
				ON namespace.oid = class.relnamespace
			WHERE namespace.nspname = TG_TABLE_SCHEMA
				AND class.relname = TG_TABLE_NAME
		)
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'Lab report receipts and decisions are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER lab_report_receipts_immutable BEFORE UPDATE OR DELETE ON lab_report_receipts
FOR EACH ROW EXECUTE FUNCTION reject_lab_report_intake_mutation();
--> statement-breakpoint
ALTER TABLE lab_report_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON lab_report_receipts
USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid)
WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER lab_report_decisions_immutable BEFORE UPDATE OR DELETE ON lab_report_decisions
FOR EACH ROW EXECUTE FUNCTION reject_lab_report_intake_mutation();
--> statement-breakpoint
ALTER TABLE lab_report_decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON lab_report_decisions
USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid)
WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid);
--> statement-breakpoint
REVOKE ALL ON FUNCTION reject_lab_report_intake_mutation() FROM PUBLIC;

--> statement-breakpoint
CREATE INDEX lab_report_receipts_revisions_idx ON lab_report_receipts (practice_id, supersedes_id);
--> statement-breakpoint
CREATE INDEX lab_report_decisions_latest_idx ON lab_report_decisions (practice_id, report_id, version);
