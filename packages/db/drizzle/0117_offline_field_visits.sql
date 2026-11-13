CREATE TABLE "offline_field_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"preparation_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"request_hash" varchar(64),
	"receipt" jsonb,
	"result" jsonb,
	CONSTRAINT "offline_field_batches_state_check" CHECK (("offline_field_batches"."request_hash" is null and "offline_field_batches"."result" is null and "offline_field_batches"."receipt" is null) or ("offline_field_batches"."request_hash" is not null and "offline_field_batches"."request_hash" ~ '^[a-f0-9]{64}$' and "offline_field_batches"."result" is not null and "offline_field_batches"."receipt" is not null)),
	CONSTRAINT "offline_field_batches_hash_check" CHECK ("offline_field_batches"."preparation_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "offline_field_batches" ADD CONSTRAINT "offline_field_batches_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_field_batches" ADD CONSTRAINT "offline_field_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_field_batches" ADD CONSTRAINT "offline_field_batches_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_field_batches" ADD CONSTRAINT "offline_field_batches_practice_user_fk" FOREIGN KEY ("practice_id","user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_field_batches" ADD CONSTRAINT "offline_field_batches_practice_patient_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offline_field_batches_owner_idx" ON "offline_field_batches" USING btree ("practice_id","user_id","created_at");
--> statement-breakpoint
CREATE FUNCTION guard_offline_field_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'openpims_app' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Offline preparation identities cannot be deleted';
    END IF;
    IF ROW(NEW.id, NEW.practice_id, NEW.user_id, NEW.patient_id, NEW.preparation_hash, NEW.expires_at, NEW.deleted_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.practice_id, OLD.user_id, OLD.patient_id, OLD.preparation_hash, OLD.expires_at, OLD.deleted_at)
      OR (OLD.result IS NOT NULL AND ROW(NEW.request_hash, NEW.result, NEW.receipt) IS DISTINCT FROM ROW(OLD.request_hash, OLD.result, OLD.receipt)) THEN
      RAISE EXCEPTION 'Offline preparation identities and synchronized receipts cannot be rewritten';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER offline_field_batch_guard BEFORE UPDATE OR DELETE ON offline_field_batches
FOR EACH ROW EXECUTE FUNCTION guard_offline_field_batch();
--> statement-breakpoint
REVOKE ALL ON FUNCTION guard_offline_field_batch() FROM PUBLIC;
