CREATE OR REPLACE FUNCTION prevent_patient_allergy_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
		AND current_user = (
			SELECT pg_catalog.pg_get_userbyid(class.relowner)
			FROM pg_catalog.pg_class class
			JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
			WHERE namespace.nspname = TG_TABLE_SCHEMA AND class.relname = TG_TABLE_NAME
		)
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'Patient allergy source records are immutable; append a clinical correction instead.';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS patient_allergies_immutable ON "patient_allergies";--> statement-breakpoint
CREATE TRIGGER patient_allergies_immutable
BEFORE UPDATE OR DELETE ON "patient_allergies"
FOR EACH ROW EXECUTE FUNCTION prevent_patient_allergy_mutation();--> statement-breakpoint
REVOKE ALL ON "patient_allergies" FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE
	role_name text;
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON patient_allergies FROM openpims_app;
		GRANT SELECT, INSERT ON patient_allergies TO openpims_app;
	END IF;

	FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
			EXECUTE format('REVOKE ALL ON patient_allergies FROM %I', role_name);
		END IF;
	END LOOP;
END $$;
