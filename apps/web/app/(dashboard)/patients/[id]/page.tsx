"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, useRef } from "react";
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
  FileDown,
  FileText,
  Loader2,
  Plus,
  Receipt,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { useCurrencyFormatter } from "@/lib/locale/useCurrency";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
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
  buildVitalTrend,
  buildWeightTrend,
} from "@/lib/records/clinical-trends";
import {
  formatClinicalDate,
  formatClinicalDateTime,
} from "@/lib/records/clinical-dates";
import {
  PATIENT_WEIGHT_MAX_KG,
  PATIENT_WEIGHT_MIN_KG,
  PATIENT_WEIGHT_STEP,
  isPatientWeightInputValid,
} from "@/lib/records/patient-weight-policy";
import {
  VITALS_BODY_CONDITION_MAX,
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
      (mod) => mod.WeightTrendChart
    ),
  {
    ssr: false,
    loading: PatientChartChunkLoading,
  }
);

const VitalsTrendChart = dynamic(
  () =>
    import("@/components/patients/patient-trend-charts").then(
      (mod) => mod.VitalsTrendChart
    ),
  {
    ssr: false,
    loading: PatientChartChunkLoading,
  }
);

const speciesEmoji: Record<string, string> = {
  canine: "\uD83D\uDC36",
  feline: "\uD83D\uDC31",
  avian: "\uD83D\uDC26",
  rabbit: "\uD83D\uDC30",
  reptile: "\uD83E\uDD8E",
  equine: "\uD83D\uDC34",
  other: "\uD83D\uDC3E",
};

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
  | "appointments"
  | "weight"
  | "vitals"
  | "vaccinations"
  | "invoices";

const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "records", label: "Medical Records" },
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
  return (
    role === "admin" || role === "veterinarian" || role === "technician"
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const canManagePatientDetail = canManagePatientDetailRole(
    session?.user?.role
  );
  const canRecordVitals = canRecordVitalsRole(session?.user?.role);

  const { data: patient, isLoading, error } = trpc.patients.getById.useQuery(
    { id: params.id },
    { enabled: !!params.id }
  );
  const {
    data: recordsSettings,
    isLoading: recordsSettingsLoading,
    error: recordsSettingsError,
  } = trpc.records.settings.useQuery();

  const updatePhotoMutation = trpc.patients.update.useMutation({
    onSuccess: () => {
      toast.success("Patient photo updated");
      utils.patients.getById.invalidate({ id: params.id });
    },
    onError: (err) => {
      toast.error(`Failed to update patient photo: ${err.message}`);
    },
  });

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!canManagePatientDetail) {
      e.currentTarget.value = "";
      return;
    }
    const file = e.target.files?.[0];
    if (!file) return;

    if (!isImageUploadFileValid(file)) {
      toast.error(IMAGE_UPLOAD_POLICY_MESSAGE);
      e.currentTarget.value = "";
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("category", "patient-photos");

    try {
      const res = await fetchWithClientTimeout(
        "/api/upload",
        {
          method: "POST",
          body: formData,
        },
        CLIENT_UPLOAD_TIMEOUT_MS
      );

      if (!res.ok) {
        throw new Error("Upload failed");
      }

      const data = await res.json();
      updatePhotoMutation.mutate({ id: params.id, photoUrl: data.url });
    } catch {
      toast.error("Failed to upload photo");
    }

    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  // Medical summary PDF data queries (lazy -- only fetched on demand)
  const problemsQuery = trpc.records.listProblems.useQuery(
    { patientId: params.id },
    { enabled: false }
  );
  const vaccinationsQuery = trpc.records.listVaccinations.useQuery(
    { patientId: params.id },
    { enabled: false }
  );
  const soapNotesQuery = trpc.records.listSoapNotes.useQuery(
    { patientId: params.id },
    { enabled: false }
  );
  const prescriptionsQuery = trpc.records.listPrescriptions.useQuery(
    { patientId: params.id },
    { enabled: false }
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
    [patient?.weights, recordsSettingsTimeZone]
  );
  const [weightKg, setWeightKg] = useState("");
  const addWeight = trpc.patients.addWeight.useMutation({
    onSuccess: () => {
      toast.success("Weight recorded");
      utils.patients.getById.invalidate({ id: params.id });
      setWeightKg("");
    },
    onError: (err) => toast.error(err.message),
  });
  const canSubmitWeight =
    canManagePatientDetail &&
    isPatientWeightInputValid(weightKg) && !addWeight.isPending;

  function handleRecordWeight(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmitWeight || !patient) return;
    addWeight.mutate({
      patientId: patient.id,
      weightKg: weightKg.trim(),
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

  async function handleDownloadSummary() {
    try {
      const [problemsResult, vaccinationsResult, soapNotesResult, prescriptionsResult] =
        await Promise.all([
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
          "Unable to load complete medical summary data. Please retry."
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
        })),
        problems: problems.map((p) => ({
          description: p.description,
          status: p.status ?? "active",
          onsetDate: p.onsetDate ?? undefined,
        })),
        vaccinations: vaccinations.map((v) => ({
          name: v.vaccineName,
          date: v.administeredAt
            ? formatClinicalDate(v.administeredAt, recordsTimeZone, "Unknown")
            : "Unknown",
          nextDue: v.nextDueDate
            ? formatClinicalDate(v.nextDueDate, recordsTimeZone)
            : undefined,
        })),
        recentNotes: soapNotes.slice(0, 5).map((n) => ({
          date: n.createdAt
            ? formatClinicalDate(n.createdAt, recordsTimeZone, "Unknown")
            : "Unknown",
          subjective: n.subjective ?? undefined,
          objective: n.objective ?? undefined,
          assessment: n.assessment ?? undefined,
          plan: n.plan ?? undefined,
        })),
        prescriptions: prescriptions.map((rx) => ({
          medication: rx.medicationName,
          dosage: rx.dosage ?? "",
          frequency: rx.frequency ?? "",
          status: rx.status ?? "active",
        })),
        generatedDate: formatClinicalDate(new Date(), recordsTimeZone),
      }).save(`${patientData.name.replace(/\s+/g, "_")}_medical_summary.pdf`);

      toast.success("Medical summary downloaded");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to generate medical summary"
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

      {/* Patient Header Card */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
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
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
                    title="Upload photo"
                  >
                    <Camera className="h-5 w-5 text-white" />
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
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-heading text-xl font-semibold">
                  {patient.name}
                </h2>
                <span
                  className={cn(
                    "inline-block h-2.5 w-2.5 rounded-full",
                    statusColor
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
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadSummary}
            >
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

      {/* Allergy Alert Bar */}
      {patient.allergies && patient.allergies.length > 0 && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
          <div>
            <p className="text-sm font-semibold text-red-800 dark:text-red-300">
              Allergies
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {patient.allergies.map((allergy) => (
                <span
                  key={allergy.id}
                  className={cn(
                    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                    allergy.severity === "severe"
                      ? "bg-red-200 text-red-800 dark:bg-red-900 dark:text-red-200"
                      : allergy.severity === "moderate"
                        ? "bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                        : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                  )}
                >
                  {allergy.allergen}
                  {allergy.severity === "severe" ? (
                    <span className="ml-1 text-[10px] font-semibold uppercase tracking-wide">
                      severe
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="mt-6 border-b border-border">
        <div className="flex gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "relative px-4 py-2.5 text-sm font-medium transition-colors",
                activeTab === tab.id
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
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
      <div className="mt-6">
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
                      Weight (kg)
                    </label>
                    <input
                      type="number"
                      min={PATIENT_WEIGHT_MIN_KG}
                      max={PATIENT_WEIGHT_MAX_KG}
                      step={PATIENT_WEIGHT_STEP}
                      value={weightKg}
                      required
                      aria-invalid={
                        weightKg.trim().length > 0 &&
                        !isPatientWeightInputValid(weightKg)
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
                <WeightTrendChart data={weightTrend} />
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50">
                        <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                          Date
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                          Weight (kg)
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
                              "\u2014"
                            )}
                          </td>
                          <td className="px-4 py-3 font-medium">
                            {weight.weightKg} kg
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
            canRecordVitals={canRecordVitals}
          />
        )}

        {activeTab === "vaccinations" && (
          <VaccinationsTab patientId={patient.id} timeZone={recordsTimeZone} />
        )}

        {activeTab === "records" && (
          <MedicalRecordsTab
            patientId={patient.id}
            timeZone={recordsTimeZone}
          />
        )}

        {activeTab === "appointments" && (
          <AppointmentsTab
            patientId={patient.id}
            timeZone={recordsTimeZone}
          />
        )}

        {activeTab === "invoices" && <InvoicesTab patientId={patient.id} />}
      </div>
    </div>
  );
}

function VitalsTab({
  patientId,
  timeZone,
  canRecordVitals,
}: {
  patientId: string;
  timeZone?: string | null;
  canRecordVitals: boolean;
}) {
  const utils = trpc.useUtils();
  const { data: vitals, isLoading, error } =
    trpc.vitals.listByPatient.useQuery({ patientId });
  const vitalsMissing = !isLoading && !error && !vitals;
  const vitalTrend = useMemo(
    () => buildVitalTrend(vitals ?? [], timeZone),
    [vitals, timeZone]
  );
  const record = trpc.vitals.record.useMutation({
    onSuccess: () => {
      toast.success("Vitals recorded");
      utils.vitals.listByPatient.invalidate({ patientId });
      setForm(initialVitalsForm());
    },
    onError: (err) => toast.error(err.message),
  });

  const [form, setForm] = useState<VitalsFormState>(() => initialVitalsForm());
  const set = (k: keyof VitalsFormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const num = (v?: string) => {
    if (v === undefined || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const hasVitalsFormContent = Object.values(form).some(
    (value) => value.trim().length > 0
  );
  const canSubmitVitals =
    canRecordVitals &&
    hasVitalsFormContent &&
    isVitalsOptionalTemperatureInputValid(form.temperatureC) &&
    isVitalsOptionalHeartRateInputValid(form.heartRateBpm) &&
    isVitalsOptionalRespiratoryRateInputValid(form.respiratoryRateBpm) &&
    isVitalsOptionalWeightInputValid(form.weightKg) &&
    isVitalsOptionalBodyConditionInputValid(form.bodyConditionScore) &&
    isVitalsOptionalPainScoreInputValid(form.painScore) &&
    isVitalsOptionalTextInputValid(
      form.mucousMembrane,
      VITALS_MUCOUS_MEMBRANE_MAX_LENGTH
    ) &&
    isVitalsOptionalCapillaryRefillInputValid(form.capillaryRefillSec) &&
    isVitalsOptionalTextInputValid(form.notes, VITALS_NOTES_MAX_LENGTH) &&
    !record.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmitVitals) return;
    record.mutate({
      patientId,
      temperatureC: num(form.temperatureC),
      heartRateBpm: num(form.heartRateBpm),
      respiratoryRateBpm: num(form.respiratoryRateBpm),
      weightKg: num(form.weightKg),
      bodyConditionScore: num(form.bodyConditionScore),
      painScore: num(form.painScore),
      mucousMembrane: form.mucousMembrane.trim() || undefined,
      capillaryRefillSec: num(form.capillaryRefillSec),
      notes: form.notes?.trim() || undefined,
    });
  }

  return (
    <div className="space-y-6">
      {canRecordVitals && (
        <form onSubmit={submit} className="rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Temp (C)
              </label>
              <input
                type="number"
                min={VITALS_TEMPERATURE_MIN_C}
                max={VITALS_TEMPERATURE_MAX_C}
                step={VITALS_TEMPERATURE_STEP}
                value={form.temperatureC}
                aria-invalid={!isVitalsOptionalTemperatureInputValid(form.temperatureC)}
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
              aria-invalid={!isVitalsOptionalHeartRateInputValid(form.heartRateBpm)}
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
                  form.respiratoryRateBpm
                )
              }
              onChange={set("respiratoryRateBpm")}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Weight (kg)
            </label>
            <input
              type="number"
              min={VITALS_WEIGHT_MIN_KG}
              max={VITALS_WEIGHT_MAX_KG}
              step={VITALS_WEIGHT_STEP}
              value={form.weightKg}
              aria-invalid={!isVitalsOptionalWeightInputValid(form.weightKg)}
              onChange={set("weightKg")}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              BCS (1-9)
            </label>
            <input
              type="number"
              min={VITALS_BODY_CONDITION_MIN}
              max={VITALS_BODY_CONDITION_MAX}
              step={1}
              value={form.bodyConditionScore}
              aria-invalid={
                !isVitalsOptionalBodyConditionInputValid(
                  form.bodyConditionScore
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
              aria-invalid={!isVitalsOptionalPainScoreInputValid(form.painScore)}
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
                  form.capillaryRefillSec
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
          <VitalsTrendChart data={vitalTrend} />
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
                </tr>
              </thead>
              <tbody>
                {vitals.map((v) => (
                  <tr key={v.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      {formatClinicalDateTime(v.recordedAt, timeZone, "—")}
                    </td>
                    <td className="px-3 py-2">{v.temperatureC ?? "—"}</td>
                    <td className="px-3 py-2">{v.heartRateBpm ?? "—"}</td>
                    <td className="px-3 py-2">{v.respiratoryRateBpm ?? "—"}</td>
                    <td className="px-3 py-2">{v.weightKg ?? "—"}</td>
                    <td className="px-3 py-2">{v.bodyConditionScore ?? "—"}</td>
                    <td className="px-3 py-2">{v.painScore ?? "—"}</td>
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

function VaccinationsTab({
  patientId,
  timeZone,
}: {
  patientId: string;
  timeZone?: string | null;
}) {
  const { data: vaccinations, isLoading, error } =
    trpc.records.listVaccinations.useQuery({ patientId });
  const vaccinationsMissing = !isLoading && !error && !vaccinations;

  if (error) {
    return (
      <PatientDetailErrorPanel
        message={`Unable to load vaccination records. ${error.message}`}
      />
    );
  }

  if (vaccinationsMissing) {
    return (
      <PatientDetailErrorPanel
        message="Unable to load vaccination records. Please retry."
      />
    );
  }

  if (isLoading) {
    return <PatientDetailLoadingPanel label="Loading vaccinations..." />;
  }

  if (!vaccinations || vaccinations.length === 0) {
    return (
      <EmptyState icon={Shield} title="No vaccination records yet" />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
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
              Lot Number
            </th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Administered By
            </th>
          </tr>
        </thead>
        <tbody>
          {vaccinations.map((vax) => (
            <tr
              key={vax.id}
              className="border-b border-border last:border-0"
            >
              <td className="px-4 py-3 font-medium">{vax.vaccineName}</td>
              <td className="px-4 py-3">
                {formatClinicalDate(vax.administeredAt, timeZone, "\u2014")}
              </td>
              <td className="px-4 py-3">
                {formatClinicalDate(vax.nextDueDate, timeZone, "\u2014")}
              </td>
              <td className="px-4 py-3">{vax.lotNumber ?? "\u2014"}</td>
              <td className="px-4 py-3 text-muted-foreground">
                {vax.administeredByName ?? "\u2014"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MedicalRecordsTab({
  patientId,
  timeZone,
}: {
  patientId: string;
  timeZone?: string | null;
}) {
  const { data: notes, isLoading, error } =
    trpc.records.listSoapNotes.useQuery({ patientId });
  const notesMissing = !isLoading && !error && !notes;

  if (error) {
    return (
      <PatientDetailErrorPanel
        message={`Unable to load medical records. ${error.message}`}
      />
    );
  }
  if (notesMissing) {
    return (
      <PatientDetailErrorPanel message="Unable to load medical records. Please retry." />
    );
  }
  if (isLoading) {
    return <PatientDetailLoadingPanel label="Loading medical records..." />;
  }
  if (!notes || notes.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No medical records yet"
        description="SOAP notes written in Records will show up here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {notes.map((note) => (
        <div
          key={note.id}
          className="rounded-lg border border-border bg-card p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {note.createdAt
                ? formatClinicalDateTime(note.createdAt, timeZone, "Unknown")
                : "Unknown"}
            </p>
            <p className="text-xs text-muted-foreground">
              {note.authorName ?? "Unknown author"}
            </p>
          </div>
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
                  <dd className="mt-1 whitespace-pre-wrap text-sm">{value}</dd>
                </div>
              ) : null
            )}
          </dl>
        </div>
      ))}
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
  const { data: visits, isLoading, error } =
    trpc.appointments.listByPatient.useQuery({ patientId });
  const visitsMissing = !isLoading && !error && !visits;

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
          {visits.map((visit) => (
            <tr
              key={visit.id}
              className="border-b border-border last:border-0"
            >
              <td className="px-4 py-3">
                {visit.startTime
                  ? formatClinicalDateTime(visit.startTime, timeZone, "Unknown")
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
                      "bg-gray-100 text-gray-600"
                  )}
                >
                  {visit.status.replace(/_/g, " ")}
                </span>
              </td>
              <td className="max-w-xs truncate px-4 py-3 text-muted-foreground">
                {visit.notes || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
                    ] ?? "bg-gray-100 text-gray-600"
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
