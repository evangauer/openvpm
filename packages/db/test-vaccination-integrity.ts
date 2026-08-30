/** Live PostgreSQL contract for vaccination identity and certificate grants. */
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
const locationId = randomUUID();
const veterinarianId = randomUUID();
const technicianId = randomUUID();
const clientId = randomUUID();
const patientA = randomUUID();
const patientB = randomUUID();
const patientBAppointment = randomUUID();
let vaccinationId = "";
let auditId = "";
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
    values (${practiceId}, 'Vaccination Integrity Test')`;
  await owner`insert into locations (id, practice_id, name, is_primary)
    values (${locationId}, ${practiceId}, 'Vaccination Test Location', true)`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id, is_veterinarian) values
    (${veterinarianId}, ${`vaccination-vet-${veterinarianId}@example.test`},
      'not-a-real-hash', 'Vaccination Veterinarian', 'veterinarian',
      ${practiceId}, true),
    (${technicianId}, ${`vaccination-tech-${technicianId}@example.test`},
      'not-a-real-hash', 'Vaccination Technician', 'technician',
      ${practiceId}, false)`;
  await owner`insert into clients (id, practice_id, first_name, last_name)
    values (${clientId}, ${practiceId}, 'Owner', 'Vaccination')`;
  await owner`insert into patients
    (id, practice_id, client_id, name, species) values
    (${patientA}, ${practiceId}, ${clientId}, 'Patient A', 'canine'),
    (${patientB}, ${practiceId}, ${clientId}, 'Patient B', 'feline')`;
  await owner`insert into appointments
    (id, practice_id, location_id, client_id, patient_id, start_time, end_time) values
    (${patientBAppointment}, ${practiceId}, ${locationId}, ${clientId}, ${patientB},
      now(), now() + interval '30 minutes')`;

  const [privileges] = await owner<
    {
      canDelete: boolean;
      canUpdateCertificate: boolean;
      canUpdateVaccineName: boolean;
      canUpdatePatient: boolean;
      canUpdateAdministeredAt: boolean;
      canUpdateNextDue: boolean;
      canInsertVaccineName: boolean;
      canInsertId: boolean;
      canInsertDeletedAt: boolean;
      canUpdateDeletedAt: boolean;
    }[]
  >`select
      has_table_privilege('openpims_app', 'public.vaccination_records', 'DELETE') as "canDelete",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'product_name', 'UPDATE') as "canUpdateCertificate",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'vaccine_name', 'UPDATE') as "canUpdateVaccineName",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'patient_id', 'UPDATE') as "canUpdatePatient",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'administered_at', 'UPDATE') as "canUpdateAdministeredAt",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'next_due_date', 'UPDATE') as "canUpdateNextDue",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'vaccine_name', 'INSERT') as "canInsertVaccineName",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'id', 'INSERT') as "canInsertId",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'deleted_at', 'INSERT') as "canInsertDeletedAt",
      has_column_privilege('openpims_app', 'public.vaccination_records', 'deleted_at', 'UPDATE') as "canUpdateDeletedAt"`;
  check(
    "app role may complete certificate metadata without rewriting or deleting vaccination identity",
    privileges?.canDelete === false &&
      privileges.canUpdateCertificate === true &&
      privileges.canUpdateVaccineName === false &&
      privileges.canUpdatePatient === false &&
      privileges.canUpdateAdministeredAt === false &&
      privileges.canUpdateNextDue === false &&
      privileges.canInsertVaccineName === true &&
      privileges.canInsertId === false &&
      privileges.canInsertDeletedAt === false &&
      privileges.canUpdateDeletedAt === false,
  );

  const created = await asTenant(
    (tx) => tx`insert into vaccination_records
      (practice_id, patient_id, vaccine_name, product_name, lot_number,
       manufacturer, product_expiration_date, dose_type,
       licensed_duration_months, rabies_tag_number, administered_by,
       supervising_veterinarian_id, administered_at, next_due_date)
      values
      (${practiceId}, ${patientA}, 'Rabies', 'Rabies Product',
       'LOT-VALID', 'Example Manufacturer', '2099-01-01', 'booster', 36,
       'TAG-VALID', ${technicianId}, ${veterinarianId}, now(), '2099-01-02')
      returning id`,
  );
  vaccinationId = String(created[0]?.id ?? "");
  check("a tenant can append a valid vaccination", created.length === 1);

  check(
    "app role cannot forge source-row identity or timestamps on insert",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`insert into vaccination_records
          (id, practice_id, patient_id, vaccine_name, administered_at)
          values (${randomUUID()}, ${practiceId}, ${patientA}, 'Forged ID', now())`,
      ),
    )) === "42501",
  );
  check(
    "appointment-linked vaccination must remain in the appointment patient chart",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`insert into vaccination_records
          (practice_id, patient_id, appointment_id, vaccine_name,
           administered_by, administered_at)
          values (${practiceId}, ${patientA}, ${patientBAppointment},
            'Chart mismatch', ${technicianId}, now())`,
      ),
    )) === "23514",
  );
  check(
    "a non-veterinarian cannot be recorded as supervising veterinarian",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`update vaccination_records
          set supervising_veterinarian_id = ${technicianId}, updated_at = now()
          where id = ${vaccinationId}`,
      ),
    )) === "23514",
  );
  check(
    "product expiration before administration is rejected",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`update vaccination_records
          set product_expiration_date = '2000-01-01', updated_at = now()
          where id = ${vaccinationId}`,
      ),
    )) === "23514",
  );
  check(
    "certificate metadata cannot change without database audit attribution",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`update vaccination_records
          set product_name = 'Unattributed Product Detail', updated_at = now()
          where id = ${vaccinationId}`,
      ),
    )) === "23514",
  );
  check(
    "bounded certificate metadata remains updateable with attribution",
    (await sqlState(() =>
      asTenant(async (tx) => {
        await tx`select
          set_config('app.vaccination_certificate_actor_id', ${veterinarianId}, true),
          set_config('app.vaccination_certificate_reason', 'verified source', true),
          set_config('app.vaccination_certificate_ip', '192.0.2.1', true)`;
        await tx`update vaccination_records
          set product_name = 'Audited Product Detail', updated_at = now()
          where id = ${vaccinationId}`;
      }),
    )) === null,
  );
  const generatedAudit = await owner<
    Array<{ userId: string | null; reason: string | null }>
  >`select user_id as "userId", changes ->> 'reason' as reason
    from audit_log
    where practice_id = ${practiceId}
      and entity_type = 'vaccination_record'
      and entity_id = ${vaccinationId}
      and action = 'certificate_details_updated'`;
  check(
    "certificate update and attributed audit evidence are atomic",
    generatedAudit.length === 1 &&
      generatedAudit[0]?.userId === veterinarianId &&
      generatedAudit[0]?.reason === "verified source",
  );
  const auditRows = await asTenant(
    (tx) => tx`insert into audit_log
      (practice_id, user_id, action, entity_type, entity_id, changes)
      values (${practiceId}, ${veterinarianId}, 'contract_evidence',
        'vaccination_record', ${vaccinationId}, '{"reason":"verified source"}'::jsonb)
      returning id`,
  );
  auditId = String(auditRows[0]?.id ?? "");
  check(
    "app role can append attributed audit evidence",
    auditRows.length === 1,
  );
  check(
    "app role cannot forge audit identity or timestamps",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`insert into audit_log
          (id, practice_id, action, entity_type, created_at)
          values (${randomUUID()}, ${practiceId}, 'forged',
            'vaccination_record', now() - interval '1 year')`,
      ),
    )) === "42501",
  );
  check(
    "app role cannot rewrite audit evidence",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`update audit_log
          set changes = '{"reason":"rewritten"}'::jsonb where id = ${auditId}`,
      ),
    )) === "42501",
  );
  check(
    "app role cannot delete audit evidence",
    (await sqlState(() =>
      asTenant((tx) => tx`delete from audit_log where id = ${auditId}`),
    )) === "42501",
  );
  check(
    "app role cannot rewrite vaccine identity",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`update vaccination_records
          set vaccine_name = 'Rewritten' where id = ${vaccinationId}`,
      ),
    )) === "42501",
  );
  check(
    "app role cannot rewrite reminder due dates",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`update vaccination_records
          set next_due_date = '2099-01-03' where id = ${vaccinationId}`,
      ),
    )) === "42501",
  );
  check(
    "app role cannot delete vaccination evidence",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`delete from vaccination_records where id = ${vaccinationId}`,
      ),
    )) === "42501",
  );
  check(
    "app role cannot hide vaccination evidence with soft deletion",
    (await sqlState(() =>
      asTenant(
        (tx) => tx`update vaccination_records
          set deleted_at = now() where id = ${vaccinationId}`,
      ),
    )) === "42501",
  );
  const correctionRows = await asTenant(
    (tx) => tx`insert into clinical_record_corrections
      (practice_id, record_type, vaccination_record_id, patient_id, reason,
       corrected_by, corrected_by_name)
      values (${practiceId}, 'vaccination_record', ${vaccinationId}, ${patientA},
        'Seeded demonstration record cleared from the clinic.',
        ${veterinarianId}, 'Vaccination Veterinarian')
      returning id`,
  );
  check(
    "known demo vaccinations can be dispositioned by append-only correction",
    correctionRows.length === 1,
  );
} finally {
  try {
    await owner`delete from audit_log where practice_id = ${practiceId}`;
    await owner.begin(async (tx) => {
      const maintenanceTx = tx as unknown as typeof owner;
      await maintenanceTx`select set_config('app.ledger_maintenance', 'on', true)`;
      await maintenanceTx`delete from clinical_record_corrections where practice_id = ${practiceId}`;
    });
    await owner`delete from vaccination_records where practice_id = ${practiceId}`;
    await owner`delete from appointments where practice_id = ${practiceId}`;
    await owner`delete from patients where practice_id = ${practiceId}`;
    await owner`delete from clients where practice_id = ${practiceId}`;
    await owner`delete from users where practice_id = ${practiceId}`;
    await owner`delete from locations where practice_id = ${practiceId}`;
    await owner`delete from practices where id = ${practiceId}`;
  } finally {
    await app.end();
    await owner.end();
  }
}

if (failures > 0) {
  console.error(`Vaccination integrity contract failed: ${failures} check(s)`);
  process.exit(1);
}

console.log("Vaccination integrity contract passed.");
