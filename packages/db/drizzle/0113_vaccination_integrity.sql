DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM vaccination_records vaccination
    LEFT JOIN practices practice
      ON practice.id = vaccination.practice_id
    LEFT JOIN patients patient
      ON patient.practice_id = vaccination.practice_id
     AND patient.id = vaccination.patient_id
    LEFT JOIN appointments appointment
      ON appointment.practice_id = vaccination.practice_id
     AND appointment.id = vaccination.appointment_id
     AND appointment.patient_id = vaccination.patient_id
    LEFT JOIN users administrator
      ON administrator.practice_id = vaccination.practice_id
     AND administrator.id = vaccination.administered_by
    LEFT JOIN users supervisor
      ON supervisor.practice_id = vaccination.practice_id
     AND supervisor.id = vaccination.supervising_veterinarian_id
     AND supervisor.is_veterinarian = true
    WHERE length(btrim(vaccination.vaccine_name)) = 0
       OR practice.id IS NULL
       OR patient.id IS NULL
       OR (vaccination.appointment_id IS NOT NULL AND appointment.id IS NULL)
       OR (vaccination.administered_by IS NOT NULL AND administrator.id IS NULL)
       OR (vaccination.supervising_veterinarian_id IS NOT NULL AND supervisor.id IS NULL)
       OR vaccination.administered_at > now() + interval '5 minutes'
       OR (
         vaccination.product_expiration_date IS NOT NULL
         AND vaccination.product_expiration_date <
           (vaccination.administered_at AT TIME ZONE coalesce(nullif(btrim(practice.timezone), ''), 'UTC'))::date
       )
       OR (
         vaccination.next_due_date IS NOT NULL
         AND vaccination.next_due_date <=
           (vaccination.administered_at AT TIME ZONE coalesce(nullif(btrim(practice.timezone), ''), 'UTC'))::date
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Vaccination integrity migration blocked: existing records violate tenant, clinician, or date-order requirements.';
  END IF;
END
$migration$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_vaccination_record_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  practice_timezone text;
  administered_date date;
  certificate_actor_id uuid;
  certificate_reason text;
BEGIN
  IF length(btrim(NEW.vaccine_name)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Vaccination name must not be blank.';
  END IF;

  SELECT coalesce(nullif(btrim(practice.timezone), ''), 'UTC')
  INTO practice_timezone
  FROM public.practices practice
  WHERE practice.id = NEW.practice_id;

  IF practice_timezone IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.patients patient
       WHERE patient.practice_id = NEW.practice_id
         AND patient.id = NEW.patient_id
     )
     OR (
       NEW.appointment_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.appointments appointment
         WHERE appointment.practice_id = NEW.practice_id
           AND appointment.id = NEW.appointment_id
           AND appointment.patient_id = NEW.patient_id
       )
     )
     OR (
       NEW.administered_by IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.users administrator
         WHERE administrator.practice_id = NEW.practice_id
           AND administrator.id = NEW.administered_by
       )
     )
     OR (
       NEW.supervising_veterinarian_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.users supervisor
         WHERE supervisor.practice_id = NEW.practice_id
           AND supervisor.id = NEW.supervising_veterinarian_id
           AND supervisor.is_veterinarian = true
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Vaccination references must remain in one clinic, patient, and encounter with a veterinarian supervisor.';
  END IF;

  administered_date :=
    (NEW.administered_at AT TIME ZONE practice_timezone)::date;
  IF NEW.administered_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Vaccination administration cannot be recorded in the future.';
  END IF;
  IF NEW.product_expiration_date IS NOT NULL
     AND NEW.product_expiration_date < administered_date THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Vaccination product expiration cannot precede administration.';
  END IF;
  IF NEW.next_due_date IS NOT NULL
     AND NEW.next_due_date <= administered_date THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Vaccination next due date must follow administration.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.updated_at <= OLD.updated_at
       OR NEW.updated_at > now() + interval '5 minutes' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Vaccination certificate updates must advance the record timestamp.';
    END IF;

    certificate_actor_id := nullif(
      current_setting('app.vaccination_certificate_actor_id', true),
      ''
    )::uuid;
    certificate_reason := btrim(coalesce(
      current_setting('app.vaccination_certificate_reason', true),
      ''
    ));
    IF certificate_actor_id IS NULL
       OR length(certificate_reason) = 0
       OR NOT EXISTS (
         SELECT 1 FROM public.users actor
         WHERE actor.practice_id = NEW.practice_id
           AND actor.id = certificate_actor_id
           AND actor.deleted_at IS NULL
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Vaccination certificate updates require an active clinic actor and reason.';
    END IF;

    INSERT INTO public.audit_log (
      practice_id, user_id, action, entity_type, entity_id, changes,
      ip_address
    ) VALUES (
      NEW.practice_id,
      certificate_actor_id,
      'certificate_details_updated',
      'vaccination_record',
      NEW.id,
      jsonb_build_object(
        'reason', certificate_reason,
        'before', jsonb_build_object(
          'productName', OLD.product_name,
          'manufacturer', OLD.manufacturer,
          'lotNumber', OLD.lot_number,
          'productExpirationDate', OLD.product_expiration_date,
          'doseType', OLD.dose_type,
          'licensedDurationMonths', OLD.licensed_duration_months,
          'rabiesTagNumber', OLD.rabies_tag_number,
          'supervisingVeterinarianId', OLD.supervising_veterinarian_id
        ),
        'after', jsonb_build_object(
          'productName', NEW.product_name,
          'manufacturer', NEW.manufacturer,
          'lotNumber', NEW.lot_number,
          'productExpirationDate', NEW.product_expiration_date,
          'doseType', NEW.dose_type,
          'licensedDurationMonths', NEW.licensed_duration_months,
          'rabiesTagNumber', NEW.rabies_tag_number,
          'supervisingVeterinarianId', NEW.supervising_veterinarian_id,
          'updatedAt', NEW.updated_at
        )
      ),
      nullif(left(coalesce(
        current_setting('app.vaccination_certificate_ip', true),
        ''
      ), 45), '')
    );
  END IF;

  RETURN NEW;
END
$function$;--> statement-breakpoint

DROP TRIGGER IF EXISTS vaccination_records_validate_write
  ON vaccination_records;--> statement-breakpoint
CREATE TRIGGER vaccination_records_validate_write
BEFORE INSERT OR UPDATE OF
  practice_id, patient_id, appointment_id, vaccine_name, administered_by,
  supervising_veterinarian_id, administered_at, next_due_date,
  product_name, manufacturer, lot_number, product_expiration_date, dose_type,
  licensed_duration_months, rabies_tag_number, updated_at
ON vaccination_records
FOR EACH ROW EXECUTE FUNCTION validate_vaccination_record_write();--> statement-breakpoint

REVOKE ALL ON FUNCTION validate_vaccination_record_write()
  FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION normalize_app_audit_log_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF current_user = 'openpims_app' THEN
    IF NEW.user_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.users actor
         WHERE actor.practice_id = NEW.practice_id
           AND actor.id = NEW.user_id
           AND actor.deleted_at IS NULL
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Audit attribution must reference an active user in the same clinic.';
    END IF;
    NEW.id := gen_random_uuid();
    NEW.created_at := now();
    NEW.updated_at := NEW.created_at;
    NEW.deleted_at := NULL;
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_normalize_app_insert
  ON audit_log;--> statement-breakpoint
CREATE TRIGGER audit_log_normalize_app_insert
BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION normalize_app_audit_log_insert();--> statement-breakpoint

REVOKE ALL ON FUNCTION normalize_app_audit_log_insert()
  FROM PUBLIC;--> statement-breakpoint
DO $privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON vaccination_records FROM openpims_app;
    GRANT SELECT ON vaccination_records TO openpims_app;
    GRANT INSERT (
      practice_id, patient_id, appointment_id, vaccine_name,
      import_fingerprint, product_name, manufacturer, lot_number,
      product_expiration_date, dose_type, licensed_duration_months,
      rabies_tag_number, administered_by, supervising_veterinarian_id,
      administered_at, next_due_date
    ) ON vaccination_records TO openpims_app;
    GRANT UPDATE (
      product_name, manufacturer, lot_number, product_expiration_date,
      dose_type, licensed_duration_months, rabies_tag_number,
      supervising_veterinarian_id, updated_at
    ) ON vaccination_records TO openpims_app;
    REVOKE ALL ON audit_log FROM openpims_app;
    GRANT SELECT ON audit_log TO openpims_app;
    GRANT INSERT (
      id, created_at, updated_at, deleted_at, practice_id, user_id, action,
      entity_type, entity_id, changes, ip_address
    ) ON audit_log TO openpims_app;
    REVOKE ALL ON FUNCTION validate_vaccination_record_write()
      FROM openpims_app;
    REVOKE ALL ON FUNCTION normalize_app_audit_log_insert()
      FROM openpims_app;
  END IF;
END
$privileges$;
