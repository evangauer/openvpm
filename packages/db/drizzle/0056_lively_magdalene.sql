CREATE TYPE "public"."stripe_conversion_evidence_kind" AS ENUM('subscription_checkout_completed', 'positive_subscription_invoice_paid');--> statement-breakpoint
CREATE TYPE "public"."conversion_evidence_source" AS ENUM('practice_created', 'product_records', 'stripe_webhook');--> statement-breakpoint
CREATE TYPE "public"."practice_conversion_milestone" AS ENUM('registered', 'activated', 'payment_method_collected', 'first_positive_payment');--> statement-breakpoint
CREATE TABLE "practice_conversion_milestones" (
	"practice_id" uuid NOT NULL,
	"milestone" "practice_conversion_milestone" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_source" "conversion_evidence_source" NOT NULL,
	"evidence_key" varchar(255) NOT NULL,
	"amount_cents" integer,
	"currency" varchar(3),
	CONSTRAINT "practice_conversion_milestones_practice_id_milestone_pk" PRIMARY KEY("practice_id","milestone"),
	CONSTRAINT "practice_conversion_milestones_payment_shape_check" CHECK ((
        "practice_conversion_milestones"."milestone" = 'first_positive_payment'
        and "practice_conversion_milestones"."amount_cents" is not null
        and "practice_conversion_milestones"."amount_cents" > 0
        and "practice_conversion_milestones"."currency" is not null
        and "practice_conversion_milestones"."currency" ~ '^[a-z]{3}$'
      ) or (
        "practice_conversion_milestones"."milestone" <> 'first_positive_payment'
        and "practice_conversion_milestones"."amount_cents" is null
        and "practice_conversion_milestones"."currency" is null
      )),
	CONSTRAINT "practice_conversion_milestones_evidence_source_check" CHECK ((
        "practice_conversion_milestones"."milestone" = 'registered'
        and "practice_conversion_milestones"."evidence_source" = 'practice_created'
        and "practice_conversion_milestones"."evidence_key" like 'practice:%'
      ) or (
        "practice_conversion_milestones"."milestone" = 'activated'
        and "practice_conversion_milestones"."evidence_source" = 'product_records'
        and "practice_conversion_milestones"."evidence_key" like 'client:%|appointment:%'
      ) or (
        "practice_conversion_milestones"."milestone" in (
          'payment_method_collected', 'first_positive_payment'
        )
        and "practice_conversion_milestones"."evidence_source" = 'stripe_webhook'
        and "practice_conversion_milestones"."evidence_key" like 'stripe:%'
      ))
);
--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "event_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "practice_id" uuid;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "object_id" varchar(128);--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "evidence_kind" "stripe_conversion_evidence_kind";--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "amount_cents" integer;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "currency" varchar(3);--> statement-breakpoint
ALTER TABLE "practice_conversion_milestones" ADD CONSTRAINT "practice_conversion_milestones_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "practice_conversion_milestones_evidence_uq" ON "practice_conversion_milestones" USING btree ("evidence_source","evidence_key","milestone");--> statement-breakpoint
CREATE INDEX "practice_conversion_milestones_stage_time_idx" ON "practice_conversion_milestones" USING btree ("milestone","occurred_at","practice_id");--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clients_conversion_created_idx" ON "clients" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE INDEX "appointments_conversion_created_idx" ON "appointments" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE INDEX "stripe_events_conversion_evidence_idx" ON "stripe_events" USING btree ("evidence_kind","practice_id","event_created_at","event_id") WHERE "stripe_events"."evidence_kind" is not null;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_conversion_evidence_shape_check" CHECK ((
        "stripe_events"."evidence_kind" is null and
        "stripe_events"."event_created_at" is null and
        "stripe_events"."object_id" is null and
        "stripe_events"."amount_cents" is null and
        "stripe_events"."currency" is null
      ) or (
        "stripe_events"."evidence_kind" is not null and
        "stripe_events"."event_created_at" is not null and
        "stripe_events"."object_id" is not null and
        length(btrim("stripe_events"."object_id")) > 0 and
        (
          ("stripe_events"."evidence_kind" = 'subscription_checkout_completed' and
            "stripe_events"."amount_cents" is null and "stripe_events"."currency" is null) or
          ("stripe_events"."evidence_kind" = 'positive_subscription_invoice_paid' and
            "stripe_events"."amount_cents" is not null and "stripe_events"."amount_cents" > 0 and
            "stripe_events"."currency" is not null and
            "stripe_events"."currency" ~ '^[a-z]{3}$')
        )
      ));--> statement-breakpoint
-- Exact local backfill only. Registration comes from the immutable practice
-- creation timestamp; no legacy funnel timestamp is consulted.
INSERT INTO practice_conversion_milestones (
  practice_id, milestone, occurred_at, evidence_source, evidence_key
)
SELECT
  p.id,
  'registered'::practice_conversion_milestone,
  p.created_at,
  'practice_created'::conversion_evidence_source,
  'practice:' || p.id::text
FROM practices p
WHERE p.deleted_at IS NULL
ON CONFLICT (practice_id, milestone) DO NOTHING;--> statement-breakpoint
-- Activation is the later of the earliest real client and earliest real
-- appointment. Seeded demo ids are explicitly excluded. Later soft-deletion
-- does not erase the historical product action.
WITH activation_evidence AS (
  SELECT
    p.id AS practice_id,
    greatest(p.created_at, c.created_at, a.created_at) AS occurred_at,
    'client:' || c.id::text || '|appointment:' || a.id::text AS evidence_key
  FROM practices p
  JOIN LATERAL (
    SELECT c.id, c.created_at
    FROM clients c
    WHERE c.practice_id = p.id
      AND NOT (
        coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb)
          @> to_jsonb(c.id::text)
      )
    ORDER BY c.created_at, c.id
    LIMIT 1
  ) c ON true
  JOIN LATERAL (
    SELECT a.id, a.created_at
    FROM appointments a
    WHERE a.practice_id = p.id
      AND NOT (
        coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
          @> to_jsonb(a.id::text)
      )
    ORDER BY a.created_at, a.id
    LIMIT 1
  ) a ON true
  WHERE p.deleted_at IS NULL
)
INSERT INTO practice_conversion_milestones (
  practice_id, milestone, occurred_at, evidence_source, evidence_key
)
SELECT
  practice_id,
  'activated'::practice_conversion_milestone,
  occurred_at,
  'product_records'::conversion_evidence_source,
  evidence_key
FROM activation_evidence
ON CONFLICT (practice_id, milestone) DO NOTHING;--> statement-breakpoint
-- Legacy card/paid funnel rows and billing updated_at/status values are
-- deliberately quarantined: none proves an exact payment occurrence. New
-- signed Stripe evidence is recorded prospectively and repaired by local cron.
ALTER TABLE practice_conversion_milestones ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS system_only ON practice_conversion_milestones;--> statement-breakpoint
CREATE POLICY system_only ON practice_conversion_milestones
  USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
  WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');--> statement-breakpoint
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS system_only ON stripe_events;--> statement-breakpoint
CREATE POLICY system_only ON stripe_events
  USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
  WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON practice_conversion_milestones TO openpims_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON practice_conversion_milestones, stripe_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON practice_conversion_milestones, stripe_events
      FROM authenticated;
  END IF;
END
$$;
