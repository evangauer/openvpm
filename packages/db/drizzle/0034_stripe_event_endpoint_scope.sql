ALTER TABLE "stripe_events" DROP CONSTRAINT "stripe_events_pkey";--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_event_id_endpoint_pk" PRIMARY KEY("event_id","endpoint");
