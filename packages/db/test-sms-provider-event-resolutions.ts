import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const packageRoot = dirname(fileURLToPath(import.meta.url));

function read(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf8");
}

function requireText(source: string, text: string, contract: string): void {
  if (!source.includes(text)) {
    throw new Error(`Missing SMS provider resolution contract: ${contract}`);
  }
}

const schema = read("schema/sms-provider-events.ts");
const migration = read("drizzle/0085_foamy_rick_jones.sql");
const privilegeMigration = read(
  "drizzle/0090_restrict_sms_resolution_function_execute.sql",
);
const snapshot = JSON.parse(read("drizzle/meta/0085_snapshot.json")) as {
  tables: Record<
    string,
    {
      columns: Record<string, { notNull: boolean }>;
      indexes: Record<string, unknown>;
      checkConstraints: Record<string, unknown>;
    }
  >;
};
const journal = read("drizzle/meta/_journal.json");
const rls = read("rls/enable-rls.sql");
const reset = read("reset.ts");
const drift = read("schema-drift.ts");

for (const symbol of [
  "smsProviderEventResolutionEnum",
  "smsProviderEventResolutions",
  "smsProviderEventSystemOnlyBackupExcludedTables",
]) {
  requireText(schema, `export const ${symbol}`, `export ${symbol}`);
}
for (const resolution of [
  "authoritative_projection",
  "conservative_opt_out",
  "carrier_state_reconciled",
  "provider_attested_no_projection",
]) {
  requireText(schema, `"${resolution}"`, `resolution enum ${resolution}`);
}
for (const table of [
  "sms_provider_events",
  "sms_provider_event_conflicts",
  "sms_provider_event_conflict_reviews",
  "sms_provider_event_resolutions",
]) {
  requireText(schema, `"${table}"`, `system-only backup exclusion ${table}`);
}

for (const contract of [
  "sms_provider_event_resolutions_base_event_uq",
  "sms_provider_event_resolutions_event_idx",
  "sms_provider_event_resolutions_conflict_uq",
  "sms_provider_event_resolutions_operation_uq",
  "sms_provider_event_resolutions_communication_evidence_idx",
  "sms_provider_event_resolutions_consent_evidence_idx",
  "sms_provider_event_resolutions_delivery_evidence_idx",
  "sms_provider_event_resolutions_registration_evidence_idx",
  "validate_sms_provider_event_resolution_insert",
  "SECURITY DEFINER",
  "sms_provider_event_resolutions_validate_insert",
  "sms_provider_event_resolutions_immutable",
  "Only terminal SMS provider events can be resolved.",
  "A conflict-caused quarantine requires conflict-scoped resolution evidence.",
  "Conflicting inbound evidence can only be resolved by conservative opt-out.",
  "provider_event_resolution:%s:%s:revoked",
  "Base conservative opt-out requires immutable, fully attributed sender-drift evidence.",
  "STOP resolution requires an active suppression or a strictly newer durable grant.",
  "registration_evidence.operation_id IS DISTINCT FROM NEW.operation_id",
  "Carrier phone evidence requires one exact disabled, unready sender identity.",
  "Unattributed provider-attested resolution cannot claim an arbitrary practice.",
  "matching the service lock set and deterministic",
  "sender.provider = provider_event.provider",
  "attempt.provider = provider_event.provider",
  "ORDER BY practice.id",
  "FOR UPDATE;",
]) {
  requireText(migration, contract, contract);
}
for (const reason of [
  "projection_repaired",
  "delivery_reconciled",
  "provider_identity_conflict_opt_out",
  "sender_identity_drift_opt_out",
  "carrier_state_readback_confirmed",
  "provider_support_invalid_callback",
  "provider_support_duplicate_callback",
]) {
  requireText(migration, `'${reason}'`, `bounded reason ${reason}`);
}
if (
  /\b(?:update|delete\s+from)\s+(?:public\.)?"?sms_provider_events\b/i.test(
    migration,
  )
) {
  throw new Error(
    "Migration 0085 must not mutate terminal SMS provider inbox events.",
  );
}

const resolutionSnapshot =
  snapshot.tables["public.sms_provider_event_resolutions"];
if (!resolutionSnapshot) {
  throw new Error("Snapshot 0085 is missing sms_provider_event_resolutions.");
}
if (resolutionSnapshot.columns.practice_id?.notNull !== false) {
  throw new Error(
    "Resolution practice_id must remain nullable for unattributed delivery-only provider attestations.",
  );
}
for (const index of [
  "sms_provider_event_resolutions_base_event_uq",
  "sms_provider_event_resolutions_event_idx",
  "sms_provider_event_resolutions_conflict_uq",
  "sms_provider_event_resolutions_operation_uq",
]) {
  if (!(index in resolutionSnapshot.indexes)) {
    throw new Error(`Snapshot 0085 is missing index ${index}.`);
  }
}
if (
  !(
    "sms_provider_event_resolutions_shape_check" in
    resolutionSnapshot.checkConstraints
  )
) {
  throw new Error("Snapshot 0085 is missing the resolution shape constraint.");
}
requireText(journal, '"tag": "0085_foamy_rick_jones"', "migration journal");
requireText(
  journal,
  '"tag": "0090_restrict_sms_resolution_function_execute"',
  "function privilege migration journal",
);

for (const contract of [
  "REVOKE ALL ON FUNCTION public.validate_sms_provider_event_resolution_insert() FROM PUBLIC",
  "'anon', 'authenticated', 'openpims_app'",
]) {
  requireText(privilegeMigration, contract, `function privilege ${contract}`);
}

for (const contract of [
  "ALTER TABLE sms_provider_event_resolutions ENABLE ROW LEVEL SECURITY",
  "CREATE POLICY system_only ON sms_provider_event_resolutions",
  "GRANT SELECT, INSERT ON sms_provider_event_conflicts, sms_provider_event_conflict_reviews, sms_provider_event_resolutions TO openpims_app",
  "REVOKE ALL ON FUNCTION public.validate_sms_provider_event_resolution_insert() FROM PUBLIC",
  "REVOKE ALL ON FUNCTION public.validate_sms_provider_event_resolution_insert() FROM openpims_app",
]) {
  requireText(rls, contract, `RLS ${contract}`);
}
requireText(
  reset,
  '"sms_provider_event_resolutions"',
  "reset deletes resolution children before evidence parents",
);
for (const contract of [
  "sms_provider_event_resolutions_shape_check",
  "sms_provider_event_resolutions_validate_insert",
  "sms_provider_event_resolutions_immutable",
  'kind: "forbidden_function_privilege"',
  "validate_sms_provider_event_resolution_insert",
  'table: "sms_provider_event_resolutions"',
]) {
  requireText(drift, contract, `drift contract ${contract}`);
}

console.log("✓ SMS provider event resolution static contracts passed");

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for the SMS provider resolution PostgreSQL contract test.",
  );
}
const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !new Set(["localhost", "127.0.0.1", "::1"]).has(parsedDatabaseUrl.hostname)
) {
  throw new Error(
    "SMS provider resolution PostgreSQL contracts only run against a local disposable database.",
  );
}

const owner = postgres(databaseUrl, { max: 1 });
const concurrentOwner = postgres(databaseUrl, { max: 1 });
type ResolutionTransaction = typeof owner & {
  savepoint<T>(
    callback: (sql: ResolutionTransaction) => T | Promise<T>,
  ): Promise<T>;
};
let activeOwnerTransaction: ResolutionTransaction | null = null;

async function appSystem<T>(
  fn: (tx: ResolutionTransaction) => Promise<T>,
): Promise<T> {
  if (!activeOwnerTransaction) {
    throw new Error("SMS provider resolution test transaction is not active.");
  }
  return activeOwnerTransaction.savepoint(async (savepoint) => {
    await savepoint`set local role openpims_app`;
    await savepoint`select set_config('app.rls_bypass', 'on', true)`;
    const result = await fn(savepoint);
    await savepoint`select set_config('app.rls_bypass', '', true)`;
    await savepoint`reset role`;
    return result;
  }) as Promise<T>;
}

async function appTenant<T>(
  practiceId: string,
  fn: (tx: ResolutionTransaction) => Promise<T>,
): Promise<T> {
  if (!activeOwnerTransaction) {
    throw new Error("SMS provider resolution test transaction is not active.");
  }
  return activeOwnerTransaction.savepoint(async (savepoint) => {
    await savepoint`set local role openpims_app`;
    await savepoint`select set_config('app.rls_bypass', '', true)`;
    await savepoint`select set_config('app.current_practice_id', ${practiceId}, true)`;
    const result = await fn(savepoint);
    await savepoint`select set_config('app.current_practice_id', '', true)`;
    await savepoint`reset role`;
    return result;
  }) as Promise<T>;
}

async function expectRejected(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch {
    console.log(`  ✓ ${label}`);
    return;
  }
  throw new Error(`Expected PostgreSQL to reject: ${label}`);
}

function requireResult(label: string, ok: boolean): void {
  if (!ok) throw new Error(`PostgreSQL contract failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

const ids = {
  practiceA: randomUUID(),
  practiceB: randomUUID(),
  locationA: randomUUID(),
  locationB: randomUUID(),
  userA: randomUUID(),
  registrationA: randomUUID(),
  locationMessagingA: randomUUID(),
  baseEvent: randomUUID(),
  baseConflict: randomUUID(),
  lateConflict: randomUUID(),
  conflictCausedEvent: randomUUID(),
  conflictCausedConflict: randomUUID(),
  unsafeStopEvent: randomUUID(),
  staleStopEvent: randomUUID(),
  deliveryEvent: randomUUID(),
  globalDeliveryEvent: randomUUID(),
  racingGlobalDeliveryEvent: randomUUID(),
  a2pEvent: randomUUID(),
  pendingEvent: randomUUID(),
  baseCommunication: randomUUID(),
  crossTenantCommunication: randomUUID(),
  conflictCausedCommunication: randomUUID(),
  unsafeStopCommunication: randomUUID(),
  staleStopCommunication: randomUUID(),
  deliveryCommunication: randomUUID(),
  baseConflictConsent: randomUUID(),
  unsafeStopConsent: randomUUID(),
  staleStopConsent: randomUUID(),
  staleStopNewerGrant: randomUUID(),
  sendAttempt: randomUUID(),
  sendAttemptEvent: randomUUID(),
  racingPractice: randomUUID(),
  racingSendAttempt: randomUUID(),
  racingSendAttemptEvent: randomUUID(),
  deliveryEvidence: randomUUID(),
  deliveryHistory: randomUUID(),
  registrationEvidence: randomUUID(),
  baseResolution: randomUUID(),
  baseOperation: randomUUID(),
  conflictResolution: randomUUID(),
  conflictOperation: randomUUID(),
  staleStopResolution: randomUUID(),
  staleStopOperation: randomUUID(),
  deliveryResolution: randomUUID(),
  deliveryOperation: randomUUID(),
  carrierResolution: randomUUID(),
  carrierOperation: randomUUID(),
  globalResolution: randomUUID(),
  globalOperation: randomUUID(),
};

const eventTime = new Date(Date.now() - 10 * 60 * 1000);
const newerGrantTime = new Date(eventTime.getTime() + 60 * 1000);
const baseMessageId = `base-${ids.baseEvent}`;
const conflictMessageId = `conflict-${ids.baseConflict}`;
const unsafeStopMessageId = `stop-unsafe-${ids.unsafeStopEvent}`;
const staleStopMessageId = `stop-stale-${ids.staleStopEvent}`;
const deliveryMessageId = `delivery-${ids.deliveryEvent}`;
const globalDeliveryMessageId = `global-${ids.globalDeliveryEvent}`;
const racingGlobalDeliveryMessageId = `global-race-${ids.racingGlobalDeliveryEvent}`;
const a2pPhone = "+15555550241";

const providerEventIds = [
  ids.baseEvent,
  ids.conflictCausedEvent,
  ids.unsafeStopEvent,
  ids.staleStopEvent,
  ids.deliveryEvent,
  ids.globalDeliveryEvent,
  ids.racingGlobalDeliveryEvent,
  ids.a2pEvent,
  ids.pendingEvent,
];
const resolutionIds = [
  ids.baseResolution,
  ids.conflictResolution,
  ids.staleStopResolution,
  ids.deliveryResolution,
  ids.carrierResolution,
  ids.globalResolution,
];
const rollbackSentinel = new Error("rollback SMS provider resolution fixtures");

try {
  // The practice and reserved attempt must be committed so a second session can
  // model a provider call that already holds its practice row while the main
  // transaction attempts a global no-projection resolution. All immutable
  // provider-event fixtures remain inside the rollback-only main transaction.
  await concurrentOwner`insert into practices (id, name)
    values (${ids.racingPractice}, 'Resolution DB Concurrency Test')`;
  await concurrentOwner`insert into sms_send_attempts
    (id, practice_id, source, source_id, idempotency_key, destination_e164,
     registered_display_name, body, body_sha256, provider, sender_e164)
    values (${ids.racingSendAttempt}, ${ids.racingPractice}, 'resolution_test',
      ${ids.racingSendAttempt}, ${`resolution-race:${ids.racingSendAttempt}`},
      '+15555550261', 'Resolution Race Clinic', 'Concurrency proof',
      ${"f".repeat(64)}, 'telnyx', '+15555550262')`;
  await owner.begin(async (rawTx) => {
    const tx = rawTx as unknown as ResolutionTransaction;
    activeOwnerTransaction = tx;
    await tx`insert into practices (id, name) values
      (${ids.practiceA}, 'Resolution DB Test A'),
      (${ids.practiceB}, 'Resolution DB Test B')`;
    await tx`insert into locations (id, practice_id, name, is_primary) values
      (${ids.locationA}, ${ids.practiceA}, 'Resolution Location A', true),
      (${ids.locationB}, ${ids.practiceB}, 'Resolution Location B', true)`;
    await tx`insert into users
      (id, email, password_hash, name, role, practice_id)
      values (${ids.userA}, ${`resolution-${ids.userA}@example.test`},
        'not-a-real-hash', 'Resolution Operator', 'admin', ${ids.practiceA})`;

    await tx`insert into sms_provider_events
      (id, occurred_at, provider, kind, provider_event_id,
       provider_message_id, provider_event_type, event_key,
       raw_body_fingerprint_sha256, from_e164, to_e164, message_body,
       inbound_classification, practice_id, location_id)
      values
      (${ids.baseEvent}, ${eventTime}, 'telnyx', 'inbound',
        ${`event-${ids.baseEvent}`}, ${baseMessageId}, 'message.received',
        ${`telnyx:event:${ids.baseEvent}`}, ${"1".repeat(64)},
        '+15555550201', '+15555550202', 'Base resolution message', 'other',
        ${ids.practiceA}, ${ids.locationA}),
      (${ids.conflictCausedEvent}, ${eventTime}, 'telnyx', 'inbound',
        ${`event-${ids.conflictCausedEvent}`},
        ${`message-${ids.conflictCausedEvent}`}, 'message.received',
        ${`telnyx:event:${ids.conflictCausedEvent}`}, ${"2".repeat(64)},
        '+15555550203', '+15555550202', 'Conflict-caused quarantine', 'other',
        ${ids.practiceA}, ${ids.locationA}),
      (${ids.unsafeStopEvent}, ${eventTime}, 'telnyx', 'inbound',
        ${`event-${ids.unsafeStopEvent}`}, ${unsafeStopMessageId},
        'message.received', ${`telnyx:event:${ids.unsafeStopEvent}`},
        ${"3".repeat(64)}, '+15555550204', '+15555550202', 'STOP', 'stop',
        ${ids.practiceA}, ${ids.locationA}),
      (${ids.staleStopEvent}, ${eventTime}, 'telnyx', 'inbound',
        ${`event-${ids.staleStopEvent}`}, ${staleStopMessageId},
        'message.received', ${`telnyx:event:${ids.staleStopEvent}`},
        ${"4".repeat(64)}, '+15555550205', '+15555550202', 'STOP', 'stop',
        ${ids.practiceA}, ${ids.locationA})`;

    await tx`insert into sms_provider_events
      (id, occurred_at, provider, kind, provider_event_id,
       provider_message_id, provider_event_type, event_key,
       raw_body_fingerprint_sha256, delivery_classification, provider_status,
       practice_id)
      values (${ids.deliveryEvent}, ${eventTime}, 'telnyx', 'delivery',
        ${`event-${ids.deliveryEvent}`}, ${deliveryMessageId},
        'message.delivered', ${`telnyx:event:${ids.deliveryEvent}`},
        ${"5".repeat(64)}, 'delivered', 'delivered', ${ids.practiceA})`;
    await tx`insert into sms_provider_events
      (id, occurred_at, provider, kind, provider_message_id,
       provider_event_type, event_key, raw_body_fingerprint_sha256,
       delivery_classification)
      values
      (${ids.globalDeliveryEvent}, ${eventTime}, 'telnyx', 'delivery',
        ${globalDeliveryMessageId}, 'message.sent',
        ${`telnyx:event:${ids.globalDeliveryEvent}`}, ${"6".repeat(64)}, 'sent'),
      (${ids.racingGlobalDeliveryEvent}, ${eventTime}, 'telnyx', 'delivery',
        ${racingGlobalDeliveryMessageId}, 'message.sent',
        ${`telnyx:event:${ids.racingGlobalDeliveryEvent}`}, ${"e".repeat(64)}, 'sent'),
      (${ids.pendingEvent}, ${eventTime}, 'telnyx', 'delivery',
        ${`pending-${ids.pendingEvent}`}, 'message.sent',
        ${`telnyx:event:${ids.pendingEvent}`}, ${"7".repeat(64)}, 'sent')`;
    await tx`insert into sms_provider_events
      (id, occurred_at, provider, kind, provider_event_id,
       provider_event_type, event_key, raw_body_fingerprint_sha256,
       a2p_phone_e164, a2p_status, a2p_type, a2p_event_type,
       a2p_observed_status, practice_id, location_id)
      values (${ids.a2pEvent}, ${eventTime}, 'telnyx', 'a2p',
        ${`event-${ids.a2pEvent}`}, '10dlc.phone_number.update',
        ${`telnyx:event:${ids.a2pEvent}`}, ${"8".repeat(64)}, ${a2pPhone},
        'SUSPENDED', 'phone_number', 'status_changed', 'suspended',
        ${ids.practiceA}, ${ids.locationA})`;

    await tx`update sms_provider_events
      set state = 'quarantined', attempt_count = 1, next_attempt_at = null,
          last_attempt_at = statement_timestamp(),
          processed_at = statement_timestamp(),
          last_error_code = case
            when id = ${ids.baseEvent} then 'sender_identity_drift'
            when id = ${ids.conflictCausedEvent} then 'provider_identity_conflict'
            when id = ${ids.globalDeliveryEvent} then 'delivery_attribution_pending'
            when id = ${ids.a2pEvent} then 'a2p_identity_conflict'
            else 'projection_failed'
          end,
          last_error_detail = 'Synthetic provider resolution contract fixture.'
      where id = any(${providerEventIds.filter((id) => id !== ids.pendingEvent)}::uuid[])`;

    await tx`insert into communications
      (id, created_at, practice_id, channel, direction, content, status,
       provider_message_id, dedupe_key)
      values
      (${ids.baseCommunication}, ${eventTime}, ${ids.practiceA}, 'sms',
        'inbound', 'Base resolution message', 'delivered', ${baseMessageId},
        ${`resolution:${ids.baseCommunication}`}),
      (${ids.crossTenantCommunication}, ${eventTime}, ${ids.practiceB}, 'sms',
        'inbound', 'Base resolution message', 'delivered', ${baseMessageId},
        ${`resolution:${ids.crossTenantCommunication}`}),
      (${ids.conflictCausedCommunication}, ${eventTime}, ${ids.practiceA}, 'sms',
        'inbound', 'Conflict-caused quarantine', 'delivered',
        ${`message-${ids.conflictCausedEvent}`},
        ${`resolution:${ids.conflictCausedCommunication}`}),
      (${ids.unsafeStopCommunication}, ${eventTime}, ${ids.practiceA}, 'sms',
        'inbound', 'STOP', 'delivered', ${unsafeStopMessageId},
        ${`resolution:${ids.unsafeStopCommunication}`}),
      (${ids.staleStopCommunication}, ${eventTime}, ${ids.practiceA}, 'sms',
        'inbound', 'STOP', 'delivered', ${staleStopMessageId},
        ${`resolution:${ids.staleStopCommunication}`}),
      (${ids.deliveryCommunication}, ${eventTime}, ${ids.practiceA}, 'sms',
        'outbound', 'Delivery projection body', 'delivered', ${deliveryMessageId},
        ${`resolution:${ids.deliveryCommunication}`})`;

    await tx`insert into sms_provider_event_conflicts
      (id, original_event_id, incoming_raw_body_fingerprint_sha256,
       incoming_provider_event_type, incoming_provider_event_id,
       incoming_provider_message_id)
      values
      (${ids.baseConflict}, ${ids.baseEvent}, ${"9".repeat(64)},
        'message.received', ${`conflict-${ids.baseConflict}`},
        ${conflictMessageId}),
      (${ids.conflictCausedConflict}, ${ids.conflictCausedEvent},
        ${"a".repeat(64)}, 'message.received',
        ${`conflict-${ids.conflictCausedConflict}`},
        ${`conflict-message-${ids.conflictCausedConflict}`})`;

    await tx`insert into sms_consent_events
      (id, occurred_at, practice_id, location_id, destination_e164, action,
       source, detail, actor_type, provider, provider_message_id, event_key)
      values
      (${ids.unsafeStopConsent}, ${eventTime}, ${ids.practiceA}, ${ids.locationA},
        '+15555550204', 'revoked', 'inbound_opt_out:v1',
        'Synthetic exact STOP revocation.', 'client', 'telnyx',
        ${unsafeStopMessageId}, ${`stop:${ids.unsafeStopConsent}`}),
      (${ids.staleStopConsent}, ${eventTime}, ${ids.practiceA}, ${ids.locationA},
        '+15555550205', 'revoked', 'inbound_opt_out:v1',
        'Synthetic exact stale STOP revocation.', 'client', 'telnyx',
        ${staleStopMessageId}, ${`stop:${ids.staleStopConsent}`}),
      (${ids.baseConflictConsent}, ${eventTime}, ${ids.practiceA}, ${ids.locationA},
        '+15555550201', 'revoked', 'provider_event_resolution:v1',
        'Synthetic conservative conflict opt-out.', 'system', null, null,
        ${`provider_event_resolution:${ids.conflictOperation}:${ids.baseConflict}:revoked`})`;
    await tx`insert into sms_consent_events
      (id, occurred_at, practice_id, location_id, destination_e164, action,
       source, disclosure_version, disclosure, detail, actor_type, provider,
       provider_message_id, event_key)
      values (${ids.staleStopNewerGrant}, ${newerGrantTime}, ${ids.practiceA},
        ${ids.locationA}, '+15555550205', 'granted', 'inbound_keyword:v1',
        'v1', 'Synthetic newer grant after stale STOP.',
        'Synthetic newer grant.', 'client', 'telnyx',
        ${`grant-${ids.staleStopNewerGrant}`},
        ${`grant:${ids.staleStopNewerGrant}`})`;
    await tx`insert into sms_suppressions
      (practice_id, location_id, phone, reason, detail)
      values (${ids.practiceA}, ${ids.locationA}, '+15555550201', 'stop',
        'Synthetic conservative conflict suppression.')`;

    await tx`insert into sms_send_attempts
      (id, practice_id, communication_id, source, source_id, idempotency_key,
       destination_e164, registered_display_name, body, body_sha256, provider,
       sender_e164)
      values (${ids.sendAttempt}, ${ids.practiceA}, ${ids.deliveryCommunication},
        'resolution_test', ${ids.sendAttempt}, ${`resolution:${ids.sendAttempt}`},
        '+15555550231', 'Resolution Clinic', 'Delivery projection body',
        ${"b".repeat(64)}, 'telnyx', '+15555550232')`;
    await tx`insert into sms_send_attempt_events
      (id, practice_id, attempt_id, kind, outcome, provider_message_id, event_key)
      values (${ids.sendAttemptEvent}, ${ids.practiceA}, ${ids.sendAttempt},
        'provider_result', 'accepted', ${deliveryMessageId},
        ${`resolution:${ids.sendAttemptEvent}`})`;
    await tx`insert into sms_delivery_events
      (id, provider, provider_event_id, provider_message_id,
       provider_event_type, provider_status, classification, occurred_at,
       event_key, payload_fingerprint_sha256)
      values (${ids.deliveryEvidence}, 'telnyx', ${`event-${ids.deliveryEvent}`},
        ${deliveryMessageId}, 'message.delivered', 'delivered', 'delivered',
        ${eventTime}, ${`resolution:${ids.deliveryEvidence}`}, ${"c".repeat(64)})`;
    await tx`insert into sms_delivery_event_history
      (id, delivery_event_id, practice_id, attempt_id, communication_id,
       kind, result, classification, event_key)
      values (${ids.deliveryHistory}, ${ids.deliveryEvidence}, ${ids.practiceA},
        ${ids.sendAttempt}, ${ids.deliveryCommunication}, 'automatic',
        'projected', 'delivered', ${`resolution:${ids.deliveryHistory}`})`;

    await tx`insert into messaging_registrations
      (id, practice_id, provider, entity_type, display_name, legal_name,
       tax_id_encrypted, tax_id_last4, contact_first_name, contact_last_name,
       contact_email, business_phone, street, city, state, postal_code,
       website, privacy_policy_url, terms_url, compliance_attested_at,
       compliance_attested_by, status, provider_brand_id, provider_campaign_id)
      values (${ids.registrationA}, ${ids.practiceA}, 'telnyx',
        'PRIVATE_PROFIT', 'Resolution Clinic', 'Resolution Clinic LLC',
        'synthetic-encrypted-tax-id', '1234', 'Test', 'Operator',
        'operator@example.test', '+15555550200', '1 Test Way', 'Testville',
        'NY', '10001', 'https://example.test',
        'https://example.test/privacy', 'https://example.test/terms', now(),
        ${ids.userA}, 'active', 'brand-resolution-test',
        'campaign-resolution-test')`;
    await tx`insert into location_messaging
      (id, practice_id, location_id, provider, sender_e164, number_source,
       registration_status, provider_profile_ready, enabled)
      values (${ids.locationMessagingA}, ${ids.practiceA}, ${ids.locationA},
        'telnyx', ${a2pPhone}, 'purchased', 'active', false, false)`;
    await tx`insert into messaging_registration_events
      (id, practice_id, registration_id, location_id, event_type, operation,
       status_before, status_after, provider, provider_brand_id,
       provider_campaign_id, actor_type, actor_name, operation_id, reason_code)
      values (${ids.registrationEvidence}, ${ids.practiceA}, ${ids.registrationA},
        ${ids.locationA}, 'provider_state_observed',
        'registration_reconciliation', 'suspended', 'active', 'telnyx',
        'brand-resolution-test', 'campaign-resolution-test', 'system',
        'OpenVPM system', ${ids.carrierOperation},
        'carrier_registration_reconciled')`;
    await expectRejected("cross-kind resolution is rejected", () =>
      appSystem(
        (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, operation_id, practice_id, resolution,
       external_evidence_reference, reason_code,
       resolved_by_identity, resolved_by_name)
      values (${ids.baseEvent}, ${randomUUID()}, ${ids.practiceA},
        'provider_attested_no_projection', 'provider-support:wrong-kind',
        'provider_support_invalid_callback', 'db-test', 'DB Test')`,
      ),
    );
    await expectRejected("cross-tenant parent attribution is rejected", () =>
      appSystem(
        (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, operation_id, practice_id, resolution,
       inbound_communication_id, reason_code,
       resolved_by_identity, resolved_by_name)
      values (${ids.baseEvent}, ${randomUUID()}, ${ids.practiceB},
        'authoritative_projection', ${ids.crossTenantCommunication},
        'projection_repaired', 'db-test', 'DB Test')`,
      ),
    );
    await expectRejected("cross-tenant evidence is rejected", () =>
      appSystem(
        (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, operation_id, practice_id, resolution,
       inbound_communication_id, reason_code,
       resolved_by_identity, resolved_by_name)
      values (${ids.baseEvent}, ${randomUUID()}, ${ids.practiceA},
        'authoritative_projection', ${ids.crossTenantCommunication},
        'projection_repaired', 'db-test', 'DB Test')`,
      ),
    );
    await expectRejected(
      "pending provider events cannot receive a resolution",
      () =>
        appSystem(
          (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, operation_id, resolution, external_evidence_reference,
       reason_code, resolved_by_identity, resolved_by_name)
      values (${ids.pendingEvent}, ${randomUUID()},
        'provider_attested_no_projection', 'provider-support:pending',
        'provider_support_invalid_callback', 'db-test', 'DB Test')`,
        ),
    );
    await expectRejected(
      "conflict-caused quarantine cannot be cleared by a base resolution",
      () =>
        appSystem(
          (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, operation_id, practice_id, resolution,
       inbound_communication_id, reason_code,
       resolved_by_identity, resolved_by_name)
      values (${ids.conflictCausedEvent}, ${randomUUID()}, ${ids.practiceA},
        'authoritative_projection', ${ids.conflictCausedCommunication},
        'projection_repaired', 'db-test', 'DB Test')`,
        ),
    );
    await expectRejected(
      "STOP cannot clear without suppression or a strictly newer grant",
      () =>
        appSystem(
          (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, operation_id, practice_id, resolution,
       inbound_communication_id, sms_consent_event_id, reason_code,
       resolved_by_identity, resolved_by_name)
      values (${ids.unsafeStopEvent}, ${randomUUID()}, ${ids.practiceA},
        'authoritative_projection', ${ids.unsafeStopCommunication},
        ${ids.unsafeStopConsent}, 'projection_repaired', 'db-test', 'DB Test')`,
        ),
    );

    const baseInserted = await appSystem(
      (tx) => tx`insert into sms_provider_event_resolutions
    (id, event_id, operation_id, practice_id, resolution,
     inbound_communication_id, reason_code, resolved_by_identity, resolved_by_name)
    values (${ids.baseResolution}, ${ids.baseEvent}, ${ids.baseOperation},
      ${ids.practiceA}, 'authoritative_projection', ${ids.baseCommunication},
      'projection_repaired', 'db-test', 'DB Test') returning id`,
    );
    requireResult(
      "valid base authoritative projection evidence is accepted",
      baseInserted[0]?.id === ids.baseResolution,
    );

    const conflictInserted = await appSystem(
      (tx) => tx`insert into sms_provider_event_resolutions
    (id, event_id, conflict_id, operation_id, practice_id, resolution,
     sms_consent_event_id, reason_code, resolved_by_identity, resolved_by_name)
    values (${ids.conflictResolution}, ${ids.baseEvent}, ${ids.baseConflict},
      ${ids.conflictOperation}, ${ids.practiceA}, 'conservative_opt_out',
      ${ids.baseConflictConsent}, 'provider_identity_conflict_opt_out',
      'db-test', 'DB Test') returning id`,
    );
    requireResult(
      "valid conflict-scoped conservative opt-out is accepted",
      conflictInserted[0]?.id === ids.conflictResolution,
    );

    await tx`insert into sms_provider_event_conflicts
    (id, original_event_id, incoming_raw_body_fingerprint_sha256,
     incoming_provider_event_type, incoming_provider_event_id,
     incoming_provider_message_id)
    values (${ids.lateConflict}, ${ids.baseEvent}, ${"d".repeat(64)},
      'message.received', ${`conflict-${ids.lateConflict}`},
      ${`message-${ids.lateConflict}`})`;
    const [lateConflictStatus] = await tx<
      Array<{ conflicts: number; resolutions: number }>
    >`select
      (select count(*)::int from sms_provider_event_conflicts
        where original_event_id = ${ids.baseEvent}) conflicts,
      (select count(*)::int from sms_provider_event_resolutions
        where event_id = ${ids.baseEvent} and conflict_id is not null) resolutions`;
    requireResult(
      "a later conflict does not inherit stale resolution evidence",
      lateConflictStatus?.conflicts === 2 &&
        lateConflictStatus.resolutions === 1,
    );
    await expectRejected(
      "a conflict cannot be resolved against another event",
      () =>
        appSystem(
          (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, conflict_id, operation_id, practice_id, resolution,
       sms_consent_event_id, reason_code, resolved_by_identity, resolved_by_name)
      values (${ids.baseEvent}, ${ids.conflictCausedConflict}, ${randomUUID()},
        ${ids.practiceA}, 'conservative_opt_out', ${ids.baseConflictConsent},
        'provider_identity_conflict_opt_out', 'db-test', 'DB Test')`,
        ),
    );
    await expectRejected(
      "conflict and operation idempotency are immutable",
      () =>
        appSystem(
          (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, conflict_id, operation_id, practice_id, resolution,
       sms_consent_event_id, reason_code, resolved_by_identity, resolved_by_name)
      values (${ids.baseEvent}, ${ids.baseConflict}, ${ids.conflictOperation},
        ${ids.practiceA}, 'conservative_opt_out', ${ids.baseConflictConsent},
        'provider_identity_conflict_opt_out', 'db-test', 'DB Test')`,
        ),
    );

    const staleStopInserted = await appSystem(
      (tx) => tx`insert into sms_provider_event_resolutions
    (id, event_id, operation_id, practice_id, resolution,
     inbound_communication_id, sms_consent_event_id, reason_code,
     resolved_by_identity, resolved_by_name)
    values (${ids.staleStopResolution}, ${ids.staleStopEvent},
      ${ids.staleStopOperation}, ${ids.practiceA}, 'authoritative_projection',
      ${ids.staleStopCommunication}, ${ids.staleStopConsent},
      'projection_repaired', 'db-test', 'DB Test') returning id`,
    );
    requireResult(
      "a projected stale STOP is accepted only with a strictly newer durable grant",
      staleStopInserted[0]?.id === ids.staleStopResolution,
    );

    const deliveryInserted = await appSystem(
      (tx) => tx`insert into sms_provider_event_resolutions
    (id, event_id, operation_id, practice_id, resolution,
     sms_delivery_event_id, reason_code, resolved_by_identity, resolved_by_name)
    values (${ids.deliveryResolution}, ${ids.deliveryEvent},
      ${ids.deliveryOperation}, ${ids.practiceA}, 'authoritative_projection',
      ${ids.deliveryEvidence}, 'delivery_reconciled', 'db-test', 'DB Test')
    returning id`,
    );
    requireResult(
      "valid delivery projection history is accepted",
      deliveryInserted[0]?.id === ids.deliveryResolution,
    );

    const carrierInserted = await appSystem(
      (tx) => tx`insert into sms_provider_event_resolutions
    (id, event_id, operation_id, practice_id, resolution,
     messaging_registration_event_id, reason_code,
     resolved_by_identity, resolved_by_name)
    values (${ids.carrierResolution}, ${ids.a2pEvent}, ${ids.carrierOperation},
      ${ids.practiceA}, 'carrier_state_reconciled', ${ids.registrationEvidence},
      'carrier_state_readback_confirmed', 'db-test', 'DB Test') returning id`,
    );
    requireResult(
      "current carrier readback can reconcile a historical A2P status safely",
      carrierInserted[0]?.id === ids.carrierResolution,
    );

    let releaseAcceptedPersistence!: () => void;
    const acceptedPersistenceMayCommit = new Promise<void>((resolve) => {
      releaseAcceptedPersistence = resolve;
    });
    let practiceShareLockAcquired!: () => void;
    const practiceShareLock = new Promise<void>((resolve) => {
      practiceShareLockAcquired = resolve;
    });
    const acceptedPersistence = concurrentOwner.begin(
      async (rawConcurrentTx) => {
        const concurrentTx =
          rawConcurrentTx as unknown as ResolutionTransaction;
        await concurrentTx`select id from practices
        where id = ${ids.racingPractice} for share`;
        practiceShareLockAcquired();
        await acceptedPersistenceMayCommit;
        await concurrentTx`insert into sms_send_attempt_events
        (id, practice_id, attempt_id, kind, outcome, provider_message_id, event_key)
        values (${ids.racingSendAttemptEvent}, ${ids.racingPractice},
          ${ids.racingSendAttempt}, 'provider_result', 'accepted',
          ${racingGlobalDeliveryMessageId},
          ${`provider-result:${ids.racingSendAttempt}`})`;
      },
    );
    await practiceShareLock;

    let resolutionSettled = false;
    const racingResolution = appSystem(
      (tx) => tx`insert into sms_provider_event_resolutions
        (event_id, operation_id, resolution, external_evidence_reference,
         reason_code, resolved_by_identity, resolved_by_name)
        values (${ids.racingGlobalDeliveryEvent}, ${randomUUID()},
          'provider_attested_no_projection', 'provider-support:race-check',
          'provider_support_invalid_callback', 'db-test', 'DB Test')`,
    ).then(
      () => {
        resolutionSettled = true;
        return { rejected: false };
      },
      () => {
        resolutionSettled = true;
        return { rejected: true };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const waitedForPractice = !resolutionSettled;
    releaseAcceptedPersistence();
    await acceptedPersistence;
    const racingOutcome = await racingResolution;
    requireResult(
      "global no-projection waits for an in-flight accepted send practice lock",
      waitedForPractice,
    );
    requireResult(
      "global no-projection rechecks ownership after accepted-send persistence",
      racingOutcome.rejected,
    );

    await expectRejected(
      "unattributed delivery cannot claim an arbitrary practice",
      () =>
        appSystem(
          (tx) => tx`insert into sms_provider_event_resolutions
      (event_id, operation_id, practice_id, resolution,
       external_evidence_reference, reason_code,
       resolved_by_identity, resolved_by_name)
      values (${ids.globalDeliveryEvent}, ${randomUUID()}, ${ids.practiceA},
        'provider_attested_no_projection', 'provider-support:arbitrary',
        'provider_support_invalid_callback', 'db-test', 'DB Test')`,
        ),
    );
    const globalInserted = await appSystem(
      (tx) => tx`insert into sms_provider_event_resolutions
    (id, event_id, operation_id, resolution, external_evidence_reference,
     reason_code, resolved_by_identity, resolved_by_name)
    values (${ids.globalResolution}, ${ids.globalDeliveryEvent},
      ${ids.globalOperation}, 'provider_attested_no_projection',
      'provider-support:case-closed', 'provider_support_invalid_callback',
      'db-test', 'DB Test') returning id, practice_id`,
    );
    requireResult(
      "valid provider-attested global no-projection evidence is accepted",
      globalInserted[0]?.id === ids.globalResolution &&
        globalInserted[0]?.practice_id === null,
    );

    const hiddenFromTenant = await appTenant(
      ids.practiceA,
      (tenantTx) =>
        tenantTx`select id from sms_provider_event_resolutions
      where id = any(${resolutionIds}::uuid[])`,
    );
    requireResult(
      "tenant context cannot read system-only resolution evidence",
      hiddenFromTenant.length === 0,
    );
    await expectRejected("resolution evidence rejects owner mutation", () =>
      tx.savepoint(
        (savepoint) =>
          savepoint`update sms_provider_event_resolutions set detail = detail
        where id = ${ids.baseResolution}`,
      ),
    );
    await expectRejected(
      "resolution evidence rejects application deletion",
      () =>
        appSystem(async (tx) => {
          await tx`select set_config('app.ledger_maintenance', 'on', true)`;
          return tx`delete from sms_provider_event_resolutions
        where id = ${ids.baseResolution}`;
        }),
    );

    console.log("✓ SMS provider event resolution PostgreSQL contracts passed");
    throw rollbackSentinel;
  });
} catch (error) {
  if (error !== rollbackSentinel) throw error;
} finally {
  activeOwnerTransaction = null;
  await owner.end();
  try {
    await concurrentOwner.begin(async (rawCleanup) => {
      const cleanup = rawCleanup as unknown as ResolutionTransaction;
      await cleanup`select set_config('app.ledger_maintenance', 'on', true)`;
      await cleanup`delete from sms_send_attempt_events
        where id = ${ids.racingSendAttemptEvent}`;
      await cleanup`delete from sms_send_attempts
        where id = ${ids.racingSendAttempt}`;
      await cleanup`delete from practices where id = ${ids.racingPractice}`;
    });
  } finally {
    await concurrentOwner.end();
  }
}
