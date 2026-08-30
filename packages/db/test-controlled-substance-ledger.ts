/**
 * Live controlled-substance ledger contract.
 *
 * Runs after migrations + RLS and proves append-only privileges, tenant
 * isolation, retry identity, and regulatory row-shape checks against real
 * PostgreSQL using only synthetic fixtures.
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import { randomUUID } from "crypto";
import postgres from "postgres";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const ownerUrl = nonBlankEnv("DATABASE_URL");
if (!ownerUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const appUrl = new URL(ownerUrl);
appUrl.username = "openpims_app";
appUrl.password = nonBlankEnv("OPENPIMS_APP_DB_PASSWORD") ?? "openpims_app";

const owner = postgres(ownerUrl, { max: 1 });
const app = postgres(appUrl.toString(), { max: 1 });

const practiceA = randomUUID();
const practiceB = randomUUID();
const performerA = randomUUID();
const witnessA = randomUUID();
const performerB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const patientA = randomUUID();
const patientB = randomUUID();
const receivedA = randomUUID();
const receivedB = randomUUID();
const operationA = randomUUID();
const operationB = randomUUID();
let failures = 0;

function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures += 1;
}

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unknown";
  }
}

async function asTenant<T>(
  practiceId: string,
  run: (tx: typeof app) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    const tenantTx = tx as unknown as typeof app;
    await tenantTx`select set_config('app.current_practice_id', ${practiceId}, true)`;
    return run(tenantTx);
  }) as Promise<T>;
}

try {
  await owner`insert into practices (id, name) values
    (${practiceA}, 'Controlled Ledger Test A'),
    (${practiceB}, 'Controlled Ledger Test B')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id) values
    (${performerA}, ${`ledger-${performerA}@example.test`}, 'not-a-real-hash', 'Performer A', 'veterinarian', ${practiceA}),
    (${witnessA}, ${`ledger-${witnessA}@example.test`}, 'not-a-real-hash', 'Witness A', 'technician', ${practiceA}),
    (${performerB}, ${`ledger-${performerB}@example.test`}, 'not-a-real-hash', 'Performer B', 'veterinarian', ${practiceB})`;
  await owner`insert into clients (id, practice_id, first_name, last_name) values
    (${clientA}, ${practiceA}, 'Owner', 'A'),
    (${clientB}, ${practiceB}, 'Owner', 'B')`;
  await owner`insert into patients
    (id, practice_id, client_id, name, species) values
    (${patientA}, ${practiceA}, ${clientA}, 'Patient A', 'canine'),
    (${patientB}, ${practiceB}, ${clientB}, 'Patient B', 'feline')`;

  await asTenant(practiceA, async (tx) => {
    await tx`insert into controlled_substance_log
      (id, practice_id, operation_id, drug_name, dea_schedule, action,
       quantity, unit, performed_by)
      values (${receivedA}, ${practiceA}, ${operationA}, 'Ketamine', 'III',
        'received', 10, 'ml', ${performerA})`;
  });
  await owner`insert into controlled_substance_log
    (id, practice_id, operation_id, drug_name, dea_schedule, action,
     quantity, unit, performed_by)
    values (${receivedB}, ${practiceB}, ${operationB}, 'Ketamine', 'III',
      'received', 10, 'ml', ${performerB})`;

  const visibleA = await asTenant(
    practiceA,
    (tx) => tx`select id from controlled_substance_log order by id`,
  );
  check(
    "tenant sees only its controlled-substance entries",
    visibleA.length === 1 && visibleA[0]?.id === receivedA,
  );
  const noContext = await app`select id from controlled_substance_log`;
  check("no-context app role sees no ledger rows", noContext.length === 0);

  check(
    "duplicate operation identity is rejected",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, performed_by)
          values (${practiceA}, ${operationA}, 'Ketamine', 'III',
            'received', 10, 'ml', ${performerA})`,
      ),
    )) === "23505",
  );
  check(
    "self-witnessed waste is rejected",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, performed_by, witnessed_by)
          values (${practiceA}, ${randomUUID()}, 'Ketamine', 'III',
            'wasted', 1, 'ml', ${performerA}, ${performerA})`,
      ),
    )) === "23514",
  );
  check(
    "waste without a witness is rejected",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, performed_by)
          values (${practiceA}, ${randomUUID()}, 'Ketamine', 'III',
            'wasted', 1, 'ml', ${performerA})`,
      ),
    )) === "23514",
  );
  check(
    "administered entry without a patient is rejected",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, performed_by)
          values (${practiceA}, ${randomUUID()}, 'Ketamine', 'III',
            'administered', 1, 'ml', ${performerA})`,
      ),
    )) === "23514",
  );
  check(
    "cross-tenant patient attribution is rejected",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, patient_id, performed_by)
          values (${practiceA}, ${randomUUID()}, 'Ketamine', 'III',
            'administered', 1, 'ml', ${patientB}, ${performerA})`,
      ),
    )) === "23503",
  );
  check(
    "cross-tenant performer attribution is rejected",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, performed_by)
          values (${practiceA}, ${randomUUID()}, 'Ketamine', 'III',
            'received', 1, 'ml', ${performerB})`,
      ),
    )) === "23503",
  );
  check(
    "cross-tenant witness attribution is rejected",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, performed_by, witnessed_by)
          values (${practiceA}, ${randomUUID()}, 'Ketamine', 'III',
            'wasted', 1, 'ml', ${performerA}, ${performerB})`,
      ),
    )) === "23503",
  );
  check(
    "non-positive quantity is rejected",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, performed_by)
          values (${practiceA}, ${randomUUID()}, 'Ketamine', 'III',
            'received', 0, 'ml', ${performerA})`,
      ),
    )) === "23514",
  );
  check(
    "direct app-role inserts cannot drive inventory negative",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`insert into controlled_substance_log
          (practice_id, operation_id, drug_name, dea_schedule, action,
           quantity, unit, patient_id, performed_by)
          values (${practiceA}, ${randomUUID()}, 'Ketamine', 'III',
            'administered', 11, 'ml', ${patientA}, ${performerA})`,
      ),
    )) === "23514",
  );

  const [privileges] = await owner<
    { canUpdate: boolean; canDelete: boolean }[]
  >`select
      has_table_privilege('openpims_app', 'public.controlled_substance_log', 'UPDATE') as "canUpdate",
      has_table_privilege('openpims_app', 'public.controlled_substance_log', 'DELETE') as "canDelete"`;
  check(
    "app role has no controlled-ledger update/delete grant",
    privileges?.canUpdate === false && privileges.canDelete === false,
  );
  check(
    "app role cannot execute a controlled-ledger update",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`update controlled_substance_log set notes = 'rewritten' where id = ${receivedA}`,
      ),
    )) === "42501",
  );
  check(
    "app role cannot execute a controlled-ledger delete",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`delete from controlled_substance_log where id = ${receivedA}`,
      ),
    )) === "42501",
  );
  check(
    "table owner is still stopped by the immutability trigger",
    (await sqlState(
      () =>
        owner`update controlled_substance_log set notes = 'rewritten' where id = ${receivedA}`,
    )) === "55000",
  );
} finally {
  try {
    await owner`alter table controlled_substance_log disable trigger controlled_substance_log_immutability`;
    try {
      await owner`delete from controlled_substance_log where practice_id in (${practiceA}, ${practiceB})`;
    } finally {
      await owner`alter table controlled_substance_log enable trigger controlled_substance_log_immutability`;
    }
    await owner`delete from patients where practice_id in (${practiceA}, ${practiceB})`;
    await owner`delete from clients where practice_id in (${practiceA}, ${practiceB})`;
    await owner`delete from users where practice_id in (${practiceA}, ${practiceB})`;
    await owner`delete from practices where id in (${practiceA}, ${practiceB})`;
  } finally {
    await app.end();
    await owner.end();
  }
}

if (failures > 0) {
  console.error(
    `Controlled-substance ledger contract failed: ${failures} check(s)`,
  );
  process.exit(1);
}

console.log("Controlled-substance ledger contract passed.");
