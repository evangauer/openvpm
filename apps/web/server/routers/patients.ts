import { z } from "zod";
import {
  eq,
  and,
  isNull,
  isNotNull,
  or,
  sql,
  desc,
  ne,
  inArray,
  asc,
} from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  patients,
  patientWeights,
  patientAllergies,
  clients,
  appointments,
  appointmentWaitlist,
  soapNotes,
  vaccinationRecords,
  labResults,
  procedures,
  clinicalNotes,
  problemList,
  vitalSigns,
  cases,
  treatmentPlans,
  prescriptions,
  prescriptionEvents,
  dispenseChargeQueue,
  consentRequests,
  captureSessions,
  files,
  invoices,
  controlledSubstanceLog,
  clinicalRecordCorrections,
  insurancePolicies,
  wellnessEnrollments,
  patientMergeEvents,
  auditLog,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { alias } from "drizzle-orm/pg-core";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import {
  CLINICAL_CORRECTION_REASON_MAX_LENGTH,
  CLINICAL_CORRECTION_REASON_MIN_LENGTH,
} from "@/lib/records/clinical-correction-policy";
import {
  clinicalDateInput,
  clinicalTextInput,
} from "@/lib/records/clinical-inputs";
import {
  PATIENT_WEIGHT_ERROR_MESSAGE,
  isPatientWeightInputValid,
} from "@/lib/records/patient-weight-policy";
import {
  PATIENT_BREED_MAX_LENGTH,
  PATIENT_COLOR_MAX_LENGTH,
  PATIENT_MICROCHIP_NUMBER_MAX_LENGTH,
  PATIENT_NAME_MAX_LENGTH,
  PATIENT_SEARCH_MAX_LENGTH,
} from "@/lib/patients/policy";
import { listOffsetInput } from "./pagination";
import {
  hasBoundedPatientSearchTokens,
  normalizePatientSearchPhrase,
  patientSearchContainsPattern,
  patientSearchTokens,
} from "@/lib/patients/search";

const patientSpeciesInput = z.enum([
  "canine",
  "feline",
  "avian",
  "rabbit",
  "reptile",
  "equine",
  "other",
]);
const patientSexInput = z.enum([
  "male",
  "female",
  "male_neutered",
  "female_spayed",
]);
const patientStatusInput = z.enum(["active", "inactive", "deceased"]);
const activeAppointmentStatuses = [
  "scheduled",
  "confirmed",
  "checked_in",
  "in_exam",
] as const;
const mergeMovableAppointmentStatuses = ["scheduled", "confirmed"] as const;
const PATIENT_MERGE_REASON_MIN_LENGTH = 5;
const PATIENT_MERGE_REASON_MAX_LENGTH = 500;
const patientManagerProcedure = protectedProcedure.use(
  requireRole("admin", "veterinarian", "technician", "front_desk"),
);
const patientDobInput = clinicalDateInput("Date of birth").optional();
const patientDobUpdateInput = clinicalDateInput("Date of birth")
  .nullable()
  .optional();
const patientSearchInput = z
  .string()
  .trim()
  .max(PATIENT_SEARCH_MAX_LENGTH)
  .optional()
  .refine(
    (value) => value === undefined || hasBoundedPatientSearchTokens(value),
    {
      message: "Search query has too many distinct words.",
    },
  );
const patientSearchQueryInput = clinicalTextInput(
  "Search query",
  PATIENT_SEARCH_MAX_LENGTH,
).refine(hasBoundedPatientSearchTokens, {
  message: "Search query has too many distinct words.",
});
const patientNameInput = clinicalTextInput(
  "Patient name",
  PATIENT_NAME_MAX_LENGTH,
);
const optionalPatientString = (label: string, maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength, `${label} must be at most ${maxLength} characters.`)
    .optional()
    .transform((value) => value || undefined);
const patientMutableInput = {
  name: patientNameInput,
  species: patientSpeciesInput,
  breed: optionalPatientString("Breed", PATIENT_BREED_MAX_LENGTH),
  sex: patientSexInput.optional(),
  dob: patientDobInput,
  color: optionalPatientString("Color", PATIENT_COLOR_MAX_LENGTH),
  microchipNumber: optionalPatientString(
    "Microchip number",
    PATIENT_MICROCHIP_NUMBER_MAX_LENGTH,
  ),
};
const patientWeightInput = z
  .string()
  .trim()
  .refine(isPatientWeightInputValid, PATIENT_WEIGHT_ERROR_MESSAGE);
const patientAllergyInput = z.object({
  patientId: z.string().uuid(),
  allergen: clinicalTextInput("Allergen", 255),
  reaction: optionalPatientString("Reaction", 2000),
  severity: z.enum(["mild", "moderate", "severe"]).default("moderate"),
});
const patientMergePairInput = z
  .object({
    keepId: z.string().uuid(),
    mergeId: z.string().uuid(),
  })
  .refine((input) => input.keepId !== input.mergeId, {
    message: "Cannot merge a patient into itself.",
    path: ["mergeId"],
  });
const patientMergeInput = patientMergePairInput.and(
  z.object({
    reason: z
      .string()
      .trim()
      .min(
        PATIENT_MERGE_REASON_MIN_LENGTH,
        `Merge reason must be at least ${PATIENT_MERGE_REASON_MIN_LENGTH} characters.`,
      )
      .max(
        PATIENT_MERGE_REASON_MAX_LENGTH,
        `Merge reason must be at most ${PATIENT_MERGE_REASON_MAX_LENGTH} characters.`,
      ),
    operationId: z.string().uuid(),
  }),
);
type PatientsContext = {
  db: Pick<Database, "select">;
  practiceId: string;
};

function literalPatientSearchMatch(column: SQLWrapper, token: string): SQL {
  const pattern = patientSearchContainsPattern(token);
  return sql`${column} ilike ${pattern} escape '\\'`;
}

function patientOwnerSearchConditions(value: string): SQL[] {
  return patientSearchTokens(value).map(
    (token) =>
      or(
        literalPatientSearchMatch(patients.name, token),
        literalPatientSearchMatch(patients.breed, token),
        literalPatientSearchMatch(clients.firstName, token),
        literalPatientSearchMatch(clients.lastName, token),
      )!,
  );
}

function patientSearchOrder(value: string): SQL[] {
  const phrase = normalizePatientSearchPhrase(value);
  return [
    sql`case
      when lower(${patients.name}) = ${phrase} then 0
      when lower(btrim(${clients.firstName} || ' ' || ${clients.lastName})) = ${phrase} then 1
      else 2
    end`,
    sql`lower(${patients.name}) asc`,
    sql`lower(${clients.lastName}) asc nulls last`,
    sql`lower(${clients.firstName}) asc nulls last`,
    asc(patients.id),
  ];
}

const patientIdentitySelection = {
  id: patients.id,
  practiceId: patients.practiceId,
  clientId: patients.clientId,
  name: patients.name,
  species: patients.species,
  breed: patients.breed,
  sex: patients.sex,
  dob: patients.dob,
  color: patients.color,
  microchipNumber: patients.microchipNumber,
  photoUrl: patients.photoUrl,
  status: patients.status,
  externalSource: patients.externalSource,
  externalId: patients.externalId,
  createdAt: patients.createdAt,
};

type MergePatientIdentity = Pick<
  typeof patients.$inferSelect,
  | "id"
  | "practiceId"
  | "clientId"
  | "name"
  | "species"
  | "breed"
  | "sex"
  | "dob"
  | "color"
  | "microchipNumber"
  | "photoUrl"
  | "status"
  | "externalSource"
  | "externalId"
  | "createdAt"
>;

function mergeIdentitySnapshot(patient: MergePatientIdentity) {
  return {
    id: patient.id,
    clientId: patient.clientId,
    name: patient.name,
    species: patient.species,
    breed: patient.breed,
    sex: patient.sex,
    dob: patient.dob,
    microchipNumber: patient.microchipNumber,
    externalSource: patient.externalSource,
    externalId: patient.externalId,
  };
}

type MergeBlockerCounts = {
  differentClient: number;
  sourceHasIncomingAliases: number;
  sourceWasPreviouslyMerged: number;
  targetWasPreviouslyMerged: number;
  appointmentHistory: number;
  appointmentCollisions: number;
  waitlistHistory: number;
  waitlistCollisions: number;
  weights: number;
  allergies: number;
  soapNotes: number;
  vaccinations: number;
  labResults: number;
  procedures: number;
  clinicalNotes: number;
  problemList: number;
  vitalSigns: number;
  cases: number;
  treatmentPlans: number;
  prescriptions: number;
  prescriptionEvents: number;
  controlledSubstanceEntries: number;
  clinicalCorrections: number;
  dispenseCharges: number;
  consentRequests: number;
  captureSessions: number;
  patientFiles: number;
  invoices: number;
  insurancePolicies: number;
  wellnessEnrollments: number;
};

type MergeMovableCounts = {
  futureAppointments: number;
  waitingListEntries: number;
};

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function retainedPatientHistoryPredicate(
  practiceId: string,
  patientId: string,
) {
  return sql<boolean>`
    exists (
      select 1
      from ${prescriptionEvents}
      where ${prescriptionEvents.practiceId} = ${practiceId}
        and ${prescriptionEvents.patientId} = ${patientId}
    )
    or exists (
      select 1
      from ${clinicalRecordCorrections}
      where ${clinicalRecordCorrections.practiceId} = ${practiceId}
        and ${clinicalRecordCorrections.patientId} = ${patientId}
    )
    or exists (
      select 1
      from ${soapNotes}
      where ${soapNotes.practiceId} = ${practiceId}
        and ${soapNotes.patientId} = ${patientId}
        and ${soapNotes.appointmentId} is not null
    )
    or exists (
      select 1
      from ${vitalSigns}
      where ${vitalSigns.practiceId} = ${practiceId}
        and ${vitalSigns.patientId} = ${patientId}
        and ${vitalSigns.appointmentId} is not null
    )
  `;
}

function immutableMergeHistoryPredicate(
  practiceId: string,
  patientId: string | SQLWrapper,
) {
  return sql<boolean>`
    exists (select 1 from ${patientWeights} where ${patientWeights.patientId} = ${patientId})
    or exists (select 1 from ${patientAllergies} where ${patientAllergies.patientId} = ${patientId})
    or exists (select 1 from ${soapNotes} where ${soapNotes.practiceId} = ${practiceId} and ${soapNotes.patientId} = ${patientId})
    or exists (select 1 from ${vaccinationRecords} where ${vaccinationRecords.practiceId} = ${practiceId} and ${vaccinationRecords.patientId} = ${patientId})
    or exists (select 1 from ${labResults} where ${labResults.practiceId} = ${practiceId} and ${labResults.patientId} = ${patientId})
    or exists (select 1 from ${procedures} where ${procedures.practiceId} = ${practiceId} and ${procedures.patientId} = ${patientId})
    or exists (select 1 from ${clinicalNotes} where ${clinicalNotes.practiceId} = ${practiceId} and ${clinicalNotes.patientId} = ${patientId})
    or exists (select 1 from ${problemList} where ${problemList.practiceId} = ${practiceId} and ${problemList.patientId} = ${patientId})
    or exists (select 1 from ${vitalSigns} where ${vitalSigns.practiceId} = ${practiceId} and ${vitalSigns.patientId} = ${patientId})
    or exists (select 1 from ${cases} where ${cases.practiceId} = ${practiceId} and ${cases.patientId} = ${patientId})
    or exists (select 1 from ${treatmentPlans} where ${treatmentPlans.practiceId} = ${practiceId} and ${treatmentPlans.patientId} = ${patientId})
    or exists (select 1 from ${prescriptions} where ${prescriptions.practiceId} = ${practiceId} and ${prescriptions.patientId} = ${patientId})
    or exists (select 1 from ${prescriptionEvents} where ${prescriptionEvents.practiceId} = ${practiceId} and ${prescriptionEvents.patientId} = ${patientId})
    or exists (select 1 from ${controlledSubstanceLog} where ${controlledSubstanceLog.practiceId} = ${practiceId} and ${controlledSubstanceLog.patientId} = ${patientId})
    or exists (select 1 from ${clinicalRecordCorrections} where ${clinicalRecordCorrections.practiceId} = ${practiceId} and ${clinicalRecordCorrections.patientId} = ${patientId})
    or exists (select 1 from ${dispenseChargeQueue} where ${dispenseChargeQueue.practiceId} = ${practiceId} and ${dispenseChargeQueue.patientId} = ${patientId})
    or exists (select 1 from ${consentRequests} where ${consentRequests.practiceId} = ${practiceId} and ${consentRequests.patientId} = ${patientId})
    or exists (select 1 from ${captureSessions} where ${captureSessions.practiceId} = ${practiceId} and ${captureSessions.patientId} = ${patientId})
    or exists (select 1 from ${files} where ${files.practiceId} = ${practiceId} and ${files.entityType} = 'patient' and ${files.entityId} = ${patientId})
    or exists (select 1 from ${invoices} where ${invoices.practiceId} = ${practiceId} and ${invoices.patientId} = ${patientId})
    or exists (select 1 from ${insurancePolicies} where ${insurancePolicies.practiceId} = ${practiceId} and ${insurancePolicies.patientId} = ${patientId})
    or exists (select 1 from ${wellnessEnrollments} where ${wellnessEnrollments.practiceId} = ${practiceId} and ${wellnessEnrollments.patientId} = ${patientId})
  `;
}

function countValue(value: unknown): number {
  return Number(value ?? 0);
}

function mergeReasons(counts: MergeBlockerCounts): string[] {
  const reasons: string[] = [];
  if (counts.differentClient) {
    reasons.push("Patients must belong to the same client.");
  }
  if (counts.sourceHasIncomingAliases) {
    reasons.push(
      "The source patient is already a canonical target for another patient and cannot become an alias.",
    );
  }
  if (counts.sourceWasPreviouslyMerged) {
    reasons.push("The source patient was already merged.");
  }
  if (counts.targetWasPreviouslyMerged) {
    reasons.push(
      "The target patient is itself an alias; choose its canonical target.",
    );
  }
  if (counts.appointmentHistory) {
    reasons.push(
      `${counts.appointmentHistory} appointment record(s) are not safely movable future visits.`,
    );
  }
  if (counts.appointmentCollisions) {
    reasons.push(
      `${counts.appointmentCollisions} future appointment(s) collide with an appointment already on the target chart.`,
    );
  }
  if (counts.waitlistHistory) {
    reasons.push(
      `${counts.waitlistHistory} resolved or deleted waitlist record(s) must retain the source identity.`,
    );
  }
  if (counts.waitlistCollisions) {
    reasons.push(
      `${counts.waitlistCollisions} waiting-list entry or entries duplicate the target chart.`,
    );
  }

  const immutableTotal =
    counts.weights +
    counts.allergies +
    counts.soapNotes +
    counts.vaccinations +
    counts.labResults +
    counts.procedures +
    counts.clinicalNotes +
    counts.problemList +
    counts.vitalSigns +
    counts.cases +
    counts.treatmentPlans +
    counts.prescriptions +
    counts.prescriptionEvents +
    counts.controlledSubstanceEntries +
    counts.clinicalCorrections +
    counts.dispenseCharges +
    counts.consentRequests +
    counts.captureSessions +
    counts.patientFiles +
    counts.invoices +
    counts.insurancePolicies +
    counts.wellnessEnrollments;
  if (immutableTotal) {
    reasons.push(
      `${immutableTotal} immutable clinical, medication, controlled-substance, correction, consent, capture, file, dispense, coverage, wellness, or financial record(s) retain the source patient identity.`,
    );
  }
  return reasons;
}

async function analyzePatientMerge(
  db: Database,
  practiceId: string,
  keepId: string,
  mergeId: string,
  now: Date,
) {
  if (keepId === mergeId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot merge a patient into itself.",
    });
  }

  await assertActivePractice({ db, practiceId });
  const lockedPatients = (await db
    .select(patientIdentitySelection)
    .from(patients)
    .where(
      and(
        inArray(patients.id, [keepId, mergeId].sort()),
        eq(patients.practiceId, practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .orderBy(asc(patients.id))
    .for("update")) as MergePatientIdentity[];
  const keepPatient = lockedPatients.find((patient) => patient.id === keepId);
  const mergePatient = lockedPatients.find((patient) => patient.id === mergeId);
  if (!keepPatient) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "The patient to keep was not found.",
    });
  }
  if (!mergePatient) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "The patient to merge was not found.",
    });
  }

  const [row] = await db
    .select({
      sourceHasIncomingAliases: sql<number>`(
        select count(*)::int from ${patientMergeEvents}
        where ${patientMergeEvents.practiceId} = ${practiceId}
          and ${patientMergeEvents.targetPatientId} = ${mergeId}
      )`,
      sourceWasPreviouslyMerged: sql<number>`(
        select count(*)::int from ${patientMergeEvents}
        where ${patientMergeEvents.practiceId} = ${practiceId}
          and ${patientMergeEvents.sourcePatientId} = ${mergeId}
      )`,
      targetWasPreviouslyMerged: sql<number>`(
        select count(*)::int from ${patientMergeEvents}
        where ${patientMergeEvents.practiceId} = ${practiceId}
          and ${patientMergeEvents.sourcePatientId} = ${keepId}
      )`,
      futureAppointments: sql<number>`(
        select count(*)::int from ${appointments}
        where ${appointments.practiceId} = ${practiceId}
          and ${appointments.patientId} = ${mergeId}
          and ${appointments.clientId} = ${mergePatient.clientId}
          and ${appointments.deletedAt} is null
          and ${appointments.status} in ('scheduled', 'confirmed')
          and ${appointments.startTime} > ${now.toISOString()}
      )`,
      appointmentHistory: sql<number>`(
        select count(*)::int from ${appointments}
        where ${appointments.practiceId} = ${practiceId}
          and ${appointments.patientId} = ${mergeId}
          and (
            ${appointments.clientId} = ${mergePatient.clientId}
            and ${appointments.deletedAt} is null
            and ${appointments.status} in ('scheduled', 'confirmed')
            and ${appointments.startTime} > ${now.toISOString()}
          ) is not true
      )`,
      appointmentCollisions: sql<number>`(
        select count(*)::int from appointments as merge_source_appointments
        where merge_source_appointments.practice_id = ${practiceId}
          and merge_source_appointments.patient_id = ${mergeId}
          and merge_source_appointments.client_id = ${mergePatient.clientId}
          and merge_source_appointments.deleted_at is null
          and merge_source_appointments.status in ('scheduled', 'confirmed')
          and merge_source_appointments.start_time > ${now.toISOString()}
          and exists (
            select 1 from appointments as merge_target_appointments
            where merge_target_appointments.practice_id = ${practiceId}
              and merge_target_appointments.patient_id = ${keepId}
              and merge_target_appointments.client_id = ${keepPatient.clientId}
              and merge_target_appointments.deleted_at is null
              and merge_target_appointments.status in ('scheduled', 'confirmed')
              and merge_target_appointments.start_time = merge_source_appointments.start_time
              and merge_target_appointments.end_time = merge_source_appointments.end_time
          )
      )`,
      waitingListEntries: sql<number>`(
        select count(*)::int from ${appointmentWaitlist}
        where ${appointmentWaitlist.practiceId} = ${practiceId}
          and ${appointmentWaitlist.patientId} = ${mergeId}
          and ${appointmentWaitlist.clientId} = ${mergePatient.clientId}
          and ${appointmentWaitlist.deletedAt} is null
          and ${appointmentWaitlist.status} = 'waiting'
      )`,
      waitlistHistory: sql<number>`(
        select count(*)::int from ${appointmentWaitlist}
        where ${appointmentWaitlist.practiceId} = ${practiceId}
          and ${appointmentWaitlist.patientId} = ${mergeId}
          and not (
            ${appointmentWaitlist.clientId} = ${mergePatient.clientId}
            and ${appointmentWaitlist.deletedAt} is null
            and ${appointmentWaitlist.status} = 'waiting'
          )
      )`,
      waitlistCollisions: sql<number>`(
        select count(*)::int from appointment_waitlist as merge_source_waitlist
        where merge_source_waitlist.practice_id = ${practiceId}
          and merge_source_waitlist.patient_id = ${mergeId}
          and merge_source_waitlist.client_id = ${mergePatient.clientId}
          and merge_source_waitlist.deleted_at is null
          and merge_source_waitlist.status = 'waiting'
          and exists (
            select 1 from appointment_waitlist as merge_target_waitlist
            where merge_target_waitlist.practice_id = ${practiceId}
              and merge_target_waitlist.patient_id = ${keepId}
              and merge_target_waitlist.client_id = ${keepPatient.clientId}
              and merge_target_waitlist.deleted_at is null
              and merge_target_waitlist.status = 'waiting'
              and merge_target_waitlist.type_id is not distinct from merge_source_waitlist.type_id
              and merge_target_waitlist.preferred_from is not distinct from merge_source_waitlist.preferred_from
              and merge_target_waitlist.preferred_to is not distinct from merge_source_waitlist.preferred_to
          )
      )`,
      weights: sql<number>`(select count(*)::int from ${patientWeights} where ${patientWeights.patientId} = ${mergeId})`,
      allergies: sql<number>`(select count(*)::int from ${patientAllergies} where ${patientAllergies.patientId} = ${mergeId})`,
      soapNotes: sql<number>`(select count(*)::int from ${soapNotes} where ${soapNotes.practiceId} = ${practiceId} and ${soapNotes.patientId} = ${mergeId})`,
      vaccinations: sql<number>`(select count(*)::int from ${vaccinationRecords} where ${vaccinationRecords.practiceId} = ${practiceId} and ${vaccinationRecords.patientId} = ${mergeId})`,
      labResults: sql<number>`(select count(*)::int from ${labResults} where ${labResults.practiceId} = ${practiceId} and ${labResults.patientId} = ${mergeId})`,
      procedures: sql<number>`(select count(*)::int from ${procedures} where ${procedures.practiceId} = ${practiceId} and ${procedures.patientId} = ${mergeId})`,
      clinicalNotes: sql<number>`(select count(*)::int from ${clinicalNotes} where ${clinicalNotes.practiceId} = ${practiceId} and ${clinicalNotes.patientId} = ${mergeId})`,
      problemList: sql<number>`(select count(*)::int from ${problemList} where ${problemList.practiceId} = ${practiceId} and ${problemList.patientId} = ${mergeId})`,
      vitalSigns: sql<number>`(select count(*)::int from ${vitalSigns} where ${vitalSigns.practiceId} = ${practiceId} and ${vitalSigns.patientId} = ${mergeId})`,
      cases: sql<number>`(select count(*)::int from ${cases} where ${cases.practiceId} = ${practiceId} and ${cases.patientId} = ${mergeId})`,
      treatmentPlans: sql<number>`(select count(*)::int from ${treatmentPlans} where ${treatmentPlans.practiceId} = ${practiceId} and ${treatmentPlans.patientId} = ${mergeId})`,
      prescriptions: sql<number>`(select count(*)::int from ${prescriptions} where ${prescriptions.practiceId} = ${practiceId} and ${prescriptions.patientId} = ${mergeId})`,
      prescriptionEvents: sql<number>`(select count(*)::int from ${prescriptionEvents} where ${prescriptionEvents.practiceId} = ${practiceId} and ${prescriptionEvents.patientId} = ${mergeId})`,
      controlledSubstanceEntries: sql<number>`(select count(*)::int from ${controlledSubstanceLog} where ${controlledSubstanceLog.practiceId} = ${practiceId} and ${controlledSubstanceLog.patientId} = ${mergeId})`,
      clinicalCorrections: sql<number>`(select count(*)::int from ${clinicalRecordCorrections} where ${clinicalRecordCorrections.practiceId} = ${practiceId} and ${clinicalRecordCorrections.patientId} = ${mergeId})`,
      dispenseCharges: sql<number>`(select count(*)::int from ${dispenseChargeQueue} where ${dispenseChargeQueue.practiceId} = ${practiceId} and ${dispenseChargeQueue.patientId} = ${mergeId})`,
      consentRequests: sql<number>`(select count(*)::int from ${consentRequests} where ${consentRequests.practiceId} = ${practiceId} and ${consentRequests.patientId} = ${mergeId})`,
      captureSessions: sql<number>`(select count(*)::int from ${captureSessions} where ${captureSessions.practiceId} = ${practiceId} and ${captureSessions.patientId} = ${mergeId})`,
      patientFiles: sql<number>`(select count(*)::int from ${files} where ${files.practiceId} = ${practiceId} and ${files.entityType} = 'patient' and ${files.entityId} = ${mergeId})`,
      invoices: sql<number>`(select count(*)::int from ${invoices} where ${invoices.practiceId} = ${practiceId} and ${invoices.patientId} = ${mergeId})`,
      insurancePolicies: sql<number>`(select count(*)::int from ${insurancePolicies} where ${insurancePolicies.practiceId} = ${practiceId} and ${insurancePolicies.patientId} = ${mergeId})`,
      wellnessEnrollments: sql<number>`(select count(*)::int from ${wellnessEnrollments} where ${wellnessEnrollments.practiceId} = ${practiceId} and ${wellnessEnrollments.patientId} = ${mergeId})`,
    })
    .from(patients)
    .where(and(eq(patients.id, mergeId), eq(patients.practiceId, practiceId)))
    .limit(1);

  if (!row) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Unable to establish patient merge safety.",
    });
  }
  const blockerCounts: MergeBlockerCounts = {
    differentClient: keepPatient.clientId === mergePatient.clientId ? 0 : 1,
    sourceHasIncomingAliases: countValue(row.sourceHasIncomingAliases),
    sourceWasPreviouslyMerged: countValue(row.sourceWasPreviouslyMerged),
    targetWasPreviouslyMerged: countValue(row.targetWasPreviouslyMerged),
    appointmentHistory: countValue(row.appointmentHistory),
    appointmentCollisions: countValue(row.appointmentCollisions),
    waitlistHistory: countValue(row.waitlistHistory),
    waitlistCollisions: countValue(row.waitlistCollisions),
    weights: countValue(row.weights),
    allergies: countValue(row.allergies),
    soapNotes: countValue(row.soapNotes),
    vaccinations: countValue(row.vaccinations),
    labResults: countValue(row.labResults),
    procedures: countValue(row.procedures),
    clinicalNotes: countValue(row.clinicalNotes),
    problemList: countValue(row.problemList),
    vitalSigns: countValue(row.vitalSigns),
    cases: countValue(row.cases),
    treatmentPlans: countValue(row.treatmentPlans),
    prescriptions: countValue(row.prescriptions),
    prescriptionEvents: countValue(row.prescriptionEvents),
    controlledSubstanceEntries: countValue(row.controlledSubstanceEntries),
    clinicalCorrections: countValue(row.clinicalCorrections),
    dispenseCharges: countValue(row.dispenseCharges),
    consentRequests: countValue(row.consentRequests),
    captureSessions: countValue(row.captureSessions),
    patientFiles: countValue(row.patientFiles),
    invoices: countValue(row.invoices),
    insurancePolicies: countValue(row.insurancePolicies),
    wellnessEnrollments: countValue(row.wellnessEnrollments),
  };
  const movableCounts: MergeMovableCounts = {
    futureAppointments: countValue(row.futureAppointments),
    waitingListEntries: countValue(row.waitingListEntries),
  };
  const blockingTotal = Object.values(blockerCounts).reduce(
    (total, count) => total + count,
    0,
  );
  return {
    allowed: blockingTotal === 0,
    keepPatient,
    mergePatient,
    blockerCounts,
    movableCounts,
    blockingTotal,
    reasons: mergeReasons(blockerCounts),
  };
}

async function assertActivePractice(ctx: PatientsContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);

  if (!practice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  }
}

async function assertClientBelongsToPractice(
  db: Database,
  practiceId: string,
  clientId: string,
) {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .limit(1);

  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
  }
}

async function assertPatientBelongsToPractice(
  db: Database,
  practiceId: string,
  patientId: string,
) {
  const [patient] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .limit(1);

  if (!patient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
  }
}

const patientDetailSelection = {
  ...patientIdentitySelection,
  clientFirstName: clients.firstName,
  clientLastName: clients.lastName,
  clientEmail: clients.email,
  clientPhone: clients.phone,
};

async function selectActivePatientDetail(
  db: Database,
  practiceId: string,
  patientId: string,
) {
  const [patient] = await db
    .select(patientDetailSelection)
    .from(patients)
    .leftJoin(
      clients,
      and(
        eq(patients.clientId, clients.id),
        eq(clients.practiceId, practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .limit(1);
  return patient ?? null;
}

async function resolveCanonicalPatientDetail(
  db: Database,
  practiceId: string,
  requestedId: string,
) {
  const direct = await selectActivePatientDetail(db, practiceId, requestedId);
  if (direct) {
    return {
      patient: direct,
      mergeMetadata: null,
    };
  }

  const [mergeEvent] = await db
    .select({
      id: patientMergeEvents.id,
      sourcePatientId: patientMergeEvents.sourcePatientId,
      targetPatientId: patientMergeEvents.targetPatientId,
      sourceSnapshot: patientMergeEvents.sourceSnapshot,
      performedByName: patientMergeEvents.performedByName,
      reason: patientMergeEvents.reason,
      createdAt: patientMergeEvents.createdAt,
    })
    .from(patientMergeEvents)
    .where(
      and(
        eq(patientMergeEvents.practiceId, practiceId),
        eq(patientMergeEvents.sourcePatientId, requestedId),
      ),
    )
    .orderBy(desc(patientMergeEvents.createdAt))
    .limit(1);
  if (!mergeEvent) return null;

  const canonical = await selectActivePatientDetail(
    db,
    practiceId,
    mergeEvent.targetPatientId,
  );
  if (!canonical) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The canonical patient record is unavailable.",
    });
  }
  return {
    patient: canonical,
    mergeMetadata: {
      requestedId,
      canonicalId: canonical.id,
      sourcePatientId: mergeEvent.sourcePatientId,
      targetPatientId: mergeEvent.targetPatientId,
      eventId: mergeEvent.id,
      sourceSnapshot: mergeEvent.sourceSnapshot,
      performedByName: mergeEvent.performedByName,
      reason: mergeEvent.reason,
      createdAt: mergeEvent.createdAt,
    },
  };
}

export const patientsRouter = createRouter({
  list: protectedProcedure
    .input(
      z.object({
        search: patientSearchInput,
        species: patientSpeciesInput.optional(),
        status: patientStatusInput.optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: listOffsetInput,
      }),
    )
    .query(async ({ ctx, input }) => {
      const conditions: SQL[] = [
        eq(patients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(patients.deletedAt),
      ];

      if (input.search) {
        conditions.push(...patientOwnerSearchConditions(input.search));
      }
      if (input.species) {
        conditions.push(eq(patients.species, input.species));
      }
      if (input.status) {
        conditions.push(eq(patients.status, input.status));
      }

      const countQuery = input.search
        ? ctx.db
            .select({ count: sql<number>`count(*)` })
            .from(patients)
            .leftJoin(
              clients,
              and(
                eq(patients.clientId, clients.id),
                eq(clients.practiceId, ctx.practiceId),
                isNull(clients.deletedAt),
              ),
            )
            .where(and(...conditions))
        : ctx.db
            .select({ count: sql<number>`count(*)` })
            .from(patients)
            .where(and(...conditions));

      const [items, countResult] = await Promise.all([
        ctx.db
          .select({
            id: patients.id,
            name: patients.name,
            species: patients.species,
            breed: patients.breed,
            sex: patients.sex,
            dob: patients.dob,
            status: patients.status,
            photoUrl: patients.photoUrl,
            clientId: patients.clientId,
            clientFirstName: clients.firstName,
            clientLastName: clients.lastName,
            createdAt: patients.createdAt,
          })
          .from(patients)
          .leftJoin(
            clients,
            and(
              eq(patients.clientId, clients.id),
              eq(clients.practiceId, ctx.practiceId),
              isNull(clients.deletedAt),
            ),
          )
          .where(and(...conditions))
          .orderBy(
            ...(input.search
              ? patientSearchOrder(input.search)
              : [desc(patients.createdAt), asc(patients.id)]),
          )
          .limit(input.limit)
          .offset(input.offset),
        countQuery,
      ]);

      return {
        items,
        total: Number(countResult[0]?.count ?? 0),
      };
    }),

  search: protectedProcedure
    .input(
      z.object({
        query: patientSearchQueryInput,
        status: patientStatusInput.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conditions: SQL[] = [
        eq(patients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(patients.deletedAt),
        ...patientOwnerSearchConditions(input.query),
      ];
      if (input.status) {
        conditions.push(eq(patients.status, input.status));
      }
      return ctx.db
        .select({
          id: patients.id,
          name: patients.name,
          species: patients.species,
          breed: patients.breed,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
        })
        .from(patients)
        .leftJoin(
          clients,
          and(
            eq(patients.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .where(and(...conditions))
        .orderBy(...patientSearchOrder(input.query))
        .limit(10);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const resolved = await resolveCanonicalPatientDetail(
        ctx.db as Database,
        ctx.practiceId,
        input.id,
      );
      if (!resolved) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found",
        });
      }
      const { patient, mergeMetadata } = resolved;

      const [weights, allergyHistory] = await Promise.all([
        ctx.db
          .select()
          .from(patientWeights)
          .where(
            and(
              eq(patientWeights.patientId, patient.id),
              sql`exists (
                select 1
                from ${patients}
                where ${patients.id} = ${patientWeights.patientId}
                  and ${patients.practiceId} = ${ctx.practiceId}
                  and ${patients.deletedAt} is null
              )`,
              activePracticePredicate(ctx.practiceId),
              isNull(patientWeights.deletedAt),
            ),
          )
          .orderBy(desc(patientWeights.recordedAt)),
        ctx.db
          .select({
            id: patientAllergies.id,
            createdAt: patientAllergies.createdAt,
            updatedAt: patientAllergies.updatedAt,
            deletedAt: patientAllergies.deletedAt,
            patientId: patientAllergies.patientId,
            allergen: patientAllergies.allergen,
            reaction: patientAllergies.reaction,
            severity: patientAllergies.severity,
            notedBy: patientAllergies.notedBy,
            notedAt: patientAllergies.notedAt,
            correctionId: clinicalRecordCorrections.id,
            correctionReason: clinicalRecordCorrections.reason,
            correctedAt: clinicalRecordCorrections.createdAt,
            correctedBy: clinicalRecordCorrections.correctedBy,
            correctedByName: clinicalRecordCorrections.correctedByName,
          })
          .from(patientAllergies)
          .leftJoin(
            clinicalRecordCorrections,
            and(
              eq(
                clinicalRecordCorrections.patientAllergyId,
                patientAllergies.id,
              ),
              eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
            ),
          )
          .where(
            and(
              eq(patientAllergies.patientId, patient.id),
              sql`exists (
                select 1
                from ${patients}
                where ${patients.id} = ${patientAllergies.patientId}
                  and ${patients.practiceId} = ${ctx.practiceId}
                  and ${patients.deletedAt} is null
              )`,
              activePracticePredicate(ctx.practiceId),
            ),
          )
          .orderBy(desc(patientAllergies.notedAt), desc(patientAllergies.id)),
      ]);

      const allergies = allergyHistory.filter(
        (allergy) => !allergy.deletedAt && !allergy.correctionId,
      );

      return {
        ...patient,
        weights,
        allergies,
        allergyHistory,
        requestedPatientId: input.id,
        canonicalPatientId: patient.id,
        mergeMetadata,
      };
    }),

  create: patientManagerProcedure
    .input(
      z.object({
        clientId: z.string().uuid(),
        ...patientMutableInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      await assertClientBelongsToPractice(
        ctx.db,
        ctx.practiceId,
        input.clientId,
      );
      const [patient] = await ctx.db
        .insert(patients)
        .values({ ...input, practiceId: ctx.practiceId })
        .returning();
      await dispatchWebhookEvent(ctx.practiceId, "patient.created", {
        id: patient!.id,
        clientId: patient!.clientId,
        name: patient!.name,
        species: patient!.species,
        breed: patient!.breed,
        sex: patient!.sex,
        status: patient!.status,
        source: "dashboard",
      });
      return patient!;
    }),

  update: patientManagerProcedure
    .input(
      z
        .object({
          id: z.string().uuid(),
          name: patientMutableInput.name.optional(),
          species: patientMutableInput.species.optional(),
          breed: patientMutableInput.breed,
          sex: patientMutableInput.sex,
          dob: patientDobUpdateInput,
          color: patientMutableInput.color,
          microchipNumber: patientMutableInput.microchipNumber,
          status: patientStatusInput.optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [patient] = await ctx.db
        .update(patients)
        .set(data)
        .where(
          and(
            eq(patients.id, id),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .returning();
      if (!patient) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found",
        });
      }
      return patient;
    }),

  delete: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [existingPatient] = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(
            and(
              eq(patients.id, input.id),
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .limit(1);

        if (!existingPatient) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Patient not found",
          });
        }

        const [activeAppointment] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.patientId, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt),
              inArray(appointments.status, activeAppointmentStatuses),
            ),
          )
          .limit(1);

        if (activeAppointment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete a patient with active appointments. Cancel or complete the appointments first.",
          });
        }

        const [waitingEntry] = await tx
          .select({ id: appointmentWaitlist.id })
          .from(appointmentWaitlist)
          .where(
            and(
              eq(appointmentWaitlist.patientId, input.id),
              eq(appointmentWaitlist.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              eq(appointmentWaitlist.status, "waiting"),
              isNull(appointmentWaitlist.deletedAt),
            ),
          )
          .limit(1);

        if (waitingEntry) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete a patient with a waiting appointment request. Resolve the waitlist entry first.",
          });
        }

        const [retainedHistory] = await tx
          .select({
            exists: retainedPatientHistoryPredicate(ctx.practiceId, input.id),
          })
          .from(patients)
          .where(
            and(
              eq(patients.id, input.id),
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
            ),
          )
          .limit(1);

        if (retainedHistory?.exists) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This patient has retained clinical or prescription history and cannot be deleted. Mark the patient inactive or deceased instead.",
          });
        }

        const [patient] = await tx
          .update(patients)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(patients.id, input.id),
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .returning({ id: patients.id });
        if (!patient) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Patient not found",
          });
        }
      });
      return { success: true };
    }),

  addWeight: patientManagerProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        weightKg: patientWeightInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(
        ctx.db,
        ctx.practiceId,
        input.patientId,
      );
      const [weight] = await ctx.db
        .insert(patientWeights)
        .values({
          patientId: input.patientId,
          weightKg: input.weightKg,
          recordedBy: ctx.user.id,
        })
        .returning();
      return weight!;
    }),

  addAllergy: patientManagerProcedure
    .input(patientAllergyInput)
    .mutation(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(
        ctx.db,
        ctx.practiceId,
        input.patientId,
      );
      const [allergy] = await ctx.db
        .insert(patientAllergies)
        .values({
          ...input,
          notedBy: ctx.user.id,
        })
        .returning();
      return allergy!;
    }),

  markAllergyEnteredInError: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        recordId: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(CLINICAL_CORRECTION_REASON_MIN_LENGTH)
          .max(CLINICAL_CORRECTION_REASON_MAX_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const sourcePredicate = and(
          eq(patientAllergies.id, input.recordId),
          eq(patientAllergies.patientId, input.patientId),
          isNull(patientAllergies.deletedAt),
          sql`exists (
            select 1
            from ${patients}
            where ${patients.id} = ${patientAllergies.patientId}
              and ${patients.practiceId} = ${ctx.practiceId}
              and ${patients.deletedAt} is null
          )`,
          activePracticePredicate(ctx.practiceId),
        );
        const [source] = await tx
          .select({
            id: patientAllergies.id,
            patientId: patientAllergies.patientId,
          })
          .from(patientAllergies)
          .where(sourcePredicate)
          .limit(1);
        if (!source) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Clinical record not found",
          });
        }

        const [created] = await tx
          .insert(clinicalRecordCorrections)
          .values({
            practiceId: ctx.practiceId,
            recordType: "patient_allergy",
            action: "entered_in_error",
            patientAllergyId: source.id,
            patientId: source.patientId,
            reason: input.reason,
            correctedBy: ctx.user.id,
            correctedByName: ctx.user.name,
          })
          .onConflictDoNothing()
          .returning();
        if (created) return created;

        const [existing] = await tx
          .select()
          .from(clinicalRecordCorrections)
          .where(
            and(
              eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
              eq(clinicalRecordCorrections.patientAllergyId, source.id),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.reason !== input.reason) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This allergy already has a different permanent correction reason. Refresh the chart.",
            });
          }
          return existing;
        }

        throw new TRPCError({
          code: "CONFLICT",
          message: "Clinical correction changed; refresh and retry.",
        });
      }),
    ),

  previewMerge: protectedProcedure
    .use(requireRole("admin"))
    .input(patientMergePairInput)
    .query(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) =>
        analyzePatientMerge(
          tx as unknown as Database,
          ctx.practiceId,
          input.keepId,
          input.mergeId,
          new Date(),
        ),
      );
    }),

  merge: protectedProcedure
    .use(requireRole("admin"))
    .input(patientMergeInput)
    .mutation(async ({ ctx, input }) => {
      // protectedProcedure selects SERIALIZABLE on the outer tenant
      // transaction before setting the RLS tenant context. The nested
      // transaction here is intentionally only a savepoint: it ensures every
      // merge write rolls back when tRPC converts a resolver exception into
      // an error result, and it must not change transaction isolation.
      return ctx.db.transaction(async (tx) => {
        const mergeDb = tx as unknown as Database;
        await assertActivePractice({ db: mergeDb, practiceId: ctx.practiceId });

        const [existingEvent] = await mergeDb
          .select({
            id: patientMergeEvents.id,
            sourcePatientId: patientMergeEvents.sourcePatientId,
            targetPatientId: patientMergeEvents.targetPatientId,
            clientId: patientMergeEvents.clientId,
            reason: patientMergeEvents.reason,
            createdAt: patientMergeEvents.createdAt,
          })
          .from(patientMergeEvents)
          .where(
            and(
              eq(patientMergeEvents.practiceId, ctx.practiceId),
              eq(patientMergeEvents.operationId, input.operationId),
            ),
          )
          .limit(1);
        if (existingEvent) {
          if (
            existingEvent.sourcePatientId !== input.mergeId ||
            existingEvent.targetPatientId !== input.keepId ||
            existingEvent.reason !== input.reason
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This patient merge operation ID was already used for different details.",
            });
          }
          const canonical = await selectActivePatientDetail(
            mergeDb,
            ctx.practiceId,
            existingEvent.targetPatientId,
          );
          if (!canonical) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "The canonical patient record is unavailable.",
            });
          }
          return {
            ...canonical,
            mergeMetadata: {
              eventId: existingEvent.id,
              sourcePatientId: existingEvent.sourcePatientId,
              canonicalId: existingEvent.targetPatientId,
              clientId: existingEvent.clientId,
              mergedAt: existingEvent.createdAt,
              replayed: true,
            },
          };
        }

        const mergeNow = new Date();
        const analysis = await analyzePatientMerge(
          mergeDb,
          ctx.practiceId,
          input.keepId,
          input.mergeId,
          mergeNow,
        );
        if (!analysis.allowed) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Patient merge blocked: ${analysis.reasons.join(" ")}`,
          });
        }

        const movedAppointments = await tx
          .update(appointments)
          .set({ patientId: input.keepId, updatedAt: mergeNow })
          .where(
            and(
              eq(appointments.patientId, input.mergeId),
              eq(appointments.clientId, analysis.keepPatient.clientId),
              eq(appointments.practiceId, ctx.practiceId),
              isNull(appointments.deletedAt),
              inArray(appointments.status, mergeMovableAppointmentStatuses),
              sql`${appointments.startTime} > ${mergeNow.toISOString()}`,
            ),
          )
          .returning({ id: appointments.id });
        if (
          movedAppointments.length !== analysis.movableCounts.futureAppointments
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The source patient's future appointments changed during merge. Preview and retry.",
          });
        }

        const movedWaitlistEntries = await tx
          .update(appointmentWaitlist)
          .set({ patientId: input.keepId, updatedAt: mergeNow })
          .where(
            and(
              eq(appointmentWaitlist.patientId, input.mergeId),
              eq(appointmentWaitlist.clientId, analysis.keepPatient.clientId),
              eq(appointmentWaitlist.practiceId, ctx.practiceId),
              eq(appointmentWaitlist.status, "waiting"),
              isNull(appointmentWaitlist.deletedAt),
            ),
          )
          .returning({ id: appointmentWaitlist.id });
        if (
          movedWaitlistEntries.length !==
          analysis.movableCounts.waitingListEntries
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The source patient's waiting-list entries changed during merge. Preview and retry.",
          });
        }

        const mergedAt = mergeNow;
        const [event] = await tx
          .insert(patientMergeEvents)
          .values({
            practiceId: ctx.practiceId,
            sourcePatientId: input.mergeId,
            targetPatientId: input.keepId,
            clientId: analysis.keepPatient.clientId,
            performedBy: ctx.user.id,
            performedByName: ctx.user.name,
            reason: input.reason,
            operationId: input.operationId,
            sourceSnapshot: mergeIdentitySnapshot(analysis.mergePatient),
            targetSnapshot: mergeIdentitySnapshot(analysis.keepPatient),
            createdAt: mergedAt,
          })
          .returning({
            id: patientMergeEvents.id,
            createdAt: patientMergeEvents.createdAt,
          });
        if (!event) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Patient merge event was not recorded.",
          });
        }

        await tx.insert(auditLog).values({
          practiceId: ctx.practiceId,
          userId: ctx.user.id,
          action: "merged",
          entityType: "patient",
          entityId: input.keepId,
          changes: {
            mergeEventId: event.id,
            sourcePatientId: input.mergeId,
            targetPatientId: input.keepId,
            clientId: analysis.keepPatient.clientId,
            reason: input.reason,
            movedAppointments: movedAppointments.length,
            movedWaitlistEntries: movedWaitlistEntries.length,
          },
        });

        const [retiredSource] = await tx
          .update(patients)
          .set({ deletedAt: mergedAt, updatedAt: mergedAt })
          .where(
            and(
              eq(patients.id, input.mergeId),
              eq(patients.practiceId, ctx.practiceId),
              eq(patients.clientId, analysis.keepPatient.clientId),
              isNull(patients.deletedAt),
            ),
          )
          .returning({ id: patients.id });
        if (!retiredSource) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The source patient changed during merge. Preview and retry.",
          });
        }

        const canonical = await selectActivePatientDetail(
          mergeDb,
          ctx.practiceId,
          input.keepId,
        );
        if (!canonical) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "The canonical patient record is unavailable.",
          });
        }
        return {
          ...canonical,
          mergeMetadata: {
            eventId: event.id,
            sourcePatientId: input.mergeId,
            canonicalId: input.keepId,
            clientId: analysis.keepPatient.clientId,
            mergedAt: event.createdAt,
            replayed: false,
          },
        };
      });
    }),

  findDuplicates: protectedProcedure
    .use(requireRole("admin"))
    .query(async ({ ctx }) => {
      const duplicatePatient = alias(patients, "duplicate_patient");
      const rows = await ctx.db
        .select({
          clientId: patients.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          id: patients.id,
          name: patients.name,
          species: patients.species,
          breed: patients.breed,
          dob: patients.dob,
          microchipNumber: patients.microchipNumber,
          externalSource: patients.externalSource,
          externalId: patients.externalId,
          createdAt: patients.createdAt,
          hasImmutableHistory: immutableMergeHistoryPredicate(
            ctx.practiceId,
            patients.id,
          ),
          duplicateId: duplicatePatient.id,
          duplicateName: duplicatePatient.name,
          duplicateSpecies: duplicatePatient.species,
          duplicateBreed: duplicatePatient.breed,
          duplicateDob: duplicatePatient.dob,
          duplicateMicrochipNumber: duplicatePatient.microchipNumber,
          duplicateExternalSource: duplicatePatient.externalSource,
          duplicateExternalId: duplicatePatient.externalId,
          duplicateCreatedAt: duplicatePatient.createdAt,
          duplicateHasImmutableHistory: immutableMergeHistoryPredicate(
            ctx.practiceId,
            duplicatePatient.id,
          ),
        })
        .from(patients)
        .innerJoin(
          duplicatePatient,
          and(
            eq(patients.practiceId, duplicatePatient.practiceId),
            eq(patients.clientId, duplicatePatient.clientId),
            ne(patients.id, duplicatePatient.id),
            sql`${patients.id} < ${duplicatePatient.id}`,
            or(
              and(
                sql`lower(trim(${patients.name})) = lower(trim(${duplicatePatient.name}))`,
                eq(patients.species, duplicatePatient.species),
              ),
              and(
                isNotNull(patients.dob),
                eq(patients.dob, duplicatePatient.dob),
                eq(patients.species, duplicatePatient.species),
              ),
              and(
                isNotNull(patients.microchipNumber),
                sql`lower(trim(${patients.microchipNumber})) = lower(trim(${duplicatePatient.microchipNumber}))`,
              ),
              and(
                isNotNull(patients.externalSource),
                isNotNull(patients.externalId),
                sql`lower(${patients.externalSource}) = lower(${duplicatePatient.externalSource})`,
                eq(patients.externalId, duplicatePatient.externalId),
              ),
            ),
          ),
        )
        .innerJoin(
          clients,
          and(
            eq(patients.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .where(
          and(
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt),
            isNull(duplicatePatient.deletedAt),
          ),
        )
        .orderBy(
          asc(clients.lastName),
          asc(clients.firstName),
          asc(patients.name),
        )
        .limit(200);

      type DuplicatePatient = {
        id: string;
        name: string;
        species: string;
        breed: string | null;
        dob: string | null;
        microchipNumber: string | null;
        externalSource: string | null;
        externalId: string | null;
        createdAt: Date;
        hasImmutableHistory: boolean;
      };
      const groups = new Map<
        string,
        {
          clientId: string;
          clientFirstName: string;
          clientLastName: string;
          patients: DuplicatePatient[];
        }
      >();
      for (const row of rows) {
        const group = groups.get(row.clientId) ?? {
          clientId: row.clientId,
          clientFirstName: row.clientFirstName,
          clientLastName: row.clientLastName,
          patients: [],
        };
        const candidates: DuplicatePatient[] = [
          {
            id: row.id,
            name: row.name,
            species: row.species,
            breed: row.breed,
            dob: row.dob,
            microchipNumber: row.microchipNumber,
            externalSource: row.externalSource,
            externalId: row.externalId,
            createdAt: row.createdAt,
            hasImmutableHistory: row.hasImmutableHistory,
          },
          {
            id: row.duplicateId,
            name: row.duplicateName,
            species: row.duplicateSpecies,
            breed: row.duplicateBreed,
            dob: row.duplicateDob,
            microchipNumber: row.duplicateMicrochipNumber,
            externalSource: row.duplicateExternalSource,
            externalId: row.duplicateExternalId,
            createdAt: row.duplicateCreatedAt,
            hasImmutableHistory: row.duplicateHasImmutableHistory,
          },
        ];
        for (const candidate of candidates) {
          if (!group.patients.some((patient) => patient.id === candidate.id)) {
            group.patients.push(candidate);
          }
        }
        groups.set(row.clientId, group);
      }

      return Array.from(groups.values()).map((group) => ({
        clientId: group.clientId,
        clientFirstName: group.clientFirstName,
        clientLastName: group.clientLastName,
        patients: group.patients.map(
          ({ hasImmutableHistory: _hasImmutableHistory, ...patient }) =>
            patient,
        ),
        blockerSummary: {
          patientsWithImmutableHistory: group.patients.filter(
            (patient) => patient.hasImmutableHistory,
          ).length,
        },
      }));
    }),
});
