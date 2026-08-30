/** Privacy-bounded, read-only preflight for vaccination and certificate evidence. */
import { config } from "dotenv";
config({ path: process.env.OPENPIMS_ENV_FILE?.trim() || "../../.env" });

import postgres from "postgres";

const CONFIRMATION = "OPENVPM_VACCINATION_INTEGRITY_READ_ONLY";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function allowLiveReadOnly(): boolean {
  return (
    process.argv.includes("--allow-live-read-only") &&
    process.env.VACCINATION_INTEGRITY_READ_ONLY_CONFIRMATION === CONFIRMATION
  );
}

if (!allowLiveReadOnly()) {
  console.error(
    `Refusing database access. Pass --allow-live-read-only and set VACCINATION_INTEGRITY_READ_ONLY_CONFIRMATION=${CONFIRMATION}.`,
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
  totalVaccinations: number;
  practicesWithVaccinations: number;
  knownRepositoryDemoVaccinations: number;
  vaccinationsOutsideKnownRepositoryDemo: number;
  correctedVaccinations: number;
  blankVaccineNames: number;
  nonImportVaccinationsWithoutAdministrator: number;
  crossTenantPatients: number;
  crossTenantAppointments: number;
  appointmentPatientMismatches: number;
  crossTenantAdministrators: number;
  crossTenantSupervisors: number;
  productExpiredBeforeAdministration: number;
  nextDueNotAfterAdministration: number;
  futureAdministrationTimes: number;
  duplicateActiveRabiesTagAssignments: number;
  certificateDetailUpdatesWithoutAuditEvidence: number;
  activeRabiesVaccinations: number;
  rabiesRecordsMissingCertificateData: number;
};

type ArchitectureState = {
  certificateSchemaPresent: boolean;
  appRoleExists: boolean;
  appRoleCanDeleteVaccinations: boolean;
  appRoleCanUpdatePatientId: boolean;
  appRoleCanUpdateVaccineName: boolean;
  appRoleCanUpdateAdministeredAt: boolean;
  appRoleCanUpdateNextDueDate: boolean;
  appRoleCanUpdateCertificateDetails: boolean;
  appRoleCanInsertSystemIdentity: boolean;
  certificateAuditEvidenceImmutable: boolean;
  certificateUpdatesAreDatabaseAudited: boolean;
};

try {
  const audit = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [architecture] = await tx.unsafe<ArchitectureState[]>(`
        select
          (select count(*) = 7
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'vaccination_records'
              and column_name in (
                'product_name', 'product_expiration_date', 'dose_type',
                'licensed_duration_months', 'rabies_tag_number',
                'supervising_veterinarian_id', 'next_due_date'
              )) as "certificateSchemaPresent",
          exists(select 1 from pg_roles where rolname = 'openpims_app') as "appRoleExists",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then has_table_privilege('openpims_app', 'public.vaccination_records', 'DELETE')
            else false end as "appRoleCanDeleteVaccinations",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then has_column_privilege('openpims_app', 'public.vaccination_records', 'patient_id', 'UPDATE')
            else false end as "appRoleCanUpdatePatientId",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then has_column_privilege('openpims_app', 'public.vaccination_records', 'vaccine_name', 'UPDATE')
            else false end as "appRoleCanUpdateVaccineName",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then has_column_privilege('openpims_app', 'public.vaccination_records', 'administered_at', 'UPDATE')
            else false end as "appRoleCanUpdateAdministeredAt",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then has_column_privilege('openpims_app', 'public.vaccination_records', 'next_due_date', 'UPDATE')
            else false end as "appRoleCanUpdateNextDueDate",
          false as "appRoleCanUpdateCertificateDetails",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then has_column_privilege('openpims_app', 'public.vaccination_records', 'id', 'INSERT')
              or has_column_privilege('openpims_app', 'public.vaccination_records', 'created_at', 'INSERT')
              or has_column_privilege('openpims_app', 'public.vaccination_records', 'deleted_at', 'INSERT')
            else false end as "appRoleCanInsertSystemIdentity",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then not has_table_privilege('openpims_app', 'public.audit_log', 'UPDATE')
              and not has_table_privilege('openpims_app', 'public.audit_log', 'DELETE')
              and not has_column_privilege('openpims_app', 'public.audit_log', 'id', 'INSERT')
              and not has_column_privilege('openpims_app', 'public.audit_log', 'created_at', 'INSERT')
              and has_column_privilege('openpims_app', 'public.audit_log', 'action', 'INSERT')
            else false end as "certificateAuditEvidenceImmutable",
          exists (
            select 1
            from pg_trigger trigger
            join pg_proc procedure on procedure.oid = trigger.tgfoid
            where trigger.tgrelid = 'public.vaccination_records'::regclass
              and trigger.tgname = 'vaccination_records_validate_write'
              and not trigger.tgisinternal
              and pg_get_functiondef(procedure.oid) like '%certificate_details_updated%'
              and pg_get_functiondef(procedure.oid) like '%app.vaccination_certificate_actor_id%'
              and pg_get_functiondef(procedure.oid) like '%app.vaccination_certificate_reason%'
          ) as "certificateUpdatesAreDatabaseAudited"
      `);
      if (!architecture) {
        throw new Error("Vaccination architecture audit returned no result.");
      }
      if (architecture.certificateSchemaPresent && architecture.appRoleExists) {
        const [certificatePrivilege] = await tx.unsafe<
          Array<{ allowed: boolean }>
        >(`
          select
            has_column_privilege('openpims_app', 'public.vaccination_records', 'product_name', 'UPDATE')
            and has_column_privilege('openpims_app', 'public.vaccination_records', 'manufacturer', 'UPDATE')
            and has_column_privilege('openpims_app', 'public.vaccination_records', 'lot_number', 'UPDATE')
            and has_column_privilege('openpims_app', 'public.vaccination_records', 'product_expiration_date', 'UPDATE')
            and has_column_privilege('openpims_app', 'public.vaccination_records', 'dose_type', 'UPDATE')
            and has_column_privilege('openpims_app', 'public.vaccination_records', 'licensed_duration_months', 'UPDATE')
            and has_column_privilege('openpims_app', 'public.vaccination_records', 'rabies_tag_number', 'UPDATE')
            and has_column_privilege('openpims_app', 'public.vaccination_records', 'supervising_veterinarian_id', 'UPDATE')
            and has_column_privilege('openpims_app', 'public.vaccination_records', 'updated_at', 'UPDATE')
              as allowed
        `);
        architecture.appRoleCanUpdateCertificateDetails =
          certificatePrivilege?.allowed ?? false;
      }
      const [counts] = await tx.unsafe<AuditCounts[]>(`
        with active_vaccinations as (
          select vaccination.*
          from vaccination_records vaccination
          where vaccination.deleted_at is null
        ),
        current_vaccinations as (
          select vaccination.*
          from active_vaccinations vaccination
          where not exists (
            select 1
            from clinical_record_corrections correction
            where correction.practice_id = vaccination.practice_id
              and correction.vaccination_record_id = vaccination.id
          )
        ),
        rabies_vaccinations as (
          select vaccination.*
          from current_vaccinations vaccination
          where vaccination.vaccine_name ~* 'rabies'
        )
        select
          (select count(*)::int from active_vaccinations) as "totalVaccinations",
          (select count(distinct practice_id)::int from active_vaccinations) as "practicesWithVaccinations",
          (select count(*)::int
            from active_vaccinations vaccination
            join practices practice on practice.id = vaccination.practice_id
            where practice.name = 'Neighborhood Veterinary'
              and practice.email = 'hello@neighborhoodvet.example.com') as "knownRepositoryDemoVaccinations",
          (select count(*)::int
            from active_vaccinations vaccination
            join practices practice on practice.id = vaccination.practice_id
            where practice.name <> 'Neighborhood Veterinary'
              or practice.email is distinct from 'hello@neighborhoodvet.example.com') as "vaccinationsOutsideKnownRepositoryDemo",
          (select count(*)::int
            from active_vaccinations vaccination
            where exists (
              select 1 from clinical_record_corrections correction
              where correction.practice_id = vaccination.practice_id
                and correction.vaccination_record_id = vaccination.id
            )) as "correctedVaccinations",
          (select count(*)::int from active_vaccinations
            where length(btrim(vaccine_name)) = 0) as "blankVaccineNames",
          (select count(*)::int from active_vaccinations
            where import_fingerprint is null and administered_by is null) as "nonImportVaccinationsWithoutAdministrator",
          (select count(*)::int
            from active_vaccinations vaccination
            left join patients patient
              on patient.practice_id = vaccination.practice_id
             and patient.id = vaccination.patient_id
            where patient.id is null) as "crossTenantPatients",
          (select count(*)::int
            from active_vaccinations vaccination
            left join appointments appointment
              on appointment.practice_id = vaccination.practice_id
             and appointment.id = vaccination.appointment_id
            where vaccination.appointment_id is not null and appointment.id is null) as "crossTenantAppointments",
          (select count(*)::int
            from active_vaccinations vaccination
            join appointments appointment
              on appointment.practice_id = vaccination.practice_id
             and appointment.id = vaccination.appointment_id
            where appointment.patient_id is distinct from vaccination.patient_id) as "appointmentPatientMismatches",
          (select count(*)::int
            from active_vaccinations vaccination
            left join users actor
              on actor.practice_id = vaccination.practice_id
             and actor.id = vaccination.administered_by
            where vaccination.administered_by is not null and actor.id is null) as "crossTenantAdministrators",
          0::int as "crossTenantSupervisors",
          0::int as "productExpiredBeforeAdministration",
          (select count(*)::int
            from active_vaccinations vaccination
            join practices practice on practice.id = vaccination.practice_id
            where vaccination.next_due_date is not null
              and vaccination.next_due_date <=
                (vaccination.administered_at at time zone practice.timezone)::date) as "nextDueNotAfterAdministration",
          (select count(*)::int from active_vaccinations
            where administered_at > now() + interval '5 minutes') as "futureAdministrationTimes",
          0::int as "duplicateActiveRabiesTagAssignments",
          (select count(*)::int
            from active_vaccinations vaccination
            where vaccination.updated_at > vaccination.created_at + interval '1 second'
              and not exists (
                select 1 from audit_log event
                where event.practice_id = vaccination.practice_id
                  and event.entity_type = 'vaccination_record'
                  and event.entity_id = vaccination.id
                  and event.action = 'certificate_details_updated'
              )) as "certificateDetailUpdatesWithoutAuditEvidence",
          (select count(*)::int from rabies_vaccinations) as "activeRabiesVaccinations",
          (select count(*)::int from rabies_vaccinations) as "rabiesRecordsMissingCertificateData"
      `);
      if (counts && architecture.certificateSchemaPresent) {
        const [certificateCounts] = await tx.unsafe<
          Array<
            Pick<
              AuditCounts,
              | "crossTenantSupervisors"
              | "productExpiredBeforeAdministration"
              | "duplicateActiveRabiesTagAssignments"
              | "rabiesRecordsMissingCertificateData"
            >
          >
        >(`
          with current_vaccinations as (
            select vaccination.*
            from vaccination_records vaccination
            where vaccination.deleted_at is null
              and not exists (
                select 1 from clinical_record_corrections correction
                where correction.practice_id = vaccination.practice_id
                  and correction.vaccination_record_id = vaccination.id
              )
          ),
          rabies_vaccinations as (
            select vaccination.*
            from current_vaccinations vaccination
            where vaccination.vaccine_name ~* 'rabies'
          ),
          duplicate_rabies_tags as (
            select practice_id, lower(btrim(rabies_tag_number)) as tag
            from rabies_vaccinations
            where length(btrim(coalesce(rabies_tag_number, ''))) > 0
            group by practice_id, lower(btrim(rabies_tag_number))
            having count(*) > 1
          )
          select
            (select count(*)::int
              from current_vaccinations vaccination
              left join users supervisor
                on supervisor.practice_id = vaccination.practice_id
               and supervisor.id = vaccination.supervising_veterinarian_id
              where vaccination.supervising_veterinarian_id is not null
                and (supervisor.id is null or supervisor.is_veterinarian is distinct from true)) as "crossTenantSupervisors",
            (select count(*)::int
              from current_vaccinations vaccination
              join practices practice on practice.id = vaccination.practice_id
              where vaccination.product_expiration_date is not null
                and vaccination.product_expiration_date <
                  (vaccination.administered_at at time zone practice.timezone)::date) as "productExpiredBeforeAdministration",
            (select count(*)::int from duplicate_rabies_tags) as "duplicateActiveRabiesTagAssignments",
            (select count(*)::int
              from rabies_vaccinations vaccination
              left join users supervisor
                on supervisor.practice_id = vaccination.practice_id
               and supervisor.id = vaccination.supervising_veterinarian_id
              join practices practice on practice.id = vaccination.practice_id
              where length(btrim(coalesce(vaccination.product_name, ''))) = 0
                or length(btrim(coalesce(vaccination.manufacturer, ''))) = 0
                or length(btrim(coalesce(vaccination.lot_number, ''))) = 0
                or vaccination.product_expiration_date is null
                or vaccination.dose_type is null
                or vaccination.licensed_duration_months is null
                or vaccination.next_due_date is null
                or vaccination.product_expiration_date <
                  (vaccination.administered_at at time zone practice.timezone)::date
                or vaccination.next_due_date <=
                  (vaccination.administered_at at time zone practice.timezone)::date
                or supervisor.id is null
                or length(btrim(coalesce(supervisor.license_number, ''))) = 0) as "rabiesRecordsMissingCertificateData"
        `);
        if (!certificateCounts) {
          throw new Error("Vaccination certificate audit returned no result.");
        }
        Object.assign(counts, certificateCounts);
      }
      if (!counts || !architecture) {
        throw new Error("Vaccination audit returned no result.");
      }
      return { counts, architecture };
    },
  );

  const { counts, architecture } = audit;
  const informationalKeys: Array<keyof AuditCounts> = [
    "totalVaccinations",
    "practicesWithVaccinations",
    "knownRepositoryDemoVaccinations",
    "vaccinationsOutsideKnownRepositoryDemo",
    "correctedVaccinations",
    "activeRabiesVaccinations",
  ];
  const operationalKeys: Array<keyof AuditCounts> = [
    "rabiesRecordsMissingCertificateData",
  ];
  const integrityFindings = (
    Object.keys(counts) as Array<keyof AuditCounts>
  ).filter(
    (key) =>
      !informationalKeys.includes(key) &&
      !operationalKeys.includes(key) &&
      counts[key] > 0,
  );
  const operationalFindings = operationalKeys.filter((key) => counts[key] > 0);
  const architectureFindings = [
    ...(!architecture.appRoleExists
      ? ["least_privilege_application_role_is_not_configured"]
      : []),
    ...(architecture.appRoleCanDeleteVaccinations ||
    architecture.appRoleCanUpdatePatientId ||
    architecture.appRoleCanUpdateVaccineName ||
    architecture.appRoleCanUpdateAdministeredAt ||
    architecture.appRoleCanUpdateNextDueDate ||
    architecture.appRoleCanInsertSystemIdentity
      ? ["vaccination_evidence_has_broad_application_role_mutation_privileges"]
      : []),
    ...(!architecture.certificateSchemaPresent
      ? ["vaccination_certificate_schema_is_not_deployed"]
      : []),
    ...(!architecture.certificateAuditEvidenceImmutable
      ? ["certificate_change_audit_evidence_is_mutable"]
      : []),
    ...(!architecture.certificateUpdatesAreDatabaseAudited
      ? ["certificate_changes_are_not_atomically_database_audited"]
      : []),
    ...(architecture.certificateSchemaPresent &&
    !architecture.appRoleCanUpdateCertificateDetails
      ? ["certificate_detail_completion_is_not_available_to_application_role"]
      : []),
  ];

  console.log(
    JSON.stringify(
      {
        version: 1,
        mode: "read_only_aggregate",
        counts,
        architectureState: architecture,
        releaseSafe:
          integrityFindings.length === 0 &&
          operationalFindings.length === 0 &&
          architectureFindings.length === 0,
        integrityFindings,
        operationalFindings,
        architectureFindings,
      },
      null,
      2,
    ),
  );
  if (
    integrityFindings.length > 0 ||
    operationalFindings.length > 0 ||
    architectureFindings.length > 0
  ) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error("Vaccination read-only audit failed; details redacted.");
  if (
    process.env.VACCINATION_INTEGRITY_DEBUG ===
    "OPENVPM_VACCINATION_INTEGRITY_DEBUG"
  ) {
    const diagnostic = error as {
      name?: unknown;
      code?: unknown;
      severity?: unknown;
      position?: unknown;
      table_name?: unknown;
      column_name?: unknown;
      constraint_name?: unknown;
    };
    console.error(
      JSON.stringify({
        name: diagnostic.name,
        code: diagnostic.code,
        severity: diagnostic.severity,
        position: diagnostic.position,
        table: diagnostic.table_name,
        column: diagnostic.column_name,
        constraint: diagnostic.constraint_name,
      }),
    );
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
