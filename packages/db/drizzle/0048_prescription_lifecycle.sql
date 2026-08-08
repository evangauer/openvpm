CREATE TYPE "public"."prescription_event_type" AS ENUM('created', 'refill_dispensed', 'refill_authorized', 'completed', 'cancelled', 'expired');--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM prescriptions rx
		LEFT JOIN patients patient
			ON patient.practice_id = rx.practice_id
			AND patient.id = rx.patient_id
		LEFT JOIN products product
			ON product.practice_id = rx.practice_id
			AND product.id = rx.product_id
		LEFT JOIN users prescriber
			ON prescriber.practice_id = rx.practice_id
			AND prescriber.id = rx.prescribed_by
		WHERE patient.id IS NULL
			OR prescriber.id IS NULL
			OR (rx.product_id IS NOT NULL AND product.id IS NULL)
	) THEN
		RAISE EXCEPTION 'Prescription lifecycle migration blocked: prescriptions contain cross-practice or orphaned patient, product, or prescriber references';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prescriptions_practice_id_uq" ON "prescriptions" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_practice_id_uq" ON "products" USING btree ("practice_id","id");--> statement-breakpoint
CREATE TABLE "prescription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"product_id" uuid,
	"event_type" "prescription_event_type" NOT NULL,
	"quantity" integer,
	"status_before" "prescription_status",
	"status_after" "prescription_status" NOT NULL,
	"refills_before" integer,
	"refills_after" integer NOT NULL,
	"reason" text,
	"actor_id" uuid,
	"actor_name" varchar(255) NOT NULL,
	"operation_id" uuid,
	CONSTRAINT "prescription_events_shape_check" CHECK (length(btrim("prescription_events"."actor_name")) > 0
        and "prescription_events"."refills_after" >= 0
        and ("prescription_events"."refills_before" is null or "prescription_events"."refills_before" >= 0)
        and ("prescription_events"."reason" is null or length("prescription_events"."reason") <= 500)
        and (
          "prescription_events"."event_type" = 'created'
          and "prescription_events"."status_before" is null
          and "prescription_events"."status_after" = 'active'
          and "prescription_events"."refills_before" is null
          and "prescription_events"."actor_id" is not null
        or "prescription_events"."event_type" = 'refill_dispensed'
          and "prescription_events"."status_before" = 'active'
          and "prescription_events"."status_after" = 'active'
          and "prescription_events"."product_id" is not null
          and "prescription_events"."quantity" > 0
          and "prescription_events"."refills_before" > 0
          and "prescription_events"."refills_after" = "prescription_events"."refills_before" - 1
          and "prescription_events"."actor_id" is not null
          and "prescription_events"."operation_id" is not null
        or "prescription_events"."event_type" = 'refill_authorized'
          and "prescription_events"."status_before" = 'active'
          and "prescription_events"."status_after" = 'active'
          and "prescription_events"."product_id" is null
          and "prescription_events"."refills_before" > 0
          and "prescription_events"."refills_after" = "prescription_events"."refills_before" - 1
          and "prescription_events"."actor_id" is not null
          and "prescription_events"."operation_id" is not null
        or "prescription_events"."event_type" in ('completed', 'cancelled')
          and "prescription_events"."status_before" = 'active'
          and "prescription_events"."status_after"::text = "prescription_events"."event_type"::text
          and length(btrim(coalesce("prescription_events"."reason", ''))) >= 5
          and "prescription_events"."refills_before" = "prescription_events"."refills_after"
          and "prescription_events"."actor_id" is not null
          and "prescription_events"."operation_id" is not null
        or "prescription_events"."event_type" = 'expired'
          and "prescription_events"."status_before" = 'active'
          and "prescription_events"."status_after" = 'expired'
          and length(btrim(coalesce("prescription_events"."reason", ''))) >= 5
          and "prescription_events"."refills_before" = "prescription_events"."refills_after"
        ))
);
--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_practice_prescription_fk" FOREIGN KEY ("practice_id","prescription_id") REFERENCES "public"."prescriptions"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_practice_patient_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_practice_product_fk" FOREIGN KEY ("practice_id","product_id") REFERENCES "public"."products"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_events" ADD CONSTRAINT "prescription_events_practice_actor_fk" FOREIGN KEY ("practice_id","actor_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prescription_events_prescription_history_idx" ON "prescription_events" USING btree ("practice_id","prescription_id","created_at","id");--> statement-breakpoint
CREATE INDEX "prescription_events_practice_time_idx" ON "prescription_events" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_events_practice_operation_uq" ON "prescription_events" USING btree ("practice_id","operation_id") WHERE "prescription_events"."operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_events_created_uq" ON "prescription_events" USING btree ("practice_id","prescription_id") WHERE "prescription_events"."event_type" = 'created';--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_events_terminal_uq" ON "prescription_events" USING btree ("practice_id","prescription_id") WHERE "prescription_events"."event_type" in ('completed', 'cancelled', 'expired');--> statement-breakpoint
INSERT INTO prescription_events (
	id,
	created_at,
	practice_id,
	prescription_id,
	patient_id,
	product_id,
	event_type,
	quantity,
	status_before,
	status_after,
	refills_before,
	refills_after,
	reason,
	actor_id,
	actor_name,
	operation_id
)
SELECT
	gen_random_uuid(),
	rx.created_at,
	rx.practice_id,
	rx.id,
	rx.patient_id,
	rx.product_id,
	'created'::prescription_event_type,
	rx.quantity,
	NULL,
	'active'::prescription_status,
	NULL,
	rx.refills_remaining,
	NULL,
	rx.prescribed_by,
	prescriber.name,
	NULL
FROM prescriptions rx
JOIN users prescriber
	ON prescriber.practice_id = rx.practice_id
	AND prescriber.id = rx.prescribed_by
WHERE rx.deleted_at IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_prescription_event_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	source_matches boolean := false;
BEGIN
	SELECT EXISTS (
		SELECT 1
		FROM public.prescriptions source
		WHERE source.practice_id = NEW.practice_id
			AND source.id = NEW.prescription_id
			AND source.patient_id = NEW.patient_id
			AND source.product_id IS NOT DISTINCT FROM NEW.product_id
			AND source.quantity IS NOT DISTINCT FROM NEW.quantity
	) INTO source_matches;

	IF NOT source_matches THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = 'Prescription event source does not match its practice, patient, product, or quantity.';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER prescription_events_validate_source
	BEFORE INSERT ON prescription_events
	FOR EACH ROW
	EXECUTE FUNCTION validate_prescription_event_source();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_prescription_event_mutation()
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
			WHERE namespace.nspname = 'public'
				AND class.relname = 'prescription_events'
		) THEN
		IF TG_OP = 'DELETE' THEN
			RETURN OLD;
		END IF;
		RETURN NEW;
	END IF;
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'Prescription events are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER prescription_events_immutable
	BEFORE UPDATE OR DELETE ON prescription_events
	FOR EACH ROW
	EXECUTE FUNCTION reject_prescription_event_mutation();--> statement-breakpoint
ALTER TABLE prescription_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON prescription_events
	USING (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
	)
	WITH CHECK (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
	);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON prescription_events FROM openpims_app;
		GRANT SELECT, INSERT ON prescription_events TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON prescription_events FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON prescription_events FROM authenticated;
	END IF;
END $$;
