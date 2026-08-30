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
		LEFT JOIN appointments appointment
			ON appointment.practice_id = rx.practice_id
			AND appointment.id = rx.appointment_id
		WHERE patient.id IS NULL
			OR prescriber.id IS NULL
			OR (rx.product_id IS NOT NULL AND product.id IS NULL)
			OR (rx.appointment_id IS NOT NULL AND appointment.id IS NULL)
			OR length(btrim(rx.medication_name)) = 0
			OR length(btrim(rx.dosage)) = 0
			OR length(btrim(rx.frequency)) = 0
			OR (rx.quantity IS NOT NULL AND rx.quantity <= 0)
			OR (rx.product_id IS NOT NULL AND coalesce(rx.quantity, 0) <= 0)
			OR rx.refills_remaining < 0
			OR (rx.end_date IS NOT NULL AND rx.end_date < rx.start_date)
	) THEN
		RAISE EXCEPTION 'Prescription integrity migration blocked: existing prescriptions violate tenant or clinical shape requirements';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM prescriptions legacy
		JOIN prescriptions existing
			ON existing.practice_id = legacy.practice_id
			AND existing.operation_id = legacy.id
			AND existing.id <> legacy.id
		WHERE legacy.operation_id IS NULL
	) THEN
		RAISE EXCEPTION 'Prescription integrity migration blocked: deterministic legacy operation IDs would collide';
	END IF;
END $$;--> statement-breakpoint
UPDATE prescriptions SET operation_id = id WHERE operation_id IS NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ALTER COLUMN "operation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_practice_patient_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_practice_product_fk" FOREIGN KEY ("practice_id","product_id") REFERENCES "public"."products"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_practice_prescriber_fk" FOREIGN KEY ("practice_id","prescribed_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_integrity_check" CHECK (length(btrim("prescriptions"."medication_name")) > 0
        and length(btrim("prescriptions"."dosage")) > 0
        and length(btrim("prescriptions"."frequency")) > 0
        and ("prescriptions"."quantity" is null or "prescriptions"."quantity" > 0)
        and ("prescriptions"."product_id" is null or "prescriptions"."quantity" > 0)
        and "prescriptions"."refills_remaining" >= 0
        and ("prescriptions"."end_date" is null or "prescriptions"."end_date" >= "prescriptions"."start_date"));--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON prescriptions FROM openpims_app;
		GRANT SELECT, INSERT ON prescriptions TO openpims_app;
		GRANT UPDATE (status, refills_remaining, updated_at) ON prescriptions TO openpims_app;
	END IF;
END $$;
