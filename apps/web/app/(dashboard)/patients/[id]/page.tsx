"use client";

import dynamic from "next/dynamic";
import { Fragment, useEffect, useMemo, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  ArrowLeft,
  AlertTriangle,
  User,
  Activity,
  Shield,
  Camera,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileDown,
  FileText,
  GitMerge,
  Loader2,
  Paperclip,
  Plus,
  Receipt,
  Stethoscope,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { useCurrencyFormatter } from "@/lib/locale/useCurrency";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { PatientHistorySearch } from "@/components/patients/patient-history-search";
import { CapturePhotos } from "@/components/records/capture-photos";
import { ConsentSign } from "@/components/records/consent-sign";
import { RecentClinicalItems } from "@/components/records/recent-clinical-items";
import { ClinicalCorrectionControl } from "@/components/records/clinical-correction-control";
import { cn } from "@/lib/utils";
import {
  CLIENT_UPLOAD_TIMEOUT_MS,
  fetchWithClientTimeout,
} from "@/lib/client-fetch";
import {
  IMAGE_UPLOAD_POLICY_MESSAGE,
  isImageUploadFileValid,
} from "@/lib/upload-policy";
import {
  selectManagedUploadFile,
  settleManagedUploadAttempt,
  type ManagedUploadAttempt,
} from "@/lib/managed-upload-attempt";
import {
  buildVitalTrend,
  buildWeightTrend,
} from "@/lib/records/clinical-trends";
import {
  formatClinicalDate,
  formatClinicalDateTime,
} from "@/lib/records/clinical-dates";
import { soapSectionText } from "@/lib/records/soap-content";
import { isRabiesVaccineName } from "@/lib/records/vaccination-policy";
import {
  patientFileKind,
  patientFileLabel,
  type PatientFileKind,
} from "@/lib/records/file-kinds";
import {
  PATIENT_WEIGHT_MAX_KG,
  PATIENT_WEIGHT_MIN_KG,
  PATIENT_WEIGHT_STEP,
  isPatientWeightInputValid,
} from "@/lib/records/patient-weight-policy";
import {
  VITALS_BODY_CONDITION_MIN,
  VITALS_CAPILLARY_REFILL_MAX_SEC,
  VITALS_CAPILLARY_REFILL_MIN_SEC,
  VITALS_CAPILLARY_REFILL_STEP,
  VITALS_HEART_RATE_MAX_BPM,
  VITALS_HEART_RATE_MIN_BPM,
  VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
  VITALS_NOTES_MAX_LENGTH,
  VITALS_PAIN_SCORE_MAX,
  VITALS_PAIN_SCORE_MIN,
  VITALS_RESPIRATORY_RATE_MAX_BPM,
  VITALS_RESPIRATORY_RATE_MIN_BPM,
  VITALS_TEMPERATURE_MAX_C,
  VITALS_TEMPERATURE_MIN_C,
  VITALS_TEMPERATURE_STEP,
  VITALS_WEIGHT_MAX_KG,
  VITALS_WEIGHT_MIN_KG,
  VITALS_WEIGHT_STEP,
  isVitalsOptionalBodyConditionInputValid,
  isVitalsOptionalCapillaryRefillInputValid,
  isVitalsOptionalHeartRateInputValid,
  isVitalsOptionalPainScoreInputValid,
  isVitalsOptionalRespiratoryRateInputValid,
  isVitalsOptionalTemperatureInputValid,
  isVitalsOptionalTextInputValid,
  isVitalsOptionalWeightInputValid,
} from "@/lib/records/vitals-policy";
import { PATIENT_SPECIES_EMOJI } from "@/lib/patients/species";
import {
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  kilogramsToPounds,
  poundsToKilograms,
  roundClinicalMeasurement,
  type BodyConditionScale,
  type MeasurementSystem,
} from "@/lib/ambulatory-workspace";

function PatientChartChunkLoading() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 h-5 w-32 animate-pulse rounded bg-muted" />
      <div className="h-64 w-full animate-pulse rounded bg-muted" />
    </div>
  );
}

const WeightTrendChart = dynamic(
  () =>
    import("@/components/patients/patient-trend-charts").then(
      (mod) => mod.WeightTrendChart,
    ),
  {
    ssr: false,
    loading: PatientChartChunkLoading,
  },
);

const VitalsTrendChart = dynamic(
  () =>
    import("@/components/patients/patient-trend-charts").then(
      (mod) => mod.VitalsTrendChart,
    ),
  {
    ssr: false,
    loading: PatientChartChunkLoading,
  },
);

const speciesEmoji: Record<string, string> = PATIENT_SPECIES_EMOJI;

function formatSex(sex: string | null): string {
  if (!sex) return "Unknown";
  const labels: Record<string, string> = {
    male: "Male (Intact)",
    female: "Female (Intact)",
    male_neutered: "Male (Neutered)",
    female_spayed: "Female (Spayed)",
  };
  return labels[sex] ?? sex;
}

function calculateAge(dob: string | null): string {
  if (!dob) return "Unknown";
  const birth = new Date(dob);
  const now = new Date();
  const years = now.getFullYear() - birth.getFullYear();
  const months = now.getMonth() - birth.getMonth();
  const adjustedMonths = months < 0 ? months + 12 : months;
  const adjustedYears = months < 0 ? years - 1 : years;

  if (adjustedYears === 0) {
    return `${adjustedMonths} month${adjustedMonths !== 1 ? "s" : ""}`;
  }
  if (adjustedMonths === 0) {
    return `${adjustedYears} year${adjustedYears !== 1 ? "s" : ""}`;
  }
  return `${adjustedYears}y ${adjustedMonths}m`;
}

type Tab =
  | "overview"
  | "records"
  | "documents"
  | "appointments"
  | "weight"
  | "vitals"
  | "vaccinations"
  | "invoices";

const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "records", label: "Medical Records" },
  { id: "documents", label: "Documents" },
  { id: "appointments", label: "Appointments" },
  { id: "weight", label: "Weight History" },
  { id: "vitals", label: "Vitals" },
  { id: "vaccinations", label: "Vaccinations" },
  { id: "invoices", label: "Invoices" },
];

function canManagePatientDetailRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function canRecordVitalsRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian" || role === "technician";
}

function canCorrectClinicalRecordRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

function canEditVaccinationCertificateRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian" || role === "technician";
}

function canSearchPatientHistoryRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "viewer"
  );
}

type VitalsFormState = {
  temperatureC: string;
  heartRateBpm: string;
  respiratoryRateBpm: string;
  weightKg: string;
  bodyConditionScore: string;
  painScore: string;
  mucousMembrane: string;
  capillaryRefillSec: string;
  notes: string;
};

function initialVitalsForm(): VitalsFormState {
  return {
    temperatureC: "",
    heartRateBpm: "",
    respiratoryRateBpm: "",
    weightKg: "",
    bodyConditionScore: "",
    painScore: "",
    mucousMembrane: "",
    capillaryRefillSec: "",
    notes: "",
  };
}

function canonicalMeasurementInput(
  value: string,
  converter: ((value: number) => number) | undefined,
  scale: number,
): string {
  const trimmed = value.trim();
  if (!trimmed || !converter) return trimmed;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;
  return String(roundClinicalMeasurement(converter(parsed), scale));
}

function formatClinicalTemperature(
  value: number | string | null | undefined,
  measurementSystem: MeasurementSystem,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return measurementSystem === "us_customary"
    ? `${roundClinicalMeasurement(celsiusToFahrenheit(parsed))} F`
    : `${roundClinicalMeasurement(parsed)} C`;
}

function formatClinicalWeight(
  value: number | string | null | undefined,
  measurementSystem: MeasurementSystem,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return measurementSystem === "us_customary"
    ? `${roundClinicalMeasurement(kilogramsToPounds(parsed))} lb`
    : `${roundClinicalMeasurement(parsed, 3)} kg`;
}

function PatientDetailErrorPanel({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}

function PatientDetailLoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export default function PatientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: session } = useSession();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [fieldVisitLocationId, setFieldVisitLocationId] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoUploadAttemptRef = useRef<ManagedUploadAttempt | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const canManagePatientDetail = canManagePatientDetailRole(
    session?.user?.role,
  );
  const canRecordVitals = canRecordVitalsRole(session?.user?.role);
  const canCorrectClinicalRecords = canCorrectClinicalRecordRole(
    session?.user?.role,
  );
  const canEditVaccinationCertificate = canEditVaccinationCertificateRole(
    session?.user?.role,
  );
  const canSearchPatientHistory = canSearchPatientHistoryRole(
    session?.user?.role,
  );

  const {
    data: patient,
    isLoading,
    error,
  } = trpc.patients.getById.useQuery(
    { id: params.id },
    { enabled: !!params.id },
  );
  const canonicalPatientId = patient?.id ?? params.id;
  const refreshPatientDetail = () =>
    Promise.all(
      Array.from(new Set([params.id, canonicalPatientId])).map((id) =>
        utils.patients.getById.invalidate({ id }),
      ),
    );

  useEffect(() => {
    if (!patient?.mergeMetadata || patient.id === params.id) return;
    window.history.replaceState(
      window.history.state,
      "",
      `/patients/${patient.id}?mergedFrom=${params.id}`,
    );
  }, [params.id, patient?.id, patient?.mergeMetadata]);
  const {
    data: recordsSettings,
    isLoading: recordsSettingsLoading,
    error: recordsSettingsError,
  } = trpc.records.settings.useQuery();
  const ambulatoryEnabled =
    recordsSettings?.ambulatoryWorkspace.enabled === true;
  const chartMeasurementSystem =
    recordsSettings?.ambulatoryWorkspace.measurementSystem ?? "metric";
  const chartBodyConditionScale =
    recordsSettings?.ambulatoryWorkspace.bodyConditionScale ?? 9;
  const fieldVisitLocationsQuery = trpc.appointments.listLocations.useQuery(
    undefined,
    {
      enabled:
        ambulatoryEnabled && canRecordVitals && patient?.status === "active",
    },
  );

  async function uploadPatientPhoto(selectedFile?: File) {
    if (!canManagePatientDetail) {
      return;
    }

    if (selectedFile && !isImageUploadFileValid(selectedFile)) {
      photoUploadAttemptRef.current = null;
      setPhotoUploadError(null);
      toast.error(IMAGE_UPLOAD_POLICY_MESSAGE);
      return;
    }

    if (selectedFile) {
      photoUploadAttemptRef.current = selectManagedUploadFile(
        photoUploadAttemptRef.current,
        selectedFile,
      );
    }
    const attempt = photoUploadAttemptRef.current;
    if (!attempt) return;

    const formData = new FormData();
    formData.append("file", attempt.file);
    formData.append("category", "patient-photos");
    formData.append("patientId", canonicalPatientId);

    setUploadingPhoto(true);
    setPhotoUploadError(null);
    try {
      const res = await fetchWithClientTimeout(
        "/api/upload",
        {
          method: "POST",
          body: formData,
          headers: { "Idempotency-Key": attempt.idempotencyKey },
        },
        CLIENT_UPLOAD_TIMEOUT_MS,
      );

      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        photoUploadAttemptRef.current = settleManagedUploadAttempt(attempt, {
          kind: "response",
          status: res.status,
        });
        throw new Error(json.error ?? "Upload failed");
      }

      photoUploadAttemptRef.current = settleManagedUploadAttempt(attempt, {
        kind: "success",
      });
      await refreshPatientDetail();
      toast.success("Patient photo updated");
    } catch (err) {
      if (photoUploadAttemptRef.current === attempt) {
        photoUploadAttemptRef.current = settleManagedUploadAttempt(attempt, {
          kind: "ambiguous",
        });
      }
      const message =
        err instanceof Error ? err.message : "Failed to upload photo";
      setPhotoUploadError(message);
      toast.error(message);
    } finally {
      setUploadingPhoto(false);
    }
  }

  function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.currentTarget.value = "";
    if (file) void uploadPatientPhoto(file);
  }

  // These sources power the ambulatory snapshot and fail closed together. SOAP
  // history remains lazy until a full medical summary is requested.
  const problemsQuery = trpc.records.listProblems.useQuery(
    { patientId: canonicalPatientId },
    { enabled: ambulatoryEnabled },
  );
  const vaccinationsQuery = trpc.records.listVaccinations.useQuery(
    { patientId: canonicalPatientId },
    { enabled: ambulatoryEnabled },
  );
  const snapshotVitalsQuery = trpc.vitals.listByPatient.useQuery(
    { patientId: canonicalPatientId, limit: 50 },
    { enabled: ambulatoryEnabled },
  );
  const soapNotesQuery = trpc.records.listSoapNotes.useQuery(
    { patientId: canonicalPatientId },
    { enabled: false },
  );
  const prescriptionsQuery = trpc.records.listPrescriptions.useQuery(
    { patientId: canonicalPatientId },
    { enabled: ambulatoryEnabled },
  );
  const recentVisitsQuery = trpc.appointments.listByPatient.useQuery(
    { patientId: canonicalPatientId, limit: 5 },
    { enabled: ambulatoryEnabled },
  );
  const recordsSettingsMissing =
    !recordsSettingsLoading && !recordsSettingsError && !recordsSettings;
  const verifiedRecordsSettings =
    recordsSettingsError || recordsSettingsMissing || !recordsSettings
      ? null
      : recordsSettings;
  const recordsSettingsTimeZone = verifiedRecordsSettings
    ? verifiedRecordsSettings.timezone
    : undefined;
  const weightTrend = useMemo(
    () => buildWeightTrend(patient?.weights ?? [], recordsSettingsTimeZone),
    [patient?.weights, recordsSettingsTimeZone],
  );
  const [weightKg, setWeightKg] = useState("");
  const canonicalPatientWeight = canonicalMeasurementInput(
    weightKg,
    chartMeasurementSystem === "us_customary" ? poundsToKilograms : undefined,
    3,
  );
  const addWeight = trpc.patients.addWeight.useMutation({
    onSuccess: () => {
      toast.success("Weight recorded");
      void refreshPatientDetail();
      setWeightKg("");
    },
    onError: (err) => toast.error(err.message),
  });
  const canSubmitWeight =
    canManagePatientDetail &&
    isPatientWeightInputValid(canonicalPatientWeight) &&
    !addWeight.isPending;

  function handleRecordWeight(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmitWeight || !patient) return;
    addWeight.mutate({
      patientId: patient.id,
      weightKg: canonicalPatientWeight,
    });
  }

  // Allergies: recorded here feed the alert bar, prescription safety
  // warnings, the portal, and PDF summaries.
  const [showAllergyForm, setShowAllergyForm] = useState(false);
  const [allergyName, setAllergyName] = useState("");
  const [allergySeverity, setAllergySeverity] = useState<
    "mild" | "moderate" | "severe"
  >("moderate");
  const [allergyReaction, setAllergyReaction] = useState("");
  const addAllergy = trpc.patients.addAllergy.useMutation({
    onSuccess: () => {
      toast.success("Allergy recorded");
      void refreshPatientDetail();
      setAllergyName("");
      setAllergyReaction("");
      setAllergySeverity("moderate");
      setShowAllergyForm(false);
    },
    onError: (err) => toast.error(err.message),
  });
  const startFieldVisit = trpc.appointments.startFieldVisit.useMutation({
    onSuccess: ({ appointment, created }) => {
      toast.success(
        created ? "Field visit started" : "Open field visit resumed",
      );
      router.push(`/encounters/${appointment.id}`);
    },
    onError: (err) => toast.error(err.message),
  });
  const correctAllergy = trpc.patients.markAllergyEnteredInError.useMutation({
    onSuccess: () => {
      toast.success("Allergy correction recorded");
      void refreshPatientDetail();
    },
    onError: (err) => toast.error(err.message),
  });
  const canSubmitAllergy =
    canManagePatientDetail &&
    allergyName.trim().length > 0 &&
    !addAllergy.isPending;

  function handleAddAllergy(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmitAllergy || !patient) return;
    addAllergy.mutate({
      patientId: patient.id,
      allergen: allergyName.trim(),
      severity: allergySeverity,
      reaction: allergyReaction.trim() || undefined,
    });
  }

  const loadError = error ?? recordsSettingsError;
  const isPageLoading = !loadError && (isLoading || recordsSettingsLoading);

  if (isPageLoading) {
    return <PatientDetailLoadingPanel label="Loading patient..." />;
  }

  if (
    loadError ||
    recordsSettingsMissing ||
    !verifiedRecordsSettings ||
    !patient
  ) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Unable to load patient"
        description={
          loadError?.message ??
          (recordsSettingsMissing || !verifiedRecordsSettings
            ? "Unable to load clinical settings. Please retry."
            : "Choose a patient from the Patients list before opening the detail page.")
        }
        action={{
          label: "Back to Patients",
          onClick: () => router.push("/patients"),
          icon: ArrowLeft,
        }}
      />
    );
  }

  const patientData = patient;
  const recordsTimeZone = verifiedRecordsSettings.timezone;
  const recordsPracticeName =
    verifiedRecordsSettings.name ?? "Veterinary Practice";
  const recordsPracticePhone = verifiedRecordsSettings.phone;
  const ambulatoryProfile = verifiedRecordsSettings.ambulatoryWorkspace;
  const fieldVisitLocations = fieldVisitLocationsQuery.data ?? [];
  const fieldVisitLocationsMissing =
    !fieldVisitLocationsQuery.isLoading &&
    !fieldVisitLocationsQuery.error &&
    !fieldVisitLocationsQuery.data;
  const selectedFieldVisitLocationId =
    fieldVisitLocations.length === 1
      ? fieldVisitLocations[0]!.id
      : fieldVisitLocations.some(
            (location) => location.id === fieldVisitLocationId,
          )
        ? fieldVisitLocationId
        : "";
  const fieldVisitLocationsUnavailable =
    fieldVisitLocationsQuery.isLoading ||
    Boolean(fieldVisitLocationsQuery.error) ||
    fieldVisitLocationsMissing ||
    fieldVisitLocations.length === 0;
  const activeProblems = (problemsQuery.data ?? []).filter(
    (problem) => problem.status === "active",
  );
  const activePrescriptions = (prescriptionsQuery.data ?? []).filter(
    (prescription) => prescription.effectiveStatus === "active",
  );
  const latestWeightKg = patient.weights[0]?.weightKg;
  const latestWeight = latestWeightKg
    ? ambulatoryProfile.measurementSystem === "us_customary"
      ? `${roundClinicalMeasurement(kilogramsToPounds(Number(latestWeightKg)))} lb`
      : `${roundClinicalMeasurement(Number(latestWeightKg), 3)} kg`
    : "Not recorded";
  const latestVisit = recentVisitsQuery.data?.[0];
  const latestSnapshotVitals = snapshotVitalsQuery.data?.find(
    (vital) => !vital.correctionId,
  );
  const latestSnapshotBcs = snapshotVitalsQuery.data?.find(
    (vital) => !vital.correctionId && vital.bodyConditionScore !== null,
  );
  const latestVitalsSummary = latestSnapshotVitals
    ? [
        latestSnapshotVitals.temperatureC != null
          ? formatClinicalTemperature(
              latestSnapshotVitals.temperatureC,
              ambulatoryProfile.measurementSystem,
            )
          : null,
        latestSnapshotVitals.heartRateBpm != null
          ? "HR " + latestSnapshotVitals.heartRateBpm
          : null,
        latestSnapshotVitals.respiratoryRateBpm != null
          ? "RR " + latestSnapshotVitals.respiratoryRateBpm
          : null,
        latestSnapshotVitals.weightKg != null
          ? formatClinicalWeight(
              latestSnapshotVitals.weightKg,
              ambulatoryProfile.measurementSystem,
            )
          : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ") || "Recorded without summary values"
    : "None recorded";
  const currentVaccinations = (vaccinationsQuery.data ?? []).filter(
    (vaccination) => !vaccination.correctionId,
  );
  const nextVaccinationDueDate = currentVaccinations
    .flatMap((vaccination) =>
      vaccination.nextDueDate ? [vaccination.nextDueDate] : [],
    )
    .sort()[0];
  const vaccinationSummary = currentVaccinations.length
    ? String(currentVaccinations.length) +
      " recorded" +
      (nextVaccinationDueDate
        ? " · next due " +
          formatClinicalDate(nextVaccinationDueDate, recordsTimeZone)
        : " · no due date recorded")
    : "None recorded";

  async function handleDownloadSummary() {
    try {
      const [
        problemsResult,
        vaccinationsResult,
        soapNotesResult,
        prescriptionsResult,
      ] = await Promise.all([
        problemsQuery.refetch(),
        vaccinationsQuery.refetch(),
        soapNotesQuery.refetch(),
        prescriptionsQuery.refetch(),
      ]);

      const summaryError =
        problemsResult.error ??
        vaccinationsResult.error ??
        soapNotesResult.error ??
        prescriptionsResult.error;
      if (summaryError) {
        throw summaryError;
      }
      if (
        !problemsResult.data ||
        !vaccinationsResult.data ||
        !soapNotesResult.data ||
        !prescriptionsResult.data
      ) {
        throw new Error(
          "Unable to load complete medical summary data. Please retry.",
        );
      }

      const problems = problemsResult.data;
      const vaccinations = vaccinationsResult.data;
      const soapNotes = soapNotesResult.data;
      const prescriptions = prescriptionsResult.data;
      const { generateMedicalSummaryPdf } = await import("@/lib/pdf");

      generateMedicalSummaryPdf({
        practiceName: recordsPracticeName,
        practicePhone: recordsPracticePhone ?? undefined,
        patientName: patientData.name,
        species: patientData.species ?? "Unknown",
        breed: patientData.breed ?? undefined,
        sex: patientData.sex ?? undefined,
        dob: patientData.dob ?? undefined,
        color: patientData.color ?? undefined,
        microchip: patientData.microchipNumber ?? undefined,
        clientName: [patientData.clientFirstName, patientData.clientLastName]
          .filter(Boolean)
          .join(" "),
        allergies: (patientData.allergies ?? []).map((a) => ({
          allergen: a.allergen,
          severity: a.severity ?? "unknown",
          reaction: a.reaction ?? undefined,
        })),
        problems: problems.map((p) => ({
          description: p.description,
          status: p.status ?? "active",
          onsetDate: p.onsetDate ?? undefined,
        })),
        vaccinations: vaccinations
          .filter((v) => !v.correctionId)
          .map((v) => ({
            name: v.vaccineName,
            date: v.administeredAt
              ? formatClinicalDate(v.administeredAt, recordsTimeZone, "Unknown")
              : "Unknown",
            nextDue: v.nextDueDate
              ? formatClinicalDate(v.nextDueDate, recordsTimeZone)
              : undefined,
          })),
        recentNotes: soapNotes
          .filter((note) => note.status === "finalized" && !note.correctionId)
          .slice(0, 5)
          .map((n) => ({
            date: n.createdAt
              ? formatClinicalDate(n.createdAt, recordsTimeZone, "Unknown")
              : "Unknown",
            subjective: n.subjective ?? undefined,
            objective: n.objective ?? undefined,
            assessment: n.assessment ?? undefined,
            plan: n.plan ?? undefined,
            imported: n.imported,
            authorName: n.authorName,
            finalizerName: n.finalizerName ?? undefined,
            finalizedAt: n.finalizedAt
              ? formatClinicalDateTime(n.finalizedAt, recordsTimeZone)
              : undefined,
            replacementForLabel: n.replacesSoapNoteId
              ? `SOAP note dated ${formatClinicalDate(
                  soapNotes.find((source) => source.id === n.replacesSoapNoteId)
                    ?.createdAt,
                  recordsTimeZone,
                  "unknown date",
                )}`
              : undefined,
            addenda: n.addenda.map((addendum) => ({
              content: soapSectionText(addendum.content),
              authorName: addendum.authorName,
              createdAt: formatClinicalDateTime(
                addendum.createdAt,
                recordsTimeZone,
              ),
            })),
          })),
        recordCorrections: [
          ...(patientData.allergyHistory ?? [])
            .filter(
              (allergy) =>
                Boolean(allergy.correctionId) &&
                Boolean(allergy.correctionReason) &&
                Boolean(allergy.correctedAt),
            )
            .map((allergy) => ({
              recordLabel: `Allergy “${allergy.allergen}” recorded ${formatClinicalDate(
                allergy.notedAt,
                recordsTimeZone,
                "Unknown date",
              )}`,
              reason: allergy.correctionReason ?? "Reason unavailable",
              correctedByName: allergy.correctedByName ?? "Unknown clinician",
              correctedAt: allergy.correctedAt
                ? formatClinicalDateTime(allergy.correctedAt, recordsTimeZone)
                : "Unknown time",
            })),
          ...soapNotes
            .filter(
              (note) =>
                note.status === "finalized" && Boolean(note.correctionId),
            )
            .map((note) => ({
              recordLabel: `SOAP note dated ${formatClinicalDate(
                note.createdAt,
                recordsTimeZone,
                "Unknown date",
              )}`,
              reason: note.correctionReason ?? "Reason unavailable",
              correctedByName: note.correctedByName ?? "Unknown clinician",
              correctedAt: note.correctedAt
                ? formatClinicalDateTime(note.correctedAt, recordsTimeZone)
                : "Unknown time",
              replacementLabel: note.replacementSoapNoteId
                ? (() => {
                    const replacement = soapNotes.find(
                      (candidate) =>
                        candidate.id === note.replacementSoapNoteId,
                    );
                    return replacement
                      ? `SOAP note dated ${formatClinicalDate(
                          replacement.createdAt,
                          recordsTimeZone,
                          "unknown date",
                        )}, finalized by ${replacement.finalizerName ?? "Unknown clinician"}`
                      : "Replacement SOAP retained in chart";
                  })()
                : undefined,
            })),
        ],
        prescriptions: prescriptions.map((rx) => ({
          medication: rx.medicationName,
          dosage: rx.dosage ?? "",
          frequency: rx.frequency ?? "",
          status: rx.effectiveStatus ?? "active",
        })),
        generatedDate: formatClinicalDate(new Date(), recordsTimeZone),
      }).save(`${patientData.name.replace(/\s+/g, "_")}_medical_summary.pdf`);

      toast.success("Medical summary downloaded");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to generate medical summary",
      );
    }
  }

  const statusColor =
    patient.status === "active"
      ? "bg-emerald-500"
      : patient.status === "deceased"
        ? "bg-gray-400"
        : "bg-amber-500";

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push("/patients")}
        className="mb-4"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Patients
      </Button>

      <RecentClinicalItems
        patientId={patient.id}
        enabled={ambulatoryProfile.enabled}
      />

      {patient.mergeMetadata ? (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <div className="flex items-start gap-3">
            <GitMerge className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">
                Opened the canonical chart for a merged patient identity
              </p>
              <p className="mt-1">
                {patient.mergeMetadata.sourceSnapshot.name} was merged into this
                chart by {patient.mergeMetadata.performedByName} on{" "}
                {formatClinicalDateTime(
                  patient.mergeMetadata.createdAt,
                  recordsTimeZone,
                )}
                .
              </p>
              <p className="mt-1 text-blue-800 dark:text-blue-200">
                Reason: {patient.mergeMetadata.reason}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Patient Header Card */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-4">
            <div className="space-y-1">
              <div className="group relative h-14 w-14">
                {patient.photoUrl ? (
                  <img
                    src={patient.photoUrl}
                    alt={patient.name}
                    className="h-14 w-14 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-2xl">
                    {speciesEmoji[patient.species ?? "other"] ?? "\uD83D\uDC3E"}
                  </div>
                )}
                {canManagePatientDetail && (
                  <>
                    <button
                      type="button"
                      disabled={uploadingPhoto}
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 disabled:cursor-wait"
                      title="Upload photo"
                    >
                      {uploadingPhoto ? (
                        <Loader2 className="h-5 w-5 animate-spin text-white" />
                      ) : (
                        <Camera className="h-5 w-5 text-white" />
                      )}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handlePhotoUpload}
                      className="hidden"
                    />
                  </>
                )}
              </div>
              {photoUploadError && photoUploadAttemptRef.current ? (
                <button
                  type="button"
                  disabled={uploadingPhoto}
                  onClick={() => void uploadPatientPhoto()}
                  className="whitespace-nowrap text-xs font-medium text-destructive underline underline-offset-2 disabled:opacity-50"
                >
                  Try photo again
                </button>
              ) : null}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-heading text-xl font-semibold">
                  {patient.name}
                </h2>
                <span
                  className={cn(
                    "inline-block h-2.5 w-2.5 rounded-full",
                    statusColor,
                  )}
                  title={patient.status ?? "active"}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {patient.species &&
                  patient.species.charAt(0).toUpperCase() +
                    patient.species.slice(1)}
                {patient.breed ? ` \u00B7 ${patient.breed}` : ""}
                {" \u00B7 "}
                {calculateAge(patient.dob)}
                {" \u00B7 "}
                {formatSex(patient.sex)}
              </p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {patient.color && <span>Color: {patient.color}</span>}
                {patient.microchipNumber && (
                  <span>Microchip: {patient.microchipNumber}</span>
                )}
              </div>
              {patient.clientFirstName && (
                <button
                  onClick={() => router.push(`/clients/${patient.clientId}`)}
                  className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <User className="h-3.5 w-3.5" />
                  {patient.clientFirstName} {patient.clientLastName}
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {verifiedRecordsSettings.ambulatoryWorkspace.enabled &&
            canRecordVitals &&
            patient.status === "active" ? (
              <div className="flex flex-col items-end gap-1">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {fieldVisitLocations.length > 1 ? (
                    <label>
                      <span className="sr-only">Field visit location</span>
                      <select
                        aria-label="Field visit location"
                        value={selectedFieldVisitLocationId}
                        disabled={
                          fieldVisitLocationsUnavailable ||
                          startFieldVisit.isPending
                        }
                        onChange={(event) =>
                          setFieldVisitLocationId(event.target.value)
                        }
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="">Select location...</option>
                        {fieldVisitLocations.map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={
                      startFieldVisit.isPending ||
                      fieldVisitLocationsUnavailable ||
                      !selectedFieldVisitLocationId
                    }
                    onClick={() => {
                      if (!selectedFieldVisitLocationId) return;
                      startFieldVisit.mutate({
                        patientId: patient.id,
                        locationId: selectedFieldVisitLocationId,
                      });
                    }}
                  >
                    {startFieldVisit.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Stethoscope className="mr-2 h-4 w-4" />
                    )}
                    {startFieldVisit.isPending
                      ? "Starting visit..."
                      : "Start field visit"}
                  </Button>
                </div>
                {fieldVisitLocationsQuery.error ||
                fieldVisitLocationsMissing ||
                (!fieldVisitLocationsQuery.isLoading &&
                  fieldVisitLocations.length === 0) ? (
                  <p className="max-w-xs text-right text-xs text-destructive">
                    {fieldVisitLocationsQuery.error?.message ??
                      "Add an active location before starting a field visit."}
                  </p>
                ) : fieldVisitLocations.length > 1 &&
                  !selectedFieldVisitLocationId ? (
                  <p className="text-xs text-muted-foreground">
                    Choose where this field visit is managed.
                  </p>
                ) : null}
              </div>
            ) : null}
            {canManagePatientDetail && (
              <>
                <CapturePhotos patientId={patient.id} />
                <ConsentSign patientId={patient.id} />
              </>
            )}
            <Button variant="outline" size="sm" onClick={handleDownloadSummary}>
              <FileDown className="mr-2 h-4 w-4" />
              Download Summary
            </Button>
            {canManagePatientDetail && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push(`/patients/${patient.id}/edit`)}
              >
                Edit
              </Button>
            )}
          </div>
        </div>
      </div>

      {ambulatoryProfile.enabled ? (
        <section className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Patient snapshot</h3>
              <p className="text-xs text-muted-foreground">
                The field essentials before treatment begins.
              </p>
            </div>
            <span className="text-xs font-medium text-muted-foreground">
              Latest weight: {latestWeight}
            </span>
          </div>
          {problemsQuery.isLoading ||
          prescriptionsQuery.isLoading ||
          recentVisitsQuery.isLoading ||
          snapshotVitalsQuery.isLoading ||
          vaccinationsQuery.isLoading ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading clinical snapshot...
            </div>
          ) : problemsQuery.error ||
            prescriptionsQuery.error ||
            recentVisitsQuery.error ||
            snapshotVitalsQuery.error ||
            vaccinationsQuery.error ||
            !problemsQuery.data ||
            !prescriptionsQuery.data ||
            !recentVisitsQuery.data ||
            !snapshotVitalsQuery.data ||
            !vaccinationsQuery.data ? (
            <p className="mt-3 text-sm text-destructive">
              The complete clinical snapshot could not be verified. Open the
              chart sections below before relying on history.
            </p>
          ) : (
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-6">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Allergies
                </dt>
                <dd className="mt-1">
                  {patient.allergies.length
                    ? patient.allergies
                        .map((allergy) => allergy.allergen)
                        .join(", ")
                    : "None recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Active problems
                </dt>
                <dd className="mt-1">
                  {activeProblems.length
                    ? activeProblems
                        .map((problem) => problem.description)
                        .join(", ")
                    : "None recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Active medications
                </dt>
                <dd className="mt-1">
                  {activePrescriptions.length
                    ? activePrescriptions
                        .map((prescription) => prescription.medicationName)
                        .join(", ")
                    : "None recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Last visit
                </dt>
                <dd className="mt-1">
                  {latestVisit
                    ? `${formatClinicalDate(latestVisit.startTime, recordsTimeZone)} · ${latestVisit.origin === "field" ? "Field visit" : (latestVisit.typeName ?? "Appointment")}`
                    : "No prior visits"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Latest vitals
                </dt>
                <dd className="mt-1">{latestVitalsSummary}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  BCS / vaccines
                </dt>
                <dd className="mt-1">
                  BCS{" "}
                  {latestSnapshotBcs?.bodyConditionScore !== null &&
                  latestSnapshotBcs?.bodyConditionScore !== undefined ? (
                    <>
                      {latestSnapshotBcs.bodyConditionScore} /{" "}
                      {latestSnapshotBcs.bodyConditionScale}
                    </>
                  ) : (
                    "not recorded"
                  )}
                  {" · "}
                  {vaccinationSummary}
                </dd>
              </div>
            </dl>
          )}
        </section>
      ) : null}

      {/* Allergy Alert Bar */}
      {patient.allergies && patient.allergies.length > 0 ? (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-red-800 dark:text-red-300">
              Allergies
            </p>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {patient.allergies.map((allergy) => (
                <div
                  key={allergy.id}
                  className={cn(
                    "rounded-md border px-3 py-2 text-sm",
                    allergy.severity === "severe"
                      ? "border-red-300 bg-red-100 text-red-900 dark:border-red-800 dark:bg-red-950/60 dark:text-red-100"
                      : allergy.severity === "moderate"
                        ? "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100"
                        : "border-yellow-300 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-100",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{allergy.allergen}</span>
                    <span className="text-xs font-semibold uppercase tracking-wide">
                      {allergy.severity}
                    </span>
                  </div>
                  <p className="mt-1 text-xs">
                    Reaction: {allergy.reaction || "Not documented"}
                  </p>
                  <ClinicalCorrectionControl
                    correction={null}
                    canCorrect={canCorrectClinicalRecords}
                    isPending={correctAllergy.isPending}
                    triggerLabel="Mark allergy entered in error"
                    description="The original allergy and this permanent reason remain in staff chart history. The allergy will stop feeding current alerts, prescription safety, AI context, PDF summaries, and the client portal."
                    timeZone={recordsTimeZone}
                    onCorrect={(reason) =>
                      correctAllergy.mutateAsync({
                        patientId: patient.id,
                        recordId: allergy.id,
                        reason,
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {canManagePatientDetail && !showAllergyForm ? (
                <button
                  type="button"
                  onClick={() => setShowAllergyForm(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-red-300 px-2.5 py-0.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              ) : null}
            </div>
            {showAllergyForm ? (
              <AllergyForm
                allergyName={allergyName}
                setAllergyName={setAllergyName}
                allergySeverity={allergySeverity}
                setAllergySeverity={setAllergySeverity}
                allergyReaction={allergyReaction}
                setAllergyReaction={setAllergyReaction}
                canSubmit={canSubmitAllergy}
                isPending={addAllergy.isPending}
                onSubmit={handleAddAllergy}
                onCancel={() => setShowAllergyForm(false)}
              />
            ) : null}
          </div>
        </div>
      ) : canManagePatientDetail ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
          {showAllergyForm ? (
            <AllergyForm
              allergyName={allergyName}
              setAllergyName={setAllergyName}
              allergySeverity={allergySeverity}
              setAllergySeverity={setAllergySeverity}
              allergyReaction={allergyReaction}
              setAllergyReaction={setAllergyReaction}
              canSubmit={canSubmitAllergy}
              isPending={addAllergy.isPending}
              onSubmit={handleAddAllergy}
              onCancel={() => setShowAllergyForm(false)}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>No known allergies recorded.</span>
              <button
                type="button"
                onClick={() => setShowAllergyForm(true)}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                <Plus className="h-3.5 w-3.5" />
                Add allergy
              </button>
            </div>
          )}
        </div>
      ) : null}

      {patient.allergyHistory.some(
        (allergy) =>
          Boolean(allergy.correctionId) || Boolean(allergy.deletedAt),
      ) ? (
        <details className="mt-3 rounded-lg border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Allergy correction history
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {patient.allergyHistory
              .filter(
                (allergy) =>
                  Boolean(allergy.correctionId) || Boolean(allergy.deletedAt),
              )
              .map((allergy) => (
                <div
                  key={allergy.id}
                  className="rounded-md border border-border bg-muted/20 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{allergy.allergen}</span>
                    <span className="text-xs uppercase text-muted-foreground">
                      {allergy.severity}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Reaction: {allergy.reaction || "Not documented"}
                  </p>
                  {allergy.correctionId &&
                  allergy.correctionReason &&
                  allergy.correctedAt ? (
                    <ClinicalCorrectionControl
                      correction={{
                        id: allergy.correctionId,
                        reason: allergy.correctionReason,
                        correctedAt: allergy.correctedAt,
                        correctedByName: allergy.correctedByName,
                      }}
                      canCorrect={false}
                      isPending={false}
                      onCorrect={async () => undefined}
                      timeZone={recordsTimeZone}
                    />
                  ) : (
                    <div className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                      Legacy removal retained. This predates permanent allergy
                      correction attribution, so no reason or clinician is
                      available.
                    </div>
                  )}
                </div>
              ))}
          </div>
        </details>
      ) : null}

      {/* Tab Navigation */}
      <div className="mt-6 overflow-x-auto border-b border-border">
        <div
          role="tablist"
          aria-label="Patient chart sections"
          className="flex min-w-max gap-0"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              id={`patient-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`patient-panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "relative min-h-11 px-4 py-2.5 text-sm font-medium transition-colors",
                activeTab === tab.id
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div
        id={`patient-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`patient-tab-${activeTab}`}
        className="mt-6"
      >
        {activeTab === "overview" && (
          <div className="rounded-lg border border-border bg-card p-6">
            <h3 className="font-heading text-base font-semibold mb-4">
              Basic Information
            </h3>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">Name</dt>
                <dd className="mt-0.5 text-sm font-medium">{patient.name}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Species</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {patient.species
                    ? patient.species.charAt(0).toUpperCase() +
                      patient.species.slice(1)
                    : "\u2014"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Breed</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {patient.breed || "\u2014"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Sex</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {formatSex(patient.sex)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Date of Birth</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {formatClinicalDate(patient.dob, recordsTimeZone, "\u2014")}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Age</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {calculateAge(patient.dob)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Color</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {patient.color || "\u2014"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Microchip Number
                </dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {patient.microchipNumber || "\u2014"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Status</dt>
                <dd className="mt-0.5 text-sm font-medium capitalize">
                  {patient.status ?? "active"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Owner</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {patient.clientFirstName
                    ? `${patient.clientFirstName} ${patient.clientLastName}`
                    : "\u2014"}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {activeTab === "weight" && (
          <div className="space-y-6">
            {canManagePatientDetail && (
              <form
                onSubmit={handleRecordWeight}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="w-full sm:max-w-xs">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Weight (
                      {chartMeasurementSystem === "us_customary" ? "lb" : "kg"})
                    </label>
                    <input
                      type="number"
                      min={
                        chartMeasurementSystem === "us_customary"
                          ? roundClinicalMeasurement(
                              kilogramsToPounds(PATIENT_WEIGHT_MIN_KG),
                              3,
                            )
                          : PATIENT_WEIGHT_MIN_KG
                      }
                      max={
                        chartMeasurementSystem === "us_customary"
                          ? roundClinicalMeasurement(
                              kilogramsToPounds(PATIENT_WEIGHT_MAX_KG),
                              3,
                            )
                          : PATIENT_WEIGHT_MAX_KG
                      }
                      step={PATIENT_WEIGHT_STEP}
                      value={weightKg}
                      required
                      aria-invalid={
                        weightKg.trim().length > 0 &&
                        !isPatientWeightInputValid(canonicalPatientWeight)
                      }
                      onChange={(event) => setWeightKg(event.target.value)}
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <Button type="submit" disabled={!canSubmitWeight}>
                    {addWeight.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    {addWeight.isPending ? "Saving..." : "Record weight"}
                  </Button>
                </div>
              </form>
            )}

            {patient.weights && patient.weights.length > 0 ? (
              <>
                {chartMeasurementSystem === "metric" ? (
                  <WeightTrendChart data={weightTrend} />
                ) : null}
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50">
                        <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                          Date
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                          Weight (
                          {chartMeasurementSystem === "us_customary"
                            ? "lb"
                            : "kg"}
                          )
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                          Recorded By
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {patient.weights.map((weight) => (
                        <tr
                          key={weight.id}
                          className="border-b border-border last:border-0"
                        >
                          <td className="px-4 py-3">
                            {formatClinicalDate(
                              weight.recordedAt,
                              recordsTimeZone,
                              "\u2014",
                            )}
                          </td>
                          <td className="px-4 py-3 font-medium">
                            {formatClinicalWeight(
                              weight.weightKg,
                              chartMeasurementSystem,
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {weight.recordedBy ?? "\u2014"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <EmptyState icon={Activity} title="No weight records yet" />
            )}
          </div>
        )}

        {activeTab === "vitals" && (
          <VitalsTab
            patientId={patient.id}
            timeZone={recordsTimeZone}
            measurementSystem={chartMeasurementSystem}
            bodyConditionScale={chartBodyConditionScale}
            canRecordVitals={canRecordVitals}
            canCorrectClinicalRecords={canCorrectClinicalRecords}
          />
        )}

        {activeTab === "vaccinations" && (
          <VaccinationsTab
            patientId={patient.id}
            timeZone={recordsTimeZone}
            canCorrectClinicalRecords={canCorrectClinicalRecords}
            canPrepareCertificate={canManagePatientDetail}
            canEditCertificate={canEditVaccinationCertificate}
          />
        )}

        {activeTab === "records" && (
          <MedicalRecordsTab
            patientId={patient.id}
            timeZone={recordsTimeZone}
            canCorrectClinicalRecords={canCorrectClinicalRecords}
            canSearchPatientHistory={canSearchPatientHistory}
          />
        )}

        {activeTab === "documents" && (
          <DocumentsTab patientId={patient.id} timeZone={recordsTimeZone} />
        )}

        {activeTab === "appointments" && (
          <AppointmentsTab patientId={patient.id} timeZone={recordsTimeZone} />
        )}

        {activeTab === "invoices" && <InvoicesTab patientId={patient.id} />}
      </div>
    </div>
  );
}

function VitalsTab({
  patientId,
  timeZone,
  measurementSystem,
  bodyConditionScale,
  canRecordVitals,
  canCorrectClinicalRecords,
}: {
  patientId: string;
  timeZone?: string | null;
  measurementSystem: MeasurementSystem;
  bodyConditionScale: BodyConditionScale;
  canRecordVitals: boolean;
  canCorrectClinicalRecords: boolean;
}) {
  const utils = trpc.useUtils();
  const {
    data: vitals,
    isLoading,
    error,
  } = trpc.vitals.listByPatient.useQuery({ patientId });
  const vitalsMissing = !isLoading && !error && !vitals;
  const vitalTrend = useMemo(
    () =>
      buildVitalTrend(
        (vitals ?? []).filter((vital) => !vital.correctionId),
        timeZone,
      ),
    [vitals, timeZone],
  );
  const record = trpc.vitals.record.useMutation({
    onSuccess: () => {
      toast.success("Vitals recorded");
      utils.vitals.listByPatient.invalidate({ patientId });
      setForm(initialVitalsForm());
    },
    onError: (err) => toast.error(err.message),
  });
  const correctVital = trpc.vitals.markEnteredInError.useMutation({
    onSuccess: async () => {
      toast.success("Vital signs retained and marked entered in error");
      await utils.vitals.listByPatient.invalidate({ patientId });
    },
    onError: (err) => toast.error(err.message),
  });

  const [form, setForm] = useState<VitalsFormState>(() => initialVitalsForm());
  const set =
    (k: keyof VitalsFormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  const num = (v?: string) => {
    if (v === undefined || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const canonicalTemperature = canonicalMeasurementInput(
    form.temperatureC,
    measurementSystem === "us_customary" ? fahrenheitToCelsius : undefined,
    1,
  );
  const canonicalWeight = canonicalMeasurementInput(
    form.weightKg,
    measurementSystem === "us_customary" ? poundsToKilograms : undefined,
    3,
  );
  const hasVitalsFormContent = Object.values(form).some(
    (value) => value.trim().length > 0,
  );
  const canSubmitVitals =
    canRecordVitals &&
    hasVitalsFormContent &&
    isVitalsOptionalTemperatureInputValid(canonicalTemperature) &&
    isVitalsOptionalHeartRateInputValid(form.heartRateBpm) &&
    isVitalsOptionalRespiratoryRateInputValid(form.respiratoryRateBpm) &&
    isVitalsOptionalWeightInputValid(canonicalWeight) &&
    isVitalsOptionalBodyConditionInputValid(
      form.bodyConditionScore,
      bodyConditionScale,
    ) &&
    isVitalsOptionalPainScoreInputValid(form.painScore) &&
    isVitalsOptionalTextInputValid(
      form.mucousMembrane,
      VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
    ) &&
    isVitalsOptionalCapillaryRefillInputValid(form.capillaryRefillSec) &&
    isVitalsOptionalTextInputValid(form.notes, VITALS_NOTES_MAX_LENGTH) &&
    !record.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmitVitals) return;
    record.mutate({
      patientId,
      temperatureC: num(canonicalTemperature),
      heartRateBpm: num(form.heartRateBpm),
      respiratoryRateBpm: num(form.respiratoryRateBpm),
      weightKg: num(canonicalWeight),
      bodyConditionScore: num(form.bodyConditionScore),
      bodyConditionScale,
      painScore: num(form.painScore),
      mucousMembrane: form.mucousMembrane.trim() || undefined,
      capillaryRefillSec: num(form.capillaryRefillSec),
      notes: form.notes?.trim() || undefined,
    });
  }

  return (
    <div className="space-y-6">
      {canRecordVitals && (
        <form
          onSubmit={submit}
          className="rounded-lg border border-border bg-card p-4"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Temp ({measurementSystem === "us_customary" ? "F" : "C"})
              </label>
              <input
                type="number"
                min={
                  measurementSystem === "us_customary"
                    ? roundClinicalMeasurement(
                        celsiusToFahrenheit(VITALS_TEMPERATURE_MIN_C),
                      )
                    : VITALS_TEMPERATURE_MIN_C
                }
                max={
                  measurementSystem === "us_customary"
                    ? roundClinicalMeasurement(
                        celsiusToFahrenheit(VITALS_TEMPERATURE_MAX_C),
                      )
                    : VITALS_TEMPERATURE_MAX_C
                }
                step={VITALS_TEMPERATURE_STEP}
                value={form.temperatureC}
                aria-invalid={
                  !isVitalsOptionalTemperatureInputValid(canonicalTemperature)
                }
                onChange={set("temperatureC")}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                HR (bpm)
              </label>
              <input
                type="number"
                min={VITALS_HEART_RATE_MIN_BPM}
                max={VITALS_HEART_RATE_MAX_BPM}
                step={1}
                value={form.heartRateBpm}
                aria-invalid={
                  !isVitalsOptionalHeartRateInputValid(form.heartRateBpm)
                }
                onChange={set("heartRateBpm")}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                RR (bpm)
              </label>
              <input
                type="number"
                min={VITALS_RESPIRATORY_RATE_MIN_BPM}
                max={VITALS_RESPIRATORY_RATE_MAX_BPM}
                step={1}
                value={form.respiratoryRateBpm}
                aria-invalid={
                  !isVitalsOptionalRespiratoryRateInputValid(
                    form.respiratoryRateBpm,
                  )
                }
                onChange={set("respiratoryRateBpm")}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Weight ({measurementSystem === "us_customary" ? "lb" : "kg"})
              </label>
              <input
                type="number"
                min={
                  measurementSystem === "us_customary"
                    ? roundClinicalMeasurement(
                        kilogramsToPounds(VITALS_WEIGHT_MIN_KG),
                        3,
                      )
                    : VITALS_WEIGHT_MIN_KG
                }
                max={
                  measurementSystem === "us_customary"
                    ? Math.floor(kilogramsToPounds(VITALS_WEIGHT_MAX_KG))
                    : VITALS_WEIGHT_MAX_KG
                }
                step={VITALS_WEIGHT_STEP}
                value={form.weightKg}
                aria-invalid={
                  !isVitalsOptionalWeightInputValid(canonicalWeight)
                }
                onChange={set("weightKg")}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                BCS (1-{bodyConditionScale})
              </label>
              <input
                type="number"
                min={VITALS_BODY_CONDITION_MIN}
                max={bodyConditionScale}
                step={1}
                value={form.bodyConditionScore}
                aria-invalid={
                  !isVitalsOptionalBodyConditionInputValid(
                    form.bodyConditionScore,
                    bodyConditionScale,
                  )
                }
                onChange={set("bodyConditionScore")}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Pain (0-10)
              </label>
              <input
                type="number"
                min={VITALS_PAIN_SCORE_MIN}
                max={VITALS_PAIN_SCORE_MAX}
                step={1}
                value={form.painScore}
                aria-invalid={
                  !isVitalsOptionalPainScoreInputValid(form.painScore)
                }
                onChange={set("painScore")}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                CRT (sec)
              </label>
              <input
                type="number"
                min={VITALS_CAPILLARY_REFILL_MIN_SEC}
                max={VITALS_CAPILLARY_REFILL_MAX_SEC}
                step={VITALS_CAPILLARY_REFILL_STEP}
                value={form.capillaryRefillSec}
                aria-invalid={
                  !isVitalsOptionalCapillaryRefillInputValid(
                    form.capillaryRefillSec,
                  )
                }
                onChange={set("capillaryRefillSec")}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Mucous Membrane
              </label>
              <input
                type="text"
                value={form.mucousMembrane}
                maxLength={VITALS_MUCOUS_MEMBRANE_MAX_LENGTH}
                onChange={set("mucousMembrane")}
                placeholder="e.g. Pink and moist"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
          <input
            type="text"
            value={form.notes ?? ""}
            maxLength={VITALS_NOTES_MAX_LENGTH}
            onChange={set("notes")}
            placeholder="Notes (optional)"
            className="mt-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="mt-3 flex justify-end">
            <Button type="submit" disabled={!canSubmitVitals}>
              {record.isPending ? "Saving..." : "Record vitals"}
            </Button>
          </div>
        </form>
      )}

      {error ? (
        <PatientDetailErrorPanel
          message={`Unable to load vitals. ${error.message}`}
        />
      ) : vitalsMissing ? (
        <PatientDetailErrorPanel message="Unable to load vitals. Please retry." />
      ) : isLoading ? (
        <PatientDetailLoadingPanel label="Loading vitals..." />
      ) : !vitals || vitals.length === 0 ? (
        <EmptyState icon={Activity} title="No vitals recorded yet" />
      ) : (
        <>
          {measurementSystem === "metric" && bodyConditionScale === 9 ? (
            <VitalsTrendChart data={vitalTrend} />
          ) : null}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Temp</th>
                  <th className="px-3 py-2 font-medium">HR</th>
                  <th className="px-3 py-2 font-medium">RR</th>
                  <th className="px-3 py-2 font-medium">Weight</th>
                  <th className="px-3 py-2 font-medium">BCS</th>
                  <th className="px-3 py-2 font-medium">Pain</th>
                  <th className="px-3 py-2 font-medium">Chart status</th>
                </tr>
              </thead>
              <tbody>
                {vitals.map((v) => (
                  <tr
                    key={v.id}
                    className={cn(
                      "border-b border-border last:border-0",
                      v.correctionId && "bg-destructive/5",
                    )}
                  >
                    <td className="px-3 py-2">
                      {formatClinicalDateTime(v.recordedAt, timeZone, "—")}
                    </td>
                    <td className="px-3 py-2">
                      {formatClinicalTemperature(
                        v.temperatureC,
                        measurementSystem,
                      )}
                    </td>
                    <td className="px-3 py-2">{v.heartRateBpm ?? "—"}</td>
                    <td className="px-3 py-2">{v.respiratoryRateBpm ?? "—"}</td>
                    <td className="px-3 py-2">
                      {formatClinicalWeight(v.weightKg, measurementSystem)}
                    </td>
                    <td className="px-3 py-2">
                      {v.bodyConditionScore !== null ? (
                        <>
                          {v.bodyConditionScore} / {v.bodyConditionScale}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2">{v.painScore ?? "—"}</td>
                    <td className="min-w-64 px-3 py-2">
                      <ClinicalCorrectionControl
                        correction={
                          v.correctionId && v.correctionReason && v.correctedAt
                            ? {
                                id: v.correctionId,
                                reason: v.correctionReason,
                                correctedAt: v.correctedAt,
                                correctedByName: v.correctedByName,
                              }
                            : null
                        }
                        canCorrect={canCorrectClinicalRecords}
                        isPending={
                          correctVital.isPending &&
                          correctVital.variables?.recordId === v.id
                        }
                        onCorrect={(reason) =>
                          correctVital.mutateAsync({
                            patientId,
                            recordId: v.id,
                            reason,
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

type VaccinationCertificateEditor = {
  id: string;
  expectedUpdatedAt: string;
  productName: string;
  manufacturer: string;
  lotNumber: string;
  productExpirationDate: string;
  doseType: "" | "initial" | "booster";
  licensedDurationMonths: string;
  rabiesTagNumber: string;
  supervisingVeterinarianId: string;
  reason: string;
};

function VaccinationsTab({
  patientId,
  timeZone,
  canCorrectClinicalRecords,
  canPrepareCertificate,
  canEditCertificate,
}: {
  patientId: string;
  timeZone?: string | null;
  canCorrectClinicalRecords: boolean;
  canPrepareCertificate: boolean;
  canEditCertificate: boolean;
}) {
  const utils = trpc.useUtils();
  const [editor, setEditor] = useState<VaccinationCertificateEditor | null>(
    null,
  );
  const {
    data: vaccinations,
    isLoading,
    error,
  } = trpc.records.listVaccinations.useQuery({ patientId });
  const providers = trpc.records.listVaccinationProviders.useQuery(undefined, {
    enabled: Boolean(editor),
    staleTime: 5 * 60 * 1000,
  });
  const prepareCertificate =
    trpc.records.prepareVaccinationCertificate.useMutation();
  const updateCertificateDetails =
    trpc.records.updateVaccinationCertificateDetails.useMutation({
      onSuccess: async () => {
        setEditor(null);
        await utils.records.listVaccinations.invalidate({ patientId });
        toast.success("Certificate details updated with an audit entry");
      },
      onError: (err) => toast.error(err.message),
    });
  const correctVaccination =
    trpc.records.markVaccinationEnteredInError.useMutation({
      onSuccess: async () => {
        toast.success("Vaccination retained and marked entered in error");
        await utils.records.listVaccinations.invalidate({ patientId });
      },
      onError: (err) => toast.error(err.message),
    });
  const vaccinationsMissing = !isLoading && !error && !vaccinations;

  async function downloadCertificate(
    kind: "vaccination_history" | "rabies",
    vaccinationRecordId?: string,
  ) {
    try {
      const certificate = await prepareCertificate.mutateAsync({
        patientId,
        kind,
        vaccinationRecordId,
      });
      if (!certificate.ready) {
        toast.error(
          `Complete these details before issuing the certificate: ${certificate.missingFields.join(
            ", ",
          )}.`,
        );
        return;
      }
      const pdf = await import("@/lib/pdf");
      const generatedDate = formatClinicalDate(
        certificate.generatedAt,
        certificate.practice.timezone,
        "Unknown date",
      );
      const baseData = {
        certificateId: certificate.certificateId,
        generatedDate,
        practice: certificate.practice,
        owner: certificate.owner,
        patient: {
          ...certificate.patient,
          sex: formatSex(certificate.patient.sex),
          dob: formatClinicalDate(
            certificate.patient.dob,
            certificate.practice.timezone,
            undefined,
          ),
        },
      };
      const safePatientName = certificate.patient.name.replace(
        /[^a-z0-9]+/gi,
        "_",
      );
      if (kind === "vaccination_history") {
        pdf
          .generateVaccinationHistoryCertificatePdf({
            ...baseData,
            vaccinations: certificate.vaccinations.map((vaccination) => ({
              ...vaccination,
              administeredAt: formatClinicalDate(
                vaccination.administeredAt,
                certificate.practice.timezone,
                "Unknown",
              ),
              nextDueDate: formatClinicalDate(
                vaccination.nextDueDate,
                certificate.practice.timezone,
                undefined,
              ),
            })),
          })
          .save(`${safePatientName}_vaccination_certificate.pdf`);
      } else {
        const rabies = certificate.vaccinations[0]!;
        pdf
          .generateRabiesVaccinationCertificatePdf({
            ...baseData,
            vaccination: {
              ...rabies,
              productName: rabies.productName!,
              manufacturer: rabies.manufacturer!,
              lotNumber: rabies.lotNumber!,
              productExpirationDate: formatClinicalDate(
                rabies.productExpirationDate,
                certificate.practice.timezone,
                "Unknown",
              ),
              doseType: rabies.doseType!,
              licensedDurationMonths: rabies.licensedDurationMonths!,
              administeredAt: formatClinicalDate(
                rabies.administeredAt,
                certificate.practice.timezone,
                "Unknown",
              ),
              nextDueDate: formatClinicalDate(
                rabies.nextDueDate,
                certificate.practice.timezone,
                "Unknown",
              ),
              veterinarianName: rabies.veterinarianName!,
              veterinarianLicenseNumber: rabies.veterinarianLicenseNumber!,
            },
          })
          .save(`${safePatientName}_rabies_vaccination_certificate.pdf`);
      }
      toast.success("Certificate downloaded");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Unable to create certificate",
      );
    }
  }

  if (error) {
    return (
      <PatientDetailErrorPanel
        message={`Unable to load vaccination records. ${error.message}`}
      />
    );
  }

  if (vaccinationsMissing) {
    return (
      <PatientDetailErrorPanel message="Unable to load vaccination records. Please retry." />
    );
  }

  if (isLoading) {
    return <PatientDetailLoadingPanel label="Loading vaccinations..." />;
  }

  if (!vaccinations || vaccinations.length === 0) {
    return <EmptyState icon={Shield} title="No vaccination records yet" />;
  }

  return (
    <div className="space-y-4">
      {canPrepareCertificate ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">Vaccination certificates</p>
            <p className="text-xs text-muted-foreground">
              Every prepared certificate receives a unique ID and an audit
              entry. Rabies certificates must pass a required-field check.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={prepareCertificate.isPending}
            onClick={() => downloadCertificate("vaccination_history")}
          >
            {prepareCertificate.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="mr-2 h-4 w-4" />
            )}
            Download vaccination certificate
          </Button>
        </div>
      ) : null}

      {editor ? (
        <form
          className="rounded-lg border border-border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (editor.reason.trim().length < 10) return;
            updateCertificateDetails.mutate({
              patientId,
              recordId: editor.id,
              expectedUpdatedAt: editor.expectedUpdatedAt,
              reason: editor.reason,
              productName: editor.productName || undefined,
              manufacturer: editor.manufacturer || undefined,
              lotNumber: editor.lotNumber || undefined,
              productExpirationDate: editor.productExpirationDate || undefined,
              doseType: editor.doseType || undefined,
              licensedDurationMonths: editor.licensedDurationMonths
                ? Number(editor.licensedDurationMonths)
                : undefined,
              rabiesTagNumber: editor.rabiesTagNumber || undefined,
              supervisingVeterinarianId:
                editor.supervisingVeterinarianId || undefined,
            });
          }}
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">Edit certificate details</p>
              <p className="text-xs text-muted-foreground">
                Clinical history is preserved. A reason is recorded with every
                change.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["Product name", "productName"],
                ["Manufacturer", "manufacturer"],
                ["Lot number", "lotNumber"],
                ["Product expiration", "productExpirationDate"],
                ["Rabies tag", "rabiesTagNumber"],
              ] as const
            ).map(([label, field]) => (
              <label
                key={field}
                className="space-y-1 text-xs font-medium text-muted-foreground"
              >
                {label}
                <input
                  type={field === "productExpirationDate" ? "date" : "text"}
                  value={editor[field]}
                  onChange={(event) =>
                    setEditor({ ...editor, [field]: event.target.value })
                  }
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
                />
              </label>
            ))}
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Dose type
              <select
                value={editor.doseType}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    doseType: event.target.value as "" | "initial" | "booster",
                  })
                }
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="">Not recorded</option>
                <option value="initial">Initial</option>
                <option value="booster">Booster</option>
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Licensed duration
              <select
                value={editor.licensedDurationMonths}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    licensedDurationMonths: event.target.value,
                  })
                }
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="">Not recorded</option>
                <option value="12">1 year</option>
                <option value="36">3 years</option>
                <option value="48">4 years</option>
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Supervising veterinarian
              <select
                value={editor.supervisingVeterinarianId}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    supervisingVeterinarianId: event.target.value,
                  })
                }
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="">Not recorded</option>
                {providers.data?.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                    {provider.licenseNumber
                      ? ` — ${provider.licenseNumber}`
                      : " — license missing"}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground sm:col-span-2 lg:col-span-4">
              Reason for change (required, at least 10 characters)
              <textarea
                value={editor.reason}
                minLength={10}
                maxLength={500}
                required
                onChange={(event) =>
                  setEditor({ ...editor, reason: event.target.value })
                }
                className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="submit"
              disabled={
                editor.reason.trim().length < 10 ||
                updateCertificateDetails.isPending
              }
            >
              {updateCertificateDetails.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Save audited changes
            </Button>
          </div>
        </form>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Vaccine Name
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Date Given
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Next Due
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Product / Lot
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Administered By
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Certificate
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {vaccinations.map((vax) => (
              <tr
                key={vax.id}
                className={cn(
                  "border-b border-border align-top last:border-0",
                  vax.correctionId && "bg-destructive/5 text-muted-foreground",
                )}
              >
                <td className="px-4 py-3 font-medium">{vax.vaccineName}</td>
                <td className="px-4 py-3">
                  {formatClinicalDate(vax.administeredAt, timeZone, "\u2014")}
                </td>
                <td className="px-4 py-3">
                  {formatClinicalDate(vax.nextDueDate, timeZone, "\u2014")}
                </td>
                <td className="px-4 py-3">
                  <span>{vax.productName ?? "—"}</span>
                  <span className="block text-xs text-muted-foreground">
                    Lot {vax.lotNumber ?? "—"}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {vax.administeredByName ?? "\u2014"}
                </td>
                <td className="px-4 py-3">
                  {!vax.correctionId &&
                  canPrepareCertificate &&
                  isRabiesVaccineName(vax.vaccineName) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={prepareCertificate.isPending}
                      onClick={() => downloadCertificate("rabies", vax.id)}
                    >
                      Rabies PDF
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                  {!vax.correctionId && canEditCertificate ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1 block"
                      onClick={() =>
                        setEditor({
                          id: vax.id,
                          expectedUpdatedAt: vax.updatedAt.toISOString(),
                          productName: vax.productName ?? "",
                          manufacturer: vax.manufacturer ?? "",
                          lotNumber: vax.lotNumber ?? "",
                          productExpirationDate:
                            vax.productExpirationDate ?? "",
                          doseType: vax.doseType ?? "",
                          licensedDurationMonths:
                            vax.licensedDurationMonths?.toString() ?? "",
                          rabiesTagNumber: vax.rabiesTagNumber ?? "",
                          supervisingVeterinarianId:
                            vax.supervisingVeterinarianId ?? "",
                          reason: "",
                        })
                      }
                    >
                      Edit details
                    </Button>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  {vax.correctionId ? (
                    <span className="inline-flex items-center rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                      Entered in error
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Recorded
                    </span>
                  )}
                  <ClinicalCorrectionControl
                    correction={
                      vax.correctionId &&
                      vax.correctionReason &&
                      vax.correctedAt
                        ? {
                            id: vax.correctionId,
                            reason: vax.correctionReason,
                            correctedAt: vax.correctedAt,
                            correctedByName: vax.correctedByName,
                          }
                        : null
                    }
                    canCorrect={canCorrectClinicalRecords}
                    isPending={
                      correctVaccination.isPending &&
                      correctVaccination.variables?.recordId === vax.id
                    }
                    onCorrect={(reason) =>
                      correctVaccination.mutateAsync({
                        patientId,
                        recordId: vax.id,
                        reason,
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MedicalRecordsTab({
  patientId,
  timeZone,
  canCorrectClinicalRecords,
  canSearchPatientHistory,
}: {
  patientId: string;
  timeZone?: string | null;
  canCorrectClinicalRecords: boolean;
  canSearchPatientHistory: boolean;
}) {
  const [historySearchActive, setHistorySearchActive] = useState(false);
  const utils = trpc.useUtils();
  const {
    data: notes,
    isLoading,
    error,
  } = trpc.records.listSoapNotes.useQuery({ patientId });
  const correctSoap = trpc.records.markSoapNoteEnteredInError.useMutation({
    onSuccess: async () => {
      toast.success("SOAP note retained and marked entered in error");
      await utils.records.listSoapNotes.invalidate({ patientId });
    },
    onError: (err) => toast.error(err.message),
  });
  const notesMissing = !isLoading && !error && !notes;

  return (
    <div className="space-y-4">
      {canSearchPatientHistory ? (
        <PatientHistorySearch
          patientId={patientId}
          timeZone={timeZone}
          onSearchModeChange={setHistorySearchActive}
        />
      ) : null}
      {!historySearchActive ? (
        error ? (
          <PatientDetailErrorPanel
            message={`Unable to load medical records. ${error.message}`}
          />
        ) : notesMissing ? (
          <PatientDetailErrorPanel message="Unable to load medical records. Please retry." />
        ) : isLoading ? (
          <PatientDetailLoadingPanel label="Loading medical records..." />
        ) : !notes || notes.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No medical records yet"
            description="SOAP notes written in Records will show up here."
          />
        ) : (
          notes.map((note) => {
            const hasOtherCurrentAppointmentSoap = Boolean(
              note.appointmentId &&
              notes.some(
                (candidate) =>
                  candidate.id !== note.id &&
                  candidate.appointmentId === note.appointmentId &&
                  candidate.status === "finalized" &&
                  !candidate.correctionId,
              ),
            );
            const hasAppointmentSoapDraft = Boolean(
              note.appointmentId &&
              notes.some(
                (candidate) =>
                  candidate.id !== note.id &&
                  candidate.appointmentId === note.appointmentId &&
                  candidate.status === "draft",
              ),
            );
            return (
              <div
                key={note.id}
                id={`soap-note-${note.id}`}
                className={cn(
                  "rounded-lg border border-border bg-card p-4",
                  note.correctionId && "border-destructive/40 bg-destructive/5",
                )}
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">
                      {note.createdAt
                        ? formatClinicalDate(
                            note.createdAt,
                            timeZone,
                            "Unknown",
                          )
                        : "Unknown"}
                    </p>
                    {note.imported ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        Imported
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                        note.status === "draft"
                          ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                          : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
                      )}
                    >
                      {note.status === "draft" ? "Draft" : "Finalized"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {note.imported
                      ? note.authorName
                        ? `Imported by ${note.authorName}`
                        : "Imported record"
                      : (note.authorName ?? "Unknown author")}
                  </p>
                </div>
                {note.status === "finalized" ? (
                  <p className="mb-3 text-xs text-muted-foreground">
                    Finalized by {note.finalizerName ?? "Unknown clinician"}
                    {note.finalizedAt
                      ? ` on ${formatClinicalDateTime(note.finalizedAt, timeZone)}`
                      : ""}
                  </p>
                ) : note.appointmentId && canCorrectClinicalRecords ? (
                  <a
                    href={`/records/new-soap/${encodeURIComponent(patientId)}?appointmentId=${encodeURIComponent(note.appointmentId)}`}
                    className="mb-3 inline-flex text-xs font-medium text-primary hover:underline"
                  >
                    Resume draft
                  </a>
                ) : null}
                {note.replacesSoapNoteId ? (
                  <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                    <p className="font-medium text-primary">
                      Current replacement SOAP
                    </p>
                    <a
                      href={`#soap-note-${note.replacesSoapNoteId}`}
                      className="mt-1 inline-flex text-xs font-medium text-primary hover:underline"
                    >
                      View retained original
                    </a>
                  </div>
                ) : null}
                <dl className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ["Subjective", note.subjective],
                      ["Objective", note.objective],
                      ["Assessment", note.assessment],
                      ["Plan", note.plan],
                    ] as const
                  ).map(([label, value]) =>
                    value ? (
                      <div key={label}>
                        <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {label}
                        </dt>
                        <dd className="mt-1 whitespace-pre-wrap text-sm">
                          {soapSectionText(value)}
                        </dd>
                      </div>
                    ) : null,
                  )}
                </dl>
                {note.addenda.length > 0 ? (
                  <div className="mt-4 space-y-2 border-t border-border pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Addenda
                    </p>
                    {note.addenda.map((addendum) => (
                      <div
                        key={addendum.id}
                        className="rounded-md bg-muted/40 p-3"
                      >
                        <p className="text-xs font-medium">
                          {addendum.authorName} -{" "}
                          {formatClinicalDateTime(addendum.createdAt, timeZone)}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">
                          {soapSectionText(addendum.content)}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
                {note.status === "finalized" && !note.correctionId ? (
                  <SoapAddendumControl
                    patientId={patientId}
                    noteId={note.id}
                    enabled={canCorrectClinicalRecords}
                  />
                ) : null}
                {note.status === "finalized" ? (
                  <>
                    <ClinicalCorrectionControl
                      correction={
                        note.correctionId &&
                        note.correctionReason &&
                        note.correctedAt
                          ? {
                              id: note.correctionId,
                              reason: note.correctionReason,
                              correctedAt: note.correctedAt,
                              correctedByName: note.correctedByName,
                            }
                          : null
                      }
                      triggerLabel="Void without replacement"
                      description="The original stays in permanent chart history but leaves current clinical summaries immediately. If its content needs correction, cancel and use Replace finalized SOAP. Use void alone only when no replacement belongs on this encounter; closeout will require a documented reason."
                      canCorrect={canCorrectClinicalRecords}
                      isPending={
                        correctSoap.isPending &&
                        correctSoap.variables?.recordId === note.id
                      }
                      onCorrect={(reason) =>
                        correctSoap.mutateAsync({
                          patientId,
                          recordId: note.id,
                          reason,
                        })
                      }
                    />
                    {note.replacementSoapNoteId ? (
                      <div className="mt-3 flex justify-end">
                        <a
                          href={`#soap-note-${note.replacementSoapNoteId}`}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          View signed replacement
                        </a>
                      </div>
                    ) : canCorrectClinicalRecords &&
                      (!note.correctionId ||
                        (!hasOtherCurrentAppointmentSoap &&
                          !hasAppointmentSoapDraft)) ? (
                      <div className="mt-3 flex justify-end">
                        <Button asChild size="sm">
                          <Link
                            href={`/records/replace-soap/${encodeURIComponent(patientId)}?sourceNoteId=${encodeURIComponent(note.id)}&return=patient`}
                          >
                            {note.correctionId
                              ? "Create missing replacement"
                              : "Replace finalized SOAP"}
                          </Link>
                        </Button>
                      </div>
                    ) : hasAppointmentSoapDraft && note.appointmentId ? (
                      <div className="mt-3 flex justify-end">
                        <Button asChild size="sm" variant="outline">
                          <a
                            href={`/records/new-soap/${encodeURIComponent(patientId)}?appointmentId=${encodeURIComponent(note.appointmentId)}`}
                          >
                            Review encounter SOAP draft
                          </a>
                        </Button>
                      </div>
                    ) : note.correctionId && hasOtherCurrentAppointmentSoap ? (
                      <p className="mt-3 text-right text-xs text-muted-foreground">
                        This encounter already has a current finalized SOAP.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })
        )
      ) : null}
    </div>
  );
}

function SoapAddendumControl({
  patientId,
  noteId,
  enabled,
}: {
  patientId: string;
  noteId: string;
  enabled: boolean;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const addendum = trpc.records.addSoapNoteAddendum.useMutation({
    onSuccess: async () => {
      setContent("");
      setOpen(false);
      setOperationId(crypto.randomUUID());
      toast.success("Addendum added to the finalized record");
      await utils.records.listSoapNotes.invalidate({ patientId });
    },
    onError: (error) => toast.error(error.message),
  });
  if (!enabled) return null;
  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={() => {
          setOperationId(crypto.randomUUID());
          setOpen(true);
        }}
      >
        <Plus className="mr-2 h-4 w-4" />
        Add addendum
      </Button>
    );
  }
  return (
    <div className="mt-4 rounded-md border border-border p-3">
      <label className="text-sm font-medium" htmlFor={`addendum-${noteId}`}>
        Add attributed addendum
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Addenda cannot be edited or deleted after saving.
      </p>
      <textarea
        id={`addendum-${noteId}`}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        maxLength={10_000}
        rows={3}
        className="mt-2 w-full rounded-md border border-border bg-background p-2 text-sm"
      />
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!content.trim() || addendum.isPending}
          onClick={() =>
            addendum.mutate({
              patientId,
              noteId,
              operationId,
              content,
            })
          }
        >
          {addendum.isPending ? "Saving..." : "Save addendum"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={addendum.isPending}
          onClick={() => {
            setOpen(false);
            setContent("");
            setOperationId(crypto.randomUUID());
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

const appointmentStatusStyles: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-700",
  confirmed: "bg-teal-100 text-teal-700",
  checked_in: "bg-amber-100 text-amber-700",
  in_exam: "bg-purple-100 text-purple-700",
  checked_out: "bg-green-100 text-green-700",
  no_show: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

function AppointmentsTab({
  patientId,
  timeZone,
}: {
  patientId: string;
  timeZone?: string | null;
}) {
  const {
    data: visits,
    isLoading,
    error,
  } = trpc.appointments.listByPatient.useQuery({ patientId });
  const visitsMissing = !isLoading && !error && !visits;
  const [expandedVisitId, setExpandedVisitId] = useState<string | null>(null);

  if (error) {
    return (
      <PatientDetailErrorPanel
        message={`Unable to load appointments. ${error.message}`}
      />
    );
  }
  if (visitsMissing) {
    return (
      <PatientDetailErrorPanel message="Unable to load appointments. Please retry." />
    );
  }
  if (isLoading) {
    return <PatientDetailLoadingPanel label="Loading appointments..." />;
  }
  if (!visits || visits.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="No appointments yet"
        description="Visits booked on the schedule will show up here."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="w-10 px-2 py-3">
              <span className="sr-only">Documents</span>
            </th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              When
            </th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Type
            </th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Doctor
            </th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Status
            </th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Notes
            </th>
          </tr>
        </thead>
        <tbody>
          {visits.map((visit) => {
            const expanded = expandedVisitId === visit.id;
            return (
              <Fragment key={visit.id}>
                <tr className="border-b border-border last:border-0">
                  <td className="px-2 py-3">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedVisitId(expanded ? null : visit.id)
                      }
                      aria-expanded={expanded}
                      aria-label={
                        expanded
                          ? "Hide documents for this visit"
                          : "Show documents for this visit"
                      }
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {expanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {visit.startTime
                      ? formatClinicalDateTime(
                          visit.startTime,
                          timeZone,
                          "Unknown",
                        )
                      : "Unknown"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2">
                      {visit.typeColor ? (
                        <span
                          aria-hidden="true"
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: visit.typeColor }}
                        />
                      ) : null}
                      {visit.typeName ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {visit.doctorName ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        appointmentStatusStyles[visit.status] ??
                          "bg-gray-100 text-gray-600",
                      )}
                    >
                      {visit.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-muted-foreground">
                    {visit.notes || "—"}
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-border last:border-0">
                    <td colSpan={6} className="bg-muted/30 px-4 py-3">
                      <VisitDocuments
                        patientId={patientId}
                        appointmentId={visit.id}
                        timeZone={timeZone}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type PatientFile = {
  id: string;
  fileName: string;
  fileUrl: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  category: string | null;
  appointmentId: string | null;
  createdAt: Date;
  consentTitle: string | null;
  consentSignerName: string | null;
  consentSignedAt: Date | null;
};

function PatientPhotoGrid({ photos }: { photos: PatientFile[] }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
      {photos.map((file) => (
        <a
          key={file.id}
          href={file.fileUrl}
          target="_blank"
          rel="noreferrer"
          title={file.fileName}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={file.fileUrl}
            alt={file.fileName}
            className="aspect-square w-full rounded-md border border-border object-cover transition-opacity hover:opacity-80"
          />
        </a>
      ))}
    </div>
  );
}

function PatientFileRows({
  files,
  timeZone,
}: {
  files: PatientFile[];
  timeZone?: string | null;
}) {
  return (
    <ul className="divide-y divide-border">
      {files.map((file) => {
        const kind = patientFileKind(file);
        return (
          <li key={file.id} className="flex items-center gap-3 py-2.5">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {patientFileLabel(file)}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {kind === "consent"
                  ? `Signed consent${
                      file.consentSignerName
                        ? ` · Signed by ${file.consentSignerName}`
                        : ""
                    }`
                  : "Document"}
                {" · "}
                {formatClinicalDateTime(file.createdAt, timeZone, "Unknown")}
              </p>
            </div>
            <a
              href={file.fileUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View
            </a>
            <a
              href={file.fileUrl}
              download={file.fileName}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function VisitDocuments({
  patientId,
  appointmentId,
  timeZone,
}: {
  patientId: string;
  appointmentId: string;
  timeZone?: string | null;
}) {
  const { data, isLoading, error } = trpc.records.listPatientFiles.useQuery({
    patientId,
    appointmentId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading documents...
      </div>
    );
  }
  if (error || !data) {
    return (
      <p className="text-xs text-destructive">
        Unable to load documents for this visit.
      </p>
    );
  }

  const photos = data.filter((file) => patientFileKind(file) === "photo");
  const documents = data.filter((file) => patientFileKind(file) !== "photo");

  if (photos.length === 0 && documents.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Nothing attached to this visit yet. Photos and consents captured during
        the visit show up here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {photos.map((file) => (
            <a
              key={file.id}
              href={file.fileUrl}
              target="_blank"
              rel="noreferrer"
              title={file.fileName}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={file.fileUrl}
                alt={file.fileName}
                className="h-16 w-16 rounded-md border border-border object-cover transition-opacity hover:opacity-80"
              />
            </a>
          ))}
        </div>
      )}
      {documents.length > 0 && (
        <PatientFileRows files={documents} timeZone={timeZone} />
      )}
    </div>
  );
}

const documentFilters: { id: PatientFileKind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "photo", label: "Photos" },
  { id: "consent", label: "Consents" },
  { id: "document", label: "Documents" },
];

function DocumentsTab({
  patientId,
  timeZone,
}: {
  patientId: string;
  timeZone?: string | null;
}) {
  const [filter, setFilter] = useState<PatientFileKind | "all">("all");
  const { data, isLoading, error } = trpc.records.listPatientFiles.useQuery({
    patientId,
  });
  const filesMissing = !isLoading && !error && !data;

  const counts = useMemo(() => {
    const next = { all: 0, photo: 0, consent: 0, document: 0 };
    for (const file of data ?? []) {
      next.all += 1;
      next[patientFileKind(file)] += 1;
    }
    return next;
  }, [data]);

  if (error) {
    return (
      <PatientDetailErrorPanel
        message={`Unable to load documents. ${error.message}`}
      />
    );
  }
  if (filesMissing) {
    return (
      <PatientDetailErrorPanel message="Unable to load documents. Please retry." />
    );
  }
  if (isLoading) {
    return <PatientDetailLoadingPanel label="Loading documents..." />;
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={Paperclip}
        title="No documents yet"
        description="Photos you capture and consents that get signed show up here."
      />
    );
  }

  const visible = data.filter(
    (file) => filter === "all" || patientFileKind(file) === filter,
  );
  const photos = visible.filter((file) => patientFileKind(file) === "photo");
  const documents = visible.filter((file) => patientFileKind(file) !== "photo");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {documentFilters.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setFilter(option.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === option.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label} ({counts[option.id]})
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Nothing here yet for this filter.
        </div>
      ) : (
        <div className="space-y-4">
          {photos.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="mb-3 text-sm font-medium">Photos</h3>
              <PatientPhotoGrid photos={photos} />
            </div>
          )}
          {documents.length > 0 && (
            <div className="rounded-lg border border-border bg-card px-4 py-2">
              <PatientFileRows files={documents} timeZone={timeZone} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const invoiceStatusStyles: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  void: "bg-gray-100 text-gray-400",
};

function InvoicesTab({ patientId }: { patientId: string }) {
  const formatCurrency = useCurrencyFormatter();
  const { data, isLoading, error } = trpc.billing.listInvoices.useQuery({
    patientId,
    limit: 50,
  });
  const invoicesMissing = !isLoading && !error && !data;

  if (error) {
    return (
      <PatientDetailErrorPanel
        message={`Unable to load invoices. ${error.message}`}
      />
    );
  }
  if (invoicesMissing) {
    return (
      <PatientDetailErrorPanel message="Unable to load invoices. Please retry." />
    );
  }
  if (isLoading) {
    return <PatientDetailLoadingPanel label="Loading invoices..." />;
  }
  if (!data || data.items.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="No invoices yet"
        description="Invoices created in Billing for this patient will show up here."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Created
            </th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
              Total
            </th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
              Paid
            </th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Status
            </th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {data.items.map((invoice) => (
            <tr
              key={invoice.id}
              className="border-b border-border last:border-0"
            >
              <td className="px-4 py-3 text-muted-foreground">
                {invoice.createdAt
                  ? new Date(invoice.createdAt).toLocaleDateString()
                  : "—"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium">
                {formatCurrency(invoice.total)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                {formatCurrency(invoice.paidAmount)}
              </td>
              <td className="px-4 py-3">
                <span
                  className={cn(
                    "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                    invoiceStatusStyles[
                      invoice.isEstimate ? "draft" : invoice.status
                    ] ?? "bg-gray-100 text-gray-600",
                  )}
                >
                  {invoice.isEstimate ? "estimate" : invoice.status}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  href="/billing"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Open in Billing
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AllergyForm({
  allergyName,
  setAllergyName,
  allergySeverity,
  setAllergySeverity,
  allergyReaction,
  setAllergyReaction,
  canSubmit,
  isPending,
  onSubmit,
  onCancel,
}: {
  allergyName: string;
  setAllergyName: (v: string) => void;
  allergySeverity: "mild" | "moderate" | "severe";
  setAllergySeverity: (v: "mild" | "moderate" | "severe") => void;
  allergyReaction: string;
  setAllergyReaction: (v: string) => void;
  canSubmit: boolean;
  isPending: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="w-full sm:w-44">
        <label
          htmlFor="allergy-allergen"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Allergen
        </label>
        <input
          id="allergy-allergen"
          type="text"
          value={allergyName}
          maxLength={255}
          required
          placeholder="Penicillin"
          onChange={(event) => setAllergyName(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
      <div>
        <label
          htmlFor="allergy-severity"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Severity
        </label>
        <select
          id="allergy-severity"
          value={allergySeverity}
          onChange={(event) =>
            setAllergySeverity(
              event.target.value as "mild" | "moderate" | "severe",
            )
          }
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="mild">Mild</option>
          <option value="moderate">Moderate</option>
          <option value="severe">Severe</option>
        </select>
      </div>
      <div className="w-full sm:w-56">
        <label
          htmlFor="allergy-reaction"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Reaction (optional)
        </label>
        <input
          id="allergy-reaction"
          type="text"
          value={allergyReaction}
          maxLength={2000}
          placeholder="Facial swelling"
          onChange={(event) => setAllergyReaction(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1.5 h-3.5 w-3.5" />
          )}
          {isPending ? "Saving..." : "Save allergy"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
