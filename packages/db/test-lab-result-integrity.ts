/** Live PostgreSQL contract for lab replacement lineage and projection grants. */
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

const practiceId = randomUUID();
const actorId = randomUUID();
const clientId = randomUUID();
const patientA = randomUUID();
const patientB = randomUUID();
const sourceResult = randomUUID();
const sameChartReplacement = randomUUID();
const otherPatientReplacement = randomUUID();
const correctionId = randomUUID();
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

async function asTenant<T>(run: (tx: typeof app) => Promise<T>): Promise<T> {
  return app.begin(async (tx) => {
    const tenantTx = tx as unknown as typeof app;
    await tenantTx`select set_config('app.current_practice_id', ${practiceId}, true)`;
    return run(tenantTx);
  }) as Promise<T>;
}

try {
  await owner`insert into practices (id, name)
    values (${practiceId}, 'Lab Result Integrity Test')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id)
    values (${actorId}, ${`lab-${actorId}@example.test`}, 'not-a-real-hash',
      'Lab Integrity Actor', 'veterinarian', ${practiceId})`;
  await owner`insert into clients (id, practice_id, first_name, last_name)
    values (${clientId}, ${practiceId}, 'Owner', 'Lab')`;
  await owner`insert into patients
    (id, practice_id, client_id, name, species) values
    (${patientA}, ${practiceId}, ${clientId}, 'Patient A', 'canine'),
    (${patientB}, ${practiceId}, ${clientId}, 'Patient B', 'feline')`;
  await owner`insert into lab_results
    (id, practice_id, patient_id, creation_operation_id,
     creation_payload_hash, test_name, result_value, status, result_flag,
     ordered_by, completed_at) values
    (${sourceResult}, ${practiceId}, ${patientA}, ${randomUUID()}, ${"a".repeat(64)},
      'Source CBC', '8.2', 'completed', 'normal', ${actorId}, now()),
    (${sameChartReplacement}, ${practiceId}, ${patientA}, ${randomUUID()}, ${"b".repeat(64)},
      'Replacement CBC', '8.3', 'completed', 'normal', ${actorId}, now()),
    (${otherPatientReplacement}, ${practiceId}, ${patientB}, ${randomUUID()}, ${"c".repeat(64)},
      'Other patient CBC', '8.4', 'completed', 'normal', ${actorId}, now())`;
  await owner`insert into clinical_record_corrections
    (id, practice_id, record_type, lab_result_id, patient_id, appointment_id,
     reason, corrected_by, corrected_by_name, operation_id,
     operation_payload_hash) values
    (${correctionId}, ${practiceId}, 'lab_result', ${sourceResult}, ${patientA}, null,
      'Entered against the wrong analyzer run.', ${actorId},
      'Lab Integrity Actor', ${randomUUID()}, ${"d".repeat(64)})`;

  const [privileges] = await owner<
    {
      canDelete: boolean;
      canUpdateStatus: boolean;
      canUpdateTestName: boolean;
    }[]
  >`select
      has_table_privilege('openpims_app', 'public.lab_results', 'DELETE') as "canDelete",
      has_column_privilege('openpims_app', 'public.lab_results', 'status', 'UPDATE') as "canUpdateStatus",
      has_column_privilege('openpims_app', 'public.lab_results', 'test_name', 'UPDATE') as "canUpdateTestName"`;
  check(
    "app role has lifecycle projection grants without clinical identity rewrite or delete",
    privileges?.canDelete === false &&
      privileges.canUpdateStatus === true &&
      privileges.canUpdateTestName === false,
  );

  check(
    "cross-patient replacement lineage is rejected",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`insert into lab_result_replacements
        (practice_id, correction_id, source_lab_result_id,
         replacement_lab_result_id, actor_id, actor_name, operation_id,
         operation_payload_hash) values
        (${practiceId}, ${correctionId}, ${sourceResult},
         ${otherPatientReplacement}, ${actorId}, 'Lab Integrity Actor',
         ${randomUUID()}, ${"e".repeat(64)})`,
      ),
    )) === "23514",
  );

  const validReplacement = await asTenant(
    (tx) => tx`insert into lab_result_replacements
      (practice_id, correction_id, source_lab_result_id,
       replacement_lab_result_id, actor_id, actor_name, operation_id,
       operation_payload_hash) values
      (${practiceId}, ${correctionId}, ${sourceResult},
       ${sameChartReplacement}, ${actorId}, 'Lab Integrity Actor',
       ${randomUUID()}, ${"f".repeat(64)}) returning id`,
  );
  check(
    "same-chart replacement lineage is accepted",
    validReplacement.length === 1,
  );

  check(
    "app role can update a lifecycle projection column",
    (await sqlState(() =>
      asTenant(
        (tx) =>
          tx`update lab_results set status = status where id = ${sourceResult}`,
      ),
    )) === null,
  );
  check(
    "app role cannot rewrite lab test identity",
    (await sqlState(() =>
      asTenant(
        (tx) =>
          tx`update lab_results set test_name = 'Rewritten' where id = ${sourceResult}`,
      ),
    )) === "42501",
  );
  check(
    "app role cannot delete the lab result projection",
    (await sqlState(() =>
      asTenant((tx) => tx`delete from lab_results where id = ${sourceResult}`),
    )) === "42501",
  );
} finally {
  try {
    await owner.begin(async (tx) => {
      const maintenance = tx as unknown as typeof owner;
      await maintenance`select set_config('app.ledger_maintenance', 'on', true)`;
      await maintenance`delete from lab_result_replacements where practice_id = ${practiceId}`;
      await maintenance`delete from clinical_record_corrections where practice_id = ${practiceId}`;
    });
    await owner`delete from lab_results where practice_id = ${practiceId}`;
    await owner`delete from patients where practice_id = ${practiceId}`;
    await owner`delete from clients where practice_id = ${practiceId}`;
    await owner`delete from users where practice_id = ${practiceId}`;
    await owner`delete from practices where id = ${practiceId}`;
  } finally {
    await app.end();
    await owner.end();
  }
}

if (failures > 0) {
  console.error(`Lab-result integrity contract failed: ${failures} check(s)`);
  process.exit(1);
}

console.log("Lab-result integrity contract passed.");
