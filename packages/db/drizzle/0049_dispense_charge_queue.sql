CREATE TYPE "public"."dispense_charge_status" AS ENUM('pending', 'invoiced', 'waived');--> statement-breakpoint
CREATE TABLE "dispense_charge_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"prescription_event_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"appointment_id" uuid,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"description_snapshot" varchar(500) NOT NULL,
	"unit_price_snapshot" numeric(10, 2) NOT NULL,
	"status" "dispense_charge_status" DEFAULT 'pending' NOT NULL,
	"invoice_id" uuid,
	"invoice_item_id" uuid,
	"resolved_by" uuid,
	"resolved_by_name" varchar(255),
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"legacy_review" boolean DEFAULT false NOT NULL,
	CONSTRAINT "dispense_charge_queue_shape_check" CHECK ("dispense_charge_queue"."quantity" > 0
        and "dispense_charge_queue"."unit_price_snapshot" >= 0
        and length(btrim("dispense_charge_queue"."description_snapshot")) > 0
        and (
          "dispense_charge_queue"."status" = 'pending'
          and "dispense_charge_queue"."invoice_id" is null
          and "dispense_charge_queue"."invoice_item_id" is null
          and "dispense_charge_queue"."resolved_by" is null
          and "dispense_charge_queue"."resolved_by_name" is null
          and "dispense_charge_queue"."resolved_at" is null
          and "dispense_charge_queue"."resolution_reason" is null
        or "dispense_charge_queue"."status" = 'invoiced'
          and "dispense_charge_queue"."invoice_id" is not null
          and "dispense_charge_queue"."invoice_item_id" is not null
          and "dispense_charge_queue"."resolved_by" is not null
          and length(btrim(coalesce("dispense_charge_queue"."resolved_by_name", ''))) > 0
          and "dispense_charge_queue"."resolved_at" is not null
          and "dispense_charge_queue"."resolution_reason" is null
        or "dispense_charge_queue"."status" = 'waived'
          and "dispense_charge_queue"."invoice_id" is null
          and "dispense_charge_queue"."invoice_item_id" is null
          and "dispense_charge_queue"."resolved_by" is not null
          and length(btrim(coalesce("dispense_charge_queue"."resolved_by_name", ''))) > 0
          and "dispense_charge_queue"."resolved_at" is not null
          and length(btrim(coalesce("dispense_charge_queue"."resolution_reason", ''))) >= 5
          and length("dispense_charge_queue"."resolution_reason") <= 1000
        ))
);
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "source_dispense_charge_id" uuid;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_prescription_event_id_prescription_events_id_fk" FOREIGN KEY ("prescription_event_id") REFERENCES "public"."prescription_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_invoice_item_id_invoice_items_id_fk" FOREIGN KEY ("invoice_item_id") REFERENCES "public"."invoice_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_events_practice_id_uq" ON "prescription_events" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_practice_event_fk" FOREIGN KEY ("practice_id","prescription_event_id") REFERENCES "public"."prescription_events"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_practice_prescription_fk" FOREIGN KEY ("practice_id","prescription_id") REFERENCES "public"."prescriptions"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_practice_patient_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_practice_product_fk" FOREIGN KEY ("practice_id","product_id") REFERENCES "public"."products"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_practice_appointment_fk" FOREIGN KEY ("practice_id","appointment_id") REFERENCES "public"."appointments"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_queue" ADD CONSTRAINT "dispense_charge_queue_invoice_item_target_fk" FOREIGN KEY ("invoice_id","invoice_item_id") REFERENCES "public"."invoice_items"("invoice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispense_charge_queue_source_uq" ON "dispense_charge_queue" USING btree ("practice_id","prescription_event_id");--> statement-breakpoint
CREATE INDEX "dispense_charge_queue_pending_idx" ON "dispense_charge_queue" USING btree ("practice_id","created_at","id") WHERE "dispense_charge_queue"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "dispense_charge_queue_patient_idx" ON "dispense_charge_queue" USING btree ("practice_id","patient_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispense_charge_queue_invoice_item_uq" ON "dispense_charge_queue" USING btree ("invoice_item_id") WHERE "dispense_charge_queue"."invoice_item_id" is not null;--> statement-breakpoint
CREATE INDEX "invoice_items_source_dispense_charge_idx" ON "invoice_items" USING btree ("source_dispense_charge_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_items_source_dispense_charge_invoice_uq" ON "invoice_items" USING btree ("invoice_id","source_dispense_charge_id") WHERE "invoice_items"."source_dispense_charge_id" is not null and "invoice_items"."deleted_at" is null;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM prescription_events event
    JOIN invoice_items item
      ON item.source_prescription_id = event.prescription_id
     AND item.deleted_at IS NULL
    JOIN invoices invoice
      ON invoice.id = item.invoice_id
     AND invoice.deleted_at IS NULL
     AND invoice.status <> 'void'
     AND invoice.is_estimate = false
    WHERE event.event_type = 'created'
      AND event.product_id IS NOT NULL
      AND event.quantity > 0
    GROUP BY event.practice_id, event.id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'contradictory active prescription invoice lines require reconciliation before dispense charge migration';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM prescription_events event
    JOIN visit_work_items work
      ON work.practice_id = event.practice_id
     AND work.prescription_id = event.prescription_id
     AND work.deleted_at IS NULL
     AND work.status IN ('no_charge', 'voided')
    JOIN invoice_items item
      ON item.source_prescription_id = event.prescription_id
     AND item.deleted_at IS NULL
    JOIN invoices invoice
      ON invoice.id = item.invoice_id
     AND invoice.deleted_at IS NULL
     AND invoice.status <> 'void'
     AND invoice.is_estimate = false
    WHERE event.event_type = 'created'
      AND event.product_id IS NOT NULL
      AND event.quantity > 0
  ) THEN
    RAISE EXCEPTION 'contradictory prescription charge and no-charge decisions require reconciliation before dispense charge migration';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM prescription_events event
    JOIN invoice_items item
      ON item.source_prescription_id = event.prescription_id
     AND item.deleted_at IS NULL
    JOIN invoices invoice
      ON invoice.id = item.invoice_id
     AND invoice.practice_id = event.practice_id
     AND invoice.deleted_at IS NULL
     AND invoice.status <> 'void'
     AND invoice.is_estimate = false
    WHERE event.event_type = 'created'
      AND event.product_id IS NOT NULL
      AND event.quantity > 0
      AND (
        item.item_type <> 'product'
        OR item.item_id IS DISTINCT FROM event.product_id
        OR item.quantity IS DISTINCT FROM event.quantity
      )
  ) THEN
    RAISE EXCEPTION 'prescription invoice line does not match its dispense event';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM prescription_events event
    JOIN prescriptions prescription
      ON prescription.id = event.prescription_id
     AND prescription.practice_id = event.practice_id
    JOIN patients patient
      ON patient.id = event.patient_id
     AND patient.practice_id = event.practice_id
    JOIN invoice_items item
      ON item.source_prescription_id = event.prescription_id
     AND item.deleted_at IS NULL
    JOIN invoices invoice
      ON invoice.id = item.invoice_id
     AND invoice.practice_id = event.practice_id
     AND invoice.deleted_at IS NULL
     AND invoice.status <> 'void'
     AND invoice.is_estimate = false
    WHERE event.event_type = 'created'
      AND event.product_id IS NOT NULL
      AND event.quantity > 0
      AND (
        invoice.client_id IS DISTINCT FROM patient.client_id
        OR invoice.patient_id IS DISTINCT FROM event.patient_id
        OR invoice.appointment_id IS DISTINCT FROM prescription.appointment_id
      )
  ) THEN
    RAISE EXCEPTION 'prescription invoice target does not match its dispense patient and visit';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM prescription_events event
    JOIN visit_work_items work
      ON work.practice_id = event.practice_id
     AND work.prescription_id = event.prescription_id
     AND work.deleted_at IS NULL
     AND work.status = 'charged'
    LEFT JOIN invoice_items item
      ON item.id = work.invoice_item_id
     AND item.invoice_id = work.invoice_id
    LEFT JOIN invoices invoice
      ON invoice.id = work.invoice_id
     AND invoice.practice_id = event.practice_id
    WHERE event.event_type = 'created'
      AND event.product_id IS NOT NULL
      AND event.quantity > 0
      AND (
        item.id IS NULL
        OR item.deleted_at IS NOT NULL
        OR invoice.id IS NULL
        OR invoice.deleted_at IS NOT NULL
        OR invoice.status = 'void'
        OR invoice.is_estimate
        OR item.source_prescription_id IS DISTINCT FROM event.prescription_id
        OR item.item_type <> 'product'
        OR item.item_id IS DISTINCT FROM event.product_id
        OR item.quantity IS DISTINCT FROM event.quantity
      )
  ) THEN
    RAISE EXCEPTION 'charged prescription work does not match an active dispense invoice line';
  END IF;
END
$$;
--> statement-breakpoint
INSERT INTO dispense_charge_queue (
  practice_id,
  prescription_event_id,
  prescription_id,
  patient_id,
  client_id,
  appointment_id,
  product_id,
  quantity,
  description_snapshot,
  unit_price_snapshot,
  status,
  resolved_by,
  resolved_by_name,
  resolved_at,
  resolution_reason,
  legacy_review
)
SELECT
  event.practice_id,
  event.id,
  event.prescription_id,
  event.patient_id,
  patient.client_id,
  CASE WHEN event.event_type = 'created' THEN prescription.appointment_id ELSE NULL END,
  event.product_id,
  event.quantity,
  left(coalesce(active_line.description, product.name || ' — ' || prescription.medication_name), 500),
  coalesce(active_line.unit_price, product.unit_price),
  CASE
    WHEN active_line.id IS NOT NULL THEN 'pending'::dispense_charge_status
    WHEN work.status IN ('no_charge', 'voided') THEN 'waived'::dispense_charge_status
    ELSE 'pending'::dispense_charge_status
  END,
  CASE WHEN work.status IN ('no_charge', 'voided') THEN coalesce(work.resolved_by, event.actor_id) END,
  CASE WHEN work.status IN ('no_charge', 'voided') THEN coalesce(resolver.name, event.actor_name) END,
  CASE WHEN work.status IN ('no_charge', 'voided') THEN coalesce(work.resolved_at, event.created_at) END,
  CASE
    WHEN work.status = 'no_charge' THEN coalesce(nullif(btrim(work.no_charge_reason), ''), 'Legacy visit marked no charge.')
    WHEN work.status = 'voided' THEN coalesce(nullif(btrim(work.void_reason), ''), 'Legacy visit charge voided.')
  END,
  active_line.id IS NULL AND coalesce(work.status, 'unresolved') NOT IN ('no_charge', 'voided')
FROM prescription_events event
JOIN prescriptions prescription
  ON prescription.id = event.prescription_id
 AND prescription.practice_id = event.practice_id
JOIN patients patient
  ON patient.id = event.patient_id
 AND patient.practice_id = event.practice_id
JOIN products product
  ON product.id = event.product_id
 AND product.practice_id = event.practice_id
LEFT JOIN visit_work_items work
  ON work.practice_id = event.practice_id
 AND work.prescription_id = event.prescription_id
 AND work.deleted_at IS NULL
 AND event.event_type = 'created'
LEFT JOIN users resolver
  ON resolver.id = work.resolved_by
 AND resolver.practice_id = event.practice_id
LEFT JOIN LATERAL (
  SELECT item.id, item.invoice_id, item.description, item.unit_price
  FROM invoice_items item
  JOIN invoices invoice
    ON invoice.id = item.invoice_id
   AND invoice.practice_id = event.practice_id
   AND invoice.client_id = patient.client_id
   AND invoice.patient_id IS NOT DISTINCT FROM event.patient_id
   AND invoice.appointment_id IS NOT DISTINCT FROM prescription.appointment_id
   AND invoice.deleted_at IS NULL
   AND invoice.status <> 'void'
   AND invoice.is_estimate = false
  WHERE item.source_prescription_id = event.prescription_id
    AND item.deleted_at IS NULL
    AND event.event_type = 'created'
  ORDER BY item.created_at, item.id
  LIMIT 1
) active_line ON true
WHERE event.event_type IN ('created', 'refill_dispensed')
  AND event.product_id IS NOT NULL
  AND event.quantity > 0
ON CONFLICT (practice_id, prescription_event_id) DO NOTHING;
--> statement-breakpoint
UPDATE invoice_items item
SET source_dispense_charge_id = queue.id,
    source_prescription_id = NULL,
    updated_at = now()
FROM dispense_charge_queue queue
JOIN prescription_events event
  ON event.id = queue.prescription_event_id
 AND event.practice_id = queue.practice_id
JOIN invoices invoice
  ON invoice.practice_id = queue.practice_id
 AND invoice.client_id = queue.client_id
 AND invoice.patient_id IS NOT DISTINCT FROM queue.patient_id
 AND invoice.appointment_id IS NOT DISTINCT FROM queue.appointment_id
 AND invoice.deleted_at IS NULL
 AND invoice.status <> 'void'
 AND invoice.is_estimate = false
WHERE event.event_type = 'created'
  AND item.invoice_id = invoice.id
  AND item.source_prescription_id = queue.prescription_id
  AND item.deleted_at IS NULL;
--> statement-breakpoint
UPDATE dispense_charge_queue queue
SET status = 'invoiced',
    invoice_id = item.invoice_id,
    invoice_item_id = item.id,
    resolved_by = event.actor_id,
    resolved_by_name = event.actor_name,
    resolved_at = item.created_at,
    resolution_reason = NULL,
    legacy_review = false,
    updated_at = now()
FROM invoice_items item, prescription_events event
WHERE event.id = queue.prescription_event_id
  AND event.practice_id = queue.practice_id
  AND item.source_dispense_charge_id = queue.id
  AND item.deleted_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION validate_dispense_charge_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  source_event public.prescription_events%ROWTYPE;
  source_patient public.patients%ROWTYPE;
  source_appointment public.appointments%ROWTYPE;
BEGIN
  SELECT * INTO source_event
  FROM public.prescription_events
  WHERE id = NEW.prescription_event_id
    AND practice_id = NEW.practice_id;
  IF NOT FOUND
    OR source_event.event_type NOT IN ('created', 'refill_dispensed')
    OR source_event.prescription_id <> NEW.prescription_id
    OR source_event.patient_id <> NEW.patient_id
    OR source_event.product_id IS DISTINCT FROM NEW.product_id
    OR source_event.quantity IS DISTINCT FROM NEW.quantity
  THEN
    RAISE EXCEPTION 'invalid medication dispense charge source';
  END IF;

  SELECT * INTO source_patient
  FROM public.patients
  WHERE id = NEW.patient_id
    AND practice_id = NEW.practice_id;
  IF NOT FOUND OR source_patient.client_id <> NEW.client_id THEN
    RAISE EXCEPTION 'invalid medication dispense charge patient';
  END IF;

  IF NEW.appointment_id IS NOT NULL THEN
    SELECT * INTO source_appointment
    FROM public.appointments
    WHERE id = NEW.appointment_id
      AND practice_id = NEW.practice_id;
    IF NOT FOUND OR source_appointment.patient_id IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'invalid medication dispense charge appointment';
    END IF;
  END IF;
  IF NEW.resolved_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.users actor
    WHERE actor.id = NEW.resolved_by
      AND actor.practice_id = NEW.practice_id
  ) THEN
    RAISE EXCEPTION 'invalid medication dispense charge resolver';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER dispense_charge_queue_validate_source
  BEFORE INSERT ON public.dispense_charge_queue
  FOR EACH ROW EXECUTE FUNCTION validate_dispense_charge_source();
--> statement-breakpoint
CREATE FUNCTION validate_dispense_charge_invoice_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  source_queue public.dispense_charge_queue%ROWTYPE;
  target_invoice public.invoices%ROWTYPE;
BEGIN
  IF NEW.source_dispense_charge_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source_queue
  FROM public.dispense_charge_queue
  WHERE id = NEW.source_dispense_charge_id
  FOR UPDATE;
  SELECT * INTO target_invoice
  FROM public.invoices
  WHERE id = NEW.invoice_id;
  IF source_queue.id IS NULL
    OR target_invoice.id IS NULL
    OR source_queue.practice_id <> target_invoice.practice_id
    OR source_queue.client_id <> target_invoice.client_id
    OR source_queue.patient_id IS DISTINCT FROM target_invoice.patient_id
    OR source_queue.appointment_id IS DISTINCT FROM target_invoice.appointment_id
    OR target_invoice.deleted_at IS NOT NULL
    OR target_invoice.is_estimate
    OR target_invoice.status = 'void'
    OR NEW.item_type <> 'product'
    OR NEW.item_id IS DISTINCT FROM source_queue.product_id
    OR NEW.quantity <> source_queue.quantity
    OR NEW.unit_price <> source_queue.unit_price_snapshot
    OR NEW.description <> source_queue.description_snapshot
    OR source_queue.status = 'waived'
    OR (
      source_queue.status = 'invoiced'
      AND (
        source_queue.invoice_id <> NEW.invoice_id
        OR source_queue.invoice_item_id <> NEW.id
      )
    )
  THEN
    RAISE EXCEPTION 'invalid medication dispense invoice line';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_items_validate_dispense_charge
  BEFORE INSERT OR UPDATE OF source_dispense_charge_id, invoice_id, item_type, item_id, quantity, unit_price, description, deleted_at
  ON public.invoice_items
  FOR EACH ROW
  WHEN (NEW.source_dispense_charge_id IS NOT NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION validate_dispense_charge_invoice_line();
--> statement-breakpoint
CREATE FUNCTION protect_dispense_charge_queue()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  active_line_count integer;
BEGIN
  IF ROW(
    NEW.practice_id,
    NEW.prescription_event_id,
    NEW.prescription_id,
    NEW.patient_id,
    NEW.client_id,
    NEW.appointment_id,
    NEW.product_id,
    NEW.quantity,
    NEW.description_snapshot,
    NEW.unit_price_snapshot,
    NEW.legacy_review,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.practice_id,
    OLD.prescription_event_id,
    OLD.prescription_id,
    OLD.patient_id,
    OLD.client_id,
    OLD.appointment_id,
    OLD.product_id,
    OLD.quantity,
    OLD.description_snapshot,
    OLD.unit_price_snapshot,
    OLD.legacy_review,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'medication dispense charge snapshots are immutable';
  END IF;

  IF NEW.resolved_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.users actor
    WHERE actor.id = NEW.resolved_by
      AND actor.practice_id = NEW.practice_id
  ) THEN
    RAISE EXCEPTION 'invalid medication dispense charge resolver';
  END IF;

  SELECT count(*) INTO active_line_count
  FROM public.invoice_items item
  JOIN public.invoices invoice ON invoice.id = item.invoice_id
  WHERE item.source_dispense_charge_id = NEW.id
    AND item.deleted_at IS NULL
    AND invoice.deleted_at IS NULL
    AND invoice.status <> 'void'
    AND invoice.is_estimate = false;
  IF NEW.status = 'invoiced' THEN
    IF active_line_count <> 1 OR NOT EXISTS (
      SELECT 1
      FROM public.invoice_items item
      JOIN public.invoices invoice ON invoice.id = item.invoice_id
      WHERE item.id = NEW.invoice_item_id
        AND item.invoice_id = NEW.invoice_id
        AND item.source_dispense_charge_id = NEW.id
        AND item.deleted_at IS NULL
        AND invoice.deleted_at IS NULL
        AND invoice.status <> 'void'
        AND invoice.is_estimate = false
    ) THEN
      RAISE EXCEPTION 'invoiced medication dispense must identify its active invoice line';
    END IF;
  ELSIF active_line_count <> 0 THEN
    RAISE EXCEPTION 'pending or waived medication dispense cannot have an active invoice line';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER dispense_charge_queue_protect
  BEFORE UPDATE ON public.dispense_charge_queue
  FOR EACH ROW EXECUTE FUNCTION protect_dispense_charge_queue();
--> statement-breakpoint
CREATE FUNCTION reopen_dispense_charge_from_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.source_dispense_charge_id IS NOT NULL
    AND OLD.deleted_at IS NULL
    AND NEW.deleted_at IS NOT NULL
  THEN
    UPDATE public.dispense_charge_queue
    SET status = 'pending',
        invoice_id = NULL,
        invoice_item_id = NULL,
        resolved_by = NULL,
        resolved_by_name = NULL,
        resolved_at = NULL,
        resolution_reason = NULL,
        updated_at = now()
    WHERE id = OLD.source_dispense_charge_id
      AND status = 'invoiced'
      AND invoice_id = OLD.invoice_id
      AND invoice_item_id = OLD.id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_items_reopen_dispense_charge
  AFTER UPDATE OF deleted_at ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION reopen_dispense_charge_from_line();
--> statement-breakpoint
CREATE FUNCTION reopen_dispense_charges_from_void_invoice()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status <> 'void' AND NEW.status = 'void' THEN
    UPDATE public.dispense_charge_queue
    SET status = 'pending',
        invoice_id = NULL,
        invoice_item_id = NULL,
        resolved_by = NULL,
        resolved_by_name = NULL,
        resolved_at = NULL,
        resolution_reason = NULL,
        updated_at = now()
    WHERE practice_id = NEW.practice_id
      AND invoice_id = NEW.id
      AND status = 'invoiced';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_reopen_dispense_charges
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION reopen_dispense_charges_from_void_invoice();
--> statement-breakpoint
CREATE FUNCTION prevent_dispense_charge_delete()
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
        AND class.relname = 'dispense_charge_queue'
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'medication dispense charge history cannot be deleted';
END
$$;
--> statement-breakpoint
CREATE TRIGGER dispense_charge_queue_no_delete
  BEFORE DELETE ON public.dispense_charge_queue
  FOR EACH ROW EXECUTE FUNCTION prevent_dispense_charge_delete();
--> statement-breakpoint
ALTER TABLE dispense_charge_queue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON dispense_charge_queue
  USING (
    coalesce(current_setting('app.rls_bypass', true), '') = 'on'
    OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
  )
  WITH CHECK (
    coalesce(current_setting('app.rls_bypass', true), '') = 'on'
    OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON dispense_charge_queue FROM openpims_app;
    GRANT SELECT, INSERT, UPDATE ON dispense_charge_queue TO openpims_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON dispense_charge_queue FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON dispense_charge_queue FROM authenticated;
  END IF;
END
$$;
