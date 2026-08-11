CREATE TYPE "public"."dispense_charge_event_type" AS ENUM('created', 'invoiced', 'waived', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."dispense_charge_transition_source" AS ENUM('prescription_dispense', 'invoice_create', 'invoice_edit', 'medication_queue', 'visit_reconciliation', 'invoice_void', 'invoice_line_removed', 'legacy_backfill', 'database_safeguard');--> statement-breakpoint
CREATE TABLE "dispense_charge_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"dispense_charge_id" uuid NOT NULL,
	"prescription_event_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	"event_type" "dispense_charge_event_type" NOT NULL,
	"transition_source" "dispense_charge_transition_source" NOT NULL,
	"status_before" "dispense_charge_status",
	"status_after" "dispense_charge_status" NOT NULL,
	"invoice_id" uuid,
	"invoice_item_id" uuid,
	"actor_id" uuid,
	"actor_name" varchar(255) NOT NULL,
	"reason" text,
	CONSTRAINT "dispense_charge_events_shape_check" CHECK (length(btrim("dispense_charge_events"."actor_name")) > 0
        and ("dispense_charge_events"."reason" is null or length("dispense_charge_events"."reason") <= 1000)
        and (
          "dispense_charge_events"."event_type" = 'created'
          and "dispense_charge_events"."status_before" is null
          and "dispense_charge_events"."status_after" = 'pending'
          and "dispense_charge_events"."invoice_id" is null
          and "dispense_charge_events"."invoice_item_id" is null
          and "dispense_charge_events"."reason" is null
        or "dispense_charge_events"."event_type" = 'invoiced'
          and "dispense_charge_events"."status_before" = 'pending'
          and "dispense_charge_events"."status_after" = 'invoiced'
          and "dispense_charge_events"."invoice_id" is not null
          and "dispense_charge_events"."invoice_item_id" is not null
          and "dispense_charge_events"."reason" is null
        or "dispense_charge_events"."event_type" = 'waived'
          and "dispense_charge_events"."status_before" = 'pending'
          and "dispense_charge_events"."status_after" = 'waived'
          and "dispense_charge_events"."invoice_id" is null
          and "dispense_charge_events"."invoice_item_id" is null
          and length(btrim(coalesce("dispense_charge_events"."reason", ''))) >= 5
        or "dispense_charge_events"."event_type" = 'reopened'
          and "dispense_charge_events"."status_before" in ('invoiced', 'waived')
          and "dispense_charge_events"."status_after" = 'pending'
          and (
            "dispense_charge_events"."status_before" = 'invoiced'
            and "dispense_charge_events"."invoice_id" is not null
            and "dispense_charge_events"."invoice_item_id" is not null
          or "dispense_charge_events"."status_before" = 'waived'
            and "dispense_charge_events"."invoice_id" is null
            and "dispense_charge_events"."invoice_item_id" is null
          )
          and length(btrim(coalesce("dispense_charge_events"."reason", ''))) >= 5
        ))
);
--> statement-breakpoint
ALTER TABLE "dispense_charge_events" ADD CONSTRAINT "dispense_charge_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_events" ADD CONSTRAINT "dispense_charge_events_dispense_charge_id_dispense_charge_queue_id_fk" FOREIGN KEY ("dispense_charge_id") REFERENCES "public"."dispense_charge_queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_events" ADD CONSTRAINT "dispense_charge_events_prescription_event_id_prescription_events_id_fk" FOREIGN KEY ("prescription_event_id") REFERENCES "public"."prescription_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_charge_events" ADD CONSTRAINT "dispense_charge_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispense_charge_events_charge_history_idx" ON "dispense_charge_events" USING btree ("practice_id","dispense_charge_id","created_at","id");--> statement-breakpoint
CREATE INDEX "dispense_charge_events_practice_time_idx" ON "dispense_charge_events" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispense_charge_events_charge_sequence_uq" ON "dispense_charge_events" USING btree ("practice_id","dispense_charge_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "dispense_charge_events_practice_charge_operation_uq" ON "dispense_charge_events" USING btree ("practice_id","dispense_charge_id","operation_id","event_type");
--> statement-breakpoint
-- Seed the immutable history from the durable queue before installing the
-- transition trigger. Pre-ledger rows are explicitly labeled as backfill
-- evidence rather than pretending we know their original transition time.
INSERT INTO public.dispense_charge_events (
  created_at,
  practice_id,
  dispense_charge_id,
  prescription_event_id,
  sequence,
  operation_id,
  event_type,
  transition_source,
  status_before,
  status_after,
  invoice_id,
  invoice_item_id,
  actor_id,
  actor_name,
  reason
)
SELECT
  queue.created_at,
  queue.practice_id,
  queue.id,
  queue.prescription_event_id,
  1,
  coalesce(event.operation_id, event.id),
  'created'::public.dispense_charge_event_type,
  'legacy_backfill'::public.dispense_charge_transition_source,
  null,
  'pending'::public.dispense_charge_status,
  null,
  null,
  event.actor_id,
  event.actor_name,
  null
FROM public.dispense_charge_queue queue
JOIN public.prescription_events event
  ON event.id = queue.prescription_event_id
 AND event.practice_id = queue.practice_id;

INSERT INTO public.dispense_charge_events (
  created_at,
  practice_id,
  dispense_charge_id,
  prescription_event_id,
  sequence,
  operation_id,
  event_type,
  transition_source,
  status_before,
  status_after,
  invoice_id,
  invoice_item_id,
  actor_id,
  actor_name,
  reason
)
SELECT
  coalesce(queue.resolved_at, queue.updated_at, queue.created_at),
  queue.practice_id,
  queue.id,
  queue.prescription_event_id,
  2,
  gen_random_uuid(),
  CASE queue.status
    WHEN 'invoiced' THEN 'invoiced'::public.dispense_charge_event_type
    WHEN 'waived' THEN 'waived'::public.dispense_charge_event_type
  END,
  'legacy_backfill'::public.dispense_charge_transition_source,
  'pending'::public.dispense_charge_status,
  queue.status,
  queue.invoice_id,
  queue.invoice_item_id,
  resolver.id,
  queue.resolved_by_name,
  queue.resolution_reason
FROM public.dispense_charge_queue queue
LEFT JOIN public.users resolver
  ON resolver.id = queue.resolved_by
 AND resolver.practice_id = queue.practice_id
WHERE queue.status IN ('invoiced', 'waived');
--> statement-breakpoint
CREATE FUNCTION public.record_dispense_charge_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  prescription_event public.prescription_events%ROWTYPE;
  event_type public.dispense_charge_event_type;
  transition_source public.dispense_charge_transition_source;
  operation_id uuid;
  actor_id uuid;
  actor_name text;
  reason text;
  snapshot_invoice_id uuid;
  snapshot_invoice_item_id uuid;
  configured_source text;
  event_sequence integer;
BEGIN
  IF coalesce(
    pg_catalog.current_setting('app.dispense_charge_restore', true),
    ''
  ) = 'on' THEN
    IF nullif(
      pg_catalog.current_setting('app.dispense_charge_restore_practice_id', true),
      ''
    )::uuid IS DISTINCT FROM NEW.practice_id
      OR NOT EXISTS (
        SELECT 1
        FROM public.practices practice
        WHERE practice.id = NEW.practice_id
          AND practice.recovery_hold = true
          AND practice.deleted_at IS NULL
      ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Medication charge restore bypass requires the exact held practice.';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT *
    INTO prescription_event
    FROM public.prescription_events
    WHERE id = NEW.prescription_event_id
      AND practice_id = NEW.practice_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'Medication charge source event is unavailable.';
    END IF;

    INSERT INTO public.dispense_charge_events (
      created_at,
      practice_id,
      dispense_charge_id,
      prescription_event_id,
      sequence,
      operation_id,
      event_type,
      transition_source,
      status_before,
      status_after,
      actor_id,
      actor_name
    ) VALUES (
      clock_timestamp(),
      NEW.practice_id,
      NEW.id,
      NEW.prescription_event_id,
      1,
      coalesce(prescription_event.operation_id, prescription_event.id),
      'created',
      'prescription_dispense',
      null,
      'pending',
      prescription_event.actor_id,
      prescription_event.actor_name
    );

    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  configured_source := nullif(
    pg_catalog.current_setting('app.dispense_charge_transition_source', true),
    ''
  );
  operation_id := coalesce(
    nullif(
      pg_catalog.current_setting('app.dispense_charge_operation_id', true),
      ''
    )::uuid,
    gen_random_uuid()
  );
  actor_id := nullif(
    pg_catalog.current_setting('app.dispense_charge_actor_id', true),
    ''
  )::uuid;
  actor_name := nullif(
    pg_catalog.current_setting('app.dispense_charge_actor_name', true),
    ''
  );
  reason := nullif(
    pg_catalog.current_setting('app.dispense_charge_reason', true),
    ''
  );

  IF OLD.status = 'pending' AND NEW.status = 'invoiced' THEN
    event_type := 'invoiced';
    transition_source := coalesce(
      configured_source::public.dispense_charge_transition_source,
      'invoice_edit'
    );
    actor_id := coalesce(actor_id, NEW.resolved_by);
    actor_name := coalesce(actor_name, NEW.resolved_by_name);
    reason := null;
    snapshot_invoice_id := NEW.invoice_id;
    snapshot_invoice_item_id := NEW.invoice_item_id;
  ELSIF OLD.status = 'pending' AND NEW.status = 'waived' THEN
    event_type := 'waived';
    transition_source := coalesce(
      configured_source::public.dispense_charge_transition_source,
      'medication_queue'
    );
    actor_id := coalesce(actor_id, NEW.resolved_by);
    actor_name := coalesce(actor_name, NEW.resolved_by_name);
    reason := NEW.resolution_reason;
  ELSIF OLD.status IN ('invoiced', 'waived') AND NEW.status = 'pending' THEN
    event_type := 'reopened';
    transition_source := coalesce(
      configured_source::public.dispense_charge_transition_source,
      CASE
        WHEN OLD.invoice_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM public.invoices invoice
           WHERE invoice.id = OLD.invoice_id
             AND invoice.practice_id = OLD.practice_id
             AND invoice.status = 'void'
         ) THEN 'invoice_void'::public.dispense_charge_transition_source
        WHEN OLD.invoice_item_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM public.invoice_items item
           WHERE item.id = OLD.invoice_item_id
             AND item.invoice_id = OLD.invoice_id
             AND item.deleted_at IS NOT NULL
         ) THEN 'invoice_line_removed'::public.dispense_charge_transition_source
        ELSE 'database_safeguard'::public.dispense_charge_transition_source
      END
    );
    actor_name := coalesce(actor_name, 'System safeguard');
    reason := coalesce(
      reason,
      CASE transition_source
        WHEN 'invoice_void' THEN 'Invoice was voided; medication charge returned to pending review.'
        WHEN 'invoice_line_removed' THEN 'Invoice line was removed; medication charge returned to pending review.'
        ELSE 'Medication charge was reopened for explicit review.'
      END
    );
    snapshot_invoice_id := OLD.invoice_id;
    snapshot_invoice_item_id := OLD.invoice_item_id;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Medication charge transition cannot be represented in its immutable ledger.';
  END IF;

  IF actor_name IS NULL OR length(btrim(actor_name)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Medication charge transition requires actor attribution.';
  END IF;

  SELECT coalesce(max(existing.sequence), 0) + 1
  INTO event_sequence
  FROM public.dispense_charge_events existing
  WHERE existing.practice_id = NEW.practice_id
    AND existing.dispense_charge_id = NEW.id;

  INSERT INTO public.dispense_charge_events (
    created_at,
    practice_id,
    dispense_charge_id,
    prescription_event_id,
    sequence,
    operation_id,
    event_type,
    transition_source,
    status_before,
    status_after,
    invoice_id,
    invoice_item_id,
    actor_id,
    actor_name,
    reason
  ) VALUES (
    clock_timestamp(),
    NEW.practice_id,
    NEW.id,
    NEW.prescription_event_id,
    event_sequence,
    operation_id,
    event_type,
    transition_source,
    OLD.status,
    NEW.status,
    snapshot_invoice_id,
    snapshot_invoice_item_id,
    actor_id,
    actor_name,
    reason
  );

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_dispense_charge_event() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER dispense_charge_queue_record_event
AFTER INSERT OR UPDATE OF status ON public.dispense_charge_queue
FOR EACH ROW EXECUTE FUNCTION public.record_dispense_charge_event();
--> statement-breakpoint
CREATE FUNCTION public.protect_dispense_charge_events()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF coalesce(pg_catalog.current_setting('app.ledger_maintenance', true), '') = 'on'
    AND current_user = (
      SELECT pg_catalog.pg_get_userbyid(class.relowner)
      FROM pg_catalog.pg_class class
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = TG_TABLE_SCHEMA
        AND class.relname = TG_TABLE_NAME
    )
  THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Medication charge transition evidence is immutable.';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER dispense_charge_events_immutable
BEFORE UPDATE OR DELETE ON public.dispense_charge_events
FOR EACH ROW EXECUTE FUNCTION public.protect_dispense_charge_events();
--> statement-breakpoint
ALTER TABLE public.dispense_charge_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dispense_charge_events
  FOR SELECT
  USING (
    coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on'
    OR practice_id = nullif(
      pg_catalog.current_setting('app.current_practice_id', true),
      ''
    )::uuid
  );
--> statement-breakpoint
REVOKE ALL ON public.dispense_charge_events FROM PUBLIC;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON public.dispense_charge_events FROM openpims_app;
    GRANT SELECT ON public.dispense_charge_events TO openpims_app;
  END IF;
END
$grant$;
