DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM staff_schedules schedule
    LEFT JOIN users staff
      ON staff.practice_id = schedule.practice_id
     AND staff.id = schedule.user_id
    LEFT JOIN locations location
      ON location.practice_id = schedule.practice_id
     AND location.id = schedule.location_id
    WHERE staff.id IS NULL
       OR (schedule.location_id IS NOT NULL AND location.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'staff_schedules contains a cross-tenant or missing user/location reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM staff_schedules
    WHERE day_of_week NOT BETWEEN 0 AND 6
       OR start_time >= end_time
  ) THEN
    RAISE EXCEPTION 'staff_schedules contains an invalid day or time range';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM staff_schedules
    WHERE deleted_at IS NULL
    GROUP BY practice_id, user_id, location_id, day_of_week, start_time, end_time
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'staff_schedules contains duplicate active working windows';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_user_tenant_fk" FOREIGN KEY ("practice_id","user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_location_tenant_fk" FOREIGN KEY ("practice_id","location_id") REFERENCES "public"."locations"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_schedules_active_day_idx" ON "staff_schedules" USING btree ("practice_id","location_id","day_of_week","user_id") WHERE "staff_schedules"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_schedules_active_window_uq" ON "staff_schedules" USING btree ("practice_id","user_id","location_id","day_of_week","start_time","end_time") WHERE "staff_schedules"."deleted_at" is null and "staff_schedules"."location_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_schedules_active_null_location_window_uq" ON "staff_schedules" USING btree ("practice_id","user_id","day_of_week","start_time","end_time") WHERE "staff_schedules"."deleted_at" is null and "staff_schedules"."location_id" is null;--> statement-breakpoint
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_day_of_week_check" CHECK ("staff_schedules"."day_of_week" between 0 and 6);--> statement-breakpoint
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_time_range_check" CHECK ("staff_schedules"."start_time" < "staff_schedules"."end_time");
