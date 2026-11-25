import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  clinicalRecordCorrections,
  patientAllergies,
  patients,
  practices,
  problemList,
  vitalSigns,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { SoapDraftContext } from "./soap-draft";

/**
 * The chart details an AI SOAP draft may lean on: who the patient is, known
 * allergies, the problem list and the latest vitals. Corrected (struck) entries
 * are left out. Returns null when the patient is not in this practice.
 */

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

export async function loadSoapChartContext(
  db: Database,
  practiceId: string,
  patientId: string,
): Promise<Omit<SoapDraftContext, "visitContext"> | null> {
  const [[patient], allergies, problems, [latestVitals]] = await Promise.all([
    db
      .select({
        name: patients.name,
        species: patients.species,
        breed: patients.breed,
        sex: patients.sex,
        dob: patients.dob,
      })
      .from(patients)
      .where(
        and(
          eq(patients.id, patientId),
          eq(patients.practiceId, practiceId),
          activePracticePredicate(practiceId),
          isNull(patients.deletedAt),
        ),
      )
      .limit(1),
    db
      .select({
        allergen: patientAllergies.allergen,
        severity: patientAllergies.severity,
      })
      .from(patientAllergies)
      .where(
        and(
          eq(patientAllergies.patientId, patientId),
          activePracticePredicate(practiceId),
          sql`exists (
                  select 1
                  from ${patients}
                  where ${patients.id} = ${patientAllergies.patientId}
                    and ${patients.practiceId} = ${practiceId}
                    and ${patients.deletedAt} is null
                )`,
          sql`not exists (
                  select 1
                  from ${clinicalRecordCorrections} as allergy_correction
                  where allergy_correction.practice_id = ${practiceId}
                    and allergy_correction.patient_allergy_id = ${patientAllergies.id}
                )`,
          isNull(patientAllergies.deletedAt),
        ),
      ),
    db
      .select({
        description: problemList.description,
        status: problemList.status,
      })
      .from(problemList)
      .where(
        and(
          eq(problemList.patientId, patientId),
          eq(problemList.practiceId, practiceId),
          activePracticePredicate(practiceId),
          isNull(problemList.deletedAt),
        ),
      ),
    db
      .select({
        temperatureC: vitalSigns.temperatureC,
        heartRateBpm: vitalSigns.heartRateBpm,
        respiratoryRateBpm: vitalSigns.respiratoryRateBpm,
        weightKg: vitalSigns.weightKg,
      })
      .from(vitalSigns)
      .where(
        and(
          eq(vitalSigns.patientId, patientId),
          eq(vitalSigns.practiceId, practiceId),
          activePracticePredicate(practiceId),
          isNull(vitalSigns.deletedAt),
          sql`not exists (
                  select 1
                  from ${clinicalRecordCorrections}
                  where ${clinicalRecordCorrections.practiceId} = ${practiceId}
                    and ${clinicalRecordCorrections.vitalSignId} = ${vitalSigns.id}
                )`,
        ),
      )
      .orderBy(desc(vitalSigns.recordedAt))
      .limit(1),
  ]);

  if (!patient) return null;
  return {
    patient,
    allergies,
    activeProblems: problems,
    latestVitals: latestVitals ?? null,
  };
}
