DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM appointments
    WHERE start_time >= end_time
  ) THEN
    RAISE EXCEPTION 'Appointment time-range constraint blocked: an appointment does not end after it starts.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_time_range_check" CHECK ("appointments"."start_time" < "appointments"."end_time");
