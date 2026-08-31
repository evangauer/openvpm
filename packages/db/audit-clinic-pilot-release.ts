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
              nullif(event.evidence_snapshot ->> 'firstVisitCloseoutId', '')::uuid
            as "firstVisitValidated",
          cp.clinic_use_validated_at is not null
            and cp.clinic_use_validated_hash = '${clinicUseValidatedHash}'
            as "clinicUseValidated",
          cp.clinic_acceptance_at is not null
            and cp.clinic_acceptance_by_user_id is not null
            as "clinicAcceptanceRecorded",
          cp.clinic_acceptance_by_user_id::text as "clinicAdministratorUserId",
          cp.clinic_acceptance_by_user_id is not null
            and jsonb_typeof(event.evidence_snapshot -> 'verifiedAdminUserIds') = 'array'
            and event.evidence_snapshot -> 'verifiedAdminUserIds'
              @> jsonb_build_array(cp.clinic_acceptance_by_user_id::text)
            as "verifiedAdministrator",
          jsonb_array_length(event.evidence_snapshot -> 'activeLocationIds')::int
            as "activeLocationCount",
          nullif(event.evidence_snapshot ->> 'setupCompletedAt', '') is not null
            and nullif(event.evidence_snapshot ->> 'activatedAt', '') is not null
            as "setupComplete",
          jsonb_array_length(event.evidence_snapshot -> 'clinicUseDays')::int
            as "distinctClinicDays",
          event.evidence_snapshot -> 'clinicUseDays' as "clinicUseDays",
          nullif(event.evidence_snapshot ->> 'paymentMethodCollectedAt', '') is not null
            as "paymentMethodCollected",
          nullif(event.evidence_snapshot ->> 'firstPositivePaymentAt', '') is not null
            as "positivePaymentRecorded",
          (event.evidence_snapshot ->> 'hostedFullAccess')::boolean
            as "hostedFullAccess",
          (event.evidence_snapshot ->> 'jurisdictionConfirmed')::boolean
            and event.evidence_snapshot ->> 'country' = 'US'
            as "jurisdictionConfirmed"
        from clinic_pilots cp
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
