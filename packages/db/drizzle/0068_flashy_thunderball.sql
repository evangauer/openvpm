ALTER TABLE "appointments" ADD COLUMN "location_id" uuid;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM rooms r
    JOIN locations l ON l.id = r.location_id
    WHERE r.location_id IS NOT NULL
      AND r.practice_id <> l.practice_id
  ) THEN
    RAISE EXCEPTION 'Location-aware scheduling migration blocked: a room references another practice location.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM appointments a
    JOIN rooms r ON r.id = a.room_id
    WHERE a.room_id IS NOT NULL
      AND a.practice_id <> r.practice_id
  ) THEN
    RAISE EXCEPTION 'Location-aware scheduling migration blocked: an appointment references another practice room.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM locations l
    WHERE l.deleted_at IS NULL AND l.is_primary = true
    GROUP BY l.practice_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Location-aware scheduling migration blocked: a practice has multiple active primary locations.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rooms r
    WHERE r.location_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM locations l
        WHERE l.practice_id = r.practice_id
          AND l.deleted_at IS NULL
        GROUP BY l.practice_id
        HAVING count(*) = 1 OR count(*) FILTER (WHERE l.is_primary = true) = 1
      )
  ) THEN
    RAISE EXCEPTION 'Location-aware scheduling migration blocked: a room has no unambiguous active location.';
  END IF;
END $$;--> statement-breakpoint

UPDATE rooms r
SET location_id = (
  SELECT l.id
  FROM locations l
  WHERE l.practice_id = r.practice_id
    AND l.deleted_at IS NULL
  ORDER BY l.is_primary DESC, l.id
  LIMIT 1
)
WHERE r.location_id IS NULL;--> statement-breakpoint

UPDATE appointments a
SET location_id = coalesce(
  (
    SELECT r.location_id
    FROM rooms r
    WHERE r.id = a.room_id
      AND r.practice_id = a.practice_id
    LIMIT 1
  ),
  (
    SELECT u.location_id
    FROM users u
    JOIN locations ul
      ON ul.id = u.location_id
     AND ul.practice_id = a.practice_id
     AND ul.deleted_at IS NULL
    WHERE u.id = a.doctor_id
      AND u.practice_id = a.practice_id
      AND u.deleted_at IS NULL
    LIMIT 1
  ),
  (
    SELECT l.id
    FROM locations l
    WHERE l.practice_id = a.practice_id
      AND l.deleted_at IS NULL
      AND (
        l.is_primary = true
        OR (
          SELECT count(*)
          FROM locations sole
          WHERE sole.practice_id = a.practice_id
            AND sole.deleted_at IS NULL
        ) = 1
      )
    ORDER BY l.is_primary DESC, l.id
    LIMIT 1
  )
)
WHERE a.location_id IS NULL;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rooms WHERE location_id IS NULL) THEN
    RAISE EXCEPTION 'Location-aware scheduling migration blocked: unresolved room location remains.';
  END IF;
  IF EXISTS (SELECT 1 FROM appointments WHERE location_id IS NULL) THEN
    RAISE EXCEPTION 'Location-aware scheduling migration blocked: unresolved appointment location remains.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM appointments a
    JOIN rooms r ON r.id = a.room_id
    WHERE a.room_id IS NOT NULL
      AND (
        a.practice_id <> r.practice_id
        OR a.location_id <> r.location_id
      )
  ) THEN
    RAISE EXCEPTION 'Location-aware scheduling migration blocked: appointment and room locations disagree.';
  END IF;
END $$;--> statement-breakpoint

-- Keep old application replicas safe during the expand rollout. Until every
-- writer sends location_id explicitly, derive it from an active room/provider
-- or the practice's sole/primary active location. Ambiguous writes fail closed
-- instead of creating appointments that location-scoped calendars cannot see.
CREATE OR REPLACE FUNCTION public.assign_room_scheduling_location()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.location_id IS NULL THEN
    SELECT l.id
    INTO NEW.location_id
    FROM public.locations l
    WHERE l.practice_id = NEW.practice_id
      AND l.deleted_at IS NULL
      AND (
        l.is_primary = true
        OR (
          SELECT count(*)
          FROM public.locations sole
          WHERE sole.practice_id = NEW.practice_id
            AND sole.deleted_at IS NULL
        ) = 1
      )
    ORDER BY l.is_primary DESC, l.id
    LIMIT 1;
  END IF;

  IF NEW.location_id IS NULL THEN
    RAISE EXCEPTION 'A clinic location is required before creating this room.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER rooms_assign_scheduling_location
BEFORE INSERT OR UPDATE OF practice_id, location_id ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.assign_room_scheduling_location();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.assign_appointment_scheduling_location()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.location_id IS NULL AND NEW.room_id IS NOT NULL THEN
    SELECT r.location_id
    INTO NEW.location_id
    FROM public.rooms r
    JOIN public.locations l
      ON l.id = r.location_id
     AND l.practice_id = NEW.practice_id
     AND l.deleted_at IS NULL
    WHERE r.id = NEW.room_id
      AND r.practice_id = NEW.practice_id
      AND r.deleted_at IS NULL
    LIMIT 1;
  END IF;

  IF NEW.location_id IS NULL AND NEW.doctor_id IS NOT NULL THEN
    SELECT u.location_id
    INTO NEW.location_id
    FROM public.users u
    JOIN public.locations l
      ON l.id = u.location_id
     AND l.practice_id = NEW.practice_id
     AND l.deleted_at IS NULL
    WHERE u.id = NEW.doctor_id
      AND u.practice_id = NEW.practice_id
      AND u.deleted_at IS NULL
    LIMIT 1;
  END IF;

  IF NEW.location_id IS NULL THEN
    SELECT l.id
    INTO NEW.location_id
    FROM public.locations l
    WHERE l.practice_id = NEW.practice_id
      AND l.deleted_at IS NULL
      AND (
        l.is_primary = true
        OR (
          SELECT count(*)
          FROM public.locations sole
          WHERE sole.practice_id = NEW.practice_id
            AND sole.deleted_at IS NULL
        ) = 1
      )
    ORDER BY l.is_primary DESC, l.id
    LIMIT 1;
  END IF;

  IF NEW.location_id IS NULL THEN
    RAISE EXCEPTION 'Choose a clinic location before scheduling this appointment.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER appointments_assign_scheduling_location
BEFORE INSERT OR UPDATE OF practice_id, location_id, room_id, doctor_id ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.assign_appointment_scheduling_location();--> statement-breakpoint

CREATE UNIQUE INDEX "rooms_practice_location_id_uq" ON "rooms" USING btree ("practice_id","location_id","id");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_tenant_fk" FOREIGN KEY ("practice_id","location_id") REFERENCES "public"."locations"("practice_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_room_location_tenant_fk" FOREIGN KEY ("practice_id","location_id","room_id") REFERENCES "public"."rooms"("practice_id","location_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_location_tenant_fk" FOREIGN KEY ("practice_id","location_id") REFERENCES "public"."locations"("practice_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_location_id_locations_id_fk";--> statement-breakpoint
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_location_tenant_fk";--> statement-breakpoint
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_room_location_tenant_fk";--> statement-breakpoint
ALTER TABLE "rooms" VALIDATE CONSTRAINT "rooms_location_tenant_fk";--> statement-breakpoint
CREATE INDEX "appointments_location_time_idx" ON "appointments" USING btree ("practice_id","location_id","start_time","deleted_at");
