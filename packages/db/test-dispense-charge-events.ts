import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const packageRoot = dirname(fileURLToPath(import.meta.url));

function read(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf8");
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireText(source: string, text: string, contract: string): void {
  check(
    source.includes(text),
    `Missing medication charge ledger contract: ${contract}`,
  );
}

const schema = read("schema/dispense-charge-events.ts");
const migration = read("drizzle/0086_solid_ben_grimm.sql");
const hardeningMigration = read("drizzle/0087_polite_hellcat.sql");
const rls = read("rls/enable-rls.sql");
const drift = read("schema-drift.ts");
const backup = read("../../apps/web/lib/backup/export.ts");

for (const contract of [
  "dispense_charge_events_shape_check",
  "dispense_charge_events_charge_sequence_uq",
  "dispense_charge_events_practice_charge_operation_uq",
]) {
  requireText(schema, contract, `schema ${contract}`);
}
for (const contract of [
  "dispense_charge_queue_practice_id_uq",
  "dispense_charge_events_practice_charge_fk",
  "dispense_charge_events_practice_prescription_event_fk",
  "dispense_charge_events_practice_actor_fk",
]) {
  requireText(hardeningMigration, contract, `hardening migration ${contract}`);
}
check(
  hardeningMigration.indexOf("dispense_charge_queue_practice_id_uq") <
    hardeningMigration.indexOf("dispense_charge_events_practice_charge_fk"),
  "queue tenant identity index must precede the referencing foreign key",
);
for (const contract of [
  "record_dispense_charge_event",
  "dispense_charge_queue_record_event",
  "dispense_charge_events_immutable",
  "app.dispense_charge_restore_practice_id",
  "Medication charge restore bypass requires the exact held practice.",
  "GRANT SELECT ON public.dispense_charge_events TO openpims_app",
]) {
  requireText(migration, contract, `migration ${contract}`);
}
for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
  requireText(
    drift,
    `('dispense_charge_events'::text, '${privilege}'::text)`,
    `forbidden app privilege ${privilege}`,
  );
}
requireText(
  rls,
  "GRANT SELECT ON dispense_charge_events TO openpims_app",
  "RLS read-only grant",
);
requireText(
  backup,
  "set_config('app.dispense_charge_restore_practice_id', ${practiceId}, true)",
  "restore practice-bound bypass",
);

console.log("✓ medication charge ledger static contracts passed");

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for the medication charge ledger PostgreSQL contract test.",
  );
}
const parsed = new URL(databaseUrl);
if (!new Set(["localhost", "127.0.0.1", "::1"]).has(parsed.hostname)) {
  throw new Error(
    "Medication charge ledger PostgreSQL contracts only run against a local disposable database.",
  );
}

const owner = postgres(databaseUrl, { max: 1 });
const practiceId = randomUUID();
const userId = randomUUID();
const clientId = randomUUID();
const patientId = randomUUID();
const productId = randomUUID();
const prescriptionId = randomUUID();
const prescriptionEventId = randomUUID();
const dispenseChargeId = randomUUID();
const waiverOperationId = randomUUID();
const reopenOperationId = randomUUID();
const restoreOperationId = randomUUID();

type TestSql = typeof owner & {
  savepoint<T>(callback: (sql: TestSql) => T | Promise<T>): Promise<T>;
};

async function expectSqlState(
  tx: TestSql,
  state: string,
  action: (sql: TestSql) => Promise<unknown>,
): Promise<void> {
  let observed: string | undefined;
  try {
    await tx.savepoint(action);
  } catch (error) {
    observed =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
  }
  check(
    observed === state,
    `expected SQLSTATE ${state}, received ${observed ?? "success"}`,
  );
}

async function asTenant<T>(
  tx: TestSql,
  action: (sql: TestSql) => Promise<T>,
): Promise<T> {
  return tx.savepoint(async (sql) => {
    await sql`set local role openpims_app`;
    await sql`select set_config('app.current_practice_id', ${practiceId}, true)`;
    const result = await action(sql);
    await sql`reset role`;
    return result;
  });
}

const rollbackSentinel = new Error(
  "rollback medication charge ledger fixtures",
);

try {
  await owner.begin(async (rawTx) => {
    const tx = rawTx as unknown as TestSql;
    await tx`insert into practices (id, name) values (${practiceId}, 'Medication Ledger Contract')`;
    await tx`insert into users (id, email, password_hash, name, role, practice_id)
      values (${userId}, ${`ledger-${userId}@example.test`}, 'not-a-real-hash', 'Ledger Operator', 'admin', ${practiceId})`;
    await tx`insert into clients (id, practice_id, first_name, last_name)
      values (${clientId}, ${practiceId}, 'Ledger', 'Client')`;
    await tx`insert into patients (id, practice_id, client_id, name, species)
      values (${patientId}, ${practiceId}, ${clientId}, 'Ledger Patient', 'canine')`;
    await tx`insert into products (id, practice_id, name, unit_price, stock_quantity)
      values (${productId}, ${practiceId}, 'Ledger Medication', 12.50, 10)`;
    await tx`insert into prescriptions (
      id, practice_id, patient_id, medication_name, dosage, frequency,
      quantity, product_id, prescribed_by, start_date
    ) values (
      ${prescriptionId}, ${practiceId}, ${patientId}, 'Ledger Medication',
      '1 tablet', 'daily', 2, ${productId}, ${userId}, current_date
    )`;
    await tx`insert into prescription_events (
      id, practice_id, prescription_id, patient_id, product_id, event_type,
      quantity, status_before, status_after, refills_before, refills_after,
      actor_id, actor_name, operation_id
    ) values (
      ${prescriptionEventId}, ${practiceId}, ${prescriptionId}, ${patientId},
      ${productId}, 'created', 2, null, 'active', null, 0,
      ${userId}, 'Ledger Operator', ${prescriptionEventId}
    )`;
    await tx`insert into dispense_charge_queue (
      id, practice_id, prescription_event_id, prescription_id, patient_id,
      client_id, product_id, quantity, description_snapshot, unit_price_snapshot
    ) values (
      ${dispenseChargeId}, ${practiceId}, ${prescriptionEventId},
      ${prescriptionId}, ${patientId}, ${clientId}, ${productId}, 2,
      'Ledger Medication × 2', 12.50
    )`;

    const created = await tx`
      select sequence, event_type, transition_source, actor_id, actor_name
      from dispense_charge_events
      where dispense_charge_id = ${dispenseChargeId}`;
    check(created.length === 1, "queue insert must append one created event");
    check(
      created[0]?.sequence === 1 &&
        created[0]?.event_type === "created" &&
        created[0]?.transition_source === "prescription_dispense" &&
        created[0]?.actor_id === userId,
      "created evidence must inherit exact prescription attribution",
    );

    await asTenant(tx, async (sql) => {
      await sql`select
        set_config('app.dispense_charge_operation_id', ${waiverOperationId}, true),
        set_config('app.dispense_charge_transition_source', 'medication_queue', true),
        set_config('app.dispense_charge_actor_id', ${userId}, true),
        set_config('app.dispense_charge_actor_name', 'Ledger Operator', true),
        set_config('app.dispense_charge_reason', 'Clinic-approved waiver', true)`;
      await sql`update dispense_charge_queue set
        status = 'waived',
        resolved_by = ${userId},
        resolved_by_name = 'Ledger Operator',
        resolved_at = clock_timestamp(),
        resolution_reason = 'Clinic-approved waiver'
      where id = ${dispenseChargeId}`;
    });
    await asTenant(tx, async (sql) => {
      await sql`select
        set_config('app.dispense_charge_operation_id', ${reopenOperationId}, true),
        set_config('app.dispense_charge_transition_source', 'medication_queue', true),
        set_config('app.dispense_charge_actor_id', ${userId}, true),
        set_config('app.dispense_charge_actor_name', 'Ledger Operator', true),
        set_config('app.dispense_charge_reason', 'Returned to billing review', true)`;
      await sql`update dispense_charge_queue set
        status = 'pending',
        resolved_by = null,
        resolved_by_name = null,
        resolved_at = null,
        resolution_reason = null
      where id = ${dispenseChargeId}`;
    });

    const history = await tx`
      select sequence, operation_id, event_type, status_before, status_after,
             transition_source, reason
      from dispense_charge_events
      where dispense_charge_id = ${dispenseChargeId}
      order by sequence`;
    check(
      history.length === 3,
      "waive and reopen must append exactly two events",
    );
    check(
      history[1]?.sequence === 2 &&
        history[1]?.operation_id === waiverOperationId &&
        history[1]?.event_type === "waived" &&
        history[1]?.status_before === "pending" &&
        history[1]?.status_after === "waived" &&
        history[1]?.reason === "Clinic-approved waiver",
      "waiver evidence must preserve operation, actor, state, and reason",
    );
    check(
      history[2]?.sequence === 3 &&
        history[2]?.operation_id === reopenOperationId &&
        history[2]?.event_type === "reopened" &&
        history[2]?.status_before === "waived" &&
        history[2]?.status_after === "pending" &&
        history[2]?.reason === "Returned to billing review",
      "reopen evidence must preserve its prior state and reason",
    );

    const privileges = await tx`
      select
        has_table_privilege('openpims_app', 'public.dispense_charge_events', 'SELECT') as can_select,
        has_table_privilege('openpims_app', 'public.dispense_charge_events', 'INSERT') as can_insert,
        has_table_privilege('openpims_app', 'public.dispense_charge_events', 'UPDATE') as can_update,
        has_table_privilege('openpims_app', 'public.dispense_charge_events', 'DELETE') as can_delete`;
    check(
      privileges[0]?.can_select === true &&
        privileges[0]?.can_insert === false &&
        privileges[0]?.can_update === false &&
        privileges[0]?.can_delete === false,
      "application role must have read-only ledger privileges",
    );
    await expectSqlState(tx, "42501", async (sql) => {
      await sql`set local role openpims_app`;
      await sql`select set_config('app.current_practice_id', ${practiceId}, true)`;
      await sql`insert into dispense_charge_events (
        practice_id, dispense_charge_id, prescription_event_id, sequence,
        operation_id, event_type, transition_source, status_before,
        status_after, actor_id, actor_name
      ) values (
        ${practiceId}, ${dispenseChargeId}, ${prescriptionEventId}, 4,
        ${randomUUID()}, 'waived', 'medication_queue', 'pending', 'waived',
        ${userId}, 'Fabricated Actor'
      )`;
    });
    await expectSqlState(tx, "55000", async (sql) => {
      await sql`update dispense_charge_events
        set actor_name = 'Tampered Actor'
        where dispense_charge_id = ${dispenseChargeId}`;
    });

    await expectSqlState(tx, "42501", async (sql) => {
      await sql`set local role openpims_app`;
      await sql`select
        set_config('app.current_practice_id', ${practiceId}, true),
        set_config('app.dispense_charge_restore_practice_id', ${practiceId}, true),
        set_config('app.dispense_charge_restore', 'on', true)`;
      await sql`update dispense_charge_queue set
        status = 'waived',
        resolved_by = ${userId},
        resolved_by_name = 'Ledger Operator',
        resolved_at = clock_timestamp(),
        resolution_reason = 'Restore-only waiver'
      where id = ${dispenseChargeId}`;
    });

    await tx`update practices set
      recovery_hold = true,
      recovery_hold_reason = 'Disposable ledger contract restore',
      recovery_hold_set_at = clock_timestamp()
    where id = ${practiceId}`;
    await asTenant(tx, async (sql) => {
      await sql`select
        set_config('app.dispense_charge_restore_practice_id', ${practiceId}, true),
        set_config('app.dispense_charge_restore', 'on', true)`;
      await sql`update dispense_charge_queue set
        status = 'waived',
        resolved_by = ${userId},
        resolved_by_name = 'Ledger Operator',
        resolved_at = clock_timestamp(),
        resolution_reason = 'Restore-only waiver'
      where id = ${dispenseChargeId}`;
      await sql`select
        set_config('app.dispense_charge_restore', '', true),
        set_config('app.dispense_charge_restore_practice_id', '', true)`;
    });
    const afterBypass = await tx`
      select count(*)::integer as count
      from dispense_charge_events
      where dispense_charge_id = ${dispenseChargeId}`;
    check(
      afterBypass[0]?.count === 3,
      "exact held-practice restore may suppress only trigger-synthesized history",
    );
    await tx`insert into dispense_charge_events (
      practice_id, dispense_charge_id, prescription_event_id, sequence,
      operation_id, event_type, transition_source, status_before, status_after,
      actor_id, actor_name, reason
    ) values (
      ${practiceId}, ${dispenseChargeId}, ${prescriptionEventId}, 4,
      ${restoreOperationId}, 'waived', 'legacy_backfill', 'pending', 'waived',
      ${userId}, 'Restored Operator', 'Restore-only waiver'
    )`;
    const restored = await tx`
      select sequence, operation_id, event_type
      from dispense_charge_events
      where dispense_charge_id = ${dispenseChargeId}
      order by sequence`;
    check(
      restored.length === 4 && restored[3]?.operation_id === restoreOperationId,
      "held restore must accept exact immutable evidence after suppressing synthesis",
    );

    throw rollbackSentinel;
  });
} catch (error) {
  if (error !== rollbackSentinel) throw error;
} finally {
  const residue = await owner`
    select
      (select count(*)::integer from practices where id = ${practiceId}) as practices,
      (select count(*)::integer from dispense_charge_events where practice_id = ${practiceId}) as events`;
  check(
    residue[0]?.practices === 0 && residue[0]?.events === 0,
    "medication charge ledger test fixtures must roll back completely",
  );
  await owner.end();
}

console.log("✓ medication charge ledger PostgreSQL contracts passed");
