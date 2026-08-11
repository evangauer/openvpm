CREATE TYPE "public"."sms_provider_event_resolution" AS ENUM('authoritative_projection', 'conservative_opt_out', 'carrier_state_reconciled', 'provider_attested_no_projection');--> statement-breakpoint
CREATE TABLE "sms_provider_event_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"event_id" uuid NOT NULL,
	"conflict_id" uuid,
	"operation_id" uuid NOT NULL,
	"practice_id" uuid,
	"resolution" "sms_provider_event_resolution" NOT NULL,
	"inbound_communication_id" uuid,
	"sms_consent_event_id" uuid,
	"sms_delivery_event_id" uuid,
	"messaging_registration_event_id" uuid,
	"external_evidence_reference" varchar(255),
	"reason_code" varchar(64) NOT NULL,
	"detail" varchar(2000),
	"resolved_by_identity" varchar(255) NOT NULL,
	"resolved_by_name" varchar(255) NOT NULL,
	CONSTRAINT "sms_provider_event_resolutions_shape_check" CHECK ("sms_provider_event_resolutions"."reason_code" ~ '^[a-z0-9_]{3,64}$'
        and ("sms_provider_event_resolutions"."resolution" = 'provider_attested_no_projection' or "sms_provider_event_resolutions"."practice_id" is not null)
        and (
          ("sms_provider_event_resolutions"."resolution" = 'authoritative_projection' and "sms_provider_event_resolutions"."reason_code" in (
            'projection_repaired', 'delivery_reconciled'
          ))
          or ("sms_provider_event_resolutions"."resolution" = 'conservative_opt_out' and "sms_provider_event_resolutions"."reason_code" in (
            'provider_identity_conflict_opt_out', 'sender_identity_drift_opt_out'
          ))
          or ("sms_provider_event_resolutions"."resolution" = 'carrier_state_reconciled'
            and "sms_provider_event_resolutions"."reason_code" = 'carrier_state_readback_confirmed')
          or ("sms_provider_event_resolutions"."resolution" = 'provider_attested_no_projection' and "sms_provider_event_resolutions"."reason_code" in (
            'provider_support_invalid_callback', 'provider_support_duplicate_callback'
          ))
        )
        and "sms_provider_event_resolutions"."resolved_by_identity" = btrim("sms_provider_event_resolutions"."resolved_by_identity")
        and length("sms_provider_event_resolutions"."resolved_by_identity") between 1 and 255
        and "sms_provider_event_resolutions"."resolved_by_name" = btrim("sms_provider_event_resolutions"."resolved_by_name")
        and length("sms_provider_event_resolutions"."resolved_by_name") between 1 and 255
        and ("sms_provider_event_resolutions"."detail" is null or length(btrim("sms_provider_event_resolutions"."detail")) between 1 and 2000)
        and ("sms_provider_event_resolutions"."external_evidence_reference" is null or (
          "sms_provider_event_resolutions"."external_evidence_reference" = btrim("sms_provider_event_resolutions"."external_evidence_reference")
          and length("sms_provider_event_resolutions"."external_evidence_reference") between 3 and 255
          and "sms_provider_event_resolutions"."external_evidence_reference" ~ '^[A-Za-z0-9][A-Za-z0-9_.:/#-]{2,254}$'
        ))
        and (
          ("sms_provider_event_resolutions"."resolution" = 'authoritative_projection'
            and "sms_provider_event_resolutions"."external_evidence_reference" is null
            and num_nonnulls(
              "sms_provider_event_resolutions"."inbound_communication_id",
              "sms_provider_event_resolutions"."sms_consent_event_id",
              "sms_provider_event_resolutions"."sms_delivery_event_id",
              "sms_provider_event_resolutions"."messaging_registration_event_id"
            ) between 1 and 2)
          or ("sms_provider_event_resolutions"."resolution" = 'conservative_opt_out'
            and "sms_provider_event_resolutions"."inbound_communication_id" is null
            and "sms_provider_event_resolutions"."sms_consent_event_id" is not null
            and "sms_provider_event_resolutions"."sms_delivery_event_id" is null
            and "sms_provider_event_resolutions"."messaging_registration_event_id" is null
            and "sms_provider_event_resolutions"."external_evidence_reference" is null)
          or ("sms_provider_event_resolutions"."resolution" = 'carrier_state_reconciled'
            and "sms_provider_event_resolutions"."inbound_communication_id" is null
            and "sms_provider_event_resolutions"."sms_consent_event_id" is null
            and "sms_provider_event_resolutions"."sms_delivery_event_id" is null
            and "sms_provider_event_resolutions"."messaging_registration_event_id" is not null
            and "sms_provider_event_resolutions"."external_evidence_reference" is null)
          or ("sms_provider_event_resolutions"."resolution" = 'provider_attested_no_projection'
            and "sms_provider_event_resolutions"."inbound_communication_id" is null
            and "sms_provider_event_resolutions"."sms_consent_event_id" is null
            and "sms_provider_event_resolutions"."sms_delivery_event_id" is null
            and "sms_provider_event_resolutions"."messaging_registration_event_id" is null
            and "sms_provider_event_resolutions"."external_evidence_reference" is not null)
        ))
);
--> statement-breakpoint
ALTER TABLE "sms_provider_event_resolutions" ADD CONSTRAINT "sms_provider_event_resolutions_event_id_sms_provider_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sms_provider_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_event_resolutions" ADD CONSTRAINT "sms_provider_event_resolutions_conflict_id_sms_provider_event_conflicts_id_fk" FOREIGN KEY ("conflict_id") REFERENCES "public"."sms_provider_event_conflicts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_event_resolutions" ADD CONSTRAINT "sms_provider_event_resolutions_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_event_resolutions" ADD CONSTRAINT "sms_provider_event_resolutions_inbound_communication_id_communications_id_fk" FOREIGN KEY ("inbound_communication_id") REFERENCES "public"."communications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_event_resolutions" ADD CONSTRAINT "sms_provider_event_resolutions_sms_consent_event_id_sms_consent_events_id_fk" FOREIGN KEY ("sms_consent_event_id") REFERENCES "public"."sms_consent_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_event_resolutions" ADD CONSTRAINT "sms_provider_event_resolutions_sms_delivery_event_id_sms_delivery_events_id_fk" FOREIGN KEY ("sms_delivery_event_id") REFERENCES "public"."sms_delivery_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_event_resolutions" ADD CONSTRAINT "sms_provider_event_resolutions_messaging_registration_event_id_messaging_registration_events_id_fk" FOREIGN KEY ("messaging_registration_event_id") REFERENCES "public"."messaging_registration_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_event_resolutions_base_event_uq" ON "sms_provider_event_resolutions" USING btree ("event_id") WHERE "sms_provider_event_resolutions"."conflict_id" is null;--> statement-breakpoint
CREATE INDEX "sms_provider_event_resolutions_event_idx" ON "sms_provider_event_resolutions" USING btree ("event_id","resolved_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_event_resolutions_conflict_uq" ON "sms_provider_event_resolutions" USING btree ("conflict_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_event_resolutions_operation_uq" ON "sms_provider_event_resolutions" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "sms_provider_event_resolutions_practice_history_idx" ON "sms_provider_event_resolutions" USING btree ("practice_id","resolved_at","id");--> statement-breakpoint
CREATE INDEX "sms_provider_event_resolutions_communication_evidence_idx" ON "sms_provider_event_resolutions" USING btree ("inbound_communication_id") WHERE "sms_provider_event_resolutions"."inbound_communication_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_provider_event_resolutions_consent_evidence_idx" ON "sms_provider_event_resolutions" USING btree ("sms_consent_event_id") WHERE "sms_provider_event_resolutions"."sms_consent_event_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_provider_event_resolutions_delivery_evidence_idx" ON "sms_provider_event_resolutions" USING btree ("sms_delivery_event_id") WHERE "sms_provider_event_resolutions"."sms_delivery_event_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_provider_event_resolutions_registration_evidence_idx" ON "sms_provider_event_resolutions" USING btree ("messaging_registration_event_id") WHERE "sms_provider_event_resolutions"."messaging_registration_event_id" is not null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_sms_provider_event_resolution_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	provider_event public.sms_provider_events%ROWTYPE;
	provider_conflict public.sms_provider_event_conflicts%ROWTYPE;
	communication_evidence public.communications%ROWTYPE;
	consent_evidence public.sms_consent_events%ROWTYPE;
	delivery_evidence public.sms_delivery_events%ROWTYPE;
	registration_evidence public.messaging_registration_events%ROWTYPE;
	accepted_send_practice_id uuid;
	accepted_send_practice_count integer;
BEGIN
	SELECT * INTO provider_event
	FROM public.sms_provider_events
	WHERE id = NEW.event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'SMS provider resolution event does not exist.';
	END IF;
	IF NEW.resolution = 'provider_attested_no_projection'
		AND NEW.practice_id IS NULL
		AND provider_event.kind = 'delivery'
		AND provider_event.practice_id IS NULL
	THEN
		-- Send transactions lock their practice row FOR SHARE before calling the
		-- provider and retain it through accepted-result persistence. Take every
		-- active practice with a current sender or historical attempt for this
		-- provider FOR UPDATE, matching the service lock set and deterministic
		-- ordering. This drains those calls before proving that this delivery
		-- identity has no accepted-send owner. Practice-before-event ordering also
		-- avoids inversion with attributed provider-event ingest.
		PERFORM practice.id
		FROM public.practices practice
		WHERE practice.deleted_at IS NULL
			AND (
				EXISTS (
					SELECT 1
					FROM public.location_messaging sender
					WHERE sender.practice_id = practice.id
						AND sender.provider = provider_event.provider
						AND sender.deleted_at IS NULL
				)
				OR EXISTS (
					SELECT 1
					FROM public.sms_send_attempts attempt
					WHERE attempt.practice_id = practice.id
						AND attempt.provider = provider_event.provider
				)
			)
		ORDER BY practice.id
		FOR UPDATE;
	END IF;
	SELECT * INTO provider_event
	FROM public.sms_provider_events
	WHERE id = NEW.event_id
	FOR SHARE;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'SMS provider resolution event disappeared during serialization.';
	END IF;
	IF provider_event.state NOT IN ('projected', 'ignored', 'quarantined') THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only terminal SMS provider events can be resolved.';
	END IF;
	IF provider_event.practice_id IS NOT NULL
		AND provider_event.practice_id IS DISTINCT FROM NEW.practice_id
	THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SMS provider resolution practice does not match its event.';
	END IF;

	IF NEW.conflict_id IS NULL THEN
		IF provider_event.state <> 'quarantined' THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A base resolution requires a quarantined event.';
		END IF;
		IF provider_event.last_error_code = 'provider_identity_conflict' THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A conflict-caused quarantine requires conflict-scoped resolution evidence.';
		END IF;
	ELSE
		SELECT * INTO provider_conflict
		FROM public.sms_provider_event_conflicts
		WHERE id = NEW.conflict_id
		FOR SHARE;
		IF NOT FOUND OR provider_conflict.original_event_id IS DISTINCT FROM NEW.event_id THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SMS provider conflict does not belong to its resolution event.';
		END IF;
	END IF;

	IF provider_event.kind = 'inbound' THEN
		IF NEW.conflict_id IS NOT NULL AND NEW.resolution <> 'conservative_opt_out' THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Conflicting inbound evidence can only be resolved by conservative opt-out.';
		END IF;
		IF NEW.resolution NOT IN ('authoritative_projection', 'conservative_opt_out') THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Inbound SMS resolution kind is invalid.';
		END IF;
	ELSIF provider_event.kind = 'delivery' THEN
		IF NEW.resolution NOT IN ('authoritative_projection', 'provider_attested_no_projection') THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Delivery SMS resolution kind is invalid.';
		END IF;
	ELSIF provider_event.kind = 'a2p' THEN
		IF NEW.resolution <> 'carrier_state_reconciled' THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A2P resolution requires carrier reconciliation evidence.';
		END IF;
	ELSE
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SMS provider resolution event kind is invalid.';
	END IF;
	IF (NEW.resolution = 'authoritative_projection' AND (
		(provider_event.kind = 'inbound' AND NEW.reason_code <> 'projection_repaired')
		OR (provider_event.kind = 'delivery' AND NEW.reason_code <> 'delivery_reconciled')
	))
		OR (NEW.resolution = 'conservative_opt_out' AND (
			(NEW.conflict_id IS NULL AND NEW.reason_code <> 'sender_identity_drift_opt_out')
			OR (NEW.conflict_id IS NOT NULL AND NEW.reason_code <> 'provider_identity_conflict_opt_out')
		))
	THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SMS provider resolution reason does not match its incident.';
	END IF;

	IF NEW.resolution = 'authoritative_projection' AND provider_event.kind = 'inbound' THEN
		IF NEW.inbound_communication_id IS NULL
			OR NEW.sms_delivery_event_id IS NOT NULL
			OR NEW.messaging_registration_event_id IS NOT NULL
			OR NEW.external_evidence_reference IS NOT NULL
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Inbound projection evidence shape is invalid.';
		END IF;

		SELECT * INTO communication_evidence
		FROM public.communications
		WHERE id = NEW.inbound_communication_id
		FOR SHARE;
		IF NOT FOUND
			OR communication_evidence.practice_id IS DISTINCT FROM NEW.practice_id
			OR communication_evidence.deleted_at IS NOT NULL
			OR communication_evidence.channel <> 'sms'
			OR communication_evidence.direction <> 'inbound'
			OR communication_evidence.status <> 'delivered'
			OR communication_evidence.provider_message_id IS DISTINCT FROM provider_event.provider_message_id
			OR btrim(communication_evidence.content) IS DISTINCT FROM btrim(provider_event.message_body)
			OR communication_evidence.created_at IS DISTINCT FROM coalesce(provider_event.occurred_at, provider_event.received_at)
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Inbound communication does not prove exact provider-event projection.';
		END IF;

		IF provider_event.inbound_classification IN ('stop', 'start') THEN
			IF NEW.sms_consent_event_id IS NULL THEN
				RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'STOP and START projection require consent evidence.';
			END IF;
			SELECT * INTO consent_evidence
			FROM public.sms_consent_events
			WHERE id = NEW.sms_consent_event_id
			FOR SHARE;
			IF NOT FOUND
				OR consent_evidence.practice_id IS DISTINCT FROM NEW.practice_id
				OR consent_evidence.destination_e164 IS DISTINCT FROM provider_event.from_e164
				OR consent_evidence.provider IS DISTINCT FROM provider_event.provider
				OR consent_evidence.provider_message_id IS DISTINCT FROM provider_event.provider_message_id
				OR consent_evidence.actor_type <> 'client'
				OR consent_evidence.occurred_at IS DISTINCT FROM coalesce(provider_event.occurred_at, provider_event.received_at)
				OR (provider_event.location_id IS NOT NULL AND consent_evidence.location_id IS DISTINCT FROM provider_event.location_id)
				OR (provider_event.inbound_classification = 'stop' AND consent_evidence.action <> 'revoked')
				OR (provider_event.inbound_classification = 'start' AND consent_evidence.action <> 'granted')
			THEN
				RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Consent evidence does not prove exact provider-event projection.';
			END IF;
			IF provider_event.inbound_classification = 'stop'
				AND NOT EXISTS (
					SELECT 1
					FROM public.sms_suppressions suppression
					WHERE suppression.practice_id = NEW.practice_id
						AND suppression.phone = provider_event.from_e164
						AND suppression.deleted_at IS NULL
				)
				AND NOT EXISTS (
					SELECT 1
					FROM public.sms_consent_events newer_consent
					WHERE newer_consent.practice_id = NEW.practice_id
						AND newer_consent.destination_e164 = provider_event.from_e164
						AND newer_consent.action = 'granted'
						AND newer_consent.occurred_at > coalesce(provider_event.occurred_at, provider_event.received_at)
				)
			THEN
				RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'STOP resolution requires an active suppression or a strictly newer durable grant.';
			END IF;
		ELSIF provider_event.inbound_classification IN ('help', 'other') THEN
			IF NEW.sms_consent_event_id IS NOT NULL THEN
				RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'HELP and other inbound projection use communication evidence only.';
			END IF;
		ELSE
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Inbound classification is invalid.';
		END IF;

	ELSIF NEW.resolution = 'conservative_opt_out' THEN
		IF provider_event.kind <> 'inbound'
			OR NEW.inbound_communication_id IS NOT NULL
			OR NEW.sms_consent_event_id IS NULL
			OR NEW.sms_delivery_event_id IS NOT NULL
			OR NEW.messaging_registration_event_id IS NOT NULL
			OR NEW.external_evidence_reference IS NOT NULL
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Conservative opt-out evidence shape is invalid.';
		END IF;
		IF NEW.conflict_id IS NULL AND (
			provider_event.last_error_code IS NULL
			OR provider_event.last_error_code NOT IN ('sender_identity_drift', 'immutable_attribution_drift')
			OR provider_event.practice_id IS NULL
			OR provider_event.location_id IS NULL
			OR provider_event.from_e164 IS NULL
		) THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Base conservative opt-out requires immutable, fully attributed sender-drift evidence.';
		END IF;
		SELECT * INTO consent_evidence
		FROM public.sms_consent_events
		WHERE id = NEW.sms_consent_event_id
		FOR SHARE;
		IF NOT FOUND
			OR consent_evidence.practice_id IS DISTINCT FROM NEW.practice_id
			OR consent_evidence.destination_e164 IS DISTINCT FROM provider_event.from_e164
			OR consent_evidence.action <> 'revoked'
			OR consent_evidence.actor_type <> 'system'
			OR consent_evidence.provider IS NOT NULL
			OR consent_evidence.provider_message_id IS NOT NULL
			OR consent_evidence.source <> 'provider_event_resolution:v1'
			OR consent_evidence.event_key IS DISTINCT FROM format(
				'provider_event_resolution:%s:%s:revoked',
				NEW.operation_id,
				coalesce(NEW.conflict_id, NEW.event_id)
			)
			OR (provider_event.location_id IS NOT NULL AND consent_evidence.location_id IS DISTINCT FROM provider_event.location_id)
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Conservative opt-out requires matching revoked consent evidence.';
		END IF;
		IF NOT EXISTS (
			SELECT 1
			FROM public.sms_suppressions suppression
			WHERE suppression.practice_id = NEW.practice_id
				AND suppression.phone = consent_evidence.destination_e164
				AND suppression.deleted_at IS NULL
		) THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Conservative opt-out requires an active durable SMS suppression.';
		END IF;

	ELSIF NEW.resolution = 'authoritative_projection' AND provider_event.kind = 'delivery' THEN
		IF NEW.inbound_communication_id IS NOT NULL
			OR NEW.sms_consent_event_id IS NOT NULL
			OR NEW.sms_delivery_event_id IS NULL
			OR NEW.messaging_registration_event_id IS NOT NULL
			OR NEW.external_evidence_reference IS NOT NULL
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Delivery projection evidence shape is invalid.';
		END IF;
		SELECT * INTO delivery_evidence
		FROM public.sms_delivery_events
		WHERE id = NEW.sms_delivery_event_id
		FOR SHARE;
		IF NOT FOUND
			OR delivery_evidence.provider IS DISTINCT FROM provider_event.provider
			OR delivery_evidence.provider_event_type IS DISTINCT FROM coalesce(provider_conflict.incoming_provider_event_type, provider_event.provider_event_type)
			OR delivery_evidence.provider_message_id IS DISTINCT FROM coalesce(provider_conflict.incoming_provider_message_id, provider_event.provider_message_id)
			OR (coalesce(provider_conflict.incoming_provider_event_id, provider_event.provider_event_id) IS NOT NULL
				AND delivery_evidence.provider_event_id IS DISTINCT FROM coalesce(provider_conflict.incoming_provider_event_id, provider_event.provider_event_id))
			OR (NEW.conflict_id IS NULL AND (
				delivery_evidence.classification IS DISTINCT FROM provider_event.delivery_classification
				OR delivery_evidence.provider_status IS DISTINCT FROM provider_event.provider_status
				OR delivery_evidence.provider_error_code IS DISTINCT FROM provider_event.provider_error_code
			))
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Delivery evidence does not match the provider incident.';
		END IF;
		IF NOT EXISTS (
			SELECT 1
			FROM public.sms_delivery_event_history history
			WHERE history.delivery_event_id = NEW.sms_delivery_event_id
				AND history.practice_id = NEW.practice_id
				AND history.result IN ('projected', 'reconciled')
		) THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Delivery resolution requires durable projected or reconciled history.';
		END IF;

	ELSIF NEW.resolution = 'carrier_state_reconciled' THEN
		IF provider_event.kind <> 'a2p'
			OR NEW.inbound_communication_id IS NOT NULL
			OR NEW.sms_consent_event_id IS NOT NULL
			OR NEW.sms_delivery_event_id IS NOT NULL
			OR NEW.messaging_registration_event_id IS NULL
			OR NEW.external_evidence_reference IS NOT NULL
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Carrier reconciliation evidence shape is invalid.';
		END IF;
		SELECT * INTO registration_evidence
		FROM public.messaging_registration_events
		WHERE id = NEW.messaging_registration_event_id
		FOR SHARE;
		IF NOT FOUND
			OR registration_evidence.practice_id IS DISTINCT FROM NEW.practice_id
			OR registration_evidence.provider IS DISTINCT FROM provider_event.provider
			OR registration_evidence.event_type <> 'provider_state_observed'
			OR registration_evidence.operation <> 'registration_reconciliation'
			OR registration_evidence.status_after NOT IN ('pending', 'active', 'action_required', 'failed', 'suspended')
			OR registration_evidence.operation_id IS DISTINCT FROM NEW.operation_id
			OR registration_evidence.reason_code <> 'carrier_registration_reconciled'
			OR (provider_event.a2p_brand_id IS NOT NULL AND registration_evidence.provider_brand_id IS DISTINCT FROM provider_event.a2p_brand_id)
			OR (provider_event.a2p_campaign_id IS NOT NULL AND registration_evidence.provider_campaign_id IS DISTINCT FROM provider_event.a2p_campaign_id)
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Carrier evidence does not prove the exact provider incident reconciliation.';
		END IF;
		IF provider_event.a2p_phone_e164 IS NOT NULL AND NOT EXISTS (
			SELECT 1
			FROM public.location_messaging sender
			WHERE sender.practice_id = NEW.practice_id
				AND sender.location_id = registration_evidence.location_id
				AND sender.provider = provider_event.provider
				AND sender.sender_e164 = provider_event.a2p_phone_e164
				AND sender.deleted_at IS NULL
				AND sender.enabled = false
				AND sender.provider_profile_ready = false
				AND (
					SELECT count(*)
					FROM public.location_messaging exact_sender
					WHERE exact_sender.practice_id = NEW.practice_id
						AND exact_sender.provider = provider_event.provider
						AND exact_sender.sender_e164 = provider_event.a2p_phone_e164
						AND exact_sender.deleted_at IS NULL
				) = 1
		) THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Carrier phone evidence requires one exact disabled, unready sender identity.';
		END IF;

	ELSIF NEW.resolution = 'provider_attested_no_projection' THEN
		IF provider_event.kind <> 'delivery'
			OR NEW.inbound_communication_id IS NOT NULL
			OR NEW.sms_consent_event_id IS NOT NULL
			OR NEW.sms_delivery_event_id IS NOT NULL
			OR NEW.messaging_registration_event_id IS NOT NULL
			OR NEW.external_evidence_reference IS NULL
		THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Provider-attested no-projection evidence shape is invalid.';
		END IF;
		IF provider_event.practice_id IS NULL THEN
			SELECT count(DISTINCT attempt.practice_id), min(attempt.practice_id::text)::uuid
			INTO accepted_send_practice_count, accepted_send_practice_id
			FROM public.sms_send_attempt_events attempt_event
			JOIN public.sms_send_attempts attempt
				ON attempt.practice_id = attempt_event.practice_id
				AND attempt.id = attempt_event.attempt_id
			WHERE attempt_event.outcome = 'accepted'
				AND attempt_event.provider_message_id = coalesce(
					provider_conflict.incoming_provider_message_id,
					provider_event.provider_message_id
				)
				AND attempt.provider = provider_event.provider;
			IF accepted_send_practice_count = 1
				AND NEW.practice_id IS DISTINCT FROM accepted_send_practice_id
			THEN
				RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Provider-attested resolution practice must match the exact accepted send.';
			END IF;
			IF accepted_send_practice_count <> 1 AND NEW.practice_id IS NOT NULL THEN
				RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unattributed provider-attested resolution cannot claim an arbitrary practice.';
			END IF;
		END IF;
	ELSE
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SMS provider resolution evidence is invalid.';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sms_provider_event_resolutions_validate_insert
	BEFORE INSERT ON sms_provider_event_resolutions
	FOR EACH ROW EXECUTE FUNCTION validate_sms_provider_event_resolution_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_sms_provider_event_resolution_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
		AND current_user = (
			SELECT pg_catalog.pg_get_userbyid(class.relowner)
			FROM pg_catalog.pg_class class
			JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
			WHERE namespace.nspname = TG_TABLE_SCHEMA AND class.relname = TG_TABLE_NAME
		)
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;
	RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider event resolution evidence is immutable.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sms_provider_event_resolutions_immutable
	BEFORE UPDATE OR DELETE ON sms_provider_event_resolutions
	FOR EACH ROW EXECUTE FUNCTION reject_sms_provider_event_resolution_mutation();
--> statement-breakpoint
ALTER TABLE sms_provider_event_resolutions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON sms_provider_event_resolutions
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');
--> statement-breakpoint
REVOKE ALL ON sms_provider_event_resolutions FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON sms_provider_event_resolutions FROM openpims_app;
		GRANT SELECT, INSERT ON sms_provider_event_resolutions TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON sms_provider_event_resolutions FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON sms_provider_event_resolutions FROM authenticated;
	END IF;
END
$$;
