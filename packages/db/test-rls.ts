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
const funnelEventId = randomUUID();
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
  await owner`insert into users (id, email, password_hash, name, role, practice_id) values
    (${aUser}, ${`rls-${aUser}@example.com`}, 'not-a-real-hash', 'RLS Admin A', 'admin', ${aId}),
    (${bUser}, ${`rls-${bUser}@example.com`}, 'not-a-real-hash', 'RLS Admin B', 'admin', ${bId})`;
  await owner`insert into patients (id, practice_id, client_id, name, species)
    select ${aPatient}, ${aId}, id, 'RLS Pet A', 'canine'
    from clients where practice_id = ${aId}`;
  await owner`insert into patients (id, practice_id, client_id, name, species)
    select ${bPatient}, ${bId}, id, 'RLS Pet B', 'feline'
    from clients where practice_id = ${bId}`;
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

  const aPrescriptionEvents = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id, practice_id from prescription_events where id in (${aPrescriptionEvent}, ${bPrescriptionEvent})`;
  });
  check(
    "tenant A sees only A's prescription events",
    aPrescriptionEvents.length === 1 &&
      aPrescriptionEvents[0]!.id === aPrescriptionEvent,
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
} catch (err) {
  console.error("Unexpected error:", err);
  failures++;
} finally {
  // Cleanup (as owner).
  await owner.begin(async (tx) => {
    const cleanup = tx as unknown as typeof owner;
    await cleanup`select set_config('app.ledger_maintenance', 'on', true)`;
    await cleanup`delete from patient_merge_events where id in (${aPatientMergeEvent}, ${bPatientMergeEvent})`;
    await cleanup`delete from dispense_charge_queue where id in (${aDispenseCharge}, ${bDispenseCharge})`;
    await cleanup`delete from invoice_adjustments where invoice_id in (${aInvoice}, ${bInvoice})`;
    await cleanup`delete from prescription_events where id in (${aPrescriptionEvent}, ${bPrescriptionEvent})`;
    await cleanup`delete from visit_closeouts where id in (${aCloseout}, ${bCloseout})`;
    await cleanup`delete from funnel_events where id = ${funnelEventId}`;
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
