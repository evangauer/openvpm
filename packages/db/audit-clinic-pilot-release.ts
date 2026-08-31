/** PHI-free, read-only proof that a release packet matches one pilot projection. */
import { createHash } from "node:crypto";
import { config } from "dotenv";
config({ path: process.env.OPENPIMS_ENV_FILE?.trim() || "../../.env" });

import postgres from "postgres";
import { databaseConnectionIdentityFingerprint } from "./deployment-target";

const CONFIRMATION = "OPENVPM_CLINIC_PILOT_RELEASE_READ_ONLY";
const SHA256 = /^[0-9a-f]{64}$/i;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const clinicUseValidatedHash = argument("--clinic-use-hash")?.toLowerCase();
const rawProjectionVersion = argument("--projection-version");
const pilotProjectionVersion = rawProjectionVersion
  ? Number(rawProjectionVersion)
  : Number.NaN;
if (
  !process.argv.includes("--allow-live-read-only") ||
  process.env.CLINIC_PILOT_RELEASE_READ_ONLY_CONFIRMATION !== CONFIRMATION ||
  !clinicUseValidatedHash ||
  !SHA256.test(clinicUseValidatedHash) ||
  !Number.isSafeInteger(pilotProjectionVersion) ||
  pilotProjectionVersion <= 0
) {
  console.error(
    `Refusing database access. Pass --allow-live-read-only --clinic-use-hash <sha256> --projection-version <positive integer> and set CLINIC_PILOT_RELEASE_READ_ONLY_CONFIRMATION=${CONFIRMATION}.`,
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const sql = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 2,
});

type PilotRow = {
  workflow: string;
  stage: string;
  decision: string;
  blockerCount: number;
  qualificationComplete: boolean;
  readinessComplete: boolean;
  communicationTested: boolean;
  firstVisitValidated: boolean;
  clinicUseValidated: boolean;
  clinicAcceptanceRecorded: boolean;
  clinicAdministratorUserId: string | null;
  verifiedAdministrator: boolean;
  activeLocationCount: number;
  setupComplete: boolean;
  distinctClinicDays: number;
  clinicUseDays: Array<{
    closeoutId: string;
    completedAt: string;
    localDate: string;
  }>;
  paymentMethodCollected: boolean;
  positivePaymentRecorded: boolean;
  hostedFullAccess: boolean;
  jurisdictionConfirmed: boolean;
};

try {
  const rows = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) =>
      tx.unsafe<PilotRow[]>(`
        with eligible_closeouts as (
          select
            cp.id as clinic_pilot_id,
            closeout.id as closeout_id,
            closeout.completed_at,
            (closeout.completed_at at time zone practice.timezone)::date as local_date
          from clinic_pilots cp
          join practices practice
            on practice.id = cp.practice_id
           and practice.deleted_at is null
           and practice.settings ->> 'analyticsExcluded' is distinct from 'true'
          join visit_closeouts closeout
            on closeout.practice_id = cp.practice_id
           and closeout.status = 'completed'
           and closeout.completed_at is not null
           and closeout.completed_at >= cp.created_at
           and closeout.deleted_at is null
          join appointments appointment
            on appointment.id = closeout.appointment_id
           and appointment.practice_id = cp.practice_id
           and appointment.deleted_at is null
          where cp.clinic_use_validated_hash = '${clinicUseValidatedHash}'
            and cp.version = ${pilotProjectionVersion}
            and not (
              coalesce(
                practice.settings -> 'demoData' -> 'appointmentIds',
                '[]'::jsonb
              ) @> to_jsonb(appointment.id::text)
            )
        ), clinic_use_days as (
          select distinct on (clinic_pilot_id, local_date)
            clinic_pilot_id, closeout_id, completed_at, local_date
          from eligible_closeouts
          order by clinic_pilot_id, local_date, completed_at, closeout_id
        ), ranked_clinic_use_days as (
          select
            clinic_use_days.*,
            row_number() over (
              partition by clinic_pilot_id order by completed_at, closeout_id
            ) as day_rank
          from clinic_use_days
        ), current_use as (
          select
            clinic_pilot_id,
            (array_agg(closeout_id order by completed_at, closeout_id))[1]
              as first_visit_closeout_id,
            count(*)::int as distinct_clinic_days,
            jsonb_agg(
              jsonb_build_object(
                'closeoutId', closeout_id,
                'completedAt', completed_at,
                'localDate', local_date
              ) order by completed_at, closeout_id
            ) filter (where day_rank <= 5) as clinic_use_days
          from ranked_clinic_use_days
          group by clinic_pilot_id
        )
        select
          cp.workflow::text as workflow,
          cp.stage::text as stage,
          cp.decision::text as decision,
          cardinality(cp.blocker_codes)::int as "blockerCount",
          not exists (
            select 1 from jsonb_each(cp.qualification_checklist) item
            where item.value is distinct from 'true'::jsonb
          ) as "qualificationComplete",
          not exists (
            select 1 from jsonb_each(cp.readiness_checklist) item
            where item.value is distinct from 'true'::jsonb
          ) as "readinessComplete",
          cp.communication_tested_at is not null as "communicationTested",
          cp.first_visit_validated_at is not null
            and cp.first_visit_validated_closeout_id is not null
            and cp.first_visit_validated_closeout_id =
              current_use.first_visit_closeout_id
            as "firstVisitValidated",
          cp.clinic_use_validated_at is not null
            and cp.clinic_use_validated_hash = '${clinicUseValidatedHash}'
            as "clinicUseValidated",
          cp.clinic_acceptance_at is not null
            and cp.clinic_acceptance_by_user_id is not null
            as "clinicAcceptanceRecorded",
          cp.clinic_acceptance_by_user_id::text as "clinicAdministratorUserId",
          cp.clinic_acceptance_by_user_id is not null
            and exists (
              select 1 from users administrator
              where administrator.practice_id = cp.practice_id
                and administrator.id = cp.clinic_acceptance_by_user_id
                and administrator.role = 'admin'
                and administrator.email_verified_at is not null
                and administrator.deleted_at is null
            )
            as "verifiedAdministrator",
          (
            select count(*)::int from locations location
            where location.practice_id = cp.practice_id
              and location.deleted_at is null
          ) as "activeLocationCount",
          nullif(practice.settings ->> 'onboardingCompletedAt', '') is not null
            and exists (
              select 1 from practice_conversion_milestones milestone
              where milestone.practice_id = cp.practice_id
                and milestone.milestone = 'activated'
            )
            as "setupComplete",
          coalesce(current_use.distinct_clinic_days, 0)::int
            as "distinctClinicDays",
          coalesce(current_use.clinic_use_days, '[]'::jsonb)
            as "clinicUseDays",
          exists (
            select 1 from practice_conversion_milestones milestone
            where milestone.practice_id = cp.practice_id
              and milestone.milestone = 'payment_method_collected'
          )
            as "paymentMethodCollected",
          exists (
            select 1 from practice_conversion_milestones milestone
            where milestone.practice_id = cp.practice_id
              and milestone.milestone = 'first_positive_payment'
          )
            as "positivePaymentRecorded",
          (
            (practice.billing_status = 'trialing'
              and practice.trial_ends_at > now())
            or (
              practice.billing_status in ('active', 'past_due')
              and practice.subscription_tier in (
                'cloud', 'enterprise', 'starter', 'pro', 'professional'
              )
            )
          )
            as "hostedFullAccess",
          practice.country = 'US'
            and practice.settings -> 'onboardingState' ->> 'jurisdictionCountry' = 'US'
            and length(btrim(coalesce(
              practice.settings -> 'onboardingState' ->> 'jurisdictionSelectedAt',
              ''
            ))) > 0
            as "jurisdictionConfirmed"
        from clinic_pilots cp
        join practices practice
          on practice.id = cp.practice_id
         and practice.deleted_at is null
         and practice.settings ->> 'analyticsExcluded' is distinct from 'true'
        join clinic_pilot_events event
          on event.clinic_pilot_id = cp.id
         and event.practice_id = cp.practice_id
         and event.projection_version = cp.version
         and event.workflow = cp.workflow
         and event.stage = cp.stage
         and event.decision = cp.decision
         and event.qualification_checklist = cp.qualification_checklist
         and event.readiness_checklist = cp.readiness_checklist
         and event.blocker_codes = cp.blocker_codes
         and event.next_action = cp.next_action
         and event.support_cadence = cp.support_cadence
         and event.owner_identity = cp.owner_identity
         and event.communication_mode = cp.communication_mode
         and event.communication_tested_at is not distinct from cp.communication_tested_at
         and event.first_visit_validated_at is not distinct from cp.first_visit_validated_at
         and event.first_visit_validated_closeout_id is not distinct from cp.first_visit_validated_closeout_id
         and event.clinic_use_validated_at is not distinct from cp.clinic_use_validated_at
         and event.clinic_use_validated_hash is not distinct from cp.clinic_use_validated_hash
         and event.clinic_acceptance_at is not distinct from cp.clinic_acceptance_at
         and event.clinic_acceptance_by_user_id is not distinct from cp.clinic_acceptance_by_user_id
         and event.last_contact_at is not distinct from cp.last_contact_at
         and event.last_contact_outcome is not distinct from cp.last_contact_outcome
         and event.target_start_on is not distinct from cp.target_start_on
         and event.next_review_at is not distinct from cp.next_review_at
        left join current_use on current_use.clinic_pilot_id = cp.id
        where cp.clinic_use_validated_hash = '${clinicUseValidatedHash}'
          and cp.version = ${pilotProjectionVersion}
      `),
  );

  const row = rows.length === 1 ? rows[0] : undefined;
  const recomputedClinicUseHash = row
    ? createHash("sha256")
        .update(JSON.stringify(row.clinicUseDays.slice(0, 5)))
        .digest("hex")
    : null;
  const clinicUseValidated = Boolean(
    row?.clinicUseValidated &&
    recomputedClinicUseHash === clinicUseValidatedHash &&
    row.distinctClinicDays >= 5,
  );
  const clinicAdministratorActorHash = row?.clinicAdministratorUserId
    ? createHash("sha256")
        .update(`user:${row.clinicAdministratorUserId}`.toLowerCase())
        .digest("hex")
    : null;
  const projection = {
    matchedPilotCount: rows.length,
    immutableEventMatch: rows.length === 1,
    workflow: row?.workflow ?? null,
    stage: row?.stage ?? null,
    decision: row?.decision ?? null,
    blockerCount: row?.blockerCount ?? -1,
    qualificationComplete: row?.qualificationComplete ?? false,
    readinessComplete: row?.readinessComplete ?? false,
  };
  const outcomes = {
    verifiedAdministrator: row?.verifiedAdministrator ?? false,
    activeLocationCount: row?.activeLocationCount ?? 0,
    setupComplete: row?.setupComplete ?? false,
    communicationTested: row?.communicationTested ?? false,
    firstVisitValidated: row?.firstVisitValidated ?? false,
    distinctClinicDays: row?.distinctClinicDays ?? 0,
    clinicUseValidated,
    paymentMethodCollected: row?.paymentMethodCollected ?? false,
    positivePaymentRecorded: row?.positivePaymentRecorded ?? false,
    hostedFullAccess: row?.hostedFullAccess ?? false,
    jurisdictionConfirmed: row?.jurisdictionConfirmed ?? false,
    clinicAcceptanceRecorded: row?.clinicAcceptanceRecorded ?? false,
  };
  const releaseSafe =
    projection.matchedPilotCount === 1 &&
    projection.immutableEventMatch &&
    projection.stage === "completed" &&
    projection.decision === "graduated" &&
    projection.blockerCount === 0 &&
    projection.qualificationComplete &&
    projection.readinessComplete &&
    projection.workflow !== null &&
    ["general_practice", "house_call"].includes(projection.workflow) &&
    Object.entries(outcomes).every(([field, value]) =>
      field === "activeLocationCount"
        ? value === 1
        : field === "distinctClinicDays"
          ? Number(value) >= 5
          : value === true,
    );

  console.log(
    JSON.stringify(
      {
        evidenceFormatVersion: 1,
        mode: "read_only_aggregate",
        checkedAt: new Date().toISOString(),
        databaseTargetFingerprint:
          databaseConnectionIdentityFingerprint(databaseUrl),
        clinicUseValidatedHash,
        pilotProjectionVersion,
        clinicAdministratorActorHash,
        projection,
        outcomes,
        evidenceSafety: {
          phiFree: true,
          secretsFree: true,
          patientIdentifiersFree: true,
          contactDestinationsFree: true,
          localPathsFree: true,
        },
        releaseSafe,
      },
      null,
      2,
    ),
  );
  if (!releaseSafe) process.exitCode = 2;
} catch {
  console.error(
    "Clinic-pilot release read-only audit failed; details redacted.",
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
