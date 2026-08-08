import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PATIENT_SEARCH_MAX_LENGTH,
  isPatientSearchInputValid,
} from "../patients/policy";
import {
  LAB_REFERENCE_MAX,
  LAB_REFERENCE_MIN,
  LAB_REFERENCE_STEP,
  LAB_RESULT_VALUE_MAX_LENGTH,
  LAB_TEST_NAME_MAX_LENGTH,
  LAB_UNIT_MAX_LENGTH,
  isLabOptionalReferenceInputValid,
  isLabOptionalTextInputValid,
  isLabReferenceRangeOrdered,
  isLabRequiredTextInputValid,
} from "../records/lab-policy";
import {
  VACCINATION_LOT_NUMBER_MAX_LENGTH,
  VACCINATION_MANUFACTURER_MAX_LENGTH,
  VACCINATION_NAME_MAX_LENGTH,
  isVaccinationDateInputValid,
  isVaccinationOptionalDateInputValid,
  isVaccinationOptionalTextInputValid,
  isVaccinationRequiredTextInputValid,
} from "../records/vaccination-policy";
import {
  PROBLEM_DESCRIPTION_MAX_LENGTH,
  PROBLEM_STATUSES,
  isProblemDateInputValid,
  isProblemOptionalDateInputValid,
  isProblemRequiredTextInputValid,
} from "../records/problem-policy";
import {
  PRESCRIPTION_COUNT_MAX,
  PRESCRIPTION_DOSAGE_MAX_LENGTH,
  PRESCRIPTION_FREQUENCY_MAX_LENGTH,
  PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH,
  PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH,
  PRESCRIPTION_QUANTITY_MIN,
  PRESCRIPTION_REFILLS_MIN,
  isPrescriptionNonnegativeIntegerInputValid,
  isPrescriptionOptionalPositiveIntegerInputValid,
  isPrescriptionOptionalTextInputValid,
  isPrescriptionPositiveIntegerInputValid,
  isPrescriptionRequiredTextInputValid,
} from "../records/prescription-policy";
import {
  PROCEDURE_ANESTHESIA_MAX_LENGTH,
  PROCEDURE_DESCRIPTION_MAX_LENGTH,
  PROCEDURE_DURATION_MAX_MINUTES,
  PROCEDURE_DURATION_MIN_MINUTES,
  PROCEDURE_NAME_MAX_LENGTH,
  PROCEDURE_NOTES_MAX_LENGTH,
  isProcedureOptionalDurationInputValid,
  isProcedureOptionalTextInputValid,
  isProcedureRequiredTextInputValid,
} from "../records/procedure-policy";
import { SOAP_NOTE_TEMPLATES } from "../records/soap-templates";

describe("SOAP note editor UX", () => {
  it("keeps placeholder copy out of the editable document content", () => {
    const source = readFileSync("components/SoapNoteEditor.tsx", "utf8");

    expect(source).toContain('content: value || ""');
    expect(source).toContain('onChange(editor.isEmpty ? "" : editor.getHTML())');
    expect(source).toContain("pointer-events-none");
    expect(source).toContain("{placeholder}");
    expect(source).toContain("useEffect");
    expect(source).toContain("editor.commands.setContent(nextValue, false)");
    expect(source).not.toContain("`<p>${placeholder}</p>`");
  });

  it("disables SOAP note save until content exists and template prompts are resolved", () => {
    const source = readFileSync(
      "app/(dashboard)/records/new-soap/[patientId]/page.tsx",
      "utf8"
    );

    expect(source).toContain("const canSave = hasSoapContent");
    expect(source).toContain(
      "const hasTemplatePrompts = hasUnresolvedSoapTemplatePrompts"
    );
    expect(source).toContain("const canSubmit = canSave && !hasTemplatePrompts");
    expect(source).toContain("disabled={createNote.isPending || !canSubmit}");
    expect(source).toContain(
      "Replace or delete every draft prompt before saving"
    );
    expect(source).toContain("normalizeSoapSection(subjective)");
  });

  it("offers structured SOAP templates without clobbering drafts by default", () => {
    const source = readFileSync(
      "app/(dashboard)/records/new-soap/[patientId]/page.tsx",
      "utf8"
    );

    expect(SOAP_NOTE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    expect(SOAP_NOTE_TEMPLATES.map((template) => template.id)).toContain(
      "wellness-exam"
    );
    expect(source).toContain("SOAP_NOTE_TEMPLATES.map");
    expect(source).toContain("getSoapTemplateById(selectedTemplateId)");
    expect(source).toContain("applySoapTemplateToSections");
    expect(source).toContain("replaceExisting: replaceTemplateContent");
    expect(source).toContain("setSubjective(next.subjective)");
    expect(source).toContain("setObjective(next.objective)");
    expect(source).toContain("setAssessment(next.assessment)");
    expect(source).toContain("setPlan(next.plan)");
    expect(source).toContain("Replace existing content");
    expect(source).toContain("Apply template");
    expect(source).toContain(
      "Templates add drafting prompts, not assumed findings"
    );
  });

  it("keeps the SOAP author access gate after hooks are declared", () => {
    const source = readFileSync(
      "app/(dashboard)/records/new-soap/[patientId]/page.tsx",
      "utf8"
    );

    expect(source).toContain(
      "function canCreateSoapNoteRole(role?: string | null): boolean"
    );
    expect(source).toContain('role === "admin" || role === "veterinarian"');
    expect(source).toContain("const { data: session, status } = useSession()");
    expect(source).toContain(
      "const canCreateSoapNote = canCreateSoapNoteRole(userRole)"
    );
    expect(source).toContain("const accessDenied =");
    expect(source).toContain(
      'const accessDenied = status !== "loading" && !canCreateSoapNote'
    );
    expect(source).toContain(
      "{ enabled: !!params.patientId && canCreateSoapNote && !!appointmentId }"
    );
    expect(source).toContain('title="Open an active visit first"');
    expect(source).toContain("if (!appointmentId)");
    expect(source).toContain('if (status === "loading")');
    expect(source).toContain("Checking SOAP note access");
    expect(source.indexOf("const [subjective")).toBeLessThan(
      source.indexOf("if (accessDenied)")
    );
    expect(source).not.toContain(
      'if (userRole && userRole !== "admin" && userRole !== "veterinarian")'
    );
  });

  it("surfaces New SOAP patient load failures before rendering the editor", () => {
    const source = readFileSync(
      "app/(dashboard)/records/new-soap/[patientId]/page.tsx",
      "utf8"
    );

    expect(source).toContain(
      'import { EmptyState } from "@/components/common/empty-state"'
    );
    expect(source).toContain("error: patientError");
    expect(source).toContain("Loading patient...");
    expect(source).toContain("if (patientError || !patient)");
    expect(source).toContain('title="Unable to load patient"');
    expect(source).toContain('label: "Back to Records"');
    expect(source).toContain("!params.patientId || !patient");
    expect(source).toContain("Load the patient before saving a SOAP note");
    expect(source.indexOf("if (patientError || !patient)")).toBeLessThan(
      source.indexOf("<SoapNoteEditor")
    );
  });
});

describe("records prescription form UX", () => {
  it("keeps prescription form controls aligned to shared policy", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH).toBe(255);
    expect(PRESCRIPTION_DOSAGE_MAX_LENGTH).toBe(128);
    expect(PRESCRIPTION_FREQUENCY_MAX_LENGTH).toBe(128);
    expect(PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH).toBe(5000);
    expect(PRESCRIPTION_QUANTITY_MIN).toBe(1);
    expect(PRESCRIPTION_REFILLS_MIN).toBe(0);
    expect(PRESCRIPTION_COUNT_MAX).toBe(2147483647);
    expect(isPrescriptionRequiredTextInputValid(" Carprofen ", 255)).toBe(true);
    expect(isPrescriptionRequiredTextInputValid(" ", 255)).toBe(false);
    expect(isPrescriptionOptionalTextInputValid("", 5000)).toBe(true);
    expect(isPrescriptionPositiveIntegerInputValid("30")).toBe(true);
    expect(isPrescriptionPositiveIntegerInputValid("0")).toBe(false);
    expect(isPrescriptionPositiveIntegerInputValid("1.5")).toBe(false);
    expect(isPrescriptionOptionalPositiveIntegerInputValid("")).toBe(true);
    expect(isPrescriptionNonnegativeIntegerInputValid("0")).toBe(true);
    expect(isPrescriptionNonnegativeIntegerInputValid("-1")).toBe(false);
    expect(source).toContain(
      "maxLength={PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH}"
    );
    expect(source).toContain("maxLength={PRESCRIPTION_DOSAGE_MAX_LENGTH}");
    expect(source).toContain("maxLength={PRESCRIPTION_FREQUENCY_MAX_LENGTH}");
    expect(source).toContain("maxLength={PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH}");
    expect(source).toContain("min={PRESCRIPTION_QUANTITY_MIN}");
    expect(source).toContain("min={PRESCRIPTION_REFILLS_MIN}");
    expect(source).toContain("max={PRESCRIPTION_COUNT_MAX}");
    expect(source).toContain("const canSubmitPrescription =");
    expect(source).toContain("hasValidPrescriptionQuantityForInventory");
    expect(source).toContain("const inventoryProductsMissing =");
    expect(source).toContain("const verifiedInventoryProducts =");
    expect(source).toContain("verifiedInventoryProducts.items.find");
    expect(source).toContain("verifiedInventoryProducts.items.map");
    expect(source).toContain("Inventory unavailable");
    expect(source).toContain("Unable to load inventory products. Please retry.");
    expect(source).toContain("prescriptionQuantity <= selectedPrescriptionProduct.stockQuantity");
    expect(source).toContain("isPrescriptionOptionalPositiveIntegerInputValid");
    expect(source).toContain("isPrescriptionNonnegativeIntegerInputValid");
    expect(source).toContain(
      "prescriptionForm.instructions.trim() || undefined"
    );
    expect(source).toContain("disabled={!canSubmitPrescription}");
    expect(source).not.toContain("inventoryProducts.data?.items.find");
    expect(source).not.toContain("inventoryProducts.data?.items.map");
    expect(source).not.toContain(
      "disabled={createPrescription.isPending}"
    );
  });

  it("prevents prescription end dates before the start date", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(source).toMatch(
      /End Date[\s\S]*?<Input[\s\S]*?type="date"[\s\S]*?min=\{prescriptionForm\.startDate \|\| undefined\}/
    );
  });
});

describe("records lab result form UX", () => {
  it("keeps lab result form controls aligned to shared policy", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(LAB_TEST_NAME_MAX_LENGTH).toBe(255);
    expect(LAB_RESULT_VALUE_MAX_LENGTH).toBe(128);
    expect(LAB_UNIT_MAX_LENGTH).toBe(32);
    expect(LAB_REFERENCE_MIN).toBe(-9999999.999);
    expect(LAB_REFERENCE_MAX).toBe(9999999.999);
    expect(LAB_REFERENCE_STEP).toBe(0.001);
    expect(isLabRequiredTextInputValid(" CBC ", 255)).toBe(true);
    expect(isLabRequiredTextInputValid(" ", 255)).toBe(false);
    expect(isLabOptionalTextInputValid("", 128)).toBe(true);
    expect(isLabOptionalReferenceInputValid("-2.125")).toBe(true);
    expect(isLabOptionalReferenceInputValid("1.2345")).toBe(false);
    expect(isLabOptionalReferenceInputValid("10000000")).toBe(false);
    expect(isLabReferenceRangeOrdered("7.000", "27.000")).toBe(true);
    expect(isLabReferenceRangeOrdered("30.000", "7.000")).toBe(false);
    expect(source).toContain("maxLength={LAB_TEST_NAME_MAX_LENGTH}");
    expect(source).toContain("maxLength={LAB_RESULT_VALUE_MAX_LENGTH}");
    expect(source).toContain("maxLength={LAB_UNIT_MAX_LENGTH}");
    expect(source).toContain("min={LAB_REFERENCE_MIN}");
    expect(source).toContain("max={LAB_REFERENCE_MAX}");
    expect(source).toContain("step={LAB_REFERENCE_STEP}");
    expect(source).toContain("const canManageLabResults =");
    expect(source).toContain("const canSubmitLabResult =");
    expect(source).toContain("{canManageLabResults && (");
    expect(source).toContain("{canManageLabResults && showLabForm && (");
    expect(source).toContain(
      'lab.status === "completed" ? ('
    );
    expect(source).toContain("isLabOptionalReferenceInputValid");
    expect(source).toContain("isLabReferenceRangeOrdered");
    expect(source).toContain("labForm.resultValue.trim() || undefined");
    expect(source).toContain("disabled={!canSubmitLabResult}");
    expect(source).not.toContain("disabled={createLabResult.isPending}");
  });

  it("clearly presents lab results as manual entry until provider adapters are connected", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(source).toContain("Manual lab entry only");
    expect(source).toContain("Reference lab ordering is disabled until IDEXX, Antech,");
    expect(source).toContain("Add Manual Lab Result");
    expect(source).not.toContain("Order Lab");
  });

  it("renders shipped lab result trends from repeated numeric manual results", () => {
    const recordsSource = readFileSync("app/(dashboard)/records/page.tsx", "utf8");
    const chartSource = readFileSync(
      "components/patients/patient-trend-charts.tsx",
      "utf8"
    );

    expect(recordsSource).toContain("buildLabTrends(labResultsList ?? [], recordsTimeZone)");
    expect(recordsSource).toContain("const LabTrendCharts = dynamic");
    expect(recordsSource).toContain("<LabTrendCharts groups={labTrendGroups} />");
    expect(chartSource).toContain("export function LabTrendCharts");
    expect(chartSource).toContain("formatLabValue(group.latestValue, group.unit)");
  });
});

describe("records vaccination form UX", () => {
  it("adds vaccinations through bounded controls aligned to shared policy", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(VACCINATION_NAME_MAX_LENGTH).toBe(255);
    expect(VACCINATION_LOT_NUMBER_MAX_LENGTH).toBe(64);
    expect(VACCINATION_MANUFACTURER_MAX_LENGTH).toBe(128);
    expect(isVaccinationRequiredTextInputValid(" Rabies ", 255)).toBe(true);
    expect(isVaccinationRequiredTextInputValid(" ", 255)).toBe(false);
    expect(isVaccinationOptionalTextInputValid("", 64)).toBe(true);
    expect(isVaccinationDateInputValid("2026-06-28")).toBe(true);
    expect(isVaccinationDateInputValid("2026-02-31")).toBe(false);
    expect(isVaccinationOptionalDateInputValid("")).toBe(true);
    expect(source).toContain("trpc.records.createVaccination.useMutation");
    expect(source).toContain("const canCreateVaccinations =");
    expect(source).toContain("const canSubmitVaccination =");
    expect(source).toContain("Add Vaccination");
    expect(source).toContain("maxLength={VACCINATION_NAME_MAX_LENGTH}");
    expect(source).toContain(
      "maxLength={VACCINATION_LOT_NUMBER_MAX_LENGTH}"
    );
    expect(source).toContain(
      "maxLength={VACCINATION_MANUFACTURER_MAX_LENGTH}"
    );
    expect(source).toContain("isVaccinationOptionalDateInputValid");
    expect(source).toContain("vaccinationForm.lotNumber.trim() || undefined");
    expect(source).toContain("disabled={!canSubmitVaccination}");
    expect(source).not.toContain("disabled={createVaccination.isPending}");
  });
});

describe("records problem list UX", () => {
  it("adds and updates problems through bounded clinical controls", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(PROBLEM_DESCRIPTION_MAX_LENGTH).toBe(500);
    expect(PROBLEM_STATUSES).toEqual(["active", "resolved", "chronic"]);
    expect(isProblemRequiredTextInputValid(" Chronic otitis ", 500)).toBe(true);
    expect(isProblemRequiredTextInputValid(" ", 500)).toBe(false);
    expect(isProblemDateInputValid("2026-06-28")).toBe(true);
    expect(isProblemDateInputValid("2026-02-31")).toBe(false);
    expect(isProblemOptionalDateInputValid("")).toBe(true);
    expect(source).toContain("trpc.records.createProblem.useMutation");
    expect(source).toContain("trpc.records.updateProblemStatus.useMutation");
    expect(source).toContain("const canManageProblems =");
    expect(source).toContain("const canSubmitProblem =");
    expect(source).toContain("Add Problem");
    expect(source).toContain("maxLength={PROBLEM_DESCRIPTION_MAX_LENGTH}");
    expect(source).toContain("PROBLEM_STATUSES.map");
    expect(source).toContain("isProblemOptionalDateInputValid");
    expect(source).toContain("problemForm.description.trim()");
    expect(source).toContain("disabled={!canSubmitProblem}");
    expect(source).toContain('status: "resolved"');
    expect(source).toContain('status: "chronic"');
    expect(source).toContain('status: "active"');
    expect(source).not.toContain("disabled={createProblem.isPending}");
  });
});

describe("records procedure form UX", () => {
  it("keeps procedure form controls aligned to shared policy", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(PROCEDURE_NAME_MAX_LENGTH).toBe(255);
    expect(PROCEDURE_DESCRIPTION_MAX_LENGTH).toBe(5000);
    expect(PROCEDURE_ANESTHESIA_MAX_LENGTH).toBe(2000);
    expect(PROCEDURE_NOTES_MAX_LENGTH).toBe(5000);
    expect(PROCEDURE_DURATION_MIN_MINUTES).toBe(1);
    expect(PROCEDURE_DURATION_MAX_MINUTES).toBe(24 * 60);
    expect(isProcedureRequiredTextInputValid(" Dental ", 255)).toBe(true);
    expect(isProcedureRequiredTextInputValid(" ", 255)).toBe(false);
    expect(isProcedureOptionalTextInputValid("", 5000)).toBe(true);
    expect(isProcedureOptionalDurationInputValid("45")).toBe(true);
    expect(isProcedureOptionalDurationInputValid("")).toBe(true);
    expect(isProcedureOptionalDurationInputValid("0")).toBe(false);
    expect(isProcedureOptionalDurationInputValid("1.5")).toBe(false);
    expect(isProcedureOptionalDurationInputValid("1441")).toBe(false);
    expect(source).toContain("maxLength={PROCEDURE_NAME_MAX_LENGTH}");
    expect(source).toContain("maxLength={PROCEDURE_DESCRIPTION_MAX_LENGTH}");
    expect(source).toContain("maxLength={PROCEDURE_ANESTHESIA_MAX_LENGTH}");
    expect(source).toContain("maxLength={PROCEDURE_NOTES_MAX_LENGTH}");
    expect(source).toContain("min={PROCEDURE_DURATION_MIN_MINUTES}");
    expect(source).toContain("max={PROCEDURE_DURATION_MAX_MINUTES}");
    expect(source).toContain("const canCreateProcedures =");
    expect(source).toContain("const canSubmitProcedure =");
    expect(source).toContain("{canCreateProcedures && (");
    expect(source).toContain("{canCreateProcedures && showProcedureForm && (");
    expect(source).toContain("isProcedureOptionalDurationInputValid");
    expect(source).toContain("procedureForm.description.trim() || undefined");
    expect(source).toContain("Number(durationMinutes)");
    expect(source).toContain("disabled={!canSubmitProcedure}");
    expect(source).not.toContain("disabled={createProcedure.isPending}");
  });
});

describe("records page state handling", () => {
  it("renders Records clinical dates through the practice timezone contract", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(source).toContain("function formatClinicalDate");
    expect(source).toContain("function getVaccineDueStatus");
    expect(source).toContain("const recordsSettings = trpc.records.settings.useQuery");
    expect(source).toContain("const verifiedRecordsSettings =");
    expect(source).toContain(
      "const recordsTimeZone = verifiedRecordsSettings\n    ? verifiedRecordsSettings.timezone\n    : undefined"
    );
    expect(source).toContain(
      'verifiedRecordsSettings?.name ?? "Veterinary Practice"'
    );
    expect(source).toContain(
      "const recordsPracticePhone = verifiedRecordsSettings\n    ? verifiedRecordsSettings.phone\n    : undefined"
    );
    expect(source).toContain("const recordsSettingsError = recordsSettings.error");
    expect(source).toContain("const recordsSettingsLoading = recordsSettings.isLoading");
    expect(source).toContain(
      "const today = formatDateInputForTimeZone(new Date(), timeZone)"
    );
    expect(source).toContain("initialPrescriptionForm(recordsTimeZone)");
    expect(source).toMatch(
      /formatClinicalDate\(\s+note\.createdAt,\s+recordsTimeZone/
    );
    expect(source).toContain(
      "getVaccineDueStatus(\n                            vax.nextDueDate,\n                            recordsTimeZone"
    );
    expect(source).toContain(
      "formatClinicalDate(\n                                      vax.administeredAt,\n                                      recordsTimeZone"
    );
    expect(source).toContain(
      "formatClinicalDate(\n                                      vax.nextDueDate,\n                                      recordsTimeZone"
    );
    expect(source).toContain(
      "formatClinicalDate(\n                                problem.onsetDate,\n                                recordsTimeZone"
    );
    expect(source).toMatch(/formatClinicalDate\(\s+lab\.createdAt,\s+recordsTimeZone/);
    expect(source).toContain(
      "formatClinicalDate(\n                                    proc.createdAt,\n                                    recordsTimeZone"
    );
    expect(source).toContain("practiceName: recordsPracticeName");
    expect(source).toContain("recordsPracticePhone ?? undefined");
    expect(source).not.toContain("recordsSettings.data?.timezone");
    expect(source).not.toContain("recordsSettings.data?.name");
    expect(source).not.toContain("recordsSettings.data?.phone");
    expect(source).not.toContain('practiceName: ""');
    expect(source).not.toContain("new Date(rx.startDate).toLocaleDateString");
    expect(source).not.toContain("new Date().toLocaleDateString");
  });

  it("keeps Records query errors exclusive from empty clinical lists", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(PATIENT_SEARCH_MAX_LENGTH).toBe(128);
    expect(isPatientSearchInputValid(" Maple ")).toBe(true);
    expect(isPatientSearchInputValid("   ")).toBe(false);
    expect(isPatientSearchInputValid("M".repeat(129))).toBe(false);

    expect(source).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(source).toContain('from "@/lib/patients/policy"');
    expect(source).toContain("const trimmedSearchQuery = searchQuery.trim()");
    expect(source).toContain("const canSearchPatients = isPatientSearchInputValid(searchQuery)");
    expect(source).toContain("{ query: trimmedSearchQuery }");
    expect(source).toContain("maxLength={PATIENT_SEARCH_MAX_LENGTH}");
    expect(source).toContain("function RecordsErrorPanel");
    expect(source).toContain("function RecordsLoadingPanel");
    expect(source).toContain("patientSearchError");
    expect(source).toContain("const patientSearchMissing =");
    expect(source).toContain("patientSearchError || patientSearchMissing");
    expect(source).toContain("Unable to search patients. Please retry.");
    expect(source).toContain("const recordsSettingsMissing =");
    expect(source).toContain("{recordsSettingsError || recordsSettingsMissing ? (");
    expect(source).toContain(
      "Unable to load records settings. ${recordsSettingsError.message}"
    );
    expect(source).toContain("Unable to load records settings. Please retry.");
    expect(source).toContain(") : recordsSettingsLoading ? (");
    expect(source).toContain('<RecordsLoadingPanel label="Loading records settings..." />');
    expect(source).toContain("const soapNotesMissing =");
    expect(source).toContain("{soapNotesError || soapNotesMissing ? (");
    expect(source).toContain(") : isLoadingSoapNotes ? (");
    expect(source).toContain("const vaccinationsMissing =");
    expect(source).toContain("{vaccinationsError || vaccinationsMissing ? (");
    expect(source).toContain("const prescriptionsMissing =");
    expect(source).toContain("{prescriptionsError || prescriptionsMissing ? (");
    expect(source).toContain("const problemsMissing =");
    expect(source).toContain("{problemsError || problemsMissing ? (");
    expect(source).toContain("const labResultsMissing =");
    expect(source).toContain("{labResultsError || labResultsMissing ? (");
    expect(source).toContain("const proceduresMissing =");
    expect(source).toContain("{proceduresError || proceduresMissing ? (");
    expect(source.indexOf("soapNotesError || soapNotesMissing")).toBeLessThan(
      source.indexOf("No SOAP notes yet")
    );
    expect(source.indexOf("labResultsError || labResultsMissing")).toBeLessThan(
      source.indexOf("No lab results yet")
    );
    expect(source).toContain('title="No SOAP notes yet"');
    expect(source).toContain('title="No lab results yet"');
  });

  it("does not show restricted Records tabs as active content for front desk users", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(source).toContain("const visibleTabs = tabs.filter");
    expect(source).toContain("const currentTab = visibleTabs.some");
    expect(source).toContain('{currentTab === "soap"');
    expect(source).toContain('{currentTab === "vaccinations"');
    expect(source).not.toContain('{activeTab === "soap"');
  });

  it("keeps Records write controls aligned to clinical role gates", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(source).not.toContain("const canCreateSoapNotes =");
    expect(source).not.toContain("/records/new-soap/");
    expect(source).toContain(
      "SOAP notes are created from an active visit so documentation stays attached to the correct encounter."
    );
    expect(source).toContain("const canPrescribe =");
    expect(source).toContain("const canCreateVaccinations =");
    expect(source).toContain("const canManageProblems =");
    expect(source).toContain("const canManageLabResults =");
    expect(source).toContain("const canCreateProcedures =");
    expect(source).not.toContain(
      'selectedPatient && userRole !== "front_desk" && userRole !== "technician"'
    );
    expect(source).toContain("{canManageLabResults && (");
    expect(source).toContain("{canManageLabResults && showLabForm && (");
    expect(source).toContain(
      'canManageLabResults &&\n                                  lab.status === "completed" ? ('
    );
    expect(source).toContain("{canCreateProcedures && (");
    expect(source).toContain("{canCreateProcedures && showProcedureForm && (");
  });

  it("surfaces prescription safety check failures before a clean bill of health", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");

    expect(source).toContain("errorMessage?: string");
    expect(source).toContain("if (errorMessage)");
    expect(source).toContain("Unable to check prescription safety. {errorMessage}");
    expect(source).toContain("const prescriptionSafetyEnabled =");
    expect(source).toContain("const prescriptionSafetyMissing =");
    expect(source).toContain("const verifiedPrescriptionSafety =");
    expect(source).toContain("const prescriptionSafetyUnavailable =");
    expect(source).toContain("!prescriptionSafetyUnavailable");
    expect(source).toContain("prescriptionSafetyMissing");
    expect(source).toContain("Please retry.");
    expect(source).toContain("verifiedPrescriptionSafety?.warnings ?? []");
    expect(source).toContain("verifiedPrescriptionSafety?.requiresOverride");
    expect(source).not.toContain("prescriptionSafety.data?.warnings");
    expect(source).not.toContain("prescriptionSafety.data?.requiresOverride");
  });
});
