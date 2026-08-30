ALTER TABLE public.controlled_substance_log
  ADD COLUMN operation_id uuid;
--> statement-breakpoint
UPDATE public.controlled_substance_log
SET operation_id = id
WHERE operation_id IS NULL;
--> statement-breakpoint
ALTER TABLE public.controlled_substance_log
  ALTER COLUMN operation_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.controlled_substance_log
  ADD CONSTRAINT controlled_substance_log_patient_tenant_fk
  FOREIGN KEY (practice_id, patient_id)
  REFERENCES public.patients (practice_id, id);
--> statement-breakpoint
ALTER TABLE public.controlled_substance_log
  ADD CONSTRAINT controlled_substance_log_performer_tenant_fk
  FOREIGN KEY (practice_id, performed_by)
  REFERENCES public.users (practice_id, id);
--> statement-breakpoint
ALTER TABLE public.controlled_substance_log
  ADD CONSTRAINT controlled_substance_log_witness_tenant_fk
  FOREIGN KEY (practice_id, witnessed_by)
  REFERENCES public.users (practice_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX controlled_substance_log_practice_id_uq
  ON public.controlled_substance_log (practice_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX controlled_substance_log_practice_operation_uq
  ON public.controlled_substance_log (practice_id, operation_id);
--> statement-breakpoint
ALTER TABLE public.controlled_substance_log
  ADD CONSTRAINT controlled_substance_log_positive_quantity_check
  CHECK (quantity > 0),
  ADD CONSTRAINT controlled_substance_log_administered_patient_check
  CHECK (action <> 'administered' OR patient_id IS NOT NULL),
  ADD CONSTRAINT controlled_substance_log_waste_witness_check
  CHECK (action <> 'wasted' OR witnessed_by IS NOT NULL),
  ADD CONSTRAINT controlled_substance_log_distinct_witness_check
  CHECK (witnessed_by IS NULL OR witnessed_by <> performed_by);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enforce_controlled_substance_log_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
DECLARE
  available_quantity numeric;
  ledger_lock_key text;
BEGIN
  ledger_lock_key := 'controlled-substance:'
    || NEW.practice_id::text || ':' || NEW.drug_name || ':' || NEW.unit;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(ledger_lock_key)
  );

  IF NEW.action = 'received' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN entry.action = 'received' THEN entry.quantity
      ELSE -entry.quantity
    END
  ), 0)
  INTO available_quantity
  FROM public.controlled_substance_log entry
  WHERE entry.practice_id = NEW.practice_id
    AND entry.drug_name = NEW.drug_name
    AND entry.unit = NEW.unit
    AND entry.deleted_at IS NULL;

  IF NEW.quantity > available_quantity THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Controlled-substance entry exceeds available inventory.';
  END IF;

  RETURN NEW;
END;
$body$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS controlled_substance_log_balance
  ON public.controlled_substance_log;
--> statement-breakpoint
CREATE TRIGGER controlled_substance_log_balance
BEFORE INSERT ON public.controlled_substance_log
FOR EACH ROW
EXECUTE FUNCTION public.enforce_controlled_substance_log_balance();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_controlled_substance_log_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Controlled-substance ledger entries are immutable; append a correction entry instead.';
END;
$body$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS controlled_substance_log_immutability
  ON public.controlled_substance_log;
--> statement-breakpoint
CREATE TRIGGER controlled_substance_log_immutability
BEFORE UPDATE OR DELETE ON public.controlled_substance_log
FOR EACH ROW
EXECUTE FUNCTION public.guard_controlled_substance_log_immutability();
--> statement-breakpoint
DO $body$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'openpims_app']
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
    ) THEN
      EXECUTE format(
        'REVOKE ALL ON public.controlled_substance_log FROM %I',
        role_name
      );
      IF role_name = 'openpims_app' THEN
        EXECUTE
          'GRANT SELECT, INSERT ON public.controlled_substance_log TO openpims_app';
      END IF;
    END IF;
  END LOOP;
END;
$body$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_controlled_substance_log_immutability()
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_controlled_substance_log_balance()
  FROM PUBLIC;
