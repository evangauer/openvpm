/** Privacy-bounded, read-only preflight for lab-result evidence and follow-up. */
import { config } from "dotenv";
config({ path: process.env.OPENPIMS_ENV_FILE?.trim() || "../../.env" });

import postgres from "postgres";

const CONFIRMATION = "OPENVPM_LAB_RESULT_INTEGRITY_READ_ONLY";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function allowLiveReadOnly(): boolean {
  return (
    process.argv.includes("--allow-live-read-only") &&
    process.env.LAB_RESULT_INTEGRITY_READ_ONLY_CONFIRMATION === CONFIRMATION
  );
}

if (!allowLiveReadOnly()) {
  console.error(
    `Refusing database access. Pass --allow-live-read-only and set LAB_RESULT_INTEGRITY_READ_ONLY_CONFIRMATION=${CONFIRMATION}.`,
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
  totalLabResults: number;
  practicesWithLabResults: number;
  knownRepositoryDemoLabResults: number;
  labResultsOutsideKnownRepositoryDemo: number;
  missingCreationIdentity: number;
  malformedCreationIdentity: number;
  blankTestNames: number;
  lifecycleShapeMismatches: number;
  resultShapeMismatches: number;
  invertedReferenceRanges: number;
  followUpShapeMismatches: number;
  crossTenantPatients: number;
  crossTenantAppointments: number;
  crossTenantOrderers: number;
  crossTenantReviewers: number;
  crossTenantFollowUpAssignees: number;
  crossTenantFollowUpCompleters: number;
  missingCreatedEvents: number;
  createdIdentityMismatches: number;
  eventSourceMismatches: number;
  latestEventProjectionMismatches: number;
  replacementChartMismatches: number;
  correctedSourcesWithoutReplacement: number;
  criticalAwaitingReview: number;
  overdueOpenFollowUps: number;
  agedPendingOverSevenDays: number;
  completedAwaitingReviewOverOneDay: number;
};

type ArchitectureState = {
  appRoleExists: boolean;
  appRoleCanDeleteLabResults: boolean;
  appRoleCanUpdateTestName: boolean;
  replacementChartIdentityEnforced: boolean;
};

try {
  const audit = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [row] = await tx.unsafe<AuditCounts[]>(`
        with results as (
          select * from lab_results where deleted_at is null
        ),
        event_rollup as (
          select
            practice_id,
            lab_result_id,
            count(*) filter (where event_type = 'created')::int as created_count
          from lab_result_events
          group by practice_id, lab_result_id
        ),
        latest_events as (
          select *
          from (
            select
              event.*,
              row_number() over (
                partition by event.practice_id, event.lab_result_id
                order by event.created_at desc, event.id desc
              ) as event_rank
            from lab_result_events event
          ) ranked
          where event_rank = 1
        ),
        corrected as (
          select correction.practice_id, correction.lab_result_id
          from clinical_record_corrections correction
          where correction.record_type = 'lab_result'
        )
        select
          (select count(*)::int from results) as "totalLabResults",
          (select count(distinct practice_id)::int from results) as "practicesWithLabResults",
          (select count(*)::int
            from results result
            join practices practice on practice.id = result.practice_id
            where practice.name = 'Neighborhood Veterinary'
              and practice.email = 'hello@neighborhoodvet.example.com') as "knownRepositoryDemoLabResults",
          (select count(*)::int
            from results result
            join practices practice on practice.id = result.practice_id
            where practice.name <> 'Neighborhood Veterinary'
              or practice.email is distinct from 'hello@neighborhoodvet.example.com') as "labResultsOutsideKnownRepositoryDemo",
          (select count(*)::int from results
            where creation_operation_id is null) as "missingCreationIdentity",
          (select count(*)::int from results
            where (creation_operation_id is null) <> (creation_payload_hash is null)
              or (creation_payload_hash is not null
                and creation_payload_hash !~ '^[0-9a-f]{64}$')) as "malformedCreationIdentity",
          (select count(*)::int from results
            where length(btrim(test_name)) = 0) as "blankTestNames",
          (select count(*)::int from results
            where not (
              (status = 'pending' and completed_at is null
                and reviewed_at is null and reviewed_by is null)
              or (status = 'completed' and completed_at is not null
                and reviewed_at is null and reviewed_by is null)
              or (status = 'reviewed' and completed_at is not null
                and reviewed_at is not null and reviewed_by is not null)
            )) as "lifecycleShapeMismatches",
          (select count(*)::int from results
            where not (
              (status = 'pending' and result_value is null and unit is null
                and reference_range_low is null and reference_range_high is null
                and result_flag = 'unknown')
              or (status in ('completed', 'reviewed')
                and length(btrim(coalesce(result_value, ''))) > 0)
            )) as "resultShapeMismatches",
          (select count(*)::int from results
            where reference_range_low is not null
              and reference_range_high is not null
              and reference_range_high < reference_range_low) as "invertedReferenceRanges",
          (select count(*)::int from results
            where not (
              (status <> 'pending' or follow_up_status = 'not_required')
              and not (status = 'reviewed' and result_flag = 'critical'
                and follow_up_status = 'not_required')
              and not (result_flag = 'critical'
                and follow_up_status in ('open', 'completed')
                and follow_up_due_at is null)
              and (
                (follow_up_status = 'not_required'
                  and follow_up_assigned_to is null and follow_up_due_at is null
                  and follow_up_note is null and follow_up_completed_by is null
                  and follow_up_completed_at is null and follow_up_outcome is null)
                or (follow_up_status = 'open'
                  and follow_up_assigned_to is not null
                  and follow_up_completed_by is null
                  and follow_up_completed_at is null and follow_up_outcome is null)
                or (follow_up_status = 'completed'
                  and follow_up_assigned_to is not null
                  and follow_up_completed_by is not null
                  and follow_up_completed_at is not null
                  and length(btrim(coalesce(follow_up_outcome, ''))) between 3 and 1000)
              )
            )) as "followUpShapeMismatches",
          (select count(*)::int from results result
            left join patients patient
              on patient.practice_id = result.practice_id and patient.id = result.patient_id
            where patient.id is null) as "crossTenantPatients",
          (select count(*)::int from results result
            left join appointments appointment
              on appointment.practice_id = result.practice_id
             and appointment.id = result.appointment_id
             and appointment.patient_id = result.patient_id
            where result.appointment_id is not null and appointment.id is null) as "crossTenantAppointments",
          (select count(*)::int from results result
            left join users actor
              on actor.practice_id = result.practice_id and actor.id = result.ordered_by
            where result.ordered_by is not null and actor.id is null) as "crossTenantOrderers",
          (select count(*)::int from results result
            left join users actor
              on actor.practice_id = result.practice_id and actor.id = result.reviewed_by
            where result.reviewed_by is not null and actor.id is null) as "crossTenantReviewers",
          (select count(*)::int from results result
            left join users actor
              on actor.practice_id = result.practice_id and actor.id = result.follow_up_assigned_to
            where result.follow_up_assigned_to is not null and actor.id is null) as "crossTenantFollowUpAssignees",
          (select count(*)::int from results result
            left join users actor
              on actor.practice_id = result.practice_id and actor.id = result.follow_up_completed_by
            where result.follow_up_completed_by is not null and actor.id is null) as "crossTenantFollowUpCompleters",
          (select count(*)::int from results result
            left join event_rollup events
              on events.practice_id = result.practice_id and events.lab_result_id = result.id
            where coalesce(events.created_count, 0) <> 1) as "missingCreatedEvents",
          (select count(*)::int
            from results result
            join lab_result_events event
              on event.practice_id = result.practice_id
             and event.lab_result_id = result.id and event.event_type = 'created'
            where event.operation_id is distinct from result.creation_operation_id
              or event.operation_payload_hash is distinct from result.creation_payload_hash) as "createdIdentityMismatches",
          (select count(*)::int
            from lab_result_events event
            left join results result
              on result.practice_id = event.practice_id
             and result.id = event.lab_result_id
             and result.patient_id = event.patient_id
             and result.appointment_id is not distinct from event.appointment_id
            where result.id is null) as "eventSourceMismatches",
          (select count(*)::int
            from results result
            join latest_events event
              on event.practice_id = result.practice_id and event.lab_result_id = result.id
            where event.status_after is distinct from result.status
              or event.result_value is distinct from result.result_value
              or event.unit is distinct from result.unit
              or event.reference_range_low is distinct from result.reference_range_low
              or event.reference_range_high is distinct from result.reference_range_high
              or event.result_flag is distinct from result.result_flag
              or event.follow_up_status is distinct from result.follow_up_status
              or event.follow_up_assigned_to is distinct from result.follow_up_assigned_to
              or event.follow_up_due_at is distinct from result.follow_up_due_at) as "latestEventProjectionMismatches",
          (select count(*)::int
            from lab_result_replacements link
            join results source
              on source.practice_id = link.practice_id and source.id = link.source_lab_result_id
            join results replacement
              on replacement.practice_id = link.practice_id and replacement.id = link.replacement_lab_result_id
            where source.patient_id is distinct from replacement.patient_id
              or source.appointment_id is distinct from replacement.appointment_id) as "replacementChartMismatches",
          (select count(*)::int
            from corrected correction
            left join lab_result_replacements link
              on link.practice_id = correction.practice_id
             and link.source_lab_result_id = correction.lab_result_id
            where link.id is null) as "correctedSourcesWithoutReplacement",
          (select count(*)::int from results result
            left join corrected correction
              on correction.practice_id = result.practice_id
             and correction.lab_result_id = result.id
            where correction.lab_result_id is null
              and result.result_flag = 'critical' and result.status = 'completed') as "criticalAwaitingReview",
          (select count(*)::int from results result
            left join corrected correction
              on correction.practice_id = result.practice_id
             and correction.lab_result_id = result.id
            where correction.lab_result_id is null
              and result.follow_up_status = 'open'
              and result.follow_up_due_at < now()) as "overdueOpenFollowUps",
          (select count(*)::int from results result
            left join corrected correction
              on correction.practice_id = result.practice_id
             and correction.lab_result_id = result.id
            where correction.lab_result_id is null
              and result.status = 'pending'
              and result.created_at < now() - interval '7 days') as "agedPendingOverSevenDays",
          (select count(*)::int from results result
            left join corrected correction
              on correction.practice_id = result.practice_id
             and correction.lab_result_id = result.id
            where correction.lab_result_id is null
              and result.status = 'completed'
              and result.completed_at < now() - interval '1 day') as "completedAwaitingReviewOverOneDay"
      `);
      const [architecture] = await tx.unsafe<ArchitectureState[]>(`
        select
          exists(select 1 from pg_roles where rolname = 'openpims_app') as "appRoleExists",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then has_table_privilege('openpims_app', 'public.lab_results', 'DELETE')
            else false end as "appRoleCanDeleteLabResults",
          case when exists(select 1 from pg_roles where rolname = 'openpims_app')
            then has_column_privilege('openpims_app', 'public.lab_results', 'test_name', 'UPDATE')
            else false end as "appRoleCanUpdateTestName",
          coalesce(
            pg_get_functiondef(
              to_regprocedure('public.validate_lab_result_replacement_insert()')
            ) like '%source.patient_id = replacement.patient_id%'
            and pg_get_functiondef(
              to_regprocedure('public.validate_lab_result_replacement_insert()')
            ) like '%source.appointment_id IS NOT DISTINCT FROM replacement.appointment_id%',
            false
          ) as "replacementChartIdentityEnforced"
      `);
      if (!row || !architecture) {
        throw new Error("Lab-result audit returned no result.");
      }
      return { counts: row, architecture };
    },
  );

  const { counts, architecture } = audit;
  const informationalKeys: Array<keyof AuditCounts> = [
    "totalLabResults",
    "practicesWithLabResults",
    "knownRepositoryDemoLabResults",
    "labResultsOutsideKnownRepositoryDemo",
    "correctedSourcesWithoutReplacement",
  ];
  const operationalKeys: Array<keyof AuditCounts> = [
    "criticalAwaitingReview",
    "overdueOpenFollowUps",
    "agedPendingOverSevenDays",
    "completedAwaitingReviewOverOneDay",
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
    ...(architecture.appRoleCanDeleteLabResults ||
    architecture.appRoleCanUpdateTestName
      ? ["lab_result_projection_has_broad_application_role_mutation_privileges"]
      : []),
    ...(!architecture.replacementChartIdentityEnforced
      ? ["lab_replacement_chart_identity_is_not_database_enforced"]
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
} catch {
  console.error("Lab-result read-only audit failed; details redacted.");
  process.exitCode = 1;
} finally {
  await sql.end();
}
