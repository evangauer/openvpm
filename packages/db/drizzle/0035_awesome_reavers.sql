CREATE TABLE "funnel_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"event_name" varchar(64) NOT NULL,
	"anonymous_id" varchar(64),
	"practice_id" uuid,
	"source" varchar(80),
	"path" varchar(500),
	"origin" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funnel_events_event_time_idx" ON "funnel_events" USING btree ("event_name","created_at");--> statement-breakpoint
CREATE INDEX "funnel_events_anonymous_time_idx" ON "funnel_events" USING btree ("anonymous_id","created_at");--> statement-breakpoint
CREATE INDEX "funnel_events_practice_time_idx" ON "funnel_events" USING btree ("practice_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_events_practice_stage_uq" ON "funnel_events" USING btree ("practice_id","event_name") WHERE "funnel_events"."practice_id" is not null and "funnel_events"."event_name" in ('registration', 'activation', 'card_added', 'paid');--> statement-breakpoint

-- Backfill the authoritative server-owned stages so the cohort report starts
-- useful on deploy. Browser traffic events intentionally begin at deploy time.
INSERT INTO "funnel_events" ("event_name", "anonymous_id", "practice_id", "source", "metadata", "created_at", "updated_at")
SELECT
  'registration',
  CASE
    WHEN p.settings -> 'acquisition' ->> 'funnelId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN p.settings -> 'acquisition' ->> 'funnelId'
    ELSE NULL
  END,
  p.id,
  p.settings -> 'acquisition' ->> 'source',
  '{"backfilled":true}'::jsonb,
  p.created_at,
  p.created_at
FROM practices p
WHERE p.deleted_at IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "funnel_events" ("event_name", "anonymous_id", "practice_id", "source", "metadata", "created_at", "updated_at")
SELECT
  'activation',
  CASE
    WHEN p.settings -> 'acquisition' ->> 'funnelId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN p.settings -> 'acquisition' ->> 'funnelId'
    ELSE NULL
  END,
  p.id,
  p.settings -> 'acquisition' ->> 'source',
  '{"backfilled":true}'::jsonb,
  greatest(
    p.created_at,
    (select min(c.created_at) from clients c where c.practice_id = p.id and c.deleted_at is null and not (coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb) @> to_jsonb(c.id::text))),
    (select min(a.created_at) from appointments a where a.practice_id = p.id and a.deleted_at is null and not (coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb) @> to_jsonb(a.id::text)))
  ),
  now()
FROM practices p
WHERE p.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM clients c
    WHERE c.practice_id = p.id
      AND c.deleted_at IS NULL
      AND NOT (coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb) @> to_jsonb(c.id::text))
  )
  AND EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.practice_id = p.id
      AND a.deleted_at IS NULL
      AND NOT (coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb) @> to_jsonb(a.id::text))
  )
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "funnel_events" ("event_name", "anonymous_id", "practice_id", "source", "metadata", "created_at", "updated_at")
SELECT
  'card_added',
  CASE
    WHEN p.settings -> 'acquisition' ->> 'funnelId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN p.settings -> 'acquisition' ->> 'funnelId'
    ELSE NULL
  END,
  p.id,
  p.settings -> 'acquisition' ->> 'source',
  '{"backfilled":true}'::jsonb,
  coalesce(p.updated_at, p.created_at),
  now()
FROM practices p
WHERE p.deleted_at IS NULL
  AND p.stripe_subscription_id IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "funnel_events" ("event_name", "anonymous_id", "practice_id", "source", "metadata", "created_at", "updated_at")
SELECT
  'paid',
  CASE
    WHEN p.settings -> 'acquisition' ->> 'funnelId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN p.settings -> 'acquisition' ->> 'funnelId'
    ELSE NULL
  END,
  p.id,
  p.settings -> 'acquisition' ->> 'source',
  '{"backfilled":true}'::jsonb,
  coalesce(p.updated_at, p.created_at),
  now()
FROM practices p
WHERE p.deleted_at IS NULL
  AND p.billing_status = 'active'
ON CONFLICT DO NOTHING;
