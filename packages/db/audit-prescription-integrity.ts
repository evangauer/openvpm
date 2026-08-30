/** Privacy-bounded, read-only preflight for prescription data and safety coverage. */
import { config } from "dotenv";
config({ path: process.env.OPENPIMS_ENV_FILE?.trim() || "../../.env" });

import postgres from "postgres";
import { databaseConnectionIdentityFingerprint } from "./deployment-target";

const CONFIRMATION = "OPENVPM_PRESCRIPTION_INTEGRITY_READ_ONLY";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function allowLiveReadOnly(): boolean {
  return (
    process.argv.includes("--allow-live-read-only") &&
    process.env.PRESCRIPTION_INTEGRITY_READ_ONLY_CONFIRMATION === CONFIRMATION
  );
}

if (!allowLiveReadOnly()) {
  console.error(
    `Refusing database access. Pass --allow-live-read-only and set PRESCRIPTION_INTEGRITY_READ_ONLY_CONFIRMATION=${CONFIRMATION}.`,
  );
  process.exit(1);
}

const databaseUrl = nonBlankEnv("DATABASE_URL");
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const sql = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 2,
});

type AuditCounts = {
  totalPrescriptions: number;
  practicesWithPrescriptions: number;
  knownRepositoryDemoPrescriptions: number;
  prescriptionsOutsideKnownRepositoryDemo: number;
  nullOperationIds: number;
  blankClinicalFields: number;
  nonPositiveQuantities: number;
  inventoryLinksWithoutPositiveQuantity: number;
  negativeRefills: number;
  endBeforeStart: number;
  crossTenantPatients: number;
  crossTenantProducts: number;
  crossTenantPrescribers: number;
  crossTenantAppointments: number;
  missingCreatedEvents: number;
  prescriptionEventSourceMismatches: number;
  currentRefillProjectionMismatches: number;
  terminalProjectionMismatches: number;
  nonCreatedEventsWithoutOperationIds: number;
  interactionCatalogRows: number;
  activeAllergyRows: number;
};

try {
  const databaseTargetFingerprint =
    databaseConnectionIdentityFingerprint(databaseUrl);
  const counts = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [row] = await tx.unsafe<AuditCounts[]>(`
        with rx as (
          select *
          from prescriptions
          where deleted_at is null
        ),
        event_rollup as (
          select
            prescription_id,
            count(*) filter (where event_type = 'created')::int as created_count,
            max(refills_after) filter (where event_type = 'created') as initial_refills,
            count(*) filter (
              where event_type in ('refill_dispensed', 'refill_authorized')
            )::int as refill_count,
            max(status_after::text) filter (
              where event_type in ('completed', 'cancelled', 'expired')
            ) as terminal_status
          from prescription_events
          group by prescription_id
        )
        select
          (select count(*)::int from rx) as "totalPrescriptions",
          (select count(distinct practice_id)::int from rx) as "practicesWithPrescriptions",
          (select count(*)::int
            from rx
            join practices practice on practice.id = rx.practice_id
            where practice.name = 'Neighborhood Veterinary'
              and practice.email = 'hello@neighborhoodvet.example.com') as "knownRepositoryDemoPrescriptions",
          (select count(*)::int
            from rx
            join practices practice on practice.id = rx.practice_id
            where practice.name <> 'Neighborhood Veterinary'
              or practice.email is distinct from 'hello@neighborhoodvet.example.com') as "prescriptionsOutsideKnownRepositoryDemo",
          (select count(*)::int from rx where operation_id is null) as "nullOperationIds",
          (select count(*)::int from rx
            where length(btrim(medication_name)) = 0
              or length(btrim(dosage)) = 0
              or length(btrim(frequency)) = 0) as "blankClinicalFields",
          (select count(*)::int from rx where quantity <= 0) as "nonPositiveQuantities",
          (select count(*)::int from rx
            where product_id is not null and coalesce(quantity, 0) <= 0) as "inventoryLinksWithoutPositiveQuantity",
          (select count(*)::int from rx where refills_remaining < 0) as "negativeRefills",
          (select count(*)::int from rx
            where end_date is not null and end_date < start_date) as "endBeforeStart",
          (select count(*)::int
            from rx
            left join patients patient
              on patient.practice_id = rx.practice_id and patient.id = rx.patient_id
            where patient.id is null) as "crossTenantPatients",
          (select count(*)::int
            from rx
            left join products product
              on product.practice_id = rx.practice_id and product.id = rx.product_id
            where rx.product_id is not null and product.id is null) as "crossTenantProducts",
          (select count(*)::int
            from rx
            left join users prescriber
              on prescriber.practice_id = rx.practice_id and prescriber.id = rx.prescribed_by
            where prescriber.id is null) as "crossTenantPrescribers",
          (select count(*)::int
            from rx
            left join appointments appointment
              on appointment.practice_id = rx.practice_id and appointment.id = rx.appointment_id
            where rx.appointment_id is not null and appointment.id is null) as "crossTenantAppointments",
          (select count(*)::int
            from rx
            left join event_rollup events on events.prescription_id = rx.id
            where coalesce(events.created_count, 0) <> 1) as "missingCreatedEvents",
          (select count(*)::int
            from prescription_events event
            left join rx
              on rx.practice_id = event.practice_id
             and rx.id = event.prescription_id
             and rx.patient_id = event.patient_id
             and rx.product_id is not distinct from event.product_id
             and rx.quantity is not distinct from event.quantity
            where rx.id is null) as "prescriptionEventSourceMismatches",
          (select count(*)::int
            from rx
            join event_rollup events on events.prescription_id = rx.id
            where events.created_count = 1
              and rx.refills_remaining <> events.initial_refills - events.refill_count) as "currentRefillProjectionMismatches",
          (select count(*)::int
            from rx
            left join event_rollup events on events.prescription_id = rx.id
            where (rx.status = 'active' and events.terminal_status is not null)
               or (rx.status <> 'active' and events.terminal_status is distinct from rx.status::text)) as "terminalProjectionMismatches",
          (select count(*)::int
            from prescription_events
            where event_type not in ('created', 'expired') and operation_id is null) as "nonCreatedEventsWithoutOperationIds",
          (select count(*)::int from drug_interactions where deleted_at is null) as "interactionCatalogRows",
          (select count(*)::int
            from patient_allergies allergy
            where allergy.deleted_at is null
              and not exists (
                select 1
                from clinical_record_corrections correction
                where correction.patient_allergy_id = allergy.id
              )) as "activeAllergyRows"
      `);
      if (!row) throw new Error("Prescription audit returned no result.");
      return row;
    },
  );

  const findingKeys = (Object.keys(counts) as Array<keyof AuditCounts>).filter(
    (key) =>
      ![
        "totalPrescriptions",
        "practicesWithPrescriptions",
        "knownRepositoryDemoPrescriptions",
        "prescriptionsOutsideKnownRepositoryDemo",
        "interactionCatalogRows",
        "activeAllergyRows",
      ].includes(key) && counts[key] > 0,
  );
  const architectureFindings = [
    "prescription_safety_overrides_are_not_persisted",
    ...(counts.interactionCatalogRows === 0
      ? ["interaction_catalog_is_empty"]
      : []),
  ];
  console.log(
    JSON.stringify(
      {
        version: 1,
        mode: "read_only_aggregate",
        checkedAt: new Date().toISOString(),
        databaseTargetFingerprint,
        counts,
        releaseSafe:
          findingKeys.length === 0 && architectureFindings.length === 0,
        findings: findingKeys,
        architectureFindings,
      },
      null,
      2,
    ),
  );
  if (findingKeys.length > 0 || architectureFindings.length > 0) {
    process.exitCode = 2;
  }
} catch {
  console.error("Prescription read-only audit failed; details redacted.");
  process.exitCode = 1;
} finally {
  await sql.end();
}
