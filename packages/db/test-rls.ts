/**
 * Live Row-Level Security verification. Connects as the least-privilege
 * `openpims_app` role and proves tenant isolation against a real database.
 *
 * Run with: pnpm db:rls:test   (requires the DB up + pnpm db:rls applied)
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import postgres from "postgres";
import { createHash, randomUUID } from "crypto";

function soapAddendumPayloadHash(
  noteId: string,
  authorId: string,
  content: string,
) {
  return createHash("sha256")
    .update(JSON.stringify({ noteId, authorId, content }))
    .digest("hex");
}

function soapReplacementPayloadHash(input: {
  patientId: string;
  sourceNoteId: string;
  actorId: string;
  reason: string;
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
  plan?: string | null;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        patientId: input.patientId,
        sourceNoteId: input.sourceNoteId,
        actorId: input.actorId,
        reason: input.reason,
        subjective: input.subjective ?? null,
        objective: input.objective ?? null,
        assessment: input.assessment ?? null,
        plan: input.plan ?? null,
      }),
    )
    .digest("hex");
}

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
const aLocation = randomUUID();
const aAltLocation = randomUUID();
const bLocation = randomUUID();
const aRoom = randomUUID();
const bRoom = randomUUID();
const aStaffSchedule = randomUUID();
const bStaffSchedule = randomUUID();
const aMigrationRun = randomUUID();
const bMigrationRun = randomUUID();
const aAppointment = randomUUID();
const bAppointment = randomUUID();
const aCloseout = randomUUID();
const bCloseout = randomUUID();
const aSoapLegalAppointment = randomUUID();
const bSoapLegalAppointment = randomUUID();
const aSoapDraftFinalAppointment = randomUUID();
const aSoapDoubleFinalAppointment = randomUUID();
const aSoapDiscardAppointment = randomUUID();
const aSoapSource = randomUUID();
const aSoapReplacement = randomUUID();
const aSoapDeletedSource = randomUUID();
const aSoapCorrection = randomUUID();
const bSoapSource = randomUUID();
const bSoapReplacement = randomUUID();
const bSoapCorrection = randomUUID();
const aSoapReplacementEvidence = randomUUID();
const bSoapReplacementEvidence = randomUUID();
const aHistoricalSoapSource = randomUUID();
const aHistoricalSoapReplacement = randomUUID();
const aHistoricalSoapSourceCorrection = randomUUID();
const aHistoricalSoapReplacementCorrection = randomUUID();
const aHistoricalSoapReplacementEvidence = randomUUID();
const aHistoricalSoapReplacementOperation = randomUUID();
const aSoapAddendum = randomUUID();
const aSoapRestoreAddendum = randomUUID();
const aSoapDeletedRestoreAddendum = randomUUID();
const aSoapDraft = randomUUID();
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
const aReplacementLabResult = randomUUID();
const bReplacementLabResult = randomUUID();
const aLabCorrection = randomUUID();
const bLabCorrection = randomUUID();
const aLabReplacement = randomUUID();
const bLabReplacement = randomUUID();
const aLabResultEvent = randomUUID();
const bLabResultEvent = randomUUID();
const aAppSmsSendAttempt = randomUUID();
const aAppSmsSendAttemptEvent = randomUUID();
const aAuthEmailAttempt = randomUUID();
const aTransitionAuthEmailAttempt = randomUUID();
const aRepairAuthEmailAttempt = randomUUID();
const aAuthEmailDeliveryEvent = randomUUID();
const aAuthEmailWebhookConflict = randomUUID();
const aAuthEmailProviderIdentityConflict = randomUUID();
const aAppAuthEmailProviderIdentityConflict = randomUUID();
const aSmsDeliveryEvent = randomUUID();
const bSmsDeliveryEvent = randomUUID();
const unmatchedSmsDeliveryEvent = randomUUID();
const aSmsDeliveryHistory = randomUUID();
const bSmsDeliveryHistory = randomUUID();
const bSmsDeliveryConflictHistory = randomUUID();
const funnelEventId = randomUUID();
const platformEmailPreferenceId = randomUUID();
const systemUpsertPlatformEmailPreferenceId = randomUUID();
const platformEmailPreferenceEventId = randomUUID();
const systemPlatformEmailPreferenceEventId = randomUUID();
const platformEmailHash = "c".repeat(64);
const platformEmailIdentityFingerprint = "d".repeat(64);
const conversionEvidenceKey = `practice:${aId}`;
const aSoapCorrectionReason =
  "Original note was documented on the wrong encounter.";
const bSoapCorrectionReason =
  "Original note B requires a legally retained replacement.";
const historicalSoapSourceReason =
  'Historical source correction: owner reported "wrong chart".\nRetain lineage.';
const historicalSoapReplacementReason =
  "Historical replacement later entered in error.";
const historicalSoapReplacementSubjective =
  'Restored replacement quote: "improved".\nDose remains ½ tablet 🐾';
const historicalSoapOccurredAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
const historicalSoapDeletedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
let failures = 0;
let createdPlatformEmailIdentity = false;

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
  const insertedPlatformEmailIdentity =
    await owner`insert into platform_email_identity
    (key_slot, identity_key_fingerprint)
    values (1, ${platformEmailIdentityFingerprint})
    on conflict (key_slot) do nothing
    returning key_slot`;
  createdPlatformEmailIdentity = insertedPlatformEmailIdentity.length === 1;
  await owner`insert into platform_email_preferences
    (id, email_hash, identity_key_fingerprint, marketing_enabled, source, reason)
    values (${platformEmailPreferenceId}, ${platformEmailHash},
      ${platformEmailIdentityFingerprint}, false, 'unsubscribe_link', 'unsubscribe')`;
  await owner`insert into platform_email_preference_events
    (id, email_hash, identity_key_fingerprint, requested_marketing_enabled,
      applied, source, reason)
    values (${platformEmailPreferenceEventId}, ${platformEmailHash},
      ${platformEmailIdentityFingerprint}, false, true,
      'unsubscribe_link', 'unsubscribe')`;
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
  await owner`insert into locations (id, practice_id, name, is_primary) values
    (${aLocation}, ${aId}, 'RLS Location A', true),
    (${aAltLocation}, ${aId}, 'RLS Location A North', false),
    (${bLocation}, ${bId}, 'RLS Location B', true)`;
  await owner`insert into rooms (id, practice_id, location_id, name) values
    (${aRoom}, ${aId}, ${aLocation}, 'RLS Exam A'),
    (${bRoom}, ${bId}, ${bLocation}, 'RLS Exam B')`;
  await owner`insert into staff_schedules
    (id, practice_id, user_id, location_id, day_of_week, start_time, end_time)
    values
    (${aStaffSchedule}, ${aId}, ${aUser}, ${aLocation}, 1, '08:00', '17:00'),
    (${bStaffSchedule}, ${bId}, ${bUser}, ${bLocation}, 1, '08:00', '17:00')`;
  await owner`insert into auth_email_attempts
    (id, resolved_at, practice_id, user_id, source, idempotency_key,
     provider_message_id, outcome)
    values
    (${aAuthEmailAttempt}, now(), ${aId}, ${aUser}, 'registration',
      ${`rls-auth:${aAuthEmailAttempt}`}, ${`resend-${aAuthEmailAttempt}`},
      'accepted')`;
  await owner`insert into auth_email_delivery_events
    (id, webhook_id, raw_body_fingerprint, provider_message_id, attempt_id, event_type,
     classification, attribution, occurred_at)
    values
    (${aAuthEmailDeliveryEvent}, ${`svix-${aAuthEmailDeliveryEvent}`},
      ${"a".repeat(64)},
      ${`resend-${aAuthEmailAttempt}`}, ${aAuthEmailAttempt},
      'email.delivered', 'delivered', 'attempt_tag', now())`;
  await owner`insert into auth_email_webhook_conflicts
    (id, original_webhook_id, incoming_raw_body_fingerprint,
     incoming_provider_message_id, incoming_event_type)
    values
    (${aAuthEmailWebhookConflict}, ${`svix-${aAuthEmailDeliveryEvent}`},
      ${"b".repeat(64)}, ${`resend-conflict-${aAuthEmailAttempt}`},
      'email.failed')`;
  await owner`insert into auth_email_provider_identity_conflicts
    (id, attempt_id, provider, source, durable_provider_message_id,
     conflicting_provider_message_id)
    values
    (${aAuthEmailProviderIdentityConflict}, ${aAuthEmailAttempt}, 'resend',
      'registration', ${`resend-${aAuthEmailAttempt}`},
      ${`resend-conflict-${aAuthEmailAttempt}`})`;
  await owner`insert into auth_email_attempts
    (id, practice_id, user_id, source, provider, idempotency_key)
    values
    (${aTransitionAuthEmailAttempt}, ${aId}, ${aUser}, 'authenticated_resend',
      'console', ${`rls-auth:${aTransitionAuthEmailAttempt}`})`;
  await owner`insert into auth_email_attempts
    (id, practice_id, user_id, source, provider, idempotency_key,
     outcome, resolved_at, failure_code)
    values
    (${aRepairAuthEmailAttempt}, ${aId}, ${aUser}, 'authenticated_resend',
      'resend', ${`rls-auth:${aRepairAuthEmailAttempt}`},
      'outcome_unknown', now(), 'send_timeout')`;
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
    (${bLabResult}, ${bId}, ${bPatient}, 'RLS CBC B', '8.2', 'completed', now(), ${bUser}),
    (${aReplacementLabResult}, ${aId}, ${aPatient}, 'RLS CBC A replacement', null, 'pending', null, ${aUser}),
    (${bReplacementLabResult}, ${bId}, ${bPatient}, 'RLS CBC B replacement', null, 'pending', null, ${bUser})`;
  await owner`insert into lab_result_events
    (id, practice_id, lab_result_id, patient_id, event_type, status_before,
     status_after, result_value, result_flag, actor_id, actor_name, operation_id,
     operation_payload_hash)
    values
    (${aLabResultEvent}, ${aId}, ${aLabResult}, ${aPatient}, 'completed', 'pending',
      'completed', '12.5', 'normal', ${aUser}, 'RLS Admin A', ${randomUUID()}, ${"a".repeat(64)}),
    (${bLabResultEvent}, ${bId}, ${bLabResult}, ${bPatient}, 'completed', 'pending',
      'completed', '8.2', 'normal', ${bUser}, 'RLS Admin B', ${randomUUID()}, ${"b".repeat(64)})`;
  const aCorrectionOperation = randomUUID();
  const bCorrectionOperation = randomUUID();
  await owner`insert into clinical_record_corrections
    (id, practice_id, record_type, lab_result_id, patient_id, reason,
     corrected_by, corrected_by_name, operation_id, operation_payload_hash)
    values
    (${aLabCorrection}, ${aId}, 'lab_result', ${aLabResult}, ${aPatient},
      'RLS correction A.', ${aUser}, 'RLS Admin A', ${aCorrectionOperation}, ${"c".repeat(64)}),
    (${bLabCorrection}, ${bId}, 'lab_result', ${bLabResult}, ${bPatient},
      'RLS correction B.', ${bUser}, 'RLS Admin B', ${bCorrectionOperation}, ${"d".repeat(64)})`;
  await owner`insert into lab_result_replacements
    (id, practice_id, correction_id, source_lab_result_id,
     replacement_lab_result_id, actor_id, actor_name, operation_id,
     operation_payload_hash)
    values
    (${aLabReplacement}, ${aId}, ${aLabCorrection}, ${aLabResult},
      ${aReplacementLabResult}, ${aUser}, 'RLS Admin A', ${randomUUID()}, ${"e".repeat(64)}),
    (${bLabReplacement}, ${bId}, ${bLabCorrection}, ${bLabResult},
      ${bReplacementLabResult}, ${bUser}, 'RLS Admin B', ${randomUUID()}, ${"f".repeat(64)})`;
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
  await owner`insert into appointments (id, practice_id, location_id, room_id, client_id, start_time, end_time)
    select ${aAppointment}::uuid, ${aId}::uuid, ${aLocation}::uuid, ${aRoom}::uuid, id, now(), now() + interval '30 minutes'
    from clients where practice_id = ${aId}
    union all
    select ${bAppointment}::uuid, ${bId}::uuid, ${bLocation}::uuid, ${bRoom}::uuid, id, now(), now() + interval '30 minutes'
    from clients where practice_id = ${bId}`;
  await owner`insert into visit_closeouts (id, practice_id, appointment_id)
    values (${aCloseout}, ${aId}, ${aAppointment}), (${bCloseout}, ${bId}, ${bAppointment})`;
  await owner`insert into appointments
    (id, practice_id, location_id, client_id, patient_id, start_time, end_time, status)
    values
    (${aSoapLegalAppointment}, ${aId}, ${aLocation}, ${aClient}, ${aPatient}, now(), now() + interval '30 minutes', 'in_exam'),
    (${bSoapLegalAppointment}, ${bId}, ${bLocation}, ${bClient}, ${bPatient}, now(), now() + interval '30 minutes', 'in_exam'),
    (${aSoapDraftFinalAppointment}, ${aId}, ${aLocation}, ${aClient}, ${aPatient}, now(), now() + interval '30 minutes', 'in_exam'),
    (${aSoapDoubleFinalAppointment}, ${aId}, ${aLocation}, ${aClient}, ${aPatient}, now(), now() + interval '30 minutes', 'in_exam'),
    (${aSoapDiscardAppointment}, ${aId}, ${aLocation}, ${aClient}, ${aPatient}, now(), now() + interval '30 minutes', 'in_exam')`;

  let correctedReplacementTransactionAllowed = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_notes
        (id, practice_id, patient_id, appointment_id, author_id, author_name,
         status, revision, finalized_at, finalized_by, finalizer_name,
         subjective, imported)
        values
        (${aSoapSource}, ${aId}, ${aPatient}, ${aSoapLegalAppointment},
          ${aUser}, 'RLS Admin A', 'finalized', 1, now() - interval '2 hours', ${aUser},
          'RLS Admin A', 'Original SOAP', false),
        (${aSoapReplacement}, ${aId}, ${aPatient}, ${aSoapLegalAppointment},
          ${aUser}, 'RLS Admin A', 'finalized', 1, now(), ${aUser},
          'RLS Admin A', 'Replacement SOAP', false)`;
      await tx`insert into clinical_record_corrections
        (id, created_at, practice_id, record_type, action, soap_note_id, patient_id,
         appointment_id, reason, corrected_by, corrected_by_name)
        values (${aSoapCorrection}, now(), ${aId}, 'soap_note', 'entered_in_error',
          ${aSoapSource}, ${aPatient}, ${aSoapLegalAppointment},
          ${aSoapCorrectionReason}, ${aUser},
          'RLS Admin A')`;
      await tx`insert into soap_note_replacements
        (id, practice_id, correction_id, source_soap_note_id,
         replacement_soap_note_id, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${aSoapReplacementEvidence}, ${aId}, ${aSoapCorrection},
          ${aSoapSource}, ${aSoapReplacement}, ${aUser}, 'RLS Admin A',
          ${randomUUID()}, ${soapReplacementPayloadHash({
            patientId: aPatient,
            sourceNoteId: aSoapSource,
            actorId: aUser,
            reason: aSoapCorrectionReason,
            subjective: "Replacement SOAP",
          })})`;
    });
    correctedReplacementTransactionAllowed = true;
  } catch {
    correctedReplacementTransactionAllowed = false;
  }
  check(
    "corrected source, replacement SOAP, and lineage can commit atomically",
    correctedReplacementTransactionAllowed,
  );

  let ordinarySoapReplacementHashMismatchBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_note_replacements
        (practice_id, correction_id, source_soap_note_id,
         replacement_soap_note_id, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${aId}, ${aSoapCorrection}, ${aSoapSource},
          ${aSoapReplacement}, ${aUser}, 'RLS Admin A', ${randomUUID()},
          ${"0".repeat(64)})`;
    });
  } catch (error) {
    ordinarySoapReplacementHashMismatchBlocked = String(error).includes(
      "SOAP replacement payload hash is invalid.",
    );
  }
  check(
    "ordinary SOAP replacement INSERT rejects a mismatched exact payload hash",
    ordinarySoapReplacementHashMismatchBlocked,
  );

  await owner.begin(async (tx) => {
    const setup = tx as unknown as typeof owner;
    await setup`insert into soap_notes
      (id, practice_id, patient_id, appointment_id, author_id, author_name,
       status, revision, finalized_at, finalized_by, finalizer_name,
       subjective, imported)
      values
      (${bSoapSource}, ${bId}, ${bPatient}, ${bSoapLegalAppointment}, ${bUser},
        'RLS Admin B', 'finalized', 1, now() - interval '2 hours', ${bUser},
        'RLS Admin B', 'Original SOAP B', false),
      (${bSoapReplacement}, ${bId}, ${bPatient}, ${bSoapLegalAppointment}, ${bUser},
        'RLS Admin B', 'finalized', 1, now(), ${bUser}, 'RLS Admin B',
        'Replacement SOAP B', false)`;
    await setup`insert into clinical_record_corrections
      (id, practice_id, record_type, action, soap_note_id, patient_id,
       appointment_id, reason, corrected_by, corrected_by_name)
      values (${bSoapCorrection}, ${bId}, 'soap_note', 'entered_in_error',
        ${bSoapSource}, ${bPatient}, ${bSoapLegalAppointment},
        ${bSoapCorrectionReason}, ${bUser},
        'RLS Admin B')`;
    await setup`insert into soap_note_replacements
      (id, practice_id, correction_id, source_soap_note_id,
       replacement_soap_note_id, actor_id, actor_name, operation_id,
       operation_payload_hash)
      values (${bSoapReplacementEvidence}, ${bId}, ${bSoapCorrection},
        ${bSoapSource}, ${bSoapReplacement}, ${bUser}, 'RLS Admin B',
        ${randomUUID()}, ${soapReplacementPayloadHash({
          patientId: bPatient,
          sourceNoteId: bSoapSource,
          actorId: bUser,
          reason: bSoapCorrectionReason,
          subjective: "Replacement SOAP B",
        })})`;
  });

  await owner`insert into soap_notes
    (id, created_at, updated_at, deleted_at, practice_id, patient_id,
     appointment_id, author_id, author_name, status, revision, finalized_at,
     finalized_by, finalizer_name, subjective, imported)
    values (${aSoapDeletedSource}, now() - interval '2 hours',
      now() - interval '1 hour', now() - interval '1 hour', ${aId},
      ${aPatient}, null, ${aUser}, 'RLS Admin A', 'finalized', 1,
      now() - interval '2 hours', ${aUser}, 'RLS Admin A',
      'Retired finalized SOAP', false)`;

  await owner`insert into soap_notes
    (id, created_at, updated_at, deleted_at, practice_id, patient_id,
     appointment_id, author_id, author_name, status, revision, finalized_at,
     finalized_by, finalizer_name, subjective, imported)
    values
    (${aHistoricalSoapSource}, ${historicalSoapOccurredAt},
      ${historicalSoapDeletedAt}, ${historicalSoapDeletedAt}, ${aId},
      ${aPatient}, null, ${aUser}, 'RLS Admin A', 'finalized', 1,
      ${historicalSoapOccurredAt}, ${aUser}, 'RLS Admin A',
      'Historical source SOAP', false),
    (${aHistoricalSoapReplacement}, ${historicalSoapOccurredAt},
      ${historicalSoapDeletedAt}, ${historicalSoapDeletedAt}, ${aId},
      ${aPatient}, null, ${aUser}, 'RLS Admin A', 'finalized', 1,
      ${historicalSoapOccurredAt}, ${aUser}, 'RLS Admin A',
      ${historicalSoapReplacementSubjective}, false)`;
  await owner`insert into clinical_record_corrections
    (id, created_at, practice_id, record_type, action, soap_note_id, patient_id,
     appointment_id, reason, corrected_by, corrected_by_name)
    values
    (${aHistoricalSoapSourceCorrection}, ${historicalSoapOccurredAt}, ${aId},
      'soap_note', 'entered_in_error', ${aHistoricalSoapSource}, ${aPatient},
      null, ${historicalSoapSourceReason}, ${aUser}, 'RLS Admin A'),
    (${aHistoricalSoapReplacementCorrection}, ${historicalSoapOccurredAt}, ${aId},
      'soap_note', 'entered_in_error', ${aHistoricalSoapReplacement}, ${aPatient},
      null, ${historicalSoapReplacementReason}, ${aUser}, 'RLS Admin A')`;

  let draftAndFinalBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_notes
        (practice_id, patient_id, appointment_id, author_id, author_name,
         status, revision, subjective, imported)
        values (${aId}, ${aPatient}, ${aSoapDraftFinalAppointment}, ${aUser},
          'RLS Admin A', 'draft', 1, 'Draft SOAP', false)`;
      await tx`insert into soap_notes
        (practice_id, patient_id, appointment_id, author_id, author_name,
         status, revision, finalized_at, finalized_by, finalizer_name,
         subjective, imported)
        values (${aId}, ${aPatient}, ${aSoapDraftFinalAppointment}, ${aUser},
          'RLS Admin A', 'finalized', 1, now(), ${aUser}, 'RLS Admin A',
          'Final SOAP', false)`;
    });
  } catch {
    draftAndFinalBlocked = true;
  }
  check(
    "deferred SOAP invariant rejects a draft plus effective final",
    draftAndFinalBlocked,
  );

  let twoEffectiveFinalsBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_notes
        (practice_id, patient_id, appointment_id, author_id, author_name,
         status, revision, finalized_at, finalized_by, finalizer_name,
         subjective, imported)
        values
        (${aId}, ${aPatient}, ${aSoapDoubleFinalAppointment}, ${aUser},
          'RLS Admin A', 'finalized', 1, now(), ${aUser}, 'RLS Admin A',
          'First final', false),
        (${aId}, ${aPatient}, ${aSoapDoubleFinalAppointment}, ${aUser},
          'RLS Admin A', 'finalized', 1, now(), ${aUser}, 'RLS Admin A',
          'Second final', false)`;
    });
  } catch {
    twoEffectiveFinalsBlocked = true;
  }
  check(
    "deferred SOAP invariant rejects two effective finals",
    twoEffectiveFinalsBlocked,
  );

  let openDraftDiscardAllowed = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_notes
        (id, practice_id, patient_id, appointment_id, author_id, author_name,
         status, revision, subjective, imported)
        values (${aSoapDraft}, ${aId}, ${aPatient}, ${aSoapDiscardAppointment},
          ${aUser}, 'RLS Admin A', 'draft', 1, 'Discard me', false)`;
      await tx`delete from soap_notes where id = ${aSoapDraft}`;
    });
    openDraftDiscardAllowed = true;
  } catch {
    openDraftDiscardAllowed = false;
  }
  check(
    "open unsigned encounter draft can be discarded",
    openDraftDiscardAllowed,
  );

  await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    await tx`insert into soap_notes
      (id, practice_id, patient_id, appointment_id, author_id, author_name,
       status, revision, subjective, imported)
      values (${aSoapDraft}, ${aId}, ${aPatient}, ${aSoapDiscardAppointment},
        ${aUser}, 'RLS Admin A', 'draft', 1, 'Cannot discard later', false)`;
  });
  await owner`update appointments set status = 'checked_out' where id = ${aSoapDiscardAppointment}`;
  let closedDraftDiscardBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`delete from soap_notes where id = ${aSoapDraft}`;
    });
  } catch {
    closedDraftDiscardBlocked = true;
  }
  check(
    "closed encounter draft cannot be discarded by the app role",
    closedDraftDiscardBlocked,
  );

  const addendumContent = 'Owner said "8 AM".\nDose unchanged — café 🐾';
  const addendumHash = soapAddendumPayloadHash(
    aSoapReplacement,
    aUser,
    addendumContent,
  );
  await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    await tx`insert into soap_note_addenda
      (id, practice_id, soap_note_id, author_id, author_name, content,
       operation_id, operation_payload_hash)
      values (${aSoapAddendum}, ${aId}, ${aSoapReplacement}, ${aUser},
        'RLS Admin A', ${addendumContent}, ${randomUUID()}, ${addendumHash})`;
  });
  let crossTenantAddendumBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_note_addenda
        (practice_id, soap_note_id, author_id, author_name, content,
         operation_id, operation_payload_hash)
        values (${bId}, ${aSoapReplacement}, ${bUser}, 'RLS Admin B',
          'Cross tenant', ${randomUUID()}, ${"b".repeat(64)})`;
    });
  } catch {
    crossTenantAddendumBlocked = true;
  }
  check(
    "cross-tenant SOAP addendum insert is blocked",
    crossTenantAddendumBlocked,
  );

  let invalidAddendumHashBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_note_addenda
        (practice_id, soap_note_id, author_id, author_name, content,
         operation_id, operation_payload_hash)
        values (${aId}, ${aSoapReplacement}, ${aUser}, 'RLS Admin A',
          'Hash tampering attempt', ${randomUUID()}, ${"0".repeat(64)})`;
    });
  } catch {
    invalidAddendumHashBlocked = true;
  }
  check(
    "ordinary SOAP addendum insert rejects a mismatched payload hash",
    invalidAddendumHashBlocked,
  );

  let addendumUpdateBlocked = false;
  let addendumDeleteBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`update soap_note_addenda set content = 'Tampered' where id = ${aSoapAddendum}`;
    });
  } catch {
    addendumUpdateBlocked = true;
  }
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`delete from soap_note_addenda where id = ${aSoapAddendum}`;
    });
  } catch {
    addendumDeleteBlocked = true;
  }
  check(
    "SOAP addenda cannot be updated or deleted by the app role",
    addendumUpdateBlocked && addendumDeleteBlocked,
  );

  let attributedRestoreAllowed = false;
  const restoredContent =
    'Restored owner quote: "yes".\nDose remains ½ tablet 🐾';
  const restoredHash = soapAddendumPayloadHash(
    aSoapSource,
    aUser,
    restoredContent,
  );
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_addendum(
        ${aSoapRestoreAddendum}, now() - interval '90 minutes', ${aId}, ${aSoapSource}, ${aUser},
        'RLS Admin A', ${restoredContent}, ${randomUUID()}, ${restoredHash})`;
    });
    attributedRestoreAllowed = true;
  } catch {
    attributedRestoreAllowed = false;
  }
  check(
    "same-tenant restore retains addendum evidence for a corrected final SOAP",
    attributedRestoreAllowed,
  );

  const deletedBoundaryContent = "Clarification before record retirement";
  let preDeletionRestoreAllowed = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_addendum(
        ${aSoapDeletedRestoreAddendum}, now() - interval '90 minutes', ${aId},
        ${aSoapDeletedSource}, ${aUser}, 'RLS Admin A', ${deletedBoundaryContent},
        ${randomUUID()},
        ${soapAddendumPayloadHash(aSoapDeletedSource, aUser, deletedBoundaryContent)})`;
    });
    preDeletionRestoreAllowed = true;
  } catch {
    preDeletionRestoreAllowed = false;
  }
  check(
    "SOAP addendum restore accepts evidence before source deletion",
    preDeletionRestoreAllowed,
  );

  const postDeletionContent = "Clarification after record retirement";
  let postDeletionRestoreBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_addendum(
        ${randomUUID()}, now() - interval '30 minutes', ${aId},
        ${aSoapDeletedSource}, ${aUser}, 'RLS Admin A', ${postDeletionContent},
        ${randomUUID()},
        ${soapAddendumPayloadHash(aSoapDeletedSource, aUser, postDeletionContent)})`;
    });
  } catch {
    postDeletionRestoreBlocked = true;
  }
  check(
    "SOAP addendum restore rejects nonfuture evidence after source deletion",
    postDeletionRestoreBlocked,
  );

  const preFinalContent = "Predates finalization";
  let preFinalRestoreBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_addendum(
        ${randomUUID()}, now() - interval '3 hours', ${aId}, ${aSoapSource}, ${aUser},
        'RLS Admin A', ${preFinalContent}, ${randomUUID()},
        ${soapAddendumPayloadHash(aSoapSource, aUser, preFinalContent)})`;
    });
  } catch {
    preFinalRestoreBlocked = true;
  }
  check(
    "SOAP addendum restore rejects evidence before finalization",
    preFinalRestoreBlocked,
  );

  const futureContent = "Future-dated evidence";
  let futureRestoreBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_addendum(
        ${randomUUID()}, now() + interval '1 hour', ${aId}, ${aSoapSource}, ${aUser},
        'RLS Admin A', ${futureContent}, ${randomUUID()},
        ${soapAddendumPayloadHash(aSoapSource, aUser, futureContent)})`;
    });
  } catch {
    futureRestoreBlocked = true;
  }
  check(
    "SOAP addendum restore rejects future-dated evidence",
    futureRestoreBlocked,
  );

  const postCorrectionContent = "Recorded after correction";
  let postCorrectionRestoreBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_addendum(
        ${randomUUID()}, (
          select created_at + interval '1 millisecond'
          from clinical_record_corrections
          where id = ${aSoapCorrection}
        ), ${aId}, ${aSoapSource}, ${aUser},
        'RLS Admin A', ${postCorrectionContent}, ${randomUUID()},
        ${soapAddendumPayloadHash(aSoapSource, aUser, postCorrectionContent)})`;
    });
  } catch {
    postCorrectionRestoreBlocked = true;
  }
  check(
    "SOAP addendum restore rejects evidence after correction",
    postCorrectionRestoreBlocked,
  );

  let mismatchedRestoreHashBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_addendum(
        ${randomUUID()}, now() - interval '90 minutes', ${aId}, ${aSoapSource}, ${aUser},
        'RLS Admin A', 'Mismatched restore hash', ${randomUUID()}, ${"0".repeat(64)})`;
    });
  } catch {
    mismatchedRestoreHashBlocked = true;
  }
  check(
    "SOAP addendum restore rejects a mismatched payload hash",
    mismatchedRestoreHashBlocked,
  );

  let crossTenantRestoreBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_addendum(
        ${randomUUID()}, now(), ${bId}, ${aSoapSource}, ${bUser},
        'RLS Admin B', 'Cross-tenant restore', ${randomUUID()}, ${"d".repeat(64)})`;
    });
  } catch {
    crossTenantRestoreBlocked = true;
  }
  check(
    "cross-tenant SOAP addendum restore is blocked",
    crossTenantRestoreBlocked,
  );

  let spoofedRestoreBypassBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${bId}, true)`;
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`select public.restore_soap_note_addendum(
        ${randomUUID()}, now(), ${aId}, ${aSoapSource}, ${aUser},
        'RLS Admin A', 'Spoofed bypass restore', ${randomUUID()}, ${"e".repeat(64)})`;
    });
  } catch {
    spoofedRestoreBypassBlocked = true;
  }
  check(
    "SOAP addendum restore cannot spoof tenant bypass GUCs",
    spoofedRestoreBypassBlocked,
  );

  const historicalSoapHash = soapReplacementPayloadHash({
    patientId: aPatient,
    sourceNoteId: aHistoricalSoapSource,
    actorId: aUser,
    reason: historicalSoapSourceReason,
    subjective: historicalSoapReplacementSubjective,
  });
  let ordinaryHistoricalReplacementBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select set_config('app.soap_replacement_restore', 'on', true)`;
      await tx`insert into soap_note_replacements
        (id, created_at, practice_id, correction_id, source_soap_note_id,
         replacement_soap_note_id, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${aHistoricalSoapReplacementEvidence}, ${historicalSoapOccurredAt},
          ${aId}, ${aHistoricalSoapSourceCorrection}, ${aHistoricalSoapSource},
          ${aHistoricalSoapReplacement}, ${aUser}, 'RLS Admin A',
          ${aHistoricalSoapReplacementOperation}, ${historicalSoapHash})`;
    });
  } catch {
    ordinaryHistoricalReplacementBlocked = true;
  }
  check(
    "ordinary app INSERT cannot spoof restore mode for deleted SOAP endpoints",
    ordinaryHistoricalReplacementBlocked,
  );

  let historicalReplacementRestoreAllowed = false;
  try {
    const restored = await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      return tx`select result_id, was_inserted
        from public.restore_soap_note_replacement(
          ${aHistoricalSoapReplacementEvidence}, ${historicalSoapOccurredAt},
          ${aId}, ${aHistoricalSoapSourceCorrection}, ${aHistoricalSoapSource},
          ${aHistoricalSoapReplacement}, ${aUser}, 'RLS Admin A',
          ${aHistoricalSoapReplacementOperation}, ${historicalSoapHash})`;
    });
    historicalReplacementRestoreAllowed =
      restored.length === 1 &&
      restored[0]!.result_id === aHistoricalSoapReplacementEvidence &&
      restored[0]!.was_inserted === true;
  } catch {
    historicalReplacementRestoreAllowed = false;
  }
  check(
    "tenant-bound restore accepts exact lineage before both SOAP deletions",
    historicalReplacementRestoreAllowed,
  );

  let exactHistoricalReplacementReplayAllowed = false;
  try {
    const replayed = await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      return tx`select result_id, was_inserted
        from public.restore_soap_note_replacement(
          ${aHistoricalSoapReplacementEvidence}, ${historicalSoapOccurredAt},
          ${aId}, ${aHistoricalSoapSourceCorrection}, ${aHistoricalSoapSource},
          ${aHistoricalSoapReplacement}, ${aUser}, 'RLS Admin A',
          ${aHistoricalSoapReplacementOperation}, ${historicalSoapHash})`;
    });
    exactHistoricalReplacementReplayAllowed =
      replayed.length === 1 &&
      replayed[0]!.result_id === aHistoricalSoapReplacementEvidence &&
      replayed[0]!.was_inserted === false;
  } catch {
    exactHistoricalReplacementReplayAllowed = false;
  }
  check(
    "SOAP replacement restore is idempotent only for exact replay evidence",
    exactHistoricalReplacementReplayAllowed,
  );

  let conflictingHistoricalReplacementReplayBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_replacement(
        ${randomUUID()}, ${historicalSoapOccurredAt}, ${aId},
        ${aHistoricalSoapSourceCorrection}, ${aHistoricalSoapSource},
        ${aHistoricalSoapReplacement}, ${aUser}, 'RLS Admin A',
        ${aHistoricalSoapReplacementOperation}, ${historicalSoapHash})`;
    });
  } catch {
    conflictingHistoricalReplacementReplayBlocked = true;
  }
  check(
    "SOAP replacement restore rejects conflicting operation replay",
    conflictingHistoricalReplacementReplayBlocked,
  );

  let historicalReplacementHashMismatchBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_replacement(
        ${randomUUID()}, ${historicalSoapOccurredAt}, ${aId},
        ${aHistoricalSoapSourceCorrection}, ${aHistoricalSoapSource},
        ${aHistoricalSoapReplacement}, ${aUser}, 'RLS Admin A', ${randomUUID()},
        ${"0".repeat(64)})`;
    });
  } catch {
    historicalReplacementHashMismatchBlocked = true;
  }
  check(
    "SOAP replacement restore rejects a mismatched exact payload hash",
    historicalReplacementHashMismatchBlocked,
  );

  let postDeletionHistoricalReplacementBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_replacement(
        ${randomUUID()},
        ${new Date(historicalSoapDeletedAt.getTime() + 60_000)}, ${aId},
        ${aHistoricalSoapSourceCorrection}, ${aHistoricalSoapSource},
        ${aHistoricalSoapReplacement}, ${aUser}, 'RLS Admin A', ${randomUUID()},
        ${historicalSoapHash})`;
    });
  } catch {
    postDeletionHistoricalReplacementBlocked = true;
  }
  check(
    "SOAP replacement restore rejects links created after endpoint deletion",
    postDeletionHistoricalReplacementBlocked,
  );

  let crossTenantHistoricalReplacementRestoreBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${bId}, true)`;
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select public.restore_soap_note_replacement(
        ${randomUUID()}, ${historicalSoapOccurredAt}, ${aId},
        ${aHistoricalSoapSourceCorrection}, ${aHistoricalSoapSource},
        ${aHistoricalSoapReplacement}, ${aUser}, 'RLS Admin A', ${randomUUID()},
        ${historicalSoapHash})`;
    });
  } catch {
    crossTenantHistoricalReplacementRestoreBlocked = true;
  }
  check(
    "SOAP replacement restore cannot spoof another tenant with bypass GUCs",
    crossTenantHistoricalReplacementRestoreBlocked,
  );

  const reverseHistoricalSoapHash = soapReplacementPayloadHash({
    patientId: aPatient,
    sourceNoteId: aHistoricalSoapReplacement,
    actorId: aUser,
    reason: historicalSoapReplacementReason,
    subjective: "Historical source SOAP",
  });
  let historicalReplacementCycleBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`select public.restore_soap_note_replacement(
        ${randomUUID()}, ${historicalSoapOccurredAt}, ${aId},
        ${aHistoricalSoapReplacementCorrection}, ${aHistoricalSoapReplacement},
        ${aHistoricalSoapSource}, ${aUser}, 'RLS Admin A', ${randomUUID()},
        ${reverseHistoricalSoapHash})`;
    });
  } catch {
    historicalReplacementCycleBlocked = true;
  }
  check(
    "historical SOAP replacement restore remains cycle-safe",
    historicalReplacementCycleBlocked,
  );

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

  const hiddenAuthEmailAttempts = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from auth_email_attempts where id = ${aAuthEmailAttempt}`;
  });
  check(
    "tenant context cannot read system-only auth email attempts",
    hiddenAuthEmailAttempts.length === 0,
  );
  const hiddenAuthEmailDelivery = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from auth_email_delivery_events where id = ${aAuthEmailDeliveryEvent}`;
  });
  check(
    "tenant context cannot read system-only auth email delivery evidence",
    hiddenAuthEmailDelivery.length === 0,
  );
  const hiddenAuthEmailConflict = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from auth_email_webhook_conflicts where id = ${aAuthEmailWebhookConflict}`;
  });
  check(
    "tenant context cannot read system-only auth email conflict evidence",
    hiddenAuthEmailConflict.length === 0,
  );
  const hiddenAuthEmailProviderConflict = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from auth_email_provider_identity_conflicts where id = ${aAuthEmailProviderIdentityConflict}`;
  });
  check(
    "tenant context cannot read provider identity conflict evidence",
    hiddenAuthEmailProviderConflict.length === 0,
  );

  let tenantAuthEmailInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into auth_email_attempts
        (practice_id, user_id, source, idempotency_key)
        values (${aId}, ${aUser}, 'authenticated_resend', ${`forged:${randomUUID()}`})`;
    });
  } catch {
    tenantAuthEmailInsertBlocked = true;
  }
  check(
    "tenant context cannot forge auth email attempts",
    tenantAuthEmailInsertBlocked,
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
  const aLabReplacementRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from lab_result_replacements where id in (${aLabReplacement}, ${bLabReplacement})`;
  });
  check(
    "tenant A sees only A's lab replacement evidence",
    aLabReplacementRows.length === 1 &&
      aLabReplacementRows[0]!.id === aLabReplacement &&
      aLabReplacementRows[0]!.practice_id === aId,
  );
  const aSoapReplacementRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from soap_note_replacements
      where id in (${aSoapReplacementEvidence}, ${bSoapReplacementEvidence})`;
  });
  check(
    "tenant A sees only A's SOAP replacement evidence",
    aSoapReplacementRows.length === 1 &&
      aSoapReplacementRows[0]!.id === aSoapReplacementEvidence &&
      aSoapReplacementRows[0]!.practice_id === aId,
  );
  const aLabCorrectionRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from clinical_record_corrections where id in (${aLabCorrection}, ${bLabCorrection})`;
  });
  check(
    "tenant A sees only A's lab correction evidence",
    aLabCorrectionRows.length === 1 &&
      aLabCorrectionRows[0]!.id === aLabCorrection &&
      aLabCorrectionRows[0]!.practice_id === aId,
  );

  const labReplacementPrivileges = await owner`
    select
      has_table_privilege('openpims_app', 'lab_result_replacements', 'SELECT') as can_select,
      has_table_privilege('openpims_app', 'lab_result_replacements', 'INSERT') as can_insert,
      has_table_privilege('openpims_app', 'lab_result_replacements', 'UPDATE') as can_update,
      has_table_privilege('openpims_app', 'lab_result_replacements', 'DELETE') as can_delete
  `;
  check(
    "app role can append/read but cannot mutate lab replacement evidence",
    labReplacementPrivileges.length === 1 &&
      labReplacementPrivileges[0]!.can_select === true &&
      labReplacementPrivileges[0]!.can_insert === true &&
      labReplacementPrivileges[0]!.can_update === false &&
      labReplacementPrivileges[0]!.can_delete === false,
  );

  const soapReplacementPrivileges = await owner`
    select
      has_table_privilege('openpims_app', 'soap_note_replacements', 'SELECT') as can_select,
      has_table_privilege('openpims_app', 'soap_note_replacements', 'INSERT') as can_insert,
      has_table_privilege('openpims_app', 'soap_note_replacements', 'UPDATE') as can_update,
      has_table_privilege('openpims_app', 'soap_note_replacements', 'DELETE') as can_delete
  `;
  check(
    "app role can append/read but cannot mutate SOAP replacement evidence",
    soapReplacementPrivileges.length === 1 &&
      soapReplacementPrivileges[0]!.can_select === true &&
      soapReplacementPrivileges[0]!.can_insert === true &&
      soapReplacementPrivileges[0]!.can_update === false &&
      soapReplacementPrivileges[0]!.can_delete === false,
  );

  const soapReplacementRestorePrivileges = await owner`
    select
      has_function_privilege(
        'openpims_app',
        to_regprocedure('public.restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text)'),
        'EXECUTE'
      ) as app_can_execute,
      coalesce((
        select has_function_privilege(
          role.oid,
          to_regprocedure('public.restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text)'),
          'EXECUTE'
        )
        from pg_roles as role where role.rolname = 'anon'
      ), false) as anon_can_execute,
      coalesce((
        select has_function_privilege(
          role.oid,
          to_regprocedure('public.restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text)'),
          'EXECUTE'
        )
        from pg_roles as role where role.rolname = 'authenticated'
      ), false) as authenticated_can_execute
  `;
  check(
    "only the app role can execute SOAP replacement restore",
    soapReplacementRestorePrivileges.length === 1 &&
      soapReplacementRestorePrivileges[0]!.app_can_execute === true &&
      soapReplacementRestorePrivileges[0]!.anon_can_execute === false &&
      soapReplacementRestorePrivileges[0]!.authenticated_can_execute === false,
  );

  let crossTenantLabReplacementInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into lab_result_replacements
        (practice_id, correction_id, source_lab_result_id,
         replacement_lab_result_id, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${bId}, ${bLabCorrection}, ${bLabResult},
          ${bReplacementLabResult}, ${bUser}, 'RLS Admin B', ${randomUUID()},
          ${"1".repeat(64)})`;
    });
  } catch {
    crossTenantLabReplacementInsertBlocked = true;
  }
  check(
    "cross-tenant lab replacement INSERT is blocked",
    crossTenantLabReplacementInsertBlocked,
  );
  let mixedTenantLabReplacementInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into lab_result_replacements
        (practice_id, correction_id, source_lab_result_id,
         replacement_lab_result_id, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${aId}, ${bLabCorrection}, ${bLabResult},
          ${bReplacementLabResult}, ${bUser}, 'Mixed tenant actor',
          ${randomUUID()}, ${"2".repeat(64)})`;
    });
  } catch {
    mixedTenantLabReplacementInsertBlocked = true;
  }
  check(
    "tenant-safe replacement FKs reject mixed-practice evidence",
    mixedTenantLabReplacementInsertBlocked,
  );

  let crossTenantSoapReplacementInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_note_replacements
        (practice_id, correction_id, source_soap_note_id,
         replacement_soap_note_id, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${bId}, ${bSoapCorrection}, ${bSoapSource},
          ${bSoapReplacement}, ${bUser}, 'RLS Admin B', ${randomUUID()},
          ${"9".repeat(64)})`;
    });
  } catch {
    crossTenantSoapReplacementInsertBlocked = true;
  }
  check(
    "cross-tenant SOAP replacement INSERT is blocked",
    crossTenantSoapReplacementInsertBlocked,
  );

  let mixedTenantSoapReplacementInsertBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into soap_note_replacements
        (practice_id, correction_id, source_soap_note_id,
         replacement_soap_note_id, actor_id, actor_name, operation_id,
         operation_payload_hash)
        values (${aId}, ${bSoapCorrection}, ${bSoapSource},
          ${bSoapReplacement}, ${bUser}, 'Mixed tenant actor', ${randomUUID()},
          ${"a".repeat(64)})`;
    });
  } catch {
    mixedTenantSoapReplacementInsertBlocked = true;
  }
  check(
    "tenant-safe SOAP replacement FKs reject mixed-practice evidence",
    mixedTenantSoapReplacementInsertBlocked,
  );

  let ownerReplacementMutationBlockedWithoutMaintenance = false;
  try {
    await owner`update lab_result_replacements set actor_name = actor_name where id = ${aLabReplacement}`;
  } catch {
    ownerReplacementMutationBlockedWithoutMaintenance = true;
  }
  check(
    "lab replacement owner mutation requires the maintenance GUC",
    ownerReplacementMutationBlockedWithoutMaintenance,
  );
  await owner.begin(async (tx) => {
    const maintenance = tx as unknown as typeof owner;
    await maintenance`select set_config('app.ledger_maintenance', 'on', true)`;
    await maintenance`update lab_result_replacements set actor_name = actor_name where id = ${aLabReplacement}`;
  });

  let ownerSoapReplacementMutationBlockedWithoutMaintenance = false;
  try {
    await owner`update soap_note_replacements set actor_name = actor_name
      where id = ${aSoapReplacementEvidence}`;
  } catch {
    ownerSoapReplacementMutationBlockedWithoutMaintenance = true;
  }
  check(
    "SOAP replacement owner mutation requires the maintenance GUC",
    ownerSoapReplacementMutationBlockedWithoutMaintenance,
  );
  await owner.begin(async (tx) => {
    const maintenance = tx as unknown as typeof owner;
    await maintenance`select set_config('app.ledger_maintenance', 'on', true)`;
    await maintenance`update soap_note_replacements set actor_name = actor_name
      where id = ${aSoapReplacementEvidence}`;
  });

  let ownerCorrectionMutationBlockedWithoutMaintenance = false;
  try {
    await owner`update clinical_record_corrections set reason = reason where id = ${aLabCorrection}`;
  } catch {
    ownerCorrectionMutationBlockedWithoutMaintenance = true;
  }
  check(
    "clinical correction owner mutation requires the maintenance GUC",
    ownerCorrectionMutationBlockedWithoutMaintenance,
  );
  await owner.begin(async (tx) => {
    const maintenance = tx as unknown as typeof owner;
    await maintenance`select set_config('app.ledger_maintenance', 'on', true)`;
    await maintenance`update clinical_record_corrections set reason = reason where id = ${aLabCorrection}`;
  });

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
  check(
    "cross-tenant lab evidence actor is blocked",
    crossTenantLabActorBlocked,
  );

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

  const visibleStaffSchedules = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from staff_schedules where id in (${aStaffSchedule}, ${bStaffSchedule})`;
  });
  check(
    "tenant A sees only A's provider hours",
    visibleStaffSchedules.length === 1 &&
      visibleStaffSchedules[0]!.id === aStaffSchedule,
  );

  let crossTenantScheduleUserBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into staff_schedules
        (practice_id, user_id, location_id, day_of_week, start_time, end_time)
        values (${aId}, ${bUser}, ${aLocation}, 2, '08:00', '17:00')`;
    });
  } catch {
    crossTenantScheduleUserBlocked = true;
  }
  check(
    "provider hours composite FK rejects a cross-tenant user",
    crossTenantScheduleUserBlocked,
  );

  let crossTenantScheduleLocationBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into staff_schedules
        (practice_id, user_id, location_id, day_of_week, start_time, end_time)
        values (${aId}, ${aUser}, ${bLocation}, 2, '08:00', '17:00')`;
    });
  } catch {
    crossTenantScheduleLocationBlocked = true;
  }
  check(
    "provider hours composite FK rejects a cross-tenant location",
    crossTenantScheduleLocationBlocked,
  );

  let duplicateNullLocationWindowBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into staff_schedules
        (practice_id, user_id, location_id, day_of_week, start_time, end_time)
        values
        (${aId}, ${aUser}, null, 3, '09:00', '12:00'),
        (${aId}, ${aUser}, null, 3, '09:00', '12:00')`;
    });
  } catch {
    duplicateNullLocationWindowBlocked = true;
  }
  check(
    "provider hours unique index rejects duplicate active null-location windows",
    duplicateNullLocationWindowBlocked,
  );

  let invalidScheduleDayBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into staff_schedules
        (practice_id, user_id, location_id, day_of_week, start_time, end_time)
        values (${aId}, ${aUser}, ${aLocation}, 7, '09:00', '12:00')`;
    });
  } catch {
    invalidScheduleDayBlocked = true;
  }
  check(
    "provider hours check rejects an invalid weekday",
    invalidScheduleDayBlocked,
  );

  let invalidScheduleRangeBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into staff_schedules
        (practice_id, user_id, location_id, day_of_week, start_time, end_time)
        values (${aId}, ${aUser}, ${aLocation}, 3, '12:00', '09:00')`;
    });
  } catch {
    invalidScheduleRangeBlocked = true;
  }
  check(
    "provider hours check rejects an inverted time range",
    invalidScheduleRangeBlocked,
  );

  const visibleAppointments = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, location_id, room_id from appointments where id in (${aAppointment}, ${bAppointment})`;
  });
  check(
    "tenant A sees only A's location-aware appointment",
    visibleAppointments.length === 1 &&
      visibleAppointments[0]!.id === aAppointment &&
      visibleAppointments[0]!.location_id === aLocation &&
      visibleAppointments[0]!.room_id === aRoom,
  );

  let crossTenantRoomLocationBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into rooms (practice_id, location_id, name)
        values (${aId}, ${bLocation}, 'Cross-tenant room')`;
    });
  } catch {
    crossTenantRoomLocationBlocked = true;
  }
  check(
    "room composite FK rejects a cross-tenant location",
    crossTenantRoomLocationBlocked,
  );

  let crossTenantAppointmentLocationBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into appointments
        (practice_id, location_id, start_time, end_time)
        values (${aId}, ${bLocation}, now(), now() + interval '30 minutes')`;
    });
  } catch {
    crossTenantAppointmentLocationBlocked = true;
  }
  check(
    "appointment composite FK rejects a cross-tenant location",
    crossTenantAppointmentLocationBlocked,
  );

  let appointmentRoomLocationMismatchBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into appointments
        (practice_id, location_id, room_id, start_time, end_time)
        values (${aId}, ${aAltLocation}, ${aRoom}, now(), now() + interval '30 minutes')`;
    });
  } catch {
    appointmentRoomLocationMismatchBlocked = true;
  }
  check(
    "appointment room/location composite FK rejects mismatched clinic resources",
    appointmentRoomLocationMismatchBlocked,
  );

  let invalidAppointmentRangeBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into appointments
        (practice_id, location_id, start_time, end_time)
        values (${aId}, ${aLocation}, now(), now())`;
    });
  } catch {
    invalidAppointmentRangeBlocked = true;
  }
  check(
    "appointment check rejects a non-positive time range",
    invalidAppointmentRangeBlocked,
  );

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
  const noContextStaffSchedules =
    await app`select id from staff_schedules where id in (${aStaffSchedule}, ${bStaffSchedule})`;
  check(
    "no tenant context hides provider hours",
    noContextStaffSchedules.length === 0,
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
  const hiddenPlatformEmailPreferences = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from platform_email_preferences where id = ${platformEmailPreferenceId}`;
  });
  check(
    "tenant context cannot read system-only platform email preferences",
    hiddenPlatformEmailPreferences.length === 0,
  );
  const hiddenPlatformEmailIdentity = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select key_slot from platform_email_identity where key_slot = 1`;
  });
  check(
    "tenant context cannot read the platform email identity fingerprint",
    hiddenPlatformEmailIdentity.length === 0,
  );
  const hiddenPlatformEmailPreferenceEvents = await appTransaction(
    async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      return tx`select id from platform_email_preference_events
        where id = ${platformEmailPreferenceEventId}`;
    },
  );
  check(
    "tenant context cannot read platform email preference audit events",
    hiddenPlatformEmailPreferenceEvents.length === 0,
  );
  let tenantCannotWritePlatformEmailPreference = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into platform_email_preferences
        (email_hash, identity_key_fingerprint, marketing_enabled, source, reason)
        values (${"e".repeat(64)}, ${platformEmailIdentityFingerprint},
          false, 'settings', 'settings_disabled')`;
    });
  } catch {
    tenantCannotWritePlatformEmailPreference = true;
  }
  check(
    "tenant context cannot write platform email preferences",
    tenantCannotWritePlatformEmailPreference,
  );
  let tenantCannotForgePlatformEmailPreferenceEvent = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into platform_email_preference_events
        (email_hash, identity_key_fingerprint, requested_marketing_enabled,
          applied, source, reason)
        values (${"e".repeat(64)}, ${platformEmailIdentityFingerprint},
          false, true, 'settings', 'settings_disabled')`;
    });
  } catch {
    tenantCannotForgePlatformEmailPreferenceEvent = true;
  }
  check(
    "tenant context cannot forge platform email preference audit events",
    tenantCannotForgePlatformEmailPreferenceEvent,
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
  const systemPlatformEmailPreferences = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select id from platform_email_preferences where id = ${platformEmailPreferenceId}`;
  });
  check(
    "system bypass can read platform email preferences",
    systemPlatformEmailPreferences.length === 1,
  );
  const systemPlatformEmailIdentity = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select key_slot from platform_email_identity where key_slot = 1`;
  });
  check(
    "system bypass can read the platform email identity fingerprint",
    systemPlatformEmailIdentity.length === 1,
  );
  const systemPlatformEmailPreferenceEvents = await appTransaction(
    async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      return tx`select id from platform_email_preference_events
        where id = ${platformEmailPreferenceEventId}`;
    },
  );
  check(
    "system bypass can read platform email preference audit events",
    systemPlatformEmailPreferenceEvents.length === 1,
  );
  const systemUpsertedPlatformPreference = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`insert into platform_email_preferences
      (id, email_hash, identity_key_fingerprint, marketing_enabled, source, reason)
      values (${systemUpsertPlatformEmailPreferenceId}, ${platformEmailHash},
        ${platformEmailIdentityFingerprint}, true, 'settings', 'settings_enabled')
      on conflict (email_hash) do update set
        marketing_enabled = excluded.marketing_enabled,
        source = excluded.source,
        reason = excluded.reason,
        updated_at = now()
      returning marketing_enabled, reason`;
  });
  check(
    "system bypass can upsert the platform email preference projection",
    systemUpsertedPlatformPreference.length === 1 &&
      systemUpsertedPlatformPreference[0]?.marketing_enabled === true &&
      systemUpsertedPlatformPreference[0]?.reason === "settings_enabled",
  );
  const systemInsertedPlatformPreferenceEvent = await appTransaction(
    async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      return tx`insert into platform_email_preference_events
        (id, email_hash, identity_key_fingerprint, requested_marketing_enabled,
          applied, source, reason)
        values (${systemPlatformEmailPreferenceEventId}, ${platformEmailHash},
          ${platformEmailIdentityFingerprint}, true, true,
          'settings', 'settings_enabled')
        returning id`;
    },
  );
  check(
    "system bypass can append platform email preference audit events",
    systemInsertedPlatformPreferenceEvent.length === 1,
  );
  let bypassCannotRewritePlatformPreferenceEvent = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`update platform_email_preference_events
        set applied = false where id = ${systemPlatformEmailPreferenceEventId}`;
    });
  } catch {
    bypassCannotRewritePlatformPreferenceEvent = true;
  }
  check(
    "application role cannot rewrite platform email preference audit events",
    bypassCannotRewritePlatformPreferenceEvent,
  );
  let bypassCannotDeletePlatformPreferenceEvent = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`delete from platform_email_preference_events
        where id = ${systemPlatformEmailPreferenceEventId}`;
    });
  } catch {
    bypassCannotDeletePlatformPreferenceEvent = true;
  }
  check(
    "application role cannot delete platform email preference audit events",
    bypassCannotDeletePlatformPreferenceEvent,
  );
  const systemAuthEmailRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select id from auth_email_attempts where id = ${aAuthEmailAttempt}`;
  });
  check(
    "system bypass can read auth email attempts",
    systemAuthEmailRows.length === 1,
  );
  const systemAuthEmailConflictRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select id from auth_email_webhook_conflicts where id = ${aAuthEmailWebhookConflict}`;
  });
  check(
    "system bypass can read auth email conflict evidence",
    systemAuthEmailConflictRows.length === 1,
  );
  const systemProviderIdentityConflicts = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select id from auth_email_provider_identity_conflicts where id = ${aAuthEmailProviderIdentityConflict}`;
  });
  check(
    "system bypass can read provider identity conflict evidence",
    systemProviderIdentityConflicts.length === 1,
  );
  const appInsertedProviderIdentityConflict = await appTransaction(
    async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      return tx`insert into auth_email_provider_identity_conflicts
      (id, attempt_id, provider, source, durable_provider_message_id,
       conflicting_provider_message_id)
      values
      (${aAppAuthEmailProviderIdentityConflict}, ${aAuthEmailAttempt}, 'resend',
       'registration', ${`resend-${aAuthEmailAttempt}`},
       ${`resend-app-conflict-${aAuthEmailAttempt}`})
      returning id`;
    },
  );
  check(
    "system bypass can insert provider identity conflict evidence",
    appInsertedProviderIdentityConflict.length === 1,
  );
  const appSelectedProviderIdentityConflict = await appTransaction(
    async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      return tx`select id from auth_email_provider_identity_conflicts
      where id = ${aAppAuthEmailProviderIdentityConflict}`;
    },
  );
  check(
    "system bypass can select inserted provider identity conflict evidence",
    appSelectedProviderIdentityConflict.length === 1,
  );

  let appCannotUpdateProviderIdentityConflict = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`update auth_email_provider_identity_conflicts
        set occurred_at = occurred_at
        where id = ${aAppAuthEmailProviderIdentityConflict}`;
    });
  } catch {
    appCannotUpdateProviderIdentityConflict = true;
  }
  check(
    "application role cannot update provider identity conflict evidence",
    appCannotUpdateProviderIdentityConflict,
  );

  let appCannotDeleteProviderIdentityConflict = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`delete from auth_email_provider_identity_conflicts
        where id = ${aAppAuthEmailProviderIdentityConflict}`;
    });
  } catch {
    appCannotDeleteProviderIdentityConflict = true;
  }
  check(
    "application role cannot delete provider identity conflict evidence",
    appCannotDeleteProviderIdentityConflict,
  );

  const transitionedAuthEmailAttempt = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`update auth_email_attempts
      set outcome = 'accepted', resolved_at = now(),
          provider_message_id = ${`console-${aTransitionAuthEmailAttempt}`}
      where id = ${aTransitionAuthEmailAttempt} and outcome = 'reserved'
      returning outcome`;
  });
  check(
    "system bypass can resolve a reserved auth email attempt exactly once",
    transitionedAuthEmailAttempt.length === 1 &&
      transitionedAuthEmailAttempt[0]!.outcome === "accepted",
  );

  const repairedUnknownAuthEmailAttempt = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`update auth_email_attempts
      set outcome = 'accepted', resolved_at = now(),
          provider_message_id = ${`resend-repaired-${aRepairAuthEmailAttempt}`},
          failure_code = null
      where id = ${aRepairAuthEmailAttempt} and outcome = 'outcome_unknown'
      returning outcome`;
  });
  check(
    "system bypass can repair an unknown Resend outcome to accepted",
    repairedUnknownAuthEmailAttempt.length === 1 &&
      repairedUnknownAuthEmailAttempt[0]!.outcome === "accepted",
  );

  let appCannotReresolveAuthEmailAttempt = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`update auth_email_attempts
        set resolved_at = now() where id = ${aTransitionAuthEmailAttempt}`;
    });
  } catch {
    appCannotReresolveAuthEmailAttempt = true;
  }
  check(
    "database trigger keeps resolved auth email attempts immutable",
    appCannotReresolveAuthEmailAttempt,
  );

  let ownerCannotRewriteAuthEmailIdentity = false;
  try {
    await owner`update auth_email_attempts
      set source = 'authenticated_resend' where id = ${aAuthEmailAttempt}`;
  } catch {
    ownerCannotRewriteAuthEmailIdentity = true;
  }
  check(
    "database trigger freezes auth email attempt identity for the owner",
    ownerCannotRewriteAuthEmailIdentity,
  );

  let ownerCannotDeleteAuthEmailAttempt = false;
  try {
    await owner`delete from auth_email_attempts
      where id = ${aTransitionAuthEmailAttempt}`;
  } catch {
    ownerCannotDeleteAuthEmailAttempt = true;
  }
  check(
    "owner cannot delete auth email attempts outside ledger maintenance",
    ownerCannotDeleteAuthEmailAttempt,
  );

  let appCannotRewriteAuthEmailDelivery = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`update auth_email_delivery_events
        set occurred_at = occurred_at where id = ${aAuthEmailDeliveryEvent}`;
    });
  } catch {
    appCannotRewriteAuthEmailDelivery = true;
  }
  check(
    "application role cannot rewrite auth email delivery evidence",
    appCannotRewriteAuthEmailDelivery,
  );
  let ownerCannotRewriteAuthEmailDelivery = false;
  try {
    await owner`update auth_email_delivery_events
      set occurred_at = occurred_at where id = ${aAuthEmailDeliveryEvent}`;
  } catch {
    ownerCannotRewriteAuthEmailDelivery = true;
  }
  check(
    "database trigger keeps auth email delivery evidence immutable for the owner",
    ownerCannotRewriteAuthEmailDelivery,
  );
  let ownerCannotRewriteAuthEmailConflict = false;
  try {
    await owner`update auth_email_webhook_conflicts
      set received_at = received_at where id = ${aAuthEmailWebhookConflict}`;
  } catch {
    ownerCannotRewriteAuthEmailConflict = true;
  }
  check(
    "database trigger keeps auth email conflict evidence immutable for the owner",
    ownerCannotRewriteAuthEmailConflict,
  );
  let ownerCannotRewriteProviderIdentityConflict = false;
  try {
    await owner`update auth_email_provider_identity_conflicts
      set occurred_at = occurred_at where id = ${aAuthEmailProviderIdentityConflict}`;
  } catch {
    ownerCannotRewriteProviderIdentityConflict = true;
  }
  check(
    "database trigger keeps provider identity conflict evidence immutable",
    ownerCannotRewriteProviderIdentityConflict,
  );
  const ownerMaintenanceDeletedProviderConflict = await owner.begin(
    async (tx) => {
      const maintenance = tx as unknown as typeof owner;
      await maintenance`select set_config('app.ledger_maintenance', 'on', true)`;
      return maintenance`delete from auth_email_provider_identity_conflicts
      where id = ${aAppAuthEmailProviderIdentityConflict}
      returning id`;
    },
  );
  check(
    "owner maintenance can delete provider identity conflict evidence",
    ownerMaintenanceDeletedProviderConflict.length === 1,
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
  let bypassCannotDeleteLabReplacement = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`delete from lab_result_replacements where id = ${aLabReplacement}`;
    });
  } catch {
    bypassCannotDeleteLabReplacement = true;
  }
  check(
    "application role cannot delete lab replacement evidence even with bypass GUCs",
    bypassCannotDeleteLabReplacement,
  );
  let bypassCannotDeleteSoapReplacement = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`delete from soap_note_replacements
        where id = ${aSoapReplacementEvidence}`;
    });
  } catch {
    bypassCannotDeleteSoapReplacement = true;
  }
  check(
    "application role cannot delete SOAP replacement evidence even with bypass GUCs",
    bypassCannotDeleteSoapReplacement,
  );
  let bypassCannotDeleteClinicalCorrection = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.rls_bypass', 'on', true)`;
      await tx`select set_config('app.ledger_maintenance', 'on', true)`;
      await tx`delete from clinical_record_corrections where id = ${aLabCorrection}`;
    });
  } catch {
    bypassCannotDeleteClinicalCorrection = true;
  }
  check(
    "application role cannot delete correction evidence even with bypass GUCs",
    bypassCannotDeleteClinicalCorrection,
  );
} catch (err) {
  console.error("Unexpected error:", err);
  failures++;
} finally {
  // Cleanup (as owner).
  await owner.begin(async (tx) => {
    const cleanup = tx as unknown as typeof owner;
    await cleanup`select set_config('app.ledger_maintenance', 'on', true)`;
    await cleanup`delete from auth_email_webhook_conflicts where id = ${aAuthEmailWebhookConflict}`;
    await cleanup`delete from auth_email_provider_identity_conflicts where id = ${aAuthEmailProviderIdentityConflict}`;
    await cleanup`delete from auth_email_delivery_events where id = ${aAuthEmailDeliveryEvent}`;
    await cleanup`delete from auth_email_attempts where id in (${aAuthEmailAttempt}, ${aTransitionAuthEmailAttempt}, ${aRepairAuthEmailAttempt})`;
    await cleanup`delete from platform_email_preference_events
      where id in (${platformEmailPreferenceEventId}, ${systemPlatformEmailPreferenceEventId})`;
    await cleanup`delete from platform_email_preferences where id = ${platformEmailPreferenceId}`;
    if (createdPlatformEmailIdentity) {
      await cleanup`delete from platform_email_identity where key_slot = 1`;
    }
    await cleanup`delete from sms_delivery_event_history where id in (${aSmsDeliveryHistory}, ${bSmsDeliveryHistory}, ${bSmsDeliveryConflictHistory})`;
    await cleanup`delete from sms_delivery_events where id in (${aSmsDeliveryEvent}, ${bSmsDeliveryEvent}, ${unmatchedSmsDeliveryEvent})`;
    await cleanup`delete from lab_result_events where id in (${aLabResultEvent}, ${bLabResultEvent})`;
    await cleanup`delete from lab_result_replacements where id in (${aLabReplacement}, ${bLabReplacement})`;
    await cleanup`delete from soap_note_replacements where id in (${aSoapReplacementEvidence}, ${bSoapReplacementEvidence}, ${aHistoricalSoapReplacementEvidence})`;
    await cleanup`delete from soap_note_addenda where practice_id in (${aId}, ${bId})`;
    await cleanup`delete from clinical_record_corrections where id in (${aLabCorrection}, ${bLabCorrection}, ${aSoapCorrection}, ${bSoapCorrection}, ${aHistoricalSoapSourceCorrection}, ${aHistoricalSoapReplacementCorrection})`;
    await cleanup`delete from soap_notes where id in (${aSoapSource}, ${aSoapReplacement}, ${bSoapSource}, ${bSoapReplacement}, ${aSoapDeletedSource}, ${aSoapDraft}, ${aHistoricalSoapSource}, ${aHistoricalSoapReplacement})`;
    await cleanup`delete from lab_results where id in (${aLabResult}, ${bLabResult}, ${aReplacementLabResult}, ${bReplacementLabResult})`;
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
    await cleanup`delete from appointments where id in (${aAppointment}, ${bAppointment}, ${aSoapLegalAppointment}, ${bSoapLegalAppointment}, ${aSoapDraftFinalAppointment}, ${aSoapDoubleFinalAppointment}, ${aSoapDiscardAppointment})`;
    await cleanup`delete from rooms where id in (${aRoom}, ${bRoom})`;
    await cleanup`delete from prescriptions where id in (${aPrescription}, ${bPrescription})`;
    await cleanup`delete from products where id in (${aProduct}, ${bProduct})`;
    await cleanup`delete from patients where id in (${aPatient}, ${bPatient}, ${aMergeTargetPatient}, ${bMergeTargetPatient}, ${aLineageCandidatePatient})`;
    await cleanup`delete from clients where practice_id in (${aId}, ${bId})`;
    await cleanup`delete from staff_schedules where id in (${aStaffSchedule}, ${bStaffSchedule})`;
    await cleanup`delete from locations where id in (${aLocation}, ${aAltLocation}, ${bLocation})`;
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
