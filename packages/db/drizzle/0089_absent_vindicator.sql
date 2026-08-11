CREATE TYPE "public"."subscription_checkout_source" AS ENUM('registration', 'in_app_pre_first_visit', 'in_app_post_first_visit', 'first_visit_email', 'trial_ending_email');--> statement-breakpoint
ALTER TABLE "stripe_events" DROP CONSTRAINT "stripe_events_conversion_evidence_shape_check";--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "checkout_source" "subscription_checkout_source";--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "checkout_source_evidence_id" varchar(128);--> statement-breakpoint
CREATE INDEX "stripe_events_checkout_source_idx" ON "stripe_events" USING btree ("checkout_source","practice_id","event_created_at","event_id") WHERE "stripe_events"."checkout_source" is not null;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_conversion_evidence_shape_check" CHECK ((
        "stripe_events"."evidence_kind" is null and
        "stripe_events"."event_created_at" is null and
        "stripe_events"."object_id" is null and
        "stripe_events"."checkout_source" is null and
        "stripe_events"."checkout_source_evidence_id" is null and
        "stripe_events"."amount_cents" is null and
        "stripe_events"."currency" is null
      ) or (
        "stripe_events"."evidence_kind" is not null and
        "stripe_events"."event_created_at" is not null and
        "stripe_events"."object_id" is not null and
        length(btrim("stripe_events"."object_id")) > 0 and
        (
          ("stripe_events"."evidence_kind" = 'subscription_checkout_completed' and
            "stripe_events"."amount_cents" is null and "stripe_events"."currency" is null and
            (
              ("stripe_events"."checkout_source" is null and
                "stripe_events"."checkout_source_evidence_id" is null) or
              ("stripe_events"."checkout_source" is not null and
                "stripe_events"."checkout_source_evidence_id" is not null and
                length(btrim("stripe_events"."checkout_source_evidence_id")) > 0)
            )) or
          ("stripe_events"."evidence_kind" = 'positive_subscription_invoice_paid' and
            "stripe_events"."amount_cents" is not null and "stripe_events"."amount_cents" > 0 and
            "stripe_events"."currency" is not null and
            "stripe_events"."checkout_source" is null and
            "stripe_events"."checkout_source_evidence_id" is null and
            "stripe_events"."currency" ~ '^[a-z]{3}$')
        )
      ));