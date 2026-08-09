CREATE TYPE "public"."sms_delivery_classification" AS ENUM('unknown', 'sent', 'failed', 'delivered');--> statement-breakpoint
CREATE TYPE "public"."sms_delivery_history_kind" AS ENUM('automatic', 'operator_reconciliation');--> statement-breakpoint
CREATE TYPE "public"."sms_delivery_history_result" AS ENUM('unmatched', 'ambiguous', 'attributed', 'projected', 'projection_miss', 'reconciled', 'operator_reviewed');--> statement-breakpoint
CREATE TYPE "public"."sms_delivery_reconciliation_reason" AS ENUM('exact_attribution_retry', 'provider_portal_status_review', 'projection_repair', 'identity_conflict_review', 'unmatched_evidence_review');--> statement-breakpoint
CREATE TABLE "sms_delivery_event_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivery_event_id" uuid NOT NULL,
	"reviewed_history_id" uuid,
	"practice_id" uuid,
	"attempt_id" uuid,
	"communication_id" uuid,
	"kind" "sms_delivery_history_kind" NOT NULL,
	"result" "sms_delivery_history_result" NOT NULL,
	"classification" "sms_delivery_classification" NOT NULL,
	"detail" text,
	"operator_reason_code" "sms_delivery_reconciliation_reason",
	"actor_type" "sms_send_actor_type",
	"actor_user_id" uuid,
	"actor_identity" varchar(255),
	"actor_name" varchar(255),
	"event_key" varchar(255) NOT NULL,
	CONSTRAINT "sms_delivery_event_history_event_key_check" CHECK (length(btrim("sms_delivery_event_history"."event_key")) between 1 and 255),
	CONSTRAINT "sms_delivery_event_history_detail_check" CHECK ("sms_delivery_event_history"."detail" is null or length("sms_delivery_event_history"."detail") <= 2000),
	CONSTRAINT "sms_delivery_event_history_target_shape_check" CHECK ((
          "sms_delivery_event_history"."result" in ('unmatched', 'ambiguous', 'operator_reviewed')
          and "sms_delivery_event_history"."practice_id" is null
          and "sms_delivery_event_history"."attempt_id" is null
          and "sms_delivery_event_history"."communication_id" is null
          and (
            ("sms_delivery_event_history"."result" = 'operator_reviewed' and "sms_delivery_event_history"."reviewed_history_id" is not null)
            or ("sms_delivery_event_history"."result" in ('unmatched', 'ambiguous') and "sms_delivery_event_history"."reviewed_history_id" is null)
          )
        ) or (
          "sms_delivery_event_history"."result" in ('attributed', 'projection_miss', 'reconciled')
          and "sms_delivery_event_history"."practice_id" is not null
          and "sms_delivery_event_history"."attempt_id" is not null
          and "sms_delivery_event_history"."reviewed_history_id" is null
        ) or (
          "sms_delivery_event_history"."result" = 'projected'
          and "sms_delivery_event_history"."practice_id" is not null
          and "sms_delivery_event_history"."attempt_id" is not null
          and "sms_delivery_event_history"."communication_id" is not null
          and "sms_delivery_event_history"."reviewed_history_id" is null
        )),
	CONSTRAINT "sms_delivery_event_history_actor_shape_check" CHECK ((
          "sms_delivery_event_history"."kind" = 'automatic'
          and "sms_delivery_event_history"."result" in (
            'unmatched',
            'ambiguous',
            'attributed',
            'projected',
            'projection_miss'
          )
          and "sms_delivery_event_history"."actor_type" is null
          and "sms_delivery_event_history"."actor_user_id" is null
          and "sms_delivery_event_history"."actor_identity" is null
          and "sms_delivery_event_history"."actor_name" is null
          and "sms_delivery_event_history"."operator_reason_code" is null
        ) or (
          "sms_delivery_event_history"."kind" = 'operator_reconciliation'
          and (
            (
              "sms_delivery_event_history"."result" = 'reconciled'
              and "sms_delivery_event_history"."operator_reason_code" in (
                'exact_attribution_retry',
                'provider_portal_status_review',
                'projection_repair'
              )
            )
            or (
              "sms_delivery_event_history"."result" = 'operator_reviewed'
              and "sms_delivery_event_history"."operator_reason_code" in (
                'identity_conflict_review',
                'unmatched_evidence_review'
              )
            )
          )
          and "sms_delivery_event_history"."actor_type" = 'platform_operator'
          and "sms_delivery_event_history"."actor_user_id" is null
          and length(btrim(coalesce("sms_delivery_event_history"."actor_identity", ''))) between 1 and 255
          and length(btrim(coalesce("sms_delivery_event_history"."actor_name", ''))) between 1 and 255
        ))
);
--> statement-breakpoint
CREATE TABLE "sms_delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" varchar(16) NOT NULL,
	"provider_event_id" varchar(255),
	"provider_message_id" varchar(255),
	"provider_event_type" varchar(80) NOT NULL,
	"provider_status" varchar(80),
	"provider_error_code" varchar(80),
	"classification" "sms_delivery_classification" NOT NULL,
	"occurred_at" timestamp with time zone,
	"event_key" varchar(255) NOT NULL,
	"payload_fingerprint_sha256" varchar(64) NOT NULL,
	CONSTRAINT "sms_delivery_events_provider_check" CHECK ("sms_delivery_events"."provider" in ('telnyx', 'twilio')),
	CONSTRAINT "sms_delivery_events_event_type_check" CHECK (length(btrim("sms_delivery_events"."provider_event_type")) between 1 and 80),
	CONSTRAINT "sms_delivery_events_event_key_check" CHECK (length(btrim("sms_delivery_events"."event_key")) between 1 and 255),
	CONSTRAINT "sms_delivery_events_fingerprint_check" CHECK ("sms_delivery_events"."payload_fingerprint_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sms_delivery_events_provider_event_id_check" CHECK ("sms_delivery_events"."provider_event_id" is null or length(btrim("sms_delivery_events"."provider_event_id")) between 1 and 255),
	CONSTRAINT "sms_delivery_events_provider_message_id_check" CHECK ("sms_delivery_events"."provider_message_id" is null or length(btrim("sms_delivery_events"."provider_message_id")) between 1 and 255),
	CONSTRAINT "sms_delivery_events_provider_status_check" CHECK ("sms_delivery_events"."provider_status" is null or length(btrim("sms_delivery_events"."provider_status")) between 1 and 80),
	CONSTRAINT "sms_delivery_events_provider_error_code_check" CHECK ("sms_delivery_events"."provider_error_code" is null or length(btrim("sms_delivery_events"."provider_error_code")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "sms_delivery_event_history" ADD CONSTRAINT "sms_delivery_event_history_delivery_event_id_sms_delivery_events_id_fk" FOREIGN KEY ("delivery_event_id") REFERENCES "public"."sms_delivery_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_delivery_event_history" ADD CONSTRAINT "sms_delivery_event_history_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_delivery_event_history" ADD CONSTRAINT "sms_delivery_event_history_communication_id_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."communications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_delivery_event_history" ADD CONSTRAINT "sms_delivery_event_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_delivery_event_history" ADD CONSTRAINT "sms_delivery_event_history_attempt_tenant_fk" FOREIGN KEY ("practice_id","attempt_id") REFERENCES "public"."sms_send_attempts"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_delivery_event_history" ADD CONSTRAINT "sms_delivery_event_history_communication_tenant_fk" FOREIGN KEY ("practice_id","communication_id") REFERENCES "public"."communications"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_delivery_event_history" ADD CONSTRAINT "sms_delivery_event_history_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_delivery_event_history_event_id_uq" ON "sms_delivery_event_history" USING btree ("delivery_event_id","id");--> statement-breakpoint
ALTER TABLE "sms_delivery_event_history" ADD CONSTRAINT "sms_delivery_event_history_reviewed_history_fk" FOREIGN KEY ("delivery_event_id","reviewed_history_id") REFERENCES "public"."sms_delivery_event_history"("delivery_event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_delivery_event_history_event_key_uq" ON "sms_delivery_event_history" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "sms_delivery_event_history_event_idx" ON "sms_delivery_event_history" USING btree ("delivery_event_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_delivery_event_history_attribution_uq" ON "sms_delivery_event_history" USING btree ("delivery_event_id") WHERE "sms_delivery_event_history"."result" = 'attributed';--> statement-breakpoint
CREATE UNIQUE INDEX "sms_delivery_event_history_reviewed_history_uq" ON "sms_delivery_event_history" USING btree ("reviewed_history_id") WHERE "sms_delivery_event_history"."reviewed_history_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_delivery_event_history_practice_queue_idx" ON "sms_delivery_event_history" USING btree ("practice_id","result","created_at","id");--> statement-breakpoint
CREATE INDEX "sms_delivery_event_history_attempt_idx" ON "sms_delivery_event_history" USING btree ("practice_id","attempt_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_delivery_events_provider_event_key_uq" ON "sms_delivery_events" USING btree ("provider","event_key");--> statement-breakpoint
CREATE INDEX "sms_delivery_events_provider_message_idx" ON "sms_delivery_events" USING btree ("provider","provider_message_id","received_at","id");--> statement-breakpoint
CREATE INDEX "sms_delivery_events_classification_queue_idx" ON "sms_delivery_events" USING btree ("classification","received_at","id");
--> statement-breakpoint
CREATE TRIGGER sms_delivery_events_immutable
	BEFORE UPDATE OR DELETE ON sms_delivery_events
	FOR EACH ROW EXECUTE FUNCTION reject_sms_send_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER sms_delivery_event_history_immutable
	BEFORE UPDATE OR DELETE ON sms_delivery_event_history
	FOR EACH ROW EXECUTE FUNCTION reject_sms_send_ledger_mutation();
--> statement-breakpoint
ALTER TABLE sms_delivery_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY delivery_evidence_select ON sms_delivery_events
	FOR SELECT
	USING (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		OR EXISTS (
			SELECT 1
			FROM sms_delivery_event_history attributed
			WHERE attributed.delivery_event_id = sms_delivery_events.id
				AND attributed.result = 'attributed'
				AND attributed.practice_id IS NOT NULL
				AND attributed.practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
		)
	);
--> statement-breakpoint
CREATE POLICY delivery_evidence_insert ON sms_delivery_events
	FOR INSERT
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');
--> statement-breakpoint
ALTER TABLE sms_delivery_event_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY delivery_history_select ON sms_delivery_event_history
	FOR SELECT
	USING (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		OR (
			practice_id IS NOT NULL
			AND practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
		)
	);
--> statement-breakpoint
CREATE POLICY delivery_history_insert ON sms_delivery_event_history
	FOR INSERT
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON sms_delivery_events, sms_delivery_event_history FROM openpims_app;
		GRANT SELECT, INSERT ON sms_delivery_events, sms_delivery_event_history TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON sms_delivery_events, sms_delivery_event_history FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON sms_delivery_events, sms_delivery_event_history FROM authenticated;
	END IF;
END
$$;
