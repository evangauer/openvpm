CREATE TABLE "patient_merge_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"source_patient_id" uuid NOT NULL,
	"target_patient_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"performed_by" uuid NOT NULL,
	"performed_by_name" varchar(255) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"operation_id" uuid NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"target_snapshot" jsonb NOT NULL,
	CONSTRAINT "patient_merge_events_different_patients_check" CHECK ("patient_merge_events"."source_patient_id" <> "patient_merge_events"."target_patient_id"),
	CONSTRAINT "patient_merge_events_attribution_check" CHECK (length(btrim("patient_merge_events"."performed_by_name")) between 1 and 255),
	CONSTRAINT "patient_merge_events_reason_check" CHECK (length(btrim("patient_merge_events"."reason")) between 5 and 500),
	CONSTRAINT "patient_merge_events_snapshots_check" CHECK (jsonb_typeof("patient_merge_events"."source_snapshot") = 'object'
        and jsonb_typeof("patient_merge_events"."target_snapshot") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clients_practice_id_uq" ON "clients" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_source_patient_id_patients_id_fk" FOREIGN KEY ("source_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_target_patient_id_patients_id_fk" FOREIGN KEY ("target_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_source_tenant_fk" FOREIGN KEY ("practice_id","source_patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_target_tenant_fk" FOREIGN KEY ("practice_id","target_patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_client_tenant_fk" FOREIGN KEY ("practice_id","client_id") REFERENCES "public"."clients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_events" ADD CONSTRAINT "patient_merge_events_actor_tenant_fk" FOREIGN KEY ("practice_id","performed_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_merge_events_source_uq" ON "patient_merge_events" USING btree ("practice_id","source_patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_merge_events_operation_uq" ON "patient_merge_events" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE INDEX "patient_merge_events_target_history_idx" ON "patient_merge_events" USING btree ("practice_id","target_patient_id","created_at","id");--> statement-breakpoint
CREATE FUNCTION validate_patient_merge_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	source_client_id uuid;
	target_client_id uuid;
BEGIN
	-- Serialize identity corrections within a practice so two concurrent merges
	-- cannot both observe an empty lineage and create a chain or cycle.
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(NEW.practice_id::text, 0)
	);

	IF EXISTS (
		SELECT 1
		FROM public.patient_merge_events event
		WHERE event.practice_id = NEW.practice_id
			AND event.target_patient_id = NEW.source_patient_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'A canonical patient with incoming merge history cannot be retired.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM public.patient_merge_events event
		WHERE event.practice_id = NEW.practice_id
			AND event.source_patient_id = NEW.target_patient_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'A patient already recorded as a merge alias cannot be a merge target.';
	END IF;

	SELECT patient.client_id INTO source_client_id
	FROM public.patients patient
	WHERE patient.practice_id = NEW.practice_id
		AND patient.id = NEW.source_patient_id;

	SELECT patient.client_id INTO target_client_id
	FROM public.patients patient
	WHERE patient.practice_id = NEW.practice_id
		AND patient.id = NEW.target_patient_id;

	IF source_client_id IS DISTINCT FROM NEW.client_id
		OR target_client_id IS DISTINCT FROM NEW.client_id
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = 'Patient merge source and target must belong to the recorded client.';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER patient_merge_events_validate_insert
	BEFORE INSERT ON patient_merge_events
	FOR EACH ROW
	EXECUTE FUNCTION validate_patient_merge_event_insert();--> statement-breakpoint
CREATE FUNCTION reject_patient_merge_event_mutation()
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
				AND class.relname = 'patient_merge_events'
		)
	THEN
		IF TG_OP = 'DELETE' THEN
			RETURN OLD;
		END IF;
		RETURN NEW;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'Patient merge events are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER patient_merge_events_immutable
	BEFORE UPDATE OR DELETE ON patient_merge_events
	FOR EACH ROW
	EXECUTE FUNCTION reject_patient_merge_event_mutation();--> statement-breakpoint
ALTER TABLE patient_merge_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON patient_merge_events
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
		REVOKE ALL ON patient_merge_events FROM openpims_app;
		GRANT SELECT, INSERT ON patient_merge_events TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON patient_merge_events FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON patient_merge_events FROM authenticated;
	END IF;
END
$$;
