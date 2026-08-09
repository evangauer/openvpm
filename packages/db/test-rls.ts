/**
 * Live Row-Level Security verification. Connects as the least-privilege
 * `openpims_app` role and proves tenant isolation against a real database.
 *
 * Run with: pnpm db:rls:test   (requires the DB up + pnpm db:rls applied)
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import postgres from "postgres";
import { randomUUID } from "crypto";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function appRoleUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = "openpims_app";
  url.password = nonBlankEnv("OPENPIMS_APP_DB_PASSWORD") ?? "openpims_app";
  return url.toString();
}

const ownerUrl = nonBlankEnv("DATABASE_URL");
if (!ownerUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
// Derive the restricted-role URL by swapping in the app-role credentials.
const appUrl = appRoleUrl(ownerUrl);

const owner = postgres(ownerUrl, { max: 1 });
const app = postgres(appUrl, { max: 1 });

const aId = randomUUID();
const bId = randomUUID();
const aClient = randomUUID();
const bClient = randomUUID();
const aCommunication = randomUUID();
const bCommunication = randomUUID();
const aInvoice = randomUUID();
const bInvoice = randomUUID();
const aUser = randomUUID();
const bUser = randomUUID();
const aMigrationRun = randomUUID();
const bMigrationRun = randomUUID();
const aAppointment = randomUUID();
const bAppointment = randomUUID();
const aCloseout = randomUUID();
const bCloseout = randomUUID();
const aPatient = randomUUID();
const bPatient = randomUUID();
const aMergeTargetPatient = randomUUID();
const bMergeTargetPatient = randomUUID();
const aLineageCandidatePatient = randomUUID();
const aPatientMergeEvent = randomUUID();
const bPatientMergeEvent = randomUUID();
const aPatientMergeOperation = randomUUID();
const bPatientMergeOperation = randomUUID();
const aProduct = randomUUID();
const bProduct = randomUUID();
const aPrescription = randomUUID();
const bPrescription = randomUUID();
const aPrescriptionEvent = randomUUID();
const bPrescriptionEvent = randomUUID();
const aDispenseCharge = randomUUID();
const bDispenseCharge = randomUUID();
const aSmsConsentEvent = randomUUID();
const bSmsConsentEvent = randomUUID();
const aSmsSendAttempt = randomUUID();
const bSmsSendAttempt = randomUUID();
const aSmsSendAttemptEvent = randomUUID();
const bSmsSendAttemptEvent = randomUUID();
const aLabResult = randomUUID();
const bLabResult = randomUUID();
const aLabResultEvent = randomUUID();
const bLabResultEvent = randomUUID();
const aAppSmsSendAttempt = randomUUID();
const aAppSmsSendAttemptEvent = randomUUID();
const aSmsDeliveryEvent = randomUUID();
const bSmsDeliveryEvent = randomUUID();
const unmatchedSmsDeliveryEvent = randomUUID();
const aSmsDeliveryHistory = randomUUID();
const bSmsDeliveryHistory = randomUUID();
const bSmsDeliveryConflictHistory = randomUUID();
const funnelEventId = randomUUID();
const conversionEvidenceKey = `practice:${aId}`;
let failures = 0;

async function appTransaction<T>(
  fn: (tx: typeof app) => Promise<T>,
): Promise<T> {
  return app.begin((tx) => fn(tx as unknown as typeof app)) as Promise<T>;
}

function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures++;
}

try {
  // Arrange (as owner — bypasses RLS).
  await owner`insert into practices (id, name) values (${aId}, 'RLS Test A'), (${bId}, 'RLS Test B')`;
  await owner`insert into clients (id, practice_id, first_name, last_name) values
    (${aClient}, ${aId}, 'Alice', 'A'), (${bClient}, ${bId}, 'Bob', 'B')`;
  await owner`insert into communications
    (id, practice_id, client_id, channel, direction, status)
    values
    (${aCommunication}, ${aId}, ${aClient}, 'sms', 'outbound', 'pending'),
    (${bCommunication}, ${bId}, ${bClient}, 'sms', 'outbound', 'pending')`;
  await owner`insert into users (id, email, password_hash, name, role, practice_id) values
    (${aUser}, ${`rls-${aUser}@example.com`}, 'not-a-real-hash', 'RLS Admin A', 'admin', ${aId}),
    (${bUser}, ${`rls-${bUser}@example.com`}, 'not-a-real-hash', 'RLS Admin B', 'admin', ${bId})`;
  await owner`insert into sms_consent_events
    (id, practice_id, client_id, destination_e164, action, source, detail, actor_type, event_key)
    values
    (${aSmsConsentEvent}, ${aId}, ${aClient}, '+15555550101', 'revoked', 'rls_test:v1', 'Tenant A event', 'system', ${`rls:${aSmsConsentEvent}`}),
    (${bSmsConsentEvent}, ${bId}, ${bClient}, '+15555550102', 'revoked', 'rls_test:v1', 'Tenant B event', 'system', ${`rls:${bSmsConsentEvent}`})`;
  await owner`insert into sms_send_attempts
    (id, practice_id, source, source_id, idempotency_key, destination_e164,
     registered_display_name, body, body_sha256, provider)
    values
    (${aSmsSendAttempt}, ${aId}, 'rls_test', ${aSmsSendAttempt}, ${`rls:${aSmsSendAttempt}`}, '+15555550101', 'RLS Clinic A', 'RLS Clinic A: Test. Reply STOP to opt out or HELP for help.', ${"a".repeat(64)}, 'console'),
    (${bSmsSendAttempt}, ${bId}, 'rls_test', ${bSmsSendAttempt}, ${`rls:${bSmsSendAttempt}`}, '+15555550102', 'RLS Clinic B', 'RLS Clinic B: Test. Reply STOP to opt out or HELP for help.', ${"b".repeat(64)}, 'console')`;
  await owner`insert into sms_send_attempt_events
    (id, practice_id, attempt_id, kind, outcome, detail, event_key)
    values
    (${aSmsSendAttemptEvent}, ${aId}, ${aSmsSendAttempt}, 'provider_result', 'definite_failure', 'RLS test rejection', ${`rls:${aSmsSendAttemptEvent}`}),
    (${bSmsSendAttemptEvent}, ${bId}, ${bSmsSendAttempt}, 'provider_result', 'definite_failure', 'RLS test rejection', ${`rls:${bSmsSendAttemptEvent}`})`;
  await owner`insert into sms_delivery_events
    (id, provider, provider_message_id, provider_event_type, provider_status,
     classification, event_key, payload_fingerprint_sha256)
    values
    (${aSmsDeliveryEvent}, 'telnyx', 'msg-rls-a', 'message.sent', 'sent',
      'sent', ${`event:${aSmsDeliveryEvent}`}, ${"1".repeat(64)}),
    (${bSmsDeliveryEvent}, 'telnyx', 'msg-rls-b', 'message.sent', 'sent',
      'sent', ${`event:${bSmsDeliveryEvent}`}, ${"2".repeat(64)}),
    (${unmatchedSmsDeliveryEvent}, 'twilio', null, 'message.status', 'mystery',
      'unknown', ${`event:${unmatchedSmsDeliveryEvent}`}, ${"3".repeat(64)})`;
  await owner`insert into sms_delivery_event_history
    (id, delivery_event_id, practice_id, attempt_id, kind, result,
     classification, event_key)
    values
    (${aSmsDeliveryHistory}, ${aSmsDeliveryEvent}, ${aId}, ${aSmsSendAttempt},
      'automatic', 'attributed', 'sent', ${`rls:${aSmsDeliveryHistory}`}),
    (${bSmsDeliveryHistory}, ${bSmsDeliveryEvent}, ${bId}, ${bSmsSendAttempt},
      'automatic', 'attributed', 'sent', ${`rls:${bSmsDeliveryHistory}`})`;
  await owner`insert into sms_delivery_event_history
    (id, delivery_event_id, kind, result, classification, detail, event_key)
    values
    (${bSmsDeliveryConflictHistory}, ${bSmsDeliveryEvent}, 'automatic',
      'ambiguous', 'sent', 'Redacted RLS identity conflict.',
      ${`rls:${bSmsDeliveryConflictHistory}`})`;
  await owner`insert into patients (id, practice_id, client_id, name, species)
    select ${aPatient}, ${aId}, id, 'RLS Pet A', 'canine'
    from clients where practice_id = ${aId}`;
  await owner`insert into patients (id, practice_id, client_id, name, species)
    select ${bPatient}, ${bId}, id, 'RLS Pet B', 'feline'
    from clients where practice_id = ${bId}`;
  await owner`insert into lab_results
    (id, practice_id, patient_id, test_name, result_value, status, completed_at, ordered_by)
    values
    (${aLabResult}, ${aId}, ${aPatient}, 'RLS CBC A', '12.5', 'completed', now(), ${aUser}),
    (${bLabResult}, ${bId}, ${bPatient}, 'RLS CBC B', '8.2', 'completed', now(), ${bUser})`;
  await owner`insert into lab_result_events
    (id, practice_id, lab_result_id, patient_id, event_type, status_before,
     status_after, result_value, result_flag, actor_id, actor_name, operation_id,
     operation_payload_hash)
    values
    (${aLabResultEvent}, ${aId}, ${aLabResult}, ${aPatient}, 'completed', 'pending',
      'completed', '12.5', 'normal', ${aUser}, 'RLS Admin A', ${randomUUID()}, ${"a".repeat(64)}),
    (${bLabResultEvent}, ${bId}, ${bLabResult}, ${bPatient}, 'completed', 'pending',
      'completed', '8.2', 'normal', ${bUser}, 'RLS Admin B', ${randomUUID()}, ${"b".repeat(64)})`;
  await owner`insert into patients (id, practice_id, client_id, name, species)
    select ${aMergeTargetPatient}, ${aId}, id, 'RLS Canonical Pet A', 'canine'
    from clients where practice_id = ${aId}`;
  await owner`insert into patients (id, practice_id, client_id, name, species)
    select ${bMergeTargetPatient}, ${bId}, id, 'RLS Canonical Pet B', 'feline'
    from clients where practice_id = ${bId}`;
  await owner`insert into patients (id, practice_id, client_id, name, species)
    select ${aLineageCandidatePatient}, ${aId}, id, 'RLS Lineage Candidate A', 'canine'
    from clients where practice_id = ${aId}`;
  await owner`insert into patient_merge_events
    (id, practice_id, source_patient_id, target_patient_id, client_id,
     performed_by, performed_by_name, reason, operation_id,
     source_snapshot, target_snapshot)
    select ${aPatientMergeEvent}, ${aId}, ${aPatient}, ${aMergeTargetPatient}, client_id,
      ${aUser}, 'RLS Admin A', 'Duplicate patient identity corrected.',
      ${aPatientMergeOperation}, jsonb_build_object('id', ${aPatient}::text),
      jsonb_build_object('id', ${aMergeTargetPatient}::text)
    from patients where id = ${aPatient}`;
  await owner`insert into patient_merge_events
    (id, practice_id, source_patient_id, target_patient_id, client_id,
     performed_by, performed_by_name, reason, operation_id,
     source_snapshot, target_snapshot)
    select ${bPatientMergeEvent}, ${bId}, ${bPatient}, ${bMergeTargetPatient}, client_id,
      ${bUser}, 'RLS Admin B', 'Duplicate patient identity corrected.',
      ${bPatientMergeOperation}, jsonb_build_object('id', ${bPatient}::text),
      jsonb_build_object('id', ${bMergeTargetPatient}::text)
    from patients where id = ${bPatient}`;
  await owner`insert into products (id, practice_id, name, category, unit_price, stock_quantity) values
    (${aProduct}, ${aId}, 'RLS Drug A', 'medication', 1, 10),
    (${bProduct}, ${bId}, 'RLS Drug B', 'medication', 1, 10)`;
  await owner`insert into prescriptions
    (id, practice_id, patient_id, product_id, medication_name, dosage, frequency, quantity, refills_remaining, prescribed_by, start_date)
    values
    (${aPrescription}, ${aId}, ${aPatient}, ${aProduct}, 'RLS Drug A', '1 tablet', 'daily', 1, 1, ${aUser}, current_date),
    (${bPrescription}, ${bId}, ${bPatient}, ${bProduct}, 'RLS Drug B', '1 tablet', 'daily', 1, 1, ${bUser}, current_date)`;
  await owner`insert into prescription_events
    (id, practice_id, prescription_id, patient_id, product_id, event_type, quantity, status_after, refills_after, actor_id, actor_name)
    values
    (${aPrescriptionEvent}, ${aId}, ${aPrescription}, ${aPatient}, ${aProduct}, 'created', 1, 'active', 1, ${aUser}, 'RLS Admin A'),
    (${bPrescriptionEvent}, ${bId}, ${bPrescription}, ${bPatient}, ${bProduct}, 'created', 1, 'active', 1, ${bUser}, 'RLS Admin B')`;
  await owner`insert into dispense_charge_queue
    (id, practice_id, prescription_event_id, prescription_id, patient_id, client_id, product_id, quantity, description_snapshot, unit_price_snapshot)
    select ${aDispenseCharge}, ${aId}, ${aPrescriptionEvent}, ${aPrescription}, ${aPatient}, client_id, ${aProduct}, 1, 'RLS Drug A', 1
    from patients where id = ${aPatient}`;
  await owner`insert into dispense_charge_queue
    (id, practice_id, prescription_event_id, prescription_id, patient_id, client_id, product_id, quantity, description_snapshot, unit_price_snapshot)
    select ${bDispenseCharge}, ${bId}, ${bPrescriptionEvent}, ${bPrescription}, ${bPatient}, client_id, ${bProduct}, 1, 'RLS Drug B', 1
    from patients where id = ${bPatient}`;
  await owner`insert into migration_runs
    (id, practice_id, created_by, mode, source, file_hash, reviewed_plan_hash, file_size_bytes, preview_expires_at)
    values
    (${aMigrationRun}, ${aId}, ${aUser}, 'clients', 'other', ${"a".repeat(64)}, ${"c".repeat(64)}, 10, now() + interval '1 day'),
    (${bMigrationRun}, ${bId}, ${bUser}, 'clients', 'other', ${"b".repeat(64)}, ${"d".repeat(64)}, 10, now() + interval '1 day')`;
  await owner`insert into funnel_events (id, event_name, practice_id)
    values (${funnelEventId}, 'registration', ${aId})`;
  await owner`insert into practice_conversion_milestones
    (practice_id, milestone, occurred_at, evidence_source, evidence_key)
    values (${aId}, 'registered', now(), 'practice_created', ${conversionEvidenceKey})`;
  await owner`insert into appointments (id, practice_id, client_id, start_time, end_time)
    select ${aAppointment}::uuid, ${aId}::uuid, id, now(), now() + interval '30 minutes'
    from clients where practice_id = ${aId}
    union all
    select ${bAppointment}::uuid, ${bId}::uuid, id, now(), now() + interval '30 minutes'
    from clients where practice_id = ${bId}`;
  await owner`insert into visit_closeouts (id, practice_id, appointment_id)
    values (${aCloseout}, ${aId}, ${aAppointment}), (${bCloseout}, ${bId}, ${bAppointment})`;

  // Tenant A context sees only A's rows.
  const aRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select practice_id from clients where practice_id in (${aId}, ${bId})`;
  });
  check(
    "tenant A sees only A's clients",
    aRows.length === 1 && aRows[0]!.practice_id === aId,
  );

  const aSmsConsentEvents = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from sms_consent_events where id in (${aSmsConsentEvent}, ${bSmsConsentEvent})`;
  });
  check(
    "tenant A sees only A's SMS consent events",
    aSmsConsentEvents.length === 1 &&
      aSmsConsentEvents[0]!.id === aSmsConsentEvent,
  );

  let smsConsentUpdateBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`update sms_consent_events set detail = 'tampered' where id = ${aSmsConsentEvent}`;
    });
  } catch {
    smsConsentUpdateBlocked = true;
  }
  check(
    "application role cannot rewrite SMS consent history",
    smsConsentUpdateBlocked,
  );

  let smsConsentDeleteBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`delete from sms_consent_events where id = ${aSmsConsentEvent}`;
    });
  } catch {
    smsConsentDeleteBlocked = true;
  }
  check(
    "application role cannot delete SMS consent history",
    smsConsentDeleteBlocked,
  );

  let crossTenantSmsConsentInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into sms_consent_events
        (practice_id, client_id, destination_e164, action, source, actor_type, event_key)
        values (${bId}, ${bClient}, '+15555550102', 'revoked', 'rls_cross_tenant:v1', 'system', ${`rls:cross:${randomUUID()}`})`;
    });
  } catch {
    crossTenantSmsConsentInsertBlocked = true;
  }
  check(
    "cross-tenant SMS consent INSERT is blocked",
    crossTenantSmsConsentInsertBlocked,
  );

  const aSmsSendAttempts = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from sms_send_attempts where id in (${aSmsSendAttempt}, ${bSmsSendAttempt})`;
  });
  check(
    "tenant A sees only A's SMS send attempts",
    aSmsSendAttempts.length === 1 &&
      aSmsSendAttempts[0]!.id === aSmsSendAttempt,
  );

  const aSmsSendEvents = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from sms_send_attempt_events where id in (${aSmsSendAttemptEvent}, ${bSmsSendAttemptEvent})`;
  });
  check(
    "tenant A sees only A's SMS send outcome events",
    aSmsSendEvents.length === 1 &&
      aSmsSendEvents[0]!.id === aSmsSendAttemptEvent,
  );

  const aDeliveryEvidence = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from sms_delivery_events where id in (${aSmsDeliveryEvent}, ${bSmsDeliveryEvent}, ${unmatchedSmsDeliveryEvent})`;
  });
  check(
    "tenant A sees only exactly attributed SMS delivery evidence",
    aDeliveryEvidence.length === 1 &&
      aDeliveryEvidence[0]!.id === aSmsDeliveryEvent,
  );

  const aDeliveryHistory = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from sms_delivery_event_history where id in (${aSmsDeliveryHistory}, ${bSmsDeliveryHistory})`;
  });
  check(
    "tenant A sees only A's attributed SMS delivery history",
    aDeliveryHistory.length === 1 &&
      aDeliveryHistory[0]!.id === aSmsDeliveryHistory,
  );

  let tenantDeliveryEvidenceInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into sms_delivery_events
        (provider, provider_event_type, classification, event_key,
         payload_fingerprint_sha256)
        values ('telnyx', 'message.sent', 'sent', ${`forged:${randomUUID()}`}, ${"4".repeat(64)})`;
    });
  } catch {
    tenantDeliveryEvidenceInsertBlocked = true;
  }
  check(
    "tenant role cannot forge global SMS delivery evidence",
    tenantDeliveryEvidenceInsertBlocked,
  );

  let tenantDeliveryHistoryInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into sms_delivery_event_history
        (delivery_event_id, practice_id, attempt_id, kind, result,
         classification, event_key)
        values (${aSmsDeliveryEvent}, ${aId}, ${aSmsSendAttempt}, 'automatic',
          'projection_miss', 'sent', ${`forged:${randomUUID()}`})`;
    });
  } catch {
    tenantDeliveryHistoryInsertBlocked = true;
  }
  check(
    "tenant role cannot forge same-tenant SMS delivery history",
    tenantDeliveryHistoryInsertBlocked,
  );

  let crossTenantDeliveryFkBlocked = false;
  try {
    await owner`insert into sms_delivery_event_history
      (delivery_event_id, practice_id, attempt_id, kind, result,
       classification, event_key)
      values (${unmatchedSmsDeliveryEvent}, ${aId}, ${bSmsSendAttempt},
        'automatic', 'projection_miss', 'unknown', ${`cross:${randomUUID()}`})`;
  } catch {
    crossTenantDeliveryFkBlocked = true;
  }
  check(
    "delivery history composite FK rejects a cross-tenant attempt",
    crossTenantDeliveryFkBlocked,
  );

  let crossTenantDeliveryCommunicationFkBlocked = false;
  try {
    await owner`insert into sms_delivery_event_history
      (delivery_event_id, practice_id, attempt_id, communication_id, kind,
       result, classification, event_key)
      values (${unmatchedSmsDeliveryEvent}, ${aId}, ${aSmsSendAttempt},
        ${bCommunication}, 'automatic', 'projection_miss', 'unknown',
        ${`cross:${randomUUID()}`})`;
  } catch {
    crossTenantDeliveryCommunicationFkBlocked = true;
  }
  check(
    "delivery history composite FK rejects a cross-tenant communication",
    crossTenantDeliveryCommunicationFkBlocked,
  );

  let crossEventDeliveryReviewFkBlocked = false;
  try {
    await owner`insert into sms_delivery_event_history
      (delivery_event_id, reviewed_history_id, kind, result, classification,
       operator_reason_code, actor_type, actor_identity, actor_name, event_key)
      values (${aSmsDeliveryEvent}, ${bSmsDeliveryConflictHistory},
        'operator_reconciliation', 'operator_reviewed', 'sent',
        'identity_conflict_review', 'platform_operator', 'rls-operator',
        'RLS Operator', ${`cross-review:${randomUUID()}`})`;
  } catch {
    crossEventDeliveryReviewFkBlocked = true;
  }
  check(
    "delivery history composite FK rejects reviewing another event's incident",
    crossEventDeliveryReviewFkBlocked,
  );

  let deliveryReviewReasonShapeBlocked = false;
  try {
    await owner`insert into sms_delivery_event_history
      (delivery_event_id, reviewed_history_id, kind, result, classification,
       operator_reason_code, actor_type, actor_identity, actor_name, event_key)
      values (${bSmsDeliveryEvent}, ${bSmsDeliveryConflictHistory},
        'operator_reconciliation', 'operator_reviewed', 'sent',
        'projection_repair', 'platform_operator', 'rls-operator',
        'RLS Operator', ${`bad-review-reason:${randomUUID()}`})`;
  } catch {
    deliveryReviewReasonShapeBlocked = true;
  }
  check(
    "delivery history rejects a projection reason on a quarantine review",
    deliveryReviewReasonShapeBlocked,
  );

  let deliveryReconciliationReasonShapeBlocked = false;
  try {
    await owner`insert into sms_delivery_event_history
      (delivery_event_id, practice_id, attempt_id, kind, result,
       classification, operator_reason_code, actor_type, actor_identity,
       actor_name, event_key)
      values (${bSmsDeliveryEvent}, ${bId}, ${bSmsSendAttempt},
        'operator_reconciliation', 'reconciled', 'sent',
        'identity_conflict_review', 'platform_operator', 'rls-operator',
        'RLS Operator', ${`bad-reconciliation-reason:${randomUUID()}`})`;
  } catch {
    deliveryReconciliationReasonShapeBlocked = true;
  }
  check(
    "delivery history rejects a quarantine reason on a reconciliation",
    deliveryReconciliationReasonShapeBlocked,
  );

  let automaticReconciliationShapeBlocked = false;
  try {
    await owner`insert into sms_delivery_event_history
      (delivery_event_id, practice_id, attempt_id, kind, result,
       classification, event_key)
      values (${bSmsDeliveryEvent}, ${bId}, ${bSmsSendAttempt}, 'automatic',
        'reconciled', 'sent', ${`automatic-reconciliation:${randomUUID()}`})`;
  } catch {
    automaticReconciliationShapeBlocked = true;
  }
  check(
    "delivery history rejects an automatic operator reconciliation",
    automaticReconciliationShapeBlocked,
  );

  let ownerDeliveryMutationBlockedWithoutMaintenance = false;
  try {
    await owner`update sms_delivery_events set provider_status = provider_status where id = ${aSmsDeliveryEvent}`;
  } catch {
    ownerDeliveryMutationBlockedWithoutMaintenance = true;
  }
  check(
    "delivery evidence owner mutation requires the maintenance GUC",
    ownerDeliveryMutationBlockedWithoutMaintenance,
  );

  await owner.begin(async (tx) => {
    const maintenance = tx as unknown as typeof owner;
    await maintenance`select set_config('app.ledger_maintenance', 'on', true)`;
    await maintenance`update sms_delivery_events set provider_status = provider_status where id = ${aSmsDeliveryEvent}`;
  });

  let smsSendAttemptUpdateBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`update sms_send_attempts set source = 'tampered' where id = ${aSmsSendAttempt}`;
    });
  } catch {
    smsSendAttemptUpdateBlocked = true;
  }
  check(
    "application role cannot rewrite SMS send attempts",
    smsSendAttemptUpdateBlocked,
  );

  let smsSendEventDeleteBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`delete from sms_send_attempt_events where id = ${aSmsSendAttemptEvent}`;
    });
  } catch {
    smsSendEventDeleteBlocked = true;
  }
  check(
    "application role cannot delete SMS send outcome events",
    smsSendEventDeleteBlocked,
  );

  let sameTenantSmsSendInsertAllowed = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into sms_send_attempts
        (id, practice_id, source, source_id, idempotency_key,
         destination_e164, registered_display_name, body, body_sha256, provider)
        values (${aAppSmsSendAttempt}, ${aId}, 'rls_app_test',
          ${aAppSmsSendAttempt}, ${`rls:${aAppSmsSendAttempt}`},
          '+15555550103', 'RLS Clinic A',
          'RLS Clinic A: App test. Reply STOP to opt out or HELP for help.',
          ${"c".repeat(64)}, 'console')`;
      await tx`insert into sms_send_attempt_events
        (id, practice_id, attempt_id, kind, outcome, detail, event_key)
        values (${aAppSmsSendAttemptEvent}, ${aId}, ${aAppSmsSendAttempt},
          'provider_result', 'definite_failure', 'App role test rejection',
          ${`rls:${aAppSmsSendAttemptEvent}`})`;
    });
    sameTenantSmsSendInsertAllowed = true;
  } catch {
    sameTenantSmsSendInsertAllowed = false;
  }
  check(
    "same-tenant app role can append SMS attempt and provider outcome",
    sameTenantSmsSendInsertAllowed,
  );

  let crossTenantSmsAttemptInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into sms_send_attempts
        (practice_id, source, source_id, idempotency_key, destination_e164,
         registered_display_name, body, body_sha256, provider)
        values (${bId}, 'rls_cross_tenant', ${randomUUID()},
          ${`rls:cross:${randomUUID()}`}, '+15555550104', 'RLS Clinic B',
          'RLS Clinic B: Cross test. Reply STOP to opt out or HELP for help.',
          ${"d".repeat(64)}, 'console')`;
    });
  } catch {
    crossTenantSmsAttemptInsertBlocked = true;
  }
  check(
    "cross-tenant SMS send attempt INSERT is blocked",
    crossTenantSmsAttemptInsertBlocked,
  );

  let crossTenantSmsSendInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into sms_send_attempt_events
        (practice_id, attempt_id, kind, outcome, detail, actor_type,
         actor_identity, actor_name, event_key)
        values (${bId}, ${bSmsSendAttempt}, 'reconciliation', 'definite_failure',
          'Cross tenant', 'platform_operator', 'operator@example.com',
          'RLS Operator', ${`rls:cross:${randomUUID()}`})`;
    });
  } catch {
    crossTenantSmsSendInsertBlocked = true;
  }
  check(
    "cross-tenant SMS send event INSERT is blocked",
    crossTenantSmsSendInsertBlocked,
  );

  const aPrescriptionEvents = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from prescription_events where id in (${aPrescriptionEvent}, ${bPrescriptionEvent})`;
  });
  check(
    "tenant A sees only A's prescription events",
    aPrescriptionEvents.length === 1 &&
      aPrescriptionEvents[0]!.id === aPrescriptionEvent,
  );
  const aLabResultEvents = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from lab_result_events where id in (${aLabResultEvent}, ${bLabResultEvent})`;
  });
  check(
    "tenant A sees only A's lab result evidence",
    aLabResultEvents.length === 1 &&
      aLabResultEvents[0]!.id === aLabResultEvent &&
      aLabResultEvents[0]!.practice_id === aId,
  );

  let ownerLabMutationBlockedWithoutMaintenance = false;
  try {
    await owner`update lab_result_events set actor_name = actor_name where id = ${aLabResultEvent}`;
  } catch {
    ownerLabMutationBlockedWithoutMaintenance = true;
  }
  check(
    "lab evidence owner mutation requires the maintenance GUC",
    ownerLabMutationBlockedWithoutMaintenance,
  );

  await owner.begin(async (tx) => {
    const maintenance = tx as unknown as typeof owner;
    await maintenance`select set_config('app.ledger_maintenance', 'on', true)`;
    await maintenance`update lab_result_events set actor_name = actor_name where id = ${aLabResultEvent}`;
  });

  let labResultEventUpdateBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`update lab_result_events set actor_name = 'tampered' where id = ${aLabResultEvent}`;
    });
  } catch {
    labResultEventUpdateBlocked = true;
  }
  check(
    "application role cannot rewrite lab result evidence",
    labResultEventUpdateBlocked,
  );

  let crossTenantLabEventInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into lab_result_events
        (practice_id, lab_result_id, patient_id, event_type, status_before,
         status_after, result_value, result_flag, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${aId}, ${bLabResult}, ${aPatient}, 'reviewed', 'completed',
          'reviewed', '8.2', 'normal', ${aUser}, 'RLS Admin A', ${randomUUID()}, ${"c".repeat(64)})`;
    });
  } catch {
    crossTenantLabEventInsertBlocked = true;
  }
  check(
    "cross-tenant lab result evidence INSERT is blocked",
    crossTenantLabEventInsertBlocked,
  );

  let crossTenantLabActorBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into lab_result_events
        (practice_id, lab_result_id, patient_id, event_type, status_before,
         status_after, result_value, result_flag, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${aId}, ${aLabResult}, ${aPatient}, 'reviewed', 'completed',
          'reviewed', '12.5', 'normal', ${bUser}, 'RLS Admin B', ${randomUUID()}, ${"d".repeat(64)})`;
    });
  } catch {
    crossTenantLabActorBlocked = true;
  }
  check("cross-tenant lab evidence actor is blocked", crossTenantLabActorBlocked);

  let crossTenantLabAssigneeBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into lab_result_events
        (practice_id, lab_result_id, patient_id, event_type, status_before,
         status_after, result_value, result_flag, follow_up_status, follow_up_assigned_to,
         actor_id, actor_name, operation_id, operation_payload_hash)
        values (${aId}, ${aLabResult}, ${aPatient}, 'follow_up_assigned', 'completed',
          'completed', '12.5', 'normal', 'open', ${bUser}, ${aUser}, 'RLS Admin A',
          ${randomUUID()}, ${"e".repeat(64)})`;
    });
  } catch {
    crossTenantLabAssigneeBlocked = true;
  }
  check(
    "cross-tenant lab follow-up assignee is blocked",
    crossTenantLabAssigneeBlocked,
  );
  const aDispenseCharges = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from dispense_charge_queue where id in (${aDispenseCharge}, ${bDispenseCharge})`;
  });
  check(
    "tenant A sees only A's dispense charge work",
    aDispenseCharges.length === 1 &&
      aDispenseCharges[0]!.id === aDispenseCharge,
  );

  const aPatientMergeEvents = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from patient_merge_events where id in (${aPatientMergeEvent}, ${bPatientMergeEvent})`;
  });
  check(
    "tenant A sees only A's patient merge events",
    aPatientMergeEvents.length === 1 &&
      aPatientMergeEvents[0]!.id === aPatientMergeEvent &&
      aPatientMergeEvents[0]!.practice_id === aId,
  );

  let patientMergeUpdateBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`update patient_merge_events set reason = 'Tampered identity correction.' where id = ${aPatientMergeEvent}`;
    });
  } catch {
    patientMergeUpdateBlocked = true;
  }
  check(
    "application role cannot rewrite patient merge history",
    patientMergeUpdateBlocked,
  );

  let patientMergeDeleteBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`delete from patient_merge_events where id = ${aPatientMergeEvent}`;
    });
  } catch {
    patientMergeDeleteBlocked = true;
  }
  check(
    "application role cannot delete patient merge history",
    patientMergeDeleteBlocked,
  );

  let canonicalRetirementBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into patient_merge_events
        (practice_id, source_patient_id, target_patient_id, client_id,
         performed_by, performed_by_name, reason, operation_id,
         source_snapshot, target_snapshot)
        values (${aId}, ${aMergeTargetPatient}, ${aLineageCandidatePatient}, ${aClient},
          ${aUser}, 'RLS Admin A', 'Canonical patient cannot be retired.',
          ${randomUUID()}, jsonb_build_object('id', ${aMergeTargetPatient}::text),
          jsonb_build_object('id', ${aLineageCandidatePatient}::text))`;
    });
  } catch {
    canonicalRetirementBlocked = true;
  }
  check(
    "canonical patient with incoming aliases cannot be retired",
    canonicalRetirementBlocked,
  );

  let aliasTargetBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into patient_merge_events
        (practice_id, source_patient_id, target_patient_id, client_id,
         performed_by, performed_by_name, reason, operation_id,
         source_snapshot, target_snapshot)
        values (${aId}, ${aLineageCandidatePatient}, ${aPatient}, ${aClient},
          ${aUser}, 'RLS Admin A', 'Merge target cannot already be an alias.',
          ${randomUUID()}, jsonb_build_object('id', ${aLineageCandidatePatient}::text),
          jsonb_build_object('id', ${aPatient}::text))`;
    });
  } catch {
    aliasTargetBlocked = true;
  }
  check("merge alias cannot be used as a target", aliasTargetBlocked);

  let dispenseSnapshotUpdateBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`update dispense_charge_queue set quantity = 2 where id = ${aDispenseCharge}`;
    });
  } catch {
    dispenseSnapshotUpdateBlocked = true;
  }
  check(
    "application role cannot rewrite dispense charge snapshots",
    dispenseSnapshotUpdateBlocked,
  );

  let dispenseDeleteBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`delete from dispense_charge_queue where id = ${aDispenseCharge}`;
    });
  } catch {
    dispenseDeleteBlocked = true;
  }
  check(
    "application role cannot delete dispense charge work",
    dispenseDeleteBlocked,
  );

  let prescriptionEventUpdateBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`update prescription_events set actor_name = 'tampered' where id = ${aPrescriptionEvent}`;
    });
  } catch {
    prescriptionEventUpdateBlocked = true;
  }
  check(
    "application role cannot rewrite prescription history",
    prescriptionEventUpdateBlocked,
  );

  let prescriptionEventDeleteBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`delete from prescription_events where id = ${aPrescriptionEvent}`;
    });
  } catch {
    prescriptionEventDeleteBlocked = true;
  }
  check(
    "application role cannot delete prescription history",
    prescriptionEventDeleteBlocked,
  );

  // Tenant B context sees only B's rows.
  const bRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${bId}, true)`;
    return tx`select practice_id from clients where practice_id in (${aId}, ${bId})`;
  });
  check(
    "tenant B sees only B's clients",
    bRows.length === 1 && bRows[0]!.practice_id === bId,
  );

  const aMigrationRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from migration_runs where id in (${aMigrationRun}, ${bMigrationRun})`;
  });
  check(
    "tenant A sees only A's migration run",
    aMigrationRows.length === 1 &&
      aMigrationRows[0]!.id === aMigrationRun &&
      aMigrationRows[0]!.practice_id === aId,
  );
  const aCloseoutRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from visit_closeouts where id in (${aCloseout}, ${bCloseout})`;
  });
  check(
    "tenant A sees only A's visit closeout",
    aCloseoutRows.length === 1 &&
      aCloseoutRows[0]!.id === aCloseout &&
      aCloseoutRows[0]!.practice_id === aId,
  );
  const correctionRls = await owner`
    select c.relrowsecurity as enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'clinical_record_corrections'
  `;
  check(
    "clinical correction ledger has RLS enabled",
    correctionRls.length === 1 && correctionRls[0]!.enabled === true,
  );
  const correctionPrivileges = await owner`
    select
      has_table_privilege('openpims_app', 'clinical_record_corrections', 'SELECT') as can_select,
      has_table_privilege('openpims_app', 'clinical_record_corrections', 'INSERT') as can_insert,
      has_table_privilege('openpims_app', 'clinical_record_corrections', 'UPDATE') as can_update,
      has_table_privilege('openpims_app', 'clinical_record_corrections', 'DELETE') as can_delete
  `;
  check(
    "app role can append/read but cannot mutate correction events",
    correctionPrivileges.length === 1 &&
      correctionPrivileges[0]!.can_select === true &&
      correctionPrivileges[0]!.can_insert === true &&
      correctionPrivileges[0]!.can_update === false &&
      correctionPrivileges[0]!.can_delete === false,
  );

  const patientMergeRls = await owner`
    select c.relrowsecurity as enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'patient_merge_events'
  `;
  check(
    "patient merge ledger has RLS enabled",
    patientMergeRls.length === 1 && patientMergeRls[0]!.enabled === true,
  );
  const patientMergePrivileges = await owner`
    select
      has_table_privilege('openpims_app', 'patient_merge_events', 'SELECT') as can_select,
      has_table_privilege('openpims_app', 'patient_merge_events', 'INSERT') as can_insert,
      has_table_privilege('openpims_app', 'patient_merge_events', 'UPDATE') as can_update,
      has_table_privilege('openpims_app', 'patient_merge_events', 'DELETE') as can_delete
  `;
  check(
    "app role can append/read but cannot mutate patient merge events",
    patientMergePrivileges.length === 1 &&
      patientMergePrivileges[0]!.can_select === true &&
      patientMergePrivileges[0]!.can_insert === true &&
      patientMergePrivileges[0]!.can_update === false &&
      patientMergePrivileges[0]!.can_delete === false,
  );

  let crossTenantPatientMergeInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into patient_merge_events
        (practice_id, source_patient_id, target_patient_id, client_id,
         performed_by, performed_by_name, reason, operation_id,
         source_snapshot, target_snapshot)
        values (${bId}, ${bPatient}, ${bMergeTargetPatient}, ${bClient},
          ${bUser}, 'RLS Admin B', 'Cross-tenant merge must be rejected.',
          ${randomUUID()}, jsonb_build_object('id', ${bPatient}::text),
          jsonb_build_object('id', ${bMergeTargetPatient}::text))`;
    });
  } catch {
    crossTenantPatientMergeInsertBlocked = true;
  }
  check(
    "cross-tenant patient merge INSERT is blocked",
    crossTenantPatientMergeInsertBlocked,
  );

  const hiddenMigrationUpdate = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`update migration_runs set source = 'hidden-update' where id = ${bMigrationRun} returning id`;
  });
  check(
    "tenant A cannot update B's migration run",
    hiddenMigrationUpdate.length === 0,
  );

  let migrationInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into migration_runs
        (practice_id, created_by, mode, source, file_hash, reviewed_plan_hash, file_size_bytes, preview_expires_at)
        values (${bId}, ${bUser}, 'patients', 'other', ${"c".repeat(64)}, ${"e".repeat(64)}, 10, now() + interval '1 day')`;
    });
  } catch {
    migrationInsertBlocked = true;
  }
  check("cross-tenant migration run INSERT is blocked", migrationInsertBlocked);

  // Child tables without practice_id isolate via the parent join policy.
  // invoice_adjustments is the representative (regression: it was missing
  // from enable-rls.sql entirely, leaving it readable across tenants).
  await owner`insert into invoices (id, practice_id, client_id, subtotal, tax, total)
    select i.id, i.practice_id, c.id, 0, 0, 0
    from (values (${aInvoice}::uuid, ${aId}::uuid), (${bInvoice}::uuid, ${bId}::uuid)) as i(id, practice_id)
    join clients c on c.practice_id = i.practice_id`;
  await owner`insert into invoice_adjustments (invoice_id, type, amount) values
    (${aInvoice}, 'credit', 1), (${bInvoice}, 'credit', 2)`;
  const aAdj = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select invoice_id from invoice_adjustments where invoice_id in (${aInvoice}, ${bInvoice})`;
  });
  check(
    "tenant A sees only A's invoice adjustments (child join policy)",
    aAdj.length === 1 && aAdj[0]!.invoice_id === aInvoice,
  );

  // Cross-tenant WRITE is rejected by the WITH CHECK clause.
  let writeBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into clients (practice_id, first_name, last_name) values (${bId}, 'Evil', 'X')`;
    });
  } catch {
    writeBlocked = true;
  }
  check("cross-tenant INSERT is blocked", writeBlocked);

  // No tenant context → deny by default.
  const noneRows =
    await app`select practice_id from clients where practice_id in (${aId}, ${bId})`;
  check("no tenant context → zero rows", noneRows.length === 0);
  const noContextMigrationRows =
    await app`select id from migration_runs where id in (${aMigrationRun}, ${bMigrationRun})`;
  check(
    "no tenant context hides migration runs",
    noContextMigrationRows.length === 0,
  );

  // Product analytics is system-only even with a valid tenant context. The
  // public ingestion route writes under an explicit system transaction.
  const hiddenFunnelRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from funnel_events where id = ${funnelEventId}`;
  });
  check(
    "tenant context cannot read system-only funnel events",
    hiddenFunnelRows.length === 0,
  );
  const hiddenConversionRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select practice_id from practice_conversion_milestones where practice_id = ${aId}`;
  });
  check(
    "tenant context cannot read system-only conversion milestones",
    hiddenConversionRows.length === 0,
  );

  // System bypass sees both (for cron / platform admin).
  const allRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select practice_id from clients where practice_id in (${aId}, ${bId})`;
  });
  check("system bypass sees both practices", allRows.length === 2);
  const allMigrationRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select id from migration_runs where id in (${aMigrationRun}, ${bMigrationRun})`;
  });
  check(
    "system bypass sees both migration runs",
    allMigrationRows.length === 2,
  );
  const systemFunnelRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select id from funnel_events where id = ${funnelEventId}`;
  });
  check("system bypass can read funnel events", systemFunnelRows.length === 1);
  const systemConversionRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select practice_id from practice_conversion_milestones where practice_id = ${aId}`;
  });
  check(
    "system bypass can read conversion milestones",
    systemConversionRows.length === 1,
  );

  let bypassCannotDeletePrescriptionHistory = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`delete from prescription_events where id = ${aPrescriptionEvent}`;
    });
  } catch {
    bypassCannotDeletePrescriptionHistory = true;
  }
  check(
    "application role cannot delete prescription history even with bypass GUCs",
    bypassCannotDeletePrescriptionHistory,
  );

  let bypassCannotDeleteDeliveryEvidence = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`delete from sms_delivery_events where id = ${aSmsDeliveryEvent}`;
    });
  } catch {
    bypassCannotDeleteDeliveryEvidence = true;
  }
  check(
    "application role cannot mutate delivery evidence even with bypass GUCs",
    bypassCannotDeleteDeliveryEvidence,
  );

  let bypassCannotDeleteLabEvidence = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`delete from lab_result_events where id = ${aLabResultEvent}`;
    });
  } catch {
    bypassCannotDeleteLabEvidence = true;
  }
  check(
    "application role cannot delete lab evidence even with bypass GUCs",
    bypassCannotDeleteLabEvidence,
  );
} catch (err) {
  console.error("Unexpected error:", err);
  failures++;
} finally {
  // Cleanup (as owner).
  await owner.begin(async (tx) => {
    const cleanup = tx as unknown as typeof owner;
    await cleanup`select set_config('app.ledger_maintenance', 'on', true)`;
    await cleanup`delete from sms_delivery_event_history where id in (${aSmsDeliveryHistory}, ${bSmsDeliveryHistory}, ${bSmsDeliveryConflictHistory})`;
    await cleanup`delete from sms_delivery_events where id in (${aSmsDeliveryEvent}, ${bSmsDeliveryEvent}, ${unmatchedSmsDeliveryEvent})`;
    await cleanup`delete from lab_result_events where id in (${aLabResultEvent}, ${bLabResultEvent})`;
    await cleanup`delete from lab_results where id in (${aLabResult}, ${bLabResult})`;
    await cleanup`delete from sms_send_attempt_events where id in (${aSmsSendAttemptEvent}, ${bSmsSendAttemptEvent}, ${aAppSmsSendAttemptEvent})`;
    await cleanup`delete from sms_send_attempts where id in (${aSmsSendAttempt}, ${bSmsSendAttempt}, ${aAppSmsSendAttempt})`;
    await cleanup`delete from sms_consent_events where id in (${aSmsConsentEvent}, ${bSmsConsentEvent})`;
    await cleanup`delete from communications where id in (${aCommunication}, ${bCommunication})`;
    await cleanup`delete from patient_merge_events where id in (${aPatientMergeEvent}, ${bPatientMergeEvent})`;
    await cleanup`delete from dispense_charge_queue where id in (${aDispenseCharge}, ${bDispenseCharge})`;
    await cleanup`delete from invoice_adjustments where invoice_id in (${aInvoice}, ${bInvoice})`;
    await cleanup`delete from prescription_events where id in (${aPrescriptionEvent}, ${bPrescriptionEvent})`;
    await cleanup`delete from visit_closeouts where id in (${aCloseout}, ${bCloseout})`;
    await cleanup`delete from funnel_events where id = ${funnelEventId}`;
    await cleanup`delete from practice_conversion_milestones where practice_id = ${aId}`;
    await cleanup`delete from invoices where id in (${aInvoice}, ${bInvoice})`;
    await cleanup`delete from migration_runs where id in (${aMigrationRun}, ${bMigrationRun})`;
    await cleanup`delete from appointments where id in (${aAppointment}, ${bAppointment})`;
    await cleanup`delete from prescriptions where id in (${aPrescription}, ${bPrescription})`;
    await cleanup`delete from products where id in (${aProduct}, ${bProduct})`;
    await cleanup`delete from patients where id in (${aPatient}, ${bPatient}, ${aMergeTargetPatient}, ${bMergeTargetPatient}, ${aLineageCandidatePatient})`;
    await cleanup`delete from clients where practice_id in (${aId}, ${bId})`;
    await cleanup`delete from users where id in (${aUser}, ${bUser})`;
    await cleanup`delete from practices where id in (${aId}, ${bId})`;
  });
  await owner.end();
  await app.end();
}

if (failures > 0) {
  console.error(`\n✗ ${failures} RLS check(s) FAILED`);
  process.exit(1);
}
console.log("\n✓ All RLS isolation checks passed.");
