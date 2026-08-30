/**
 * Live prescription-row integrity contract.
 *
 * Runs after migrations + RLS and proves tenant-bound references, retry
 * identity, clinical row shape, RLS, and least-privilege mutation scope in
 * real PostgreSQL using only synthetic fixtures.
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
const prescriberA = randomUUID();
const prescriberB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const patientA = randomUUID();
const patientB = randomUUID();
const productA = randomUUID();
const productB = randomUUID();
const prescriptionA = randomUUID();
const operationA = randomUUID();
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

function insertPrescription(
  tx: typeof app,
  overrides: {
    patientId?: string;
    productId?: string | null;
    prescriberId?: string;
    operationId?: string | null;
    medicationName?: string;
    dosage?: string;
    frequency?: string;
    quantity?: number | null;
    refills?: number;
    startDate?: string;
    endDate?: string | null;
  } = {},
) {
  return tx`insert into prescriptions
    (practice_id, patient_id, product_id, prescribed_by, operation_id,
     medication_name, dosage, frequency, quantity, refills_remaining,
     start_date, end_date)
    values (
      ${practiceA},
      ${overrides.patientId ?? patientA},
      ${overrides.productId === undefined ? null : overrides.productId},
      ${overrides.prescriberId ?? prescriberA},
      ${overrides.operationId === undefined ? randomUUID() : overrides.operationId},
      ${overrides.medicationName ?? "Carprofen"},
      ${overrides.dosage ?? "75 mg"},
      ${overrides.frequency ?? "Every 12 hours"},
      ${overrides.quantity === undefined ? 10 : overrides.quantity},
      ${overrides.refills ?? 1},
      ${overrides.startDate ?? "2026-08-30"},
      ${overrides.endDate === undefined ? "2026-09-30" : overrides.endDate}
    )`;
}

try {
  await owner`insert into practices (id, name) values
    (${practiceA}, 'Prescription Integrity Test A'),
    (${practiceB}, 'Prescription Integrity Test B')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id) values
    (${prescriberA}, ${`rx-${prescriberA}@example.test`}, 'not-a-real-hash', 'Prescriber A', 'veterinarian', ${practiceA}),
    (${prescriberB}, ${`rx-${prescriberB}@example.test`}, 'not-a-real-hash', 'Prescriber B', 'veterinarian', ${practiceB})`;
  await owner`insert into clients (id, practice_id, first_name, last_name) values
    (${clientA}, ${practiceA}, 'Owner', 'A'),
    (${clientB}, ${practiceB}, 'Owner', 'B')`;
  await owner`insert into patients
    (id, practice_id, client_id, name, species) values
    (${patientA}, ${practiceA}, ${clientA}, 'Patient A', 'canine'),
    (${patientB}, ${practiceB}, ${clientB}, 'Patient B', 'feline')`;
  await owner`insert into products
    (id, practice_id, name, unit_price, inventory_tracked, stock_quantity) values
    (${productA}, ${practiceA}, 'Product A', 1, true, 100),
    (${productB}, ${practiceB}, 'Product B', 1, true, 100)`;

  await asTenant(
    practiceA,
    (tx) => tx`insert into prescriptions
    (id, practice_id, patient_id, product_id, prescribed_by, operation_id,
     medication_name, dosage, frequency, quantity, refills_remaining,
     start_date, end_date)
    values (${prescriptionA}, ${practiceA}, ${patientA}, ${productA},
      ${prescriberA}, ${operationA}, 'Carprofen', '75 mg', 'Every 12 hours',
      10, 1, '2026-08-30', '2026-09-30')`,
  );

  const visibleA = await asTenant(
    practiceA,
    (tx) => tx`select id from prescriptions order by id`,
  );
  check(
    "tenant sees only its prescriptions",
    visibleA.length === 1 && visibleA[0]?.id === prescriptionA,
  );
  const noContext = await app`select id from prescriptions`;
  check("no-context app role sees no prescriptions", noContext.length === 0);

  check(
    "duplicate operation identity is rejected",
    (await sqlState(() =>
      asTenant(practiceA, (tx) =>
        insertPrescription(tx, { operationId: operationA }),
      ),
    )) === "23505",
  );
  check(
    "missing operation identity is rejected",
    (await sqlState(() =>
      asTenant(practiceA, (tx) =>
        insertPrescription(tx, { operationId: null }),
      ),
    )) === "23502",
  );
  check(
    "cross-tenant patient is rejected",
    (await sqlState(() =>
      asTenant(practiceA, (tx) =>
        insertPrescription(tx, { patientId: patientB }),
      ),
    )) === "23503",
  );
  check(
    "cross-tenant product is rejected",
    (await sqlState(() =>
      asTenant(practiceA, (tx) =>
        insertPrescription(tx, { productId: productB }),
      ),
    )) === "23503",
  );
  check(
    "cross-tenant prescriber is rejected",
    (await sqlState(() =>
      asTenant(practiceA, (tx) =>
        insertPrescription(tx, { prescriberId: prescriberB }),
      ),
    )) === "23503",
  );
  for (const [name, overrides] of [
    ["blank medication", { medicationName: " " }],
    ["non-positive quantity", { quantity: 0 }],
    ["inventory without quantity", { productId: productA, quantity: null }],
    ["negative refills", { refills: -1 }],
    ["end before start", { endDate: "2026-08-29" }],
  ] as const) {
    check(
      `${name} is rejected`,
      (await sqlState(() =>
        asTenant(practiceA, (tx) => insertPrescription(tx, overrides)),
      )) === "23514",
    );
  }

  const [privileges] = await owner<
    {
      canDelete: boolean;
      canUpdateStatus: boolean;
      canUpdateMedication: boolean;
    }[]
  >`select
      has_table_privilege('openpims_app', 'public.prescriptions', 'DELETE') as "canDelete",
      has_column_privilege('openpims_app', 'public.prescriptions', 'status', 'UPDATE') as "canUpdateStatus",
      has_column_privilege('openpims_app', 'public.prescriptions', 'medication_name', 'UPDATE') as "canUpdateMedication"`;
  check(
    "app role can advance lifecycle state but cannot delete or rewrite the clinical snapshot",
    privileges?.canDelete === false &&
      privileges.canUpdateStatus === true &&
      privileges.canUpdateMedication === false,
  );
  check(
    "app role cannot rewrite medication identity",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) =>
          tx`update prescriptions set medication_name = 'Rewritten' where id = ${prescriptionA}`,
      ),
    )) === "42501",
  );
  check(
    "app role cannot delete prescription evidence",
    (await sqlState(() =>
      asTenant(
        practiceA,
        (tx) => tx`delete from prescriptions where id = ${prescriptionA}`,
      ),
    )) === "42501",
  );
} finally {
  try {
    await owner`delete from prescriptions where practice_id in (${practiceA}, ${practiceB})`;
    await owner`delete from products where practice_id in (${practiceA}, ${practiceB})`;
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
  console.error(`Prescription integrity contract failed: ${failures} check(s)`);
  process.exit(1);
}

console.log("Prescription integrity contract passed.");
