import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PATIENT_WEIGHT_MAX_KG,
  PATIENT_WEIGHT_MIN_KG,
  PATIENT_WEIGHT_STEP,
  isPatientWeightInputValid,
} from "../records/patient-weight-policy";
import {
  VITALS_CAPILLARY_REFILL_MAX_SEC,
  VITALS_CAPILLARY_REFILL_MIN_SEC,
  VITALS_CAPILLARY_REFILL_STEP,
  VITALS_HEART_RATE_MAX_BPM,
  VITALS_HEART_RATE_MIN_BPM,
  VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
  VITALS_NOTES_MAX_LENGTH,
  VITALS_TEMPERATURE_MAX_C,
  VITALS_TEMPERATURE_MIN_C,
  VITALS_TEMPERATURE_STEP,
  VITALS_WEIGHT_MAX_KG,
  VITALS_WEIGHT_MIN_KG,
  VITALS_WEIGHT_STEP,
  isVitalsOptionalCapillaryRefillInputValid,
  isVitalsOptionalHeartRateInputValid,
  isVitalsOptionalTemperatureInputValid,
  isVitalsOptionalTextInputValid,
  isVitalsOptionalWeightInputValid,
} from "../records/vitals-policy";
import {
  fahrenheitToCelsius,
  poundsToKilograms,
  roundClinicalMeasurement,
} from "../ambulatory-workspace";

describe("patient detail UI states", () => {
  it("resolves merged source charts to the canonical identity with attribution", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(source).toContain(
      "const canonicalPatientId = patient?.id ?? params.id",
    );
    expect(source).toContain("patient?.mergeMetadata");
    expect(source).toContain("window.history.replaceState(");
    expect(source).toContain("?mergedFrom=${params.id}");
    expect(source).toContain(
      "Opened the canonical chart for a merged patient identity",
    );
    expect(source).toContain("patient.mergeMetadata.sourceSnapshot.name");
    expect(source).toContain("patient.mergeMetadata.performedByName");
    expect(source).toContain("patient.mergeMetadata.reason");
    expect(source).toContain("{ patientId: canonicalPatientId }");
    expect(source).toContain(
      'formData.append("patientId", canonicalPatientId)',
    );
    expect(source).toContain(
      'headers: { "Idempotency-Key": attempt.idempotencyKey }',
    );
    expect(source).not.toContain("updatePhotoMutation");
    expect(source).toContain(
      "Array.from(new Set([params.id, canonicalPatientId]))",
    );
  });

  it("keeps viewer access read-only for patient detail writes", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain(
      "function canManagePatientDetailRole(role?: string | null): boolean",
    );
    expect(source).toContain(
      "function canRecordVitalsRole(role?: string | null): boolean",
    );
    expect(source).toContain("const { data: session } = useSession()");
    expect(source).toContain(
      "const canManagePatientDetail = canManagePatientDetailRole(",
    );
    expect(source).toContain("const canRecordVitals = canRecordVitalsRole(");
    expect(source).toContain("if (!canManagePatientDetail)");
    expect(source).toContain("{canManagePatientDetail && (");
    expect(source).toContain(
      "canManagePatientDetail &&\n    isPatientWeightInputValid",
    );
    expect(source).toContain("canRecordVitals={canRecordVitals}");
    expect(source).toContain("canRecordVitals &&");
    expect(source).toContain("canRecordVitals: boolean");

    expect(source).toContain('role === "admin"');
    expect(source).toContain('role === "veterinarian"');
    expect(source).toContain('role === "technician"');
    expect(source).toContain('role === "front_desk"');

    const vitalsRoleStart = source.indexOf("function canRecordVitalsRole");
    const vitalsRoleEnd = source.indexOf(
      "type VitalsFormState",
      vitalsRoleStart,
    );
    const vitalsRoleSource = source.slice(vitalsRoleStart, vitalsRoleEnd);
    expect(vitalsRoleSource).toContain('role === "admin"');
    expect(vitalsRoleSource).toContain('role === "veterinarian"');
    expect(vitalsRoleSource).toContain('role === "technician"');
    expect(vitalsRoleSource).not.toContain('role === "front_desk"');
  });

  it("uses shared empty states for patient clinical-history tabs", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(source).toContain(
      'import { EmptyState } from "@/components/common/empty-state"',
    );
    expect(source).toContain('title="No weight records yet"');
    expect(source).toContain('title="No vitals recorded yet"');
    expect(source).toContain('title="No vaccination records yet"');
    expect(source).toContain('title="No medical records yet"');
    expect(source).toContain('title="No appointments yet"');
    expect(source).toContain('title="No invoices yet"');
  });

  it("gives the chart medical-history tabs backed by tenant-scoped queries", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );
    const appointmentsRouter = readFileSync(
      "server/routers/appointments.ts",
      "utf8",
    );

    // The chart is the medical record: SOAP timeline, visit history, and
    // billing history live on the patient page.
    for (const label of ["Medical Records", "Appointments", "Invoices"]) {
      expect(source).toContain(`label: "${label}"`);
    }
    expect(source).toContain(
      "trpc.records.listSoapNotes.useQuery({ patientId })",
    );
    expect(source).toContain(
      "trpc.appointments.listByPatient.useQuery({ patientId })",
    );
    expect(source).toContain("trpc.billing.listInvoices.useQuery({");
    // listByPatient stays tenant-scoped like every appointments query.
    const listByPatient = appointmentsRouter.slice(
      appointmentsRouter.indexOf("listByPatient:"),
    );
    expect(listByPatient).toContain(
      "eq(appointments.practiceId, ctx.practiceId)",
    );
    expect(listByPatient).toContain("activePracticePredicate(ctx.practiceId)");
  });

  it("surfaces Vitals and Vaccinations load errors before empty states", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(source).toContain("function PatientDetailErrorPanel");
    expect(source).toContain("function PatientDetailLoadingPanel");
    expect(source).toContain("trpc.records.settings.useQuery()");
    expect(source).toContain("const loadError = error ?? recordsSettingsError");
    expect(source).toContain("const recordsSettingsMissing =");
    expect(source).toContain(
      "const isPageLoading = !loadError && (isLoading || recordsSettingsLoading)",
    );
    expect(source).toContain(
      '<PatientDetailLoadingPanel label="Loading patient..." />',
    );
    expect(source).toContain("if (\n    loadError ||");
    expect(source).toContain("!verifiedRecordsSettings ||\n    !patient");
    expect(source).toContain('title="Unable to load patient"');
    expect(source).toContain(
      "recordsSettingsMissing || !verifiedRecordsSettings",
    );
    expect(source).toContain("Unable to load clinical settings. Please retry.");
    expect(source).toContain('label: "Back to Patients"');
    expect(source).toContain('router.push("/patients")');
    expect(source).toMatch(
      /const \{\s*data: vitals,\s*isLoading,\s*error,?\s*\}/,
    );
    expect(source).toContain("const vitalsMissing =");
    expect(source).toContain("{error ? (");
    expect(source).toContain("Unable to load vitals. ${error.message}");
    expect(source).toContain("Unable to load vitals. Please retry.");
    expect(source).toContain("const vaccinationsMissing =");
    expect(source).toContain(
      "Unable to load vaccination records. ${error.message}",
    );
    expect(source).toContain(
      "Unable to load vaccination records. Please retry.",
    );
    expect(source.indexOf("vitalsMissing ? (")).toBeLessThan(
      source.indexOf('title="No vitals recorded yet"'),
    );
    expect(source.indexOf("if (vaccinationsMissing)")).toBeLessThan(
      source.indexOf('title="No vaccination records yet"'),
    );
    expect(source).not.toContain(
      'className="text-center text-muted-foreground py-12"',
    );
    expect(source).not.toContain("if (!patient) return null");
  });

  it("fails closed when medical summary clinical payloads are incomplete", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(source).toContain("const summaryError =");
    expect(source).toContain("throw summaryError");
    expect(source).toContain(
      "Unable to load complete medical summary data. Please retry.",
    );
    expect(source).toMatch(/err instanceof Error\s*\?\s*err\.message/);
    expect(source).toContain("const problems = problemsResult.data;");
    expect(source).toContain("const vaccinations = vaccinationsResult.data;");
    expect(source).toContain("const soapNotes = soapNotesResult.data;");
    expect(source).toContain("const prescriptions = prescriptionsResult.data;");
    expect(source).not.toContain("if (!patient) return;");
    expect(source).not.toContain("const problems = problemsResult.data ?? []");
    expect(source).not.toContain(
      "const vaccinations = vaccinationsResult.data ?? []",
    );
    expect(source).not.toContain(
      "const soapNotes = soapNotesResult.data ?? []",
    );
    expect(source).not.toContain(
      "const prescriptions = prescriptionsResult.data ?? []",
    );
  });

  it("renders patient clinical dates through the practice timezone contract", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(source).toContain(
      'import {\n  formatClinicalDate,\n  formatClinicalDateTime,\n} from "@/lib/records/clinical-dates"',
    );
    expect(source).toContain("const verifiedRecordsSettings =");
    expect(source).toContain(
      "const recordsSettingsTimeZone = verifiedRecordsSettings\n    ? verifiedRecordsSettings.timezone\n    : undefined",
    );
    expect(source).toContain(
      "buildWeightTrend(patient?.weights ?? [], recordsSettingsTimeZone)",
    );
    expect(source).toContain("const patientData = patient");
    expect(source).toContain(
      "const recordsTimeZone = verifiedRecordsSettings.timezone",
    );
    expect(source).toContain(
      'const recordsPracticeName =\n    verifiedRecordsSettings.name ?? "Veterinary Practice"',
    );
    expect(source).toContain(
      "const recordsPracticePhone = verifiedRecordsSettings.phone",
    );
    expect(source).toContain("formatClinicalDate(patient.dob, recordsTimeZone");
    expect(source).toContain(
      "formatClinicalDate(\n                              weight.recordedAt,\n                              recordsTimeZone",
    );
    expect(source).toContain("<VitalsTab");
    expect(source).toContain("canRecordVitals={canRecordVitals}");
    expect(source).toContain("<VaccinationsTab");
    expect(source).toContain("timeZone={recordsTimeZone}");
    expect(source).toContain(
      "canCorrectClinicalRecords={canCorrectClinicalRecords}",
    );
    expect(source).toContain(
      "(vitals ?? []).filter((vital) => !vital.correctionId)",
    );
    expect(source).toContain("formatClinicalDateTime(v.recordedAt, timeZone");
    expect(source).toContain("formatClinicalDate(vax.administeredAt, timeZone");
    expect(source).toContain("formatClinicalDate(vax.nextDueDate, timeZone");
    expect(source).toContain(
      "formatClinicalDate(v.administeredAt, recordsTimeZone",
    );
    expect(source).toContain("formatClinicalDate(n.createdAt, recordsTimeZone");
    expect(source).toContain("practiceName: recordsPracticeName");
    expect(source).toContain(
      "practicePhone: recordsPracticePhone ?? undefined",
    );
    expect(source).toContain(
      "generatedDate: formatClinicalDate(new Date(), recordsTimeZone)",
    );
    expect(source).not.toContain(
      "const recordsTimeZone = recordsSettings?.timezone",
    );
    expect(source).not.toContain(
      "const recordsSettingsTimeZone = recordsSettings?.timezone",
    );
    expect(source).not.toContain("recordsSettings?.name");
    expect(source).not.toContain("recordsSettings?.phone");
    expect(source).not.toContain('practiceName: ""');
    expect(source).not.toContain(
      "new Date(weight.recordedAt).toLocaleDateString",
    );
    expect(source).not.toContain("new Date(v.recordedAt).toLocaleString");
    expect(source).not.toContain(
      "new Date(vax.administeredAt).toLocaleDateString",
    );
  });

  it("bounds the vitals form before record mutation", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(VITALS_TEMPERATURE_MIN_C).toBe(20);
    expect(VITALS_TEMPERATURE_MAX_C).toBe(45);
    expect(VITALS_TEMPERATURE_STEP).toBe(0.1);
    expect(VITALS_HEART_RATE_MIN_BPM).toBe(0);
    expect(VITALS_HEART_RATE_MAX_BPM).toBe(400);
    expect(VITALS_WEIGHT_MIN_KG).toBe(0.001);
    expect(VITALS_WEIGHT_MAX_KG).toBe(10_000);
    expect(VITALS_WEIGHT_STEP).toBe(0.001);
    expect(VITALS_CAPILLARY_REFILL_MIN_SEC).toBe(0);
    expect(VITALS_CAPILLARY_REFILL_MAX_SEC).toBe(10);
    expect(VITALS_CAPILLARY_REFILL_STEP).toBe(0.1);
    expect(VITALS_MUCOUS_MEMBRANE_MAX_LENGTH).toBe(64);
    expect(VITALS_NOTES_MAX_LENGTH).toBe(5000);
    expect(isVitalsOptionalTemperatureInputValid("38.6")).toBe(true);
    expect(isVitalsOptionalTemperatureInputValid("38.66")).toBe(false);
    expect(isVitalsOptionalHeartRateInputValid("120")).toBe(true);
    expect(isVitalsOptionalHeartRateInputValid("120.5")).toBe(false);
    expect(isVitalsOptionalWeightInputValid("12.345")).toBe(true);
    expect(isVitalsOptionalWeightInputValid("12.3456")).toBe(false);
    expect(isVitalsOptionalWeightInputValid("0")).toBe(false);
    expect(isVitalsOptionalCapillaryRefillInputValid("1.5")).toBe(true);
    expect(isVitalsOptionalCapillaryRefillInputValid("1.55")).toBe(false);
    expect(isVitalsOptionalTextInputValid("", 64)).toBe(true);
    expect(source).toContain("type VitalsFormState =");
    expect(source).toContain("const canSubmitVitals =");
    expect(source).toContain("hasVitalsFormContent");
    expect(source).toContain("celsiusToFahrenheit(VITALS_TEMPERATURE_MIN_C)");
    expect(source).toContain("celsiusToFahrenheit(VITALS_TEMPERATURE_MAX_C)");
    expect(source).toContain("step={VITALS_TEMPERATURE_STEP}");
    expect(source).toContain("kilogramsToPounds(VITALS_WEIGHT_MIN_KG)");
    expect(source).toContain("kilogramsToPounds(VITALS_WEIGHT_MAX_KG)");
    expect(source).toContain("step={VITALS_WEIGHT_STEP}");
    expect(source).toContain("maxLength={VITALS_MUCOUS_MEMBRANE_MAX_LENGTH}");
    expect(source).toContain("maxLength={VITALS_NOTES_MAX_LENGTH}");
    expect(source).toContain(
      "mucousMembrane: form.mucousMembrane.trim() || undefined",
    );
    expect(source).toContain(
      "capillaryRefillSec: num(form.capillaryRefillSec)",
    );
    expect(source).toContain("temperatureC: num(canonicalTemperature)");
    expect(source).toContain("weightKg: num(canonicalWeight)");
    expect(source).toContain("bodyConditionScale,");
    expect(source).toContain("disabled={!canSubmitVitals}");
    expect(source).not.toContain("disabled={record.isPending}");
  });

  it("bounds and wires the patient weight history form", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(PATIENT_WEIGHT_MIN_KG).toBe(0.001);
    expect(PATIENT_WEIGHT_MAX_KG).toBe(99999.999);
    expect(PATIENT_WEIGHT_STEP).toBe(0.001);
    expect(isPatientWeightInputValid("12.345")).toBe(true);
    expect(isPatientWeightInputValid("12.3456")).toBe(false);
    expect(isPatientWeightInputValid("0")).toBe(false);
    expect(isPatientWeightInputValid("100000")).toBe(false);
    expect(source).toContain(
      "const addWeight = trpc.patients.addWeight.useMutation",
    );
    expect(source).toContain("const canSubmitWeight =");
    expect(source).toContain("handleRecordWeight");
    expect(source).toContain("kilogramsToPounds(PATIENT_WEIGHT_MIN_KG)");
    expect(source).toContain("kilogramsToPounds(PATIENT_WEIGHT_MAX_KG)");
    expect(source).toContain("step={PATIENT_WEIGHT_STEP}");
    expect(source).toContain("disabled={!canSubmitWeight}");
    expect(source).toContain("weightKg: canonicalPatientWeight");
    expect(source).toContain('toast.success("Weight recorded")');
  });

  it("applies ambulatory units and the stored BCS scale across chart entry and history", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(roundClinicalMeasurement(fahrenheitToCelsius(101.5), 1)).toBe(38.6);
    expect(roundClinicalMeasurement(poundsToKilograms(1600), 3)).toBe(725.748);
    expect(source).toContain(
      'const chartMeasurementSystem =\n    recordsSettings?.ambulatoryWorkspace.measurementSystem ?? "metric"',
    );
    expect(source).toContain(
      "recordsSettings?.ambulatoryWorkspace.bodyConditionScale ?? 9",
    );
    expect(source).toContain(
      'chartMeasurementSystem === "us_customary" ? poundsToKilograms : undefined',
    );
    expect(source).toContain(
      'measurementSystem === "us_customary" ? fahrenheitToCelsius : undefined',
    );
    expect(source).toContain(
      'measurementSystem === "us_customary" ? poundsToKilograms : undefined',
    );
    expect(source).toContain(
      'Temp ({measurementSystem === "us_customary" ? "F" : "C"})',
    );
    expect(source).toContain(
      'Weight ({measurementSystem === "us_customary" ? "lb" : "kg"})',
    );
    expect(source).toContain("BCS (1-{bodyConditionScale})");
    expect(source).toContain(
      "formatClinicalTemperature(\n                        v.temperatureC,\n                        measurementSystem",
    );
    expect(source).toContain(
      "formatClinicalWeight(v.weightKg, measurementSystem)",
    );
    expect(source).toContain("{v.bodyConditionScore} / {v.bodyConditionScale}");
  });

  it("fails the ambulatory snapshot closed and excludes corrected clinical observations", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(source).toContain(
      "const snapshotVitalsQuery = trpc.vitals.listByPatient.useQuery",
    );
    expect(source).toContain(
      "const latestSnapshotVitals = snapshotVitalsQuery.data?.find",
    );
    expect(source).toContain("(vital) => !vital.correctionId");
    expect(source).toContain("(vaccination) => !vaccination.correctionId");
    expect(source).toContain("snapshotVitalsQuery.error");
    expect(source).toContain("vaccinationsQuery.error");
    expect(source).toContain("!snapshotVitalsQuery.data");
    expect(source).toContain("!vaccinationsQuery.data");
    expect(source).toContain("Latest vitals");
    expect(source).toContain("BCS / vaccines");
    expect(source).toContain("latestSnapshotBcs.bodyConditionScale");
  });

  it("requires an explicit active location for multi-location field visits", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );

    expect(source).toContain(
      "trpc.appointments.listLocations.useQuery(\n    undefined,",
    );
    expect(source).toContain("fieldVisitLocations.length === 1");
    expect(source).toContain('aria-label="Field visit location"');
    expect(source).toContain("fieldVisitLocations.length > 1");
    expect(source).toContain("!selectedFieldVisitLocationId");
    expect(source).toContain("locationId: selectedFieldVisitLocationId");
    expect(source).toContain(
      "Add an active location before starting a field visit.",
    );
  });

  it("keeps allergy reactions visible and uses permanent clinician corrections", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );
    // Add + correction both refresh the same getById payload the bar renders from.
    expect(source).toContain("trpc.patients.addAllergy.useMutation");
    expect(source).toContain(
      "trpc.patients.markAllergyEnteredInError.useMutation",
    );
    const refreshes = source.match(/refreshPatientDetail\(\)/g);
    expect(refreshes && refreshes.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('triggerLabel="Mark allergy entered in error"');
    expect(source).toContain("canCorrect={canCorrectClinicalRecords}");
    expect(source).toContain(
      'Reaction: {allergy.reaction || "Not documented"}',
    );
    expect(source).toContain("Allergy correction history");
    expect(source).toContain("Legacy removal retained.");
    expect(source).toContain("{canManagePatientDetail && !showAllergyForm ?");
    expect(source).toContain("allergen: allergyName.trim()");
    // Read-only roles still see the alert bar but never the empty-state
    // add strip (it renders null for them).
    expect(source).toContain(") : canManagePatientDetail ? (");
  });
});
