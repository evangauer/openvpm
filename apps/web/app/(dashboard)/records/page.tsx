"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Search,
  FileText,
  Syringe,
  Pill,
  ClipboardList,
  Plus,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Scissors,
  Tag,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/common/empty-state";
import { ClinicalCorrectionControl } from "@/components/records/clinical-correction-control";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  PATIENT_SEARCH_MAX_LENGTH,
  isPatientSearchInputValid,
} from "@/lib/patients/policy";
import type { PrescriptionSafetyWarning } from "@/lib/records/prescription-safety";
import { buildLabTrends } from "@/lib/records/clinical-trends";
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
} from "@/lib/records/prescription-policy";
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
} from "@/lib/records/lab-policy";
import {
  VACCINATION_LOT_NUMBER_MAX_LENGTH,
  VACCINATION_MANUFACTURER_MAX_LENGTH,
  VACCINATION_NAME_MAX_LENGTH,
  isVaccinationOptionalDateInputValid,
  isVaccinationOptionalTextInputValid,
  isVaccinationRequiredTextInputValid,
} from "@/lib/records/vaccination-policy";
import {
  PROBLEM_DESCRIPTION_MAX_LENGTH,
  PROBLEM_STATUSES,
  type ProblemStatus,
  isProblemOptionalDateInputValid,
  isProblemRequiredTextInputValid,
} from "@/lib/records/problem-policy";
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
} from "@/lib/records/procedure-policy";

type Tab = "soap" | "vaccinations" | "prescriptions" | "problems" | "labResults" | "procedures";

const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "soap", label: "SOAP Notes", icon: FileText },
  { id: "vaccinations", label: "Vaccinations", icon: Syringe },
  { id: "prescriptions", label: "Prescriptions", icon: Pill },
  { id: "problems", label: "Problems", icon: ClipboardList },
  { id: "labResults", label: "Lab Results", icon: FlaskConical },
  { id: "procedures", label: "Procedures", icon: Scissors },
];

function RecordsChartChunkLoading() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 h-5 w-32 animate-pulse rounded bg-muted" />
      <div className="h-56 w-full animate-pulse rounded bg-muted" />
    </div>
  );
}

function PrescriptionLifecycleChunkLoading() {
  return <div className="h-8 w-24 animate-pulse rounded bg-muted" />;
}

const LabTrendCharts = dynamic(
  () =>
    import("@/components/patients/patient-trend-charts").then(
      (mod) => mod.LabTrendCharts
    ),
  {
    ssr: false,
    loading: RecordsChartChunkLoading,
  }
);

const PrescriptionLifecycleControl = dynamic(
  () =>
    import("@/components/records/prescription-lifecycle-control").then(
      (mod) => mod.PrescriptionLifecycleControl,
    ),
  {
    ssr: false,
    loading: PrescriptionLifecycleChunkLoading,
  },
);

const CLINICAL_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
};

function clinicalDateInputToUtcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function dateInputDayNumber(value: string): number | null {
  const date = clinicalDateInputToUtcDate(value);
  if (!date) return null;
  return Math.floor(date.getTime() / (1000 * 60 * 60 * 24));
}

function formatClinicalDate(
  value: Date | string | null | undefined,
  timeZone?: string | null,
  fallback = "--"
): string {
  if (!value) return fallback;

  if (typeof value === "string") {
    const dateOnly = clinicalDateInputToUtcDate(value);
    if (dateOnly) {
      return dateOnly.toLocaleDateString("en-US", {
        ...CLINICAL_DATE_FORMAT,
        timeZone: "UTC",
      });
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  const options = {
    ...CLINICAL_DATE_FORMAT,
    timeZone: timeZone ?? undefined,
  };

  try {
    return date.toLocaleDateString("en-US", options);
  } catch {
    return date.toLocaleDateString("en-US", {
      ...options,
      timeZone: undefined,
    });
  }
}

function getVaccineDueStatus(
  nextDueDate: string | null,
  timeZone?: string | null
): {
  label: string;
  className: string;
} {
  if (!nextDueDate) return { label: "N/A", className: "text-muted-foreground" };
  const today = formatDateInputForTimeZone(new Date(), timeZone);
  const todayDay = dateInputDayNumber(today);
  const dueDay = dateInputDayNumber(nextDueDate);
  if (todayDay === null || dueDay === null) {
    return { label: "N/A", className: "text-muted-foreground" };
  }
  const daysUntilDue = dueDay - todayDay;

  if (daysUntilDue < 0)
    return {
      label: "Overdue",
      className:
        "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    };
  if (daysUntilDue <= 30)
    return {
      label: "Due Soon",
      className:
        "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    };
  return {
    label: "Current",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  };
}

function getLabStatusBadge(status: string | null) {
  switch (status) {
    case "pending":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400";
    case "completed":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
    case "reviewed":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  }
}

function isOutOfRange(
  resultValue: string | null,
  low: string | null,
  high: string | null
): boolean {
  if (!resultValue) return false;
  const val = parseFloat(resultValue);
  if (isNaN(val)) return false;
  if (low !== null && low !== undefined) {
    const lowVal = parseFloat(low);
    if (!isNaN(lowVal) && val < lowVal) return true;
  }
  if (high !== null && high !== undefined) {
    const highVal = parseFloat(high);
    if (!isNaN(highVal) && val > highVal) return true;
  }
  return false;
}

function getPrescriptionStatusBadge(status: string | null) {
  switch (status) {
    case "active":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
    case "completed":
      return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
    case "discontinued":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  }
}

// Tabs restricted from front_desk: SOAP Notes, Prescriptions, Lab Results, Procedures
const frontDeskRestrictedTabs: Tab[] = ["soap", "prescriptions", "labResults", "procedures"];

type LabResultFormState = {
  testName: string;
  resultValue: string;
  unit: string;
  referenceRangeLow: string;
  referenceRangeHigh: string;
  resultFlag: "unknown" | "normal" | "abnormal" | "critical";
};

type VaccinationFormState = {
  vaccineName: string;
  lotNumber: string;
  manufacturer: string;
  nextDueDate: string;
};

type ProblemFormState = {
  description: string;
  status: ProblemStatus;
  onsetDate: string;
};

type ProcedureFormState = {
  name: string;
  description: string;
  anesthesiaUsed: string;
  durationMinutes: string;
  notes: string;
};

type PrescriptionFormState = {
  medicationName: string;
  productId: string;
  dosage: string;
  frequency: string;
  quantity: string;
  refillsRemaining: string;
  startDate: string;
  endDate: string;
  instructions: string;
  acknowledgeSafetyWarnings: boolean;
};

function initialLabResultForm(): LabResultFormState {
  return {
    testName: "",
    resultValue: "",
    unit: "",
    referenceRangeLow: "",
    referenceRangeHigh: "",
    resultFlag: "unknown",
  };
}

function initialVaccinationForm(): VaccinationFormState {
  return {
    vaccineName: "",
    lotNumber: "",
    manufacturer: "",
    nextDueDate: "",
  };
}

function initialProblemForm(): ProblemFormState {
  return {
    description: "",
    status: "active",
    onsetDate: "",
  };
}

function initialProcedureForm(): ProcedureFormState {
  return {
    name: "",
    description: "",
    anesthesiaUsed: "",
    durationMinutes: "",
    notes: "",
  };
}

function dateInputValue(date: Date, timeZone?: string | null): string {
  return formatDateInputForTimeZone(date, timeZone);
}

function initialPrescriptionForm(timeZone?: string | null): PrescriptionFormState {
  return {
    medicationName: "",
    productId: "",
    dosage: "",
    frequency: "",
    quantity: "",
    refillsRemaining: "0",
    startDate: dateInputValue(new Date(), timeZone),
    endDate: "",
    instructions: "",
    acknowledgeSafetyWarnings: false,
  };
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safetyBadgeVariant(
  warning: PrescriptionSafetyWarning
): "destructive" | "warning" | "secondary" {
  if (warning.severity === "major") return "destructive";
  if (warning.severity === "moderate") return "warning";
  return "secondary";
}

function PrescriptionSafetyPanel({
  medicationName,
  isLoading,
  errorMessage,
  warnings,
}: {
  medicationName: string;
  isLoading: boolean;
  errorMessage?: string;
  warnings: PrescriptionSafetyWarning[];
}) {
  if (medicationName.trim().length < 2) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking prescription safety
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Unable to check prescription safety. {errorMessage}</span>
      </div>
    );
  }

  if (warnings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        <CheckCircle2 className="h-4 w-4" />
        No allergy or active-medication warnings found.
      </div>
    );
  }

  const hasBlockingWarning = warnings.some((warning) => warning.requiresOverride);

  return (
    <div
      className={cn(
        "rounded-md border p-3",
        hasBlockingWarning
          ? "border-amber-300 bg-amber-50"
          : "border-border bg-muted/30"
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <AlertTriangle
          className={cn(
            "h-4 w-4",
            hasBlockingWarning ? "text-amber-700" : "text-muted-foreground"
          )}
        />
        Prescription safety warnings
      </div>
      <div className="space-y-2">
        {warnings.map((warning, index) => (
          <div
            key={`${warning.type}-${warning.title}-${index}`}
            className="rounded-md border border-border/60 bg-background px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{warning.title}</p>
              <Badge variant={safetyBadgeVariant(warning)} className="capitalize">
                {warning.severity}
              </Badge>
              {warning.requiresOverride && (
                <Badge variant="outline">Override required</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {warning.message}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecordsErrorPanel({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive",
        className
      )}
    >
      {message}
    </div>
  );
}

function RecordsLoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function RecordsPageContent() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const linkedPatientId = searchParams.get("patientId") ?? "";
  const linkedAppointmentId = searchParams.get("appointmentId") ?? "";
  const shouldOpenPrescription =
    searchParams.get("tab") === "prescriptions" &&
    searchParams.get("new") === "1";
  const appliedVisitLink = useRef(false);
  const prescriptionOperationId = useRef<string | null>(null);
  const labResultCreationOperationId = useRef<string | null>(null);
  const labReviewOperationIds = useRef(new Map<string, string>());
  const userRole = session?.user?.role;
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<{
    id: string;
    name: string;
    species: string | null;
    breed: string | null;
    clientFirstName: string | null;
    clientLastName: string | null;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("soap");
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [showVaccinationForm, setShowVaccinationForm] = useState(false);
  const [showProblemForm, setShowProblemForm] = useState(false);
  const [showLabForm, setShowLabForm] = useState(false);
  const [showProcedureForm, setShowProcedureForm] = useState(false);
  const [showPrescriptionForm, setShowPrescriptionForm] = useState(false);
  const [vaccinationForm, setVaccinationForm] = useState<VaccinationFormState>(
    () => initialVaccinationForm()
  );
  const [problemForm, setProblemForm] = useState<ProblemFormState>(() =>
    initialProblemForm()
  );
  const [labForm, setLabForm] = useState<LabResultFormState>(() =>
    initialLabResultForm()
  );
  const [procedureForm, setProcedureForm] = useState<ProcedureFormState>(() =>
    initialProcedureForm()
  );
  const [prescriptionForm, setPrescriptionForm] = useState<PrescriptionFormState>(
    () => initialPrescriptionForm()
  );
  const trimmedSearchQuery = searchQuery.trim();
  const canSearchPatients = isPatientSearchInputValid(searchQuery);

  const linkedPatientQuery = trpc.patients.getById.useQuery(
    { id: linkedPatientId || "00000000-0000-0000-0000-000000000000" },
    { enabled: Boolean(linkedPatientId) }
  );

  useEffect(() => {
    if (appliedVisitLink.current || !linkedPatientQuery.data) return;
    const linkedPatient = linkedPatientQuery.data;
    setSelectedPatient({
      id: linkedPatient.id,
      name: linkedPatient.name,
      species: linkedPatient.species,
      breed: linkedPatient.breed,
      clientFirstName: linkedPatient.clientFirstName,
      clientLastName: linkedPatient.clientLastName,
    });
    setSearchQuery(linkedPatient.name);
    const linkedTab = searchParams.get("tab");
    if (linkedTab === "prescriptions" || linkedTab === "labResults") {
      setActiveTab(linkedTab);
    }
    if (shouldOpenPrescription) {
      setShowPrescriptionForm(true);
    }
    appliedVisitLink.current = true;
  }, [linkedPatientQuery.data, searchParams, shouldOpenPrescription]);

  const {
    data: searchResults,
    isLoading: isSearchingPatients,
    error: patientSearchError,
  } = trpc.patients.search.useQuery(
    { query: trimmedSearchQuery },
    { enabled: canSearchPatients }
  );
  const patientSearchMissing =
    canSearchPatients &&
    !selectedPatient &&
    !isSearchingPatients &&
    !patientSearchError &&
    !searchResults;

  const patientId = selectedPatient?.id ?? "";
  const recordsSettings = trpc.records.settings.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const recordsSettingsError = recordsSettings.error;
  const recordsSettingsLoading = recordsSettings.isLoading;
  const recordsSettingsMissing =
    !recordsSettingsLoading && !recordsSettingsError && !recordsSettings.data;
  const verifiedRecordsSettings =
    recordsSettingsError || recordsSettingsMissing || !recordsSettings.data
      ? null
      : recordsSettings.data;
  const recordsTimeZone = verifiedRecordsSettings
    ? verifiedRecordsSettings.timezone
    : undefined;
  const recordsPracticeName =
    verifiedRecordsSettings?.name ?? "Veterinary Practice";
  const recordsPracticePhone = verifiedRecordsSettings
    ? verifiedRecordsSettings.phone
    : undefined;

  const {
    data: soapNotes,
    isLoading: isLoadingSoapNotes,
    error: soapNotesError,
  } = trpc.records.listSoapNotes.useQuery(
    { patientId },
    { enabled: !!patientId }
  );
  const soapNotesMissing =
    Boolean(patientId) && !isLoadingSoapNotes && !soapNotesError && !soapNotes;
  const correctSoap = trpc.records.markSoapNoteEnteredInError.useMutation({
    onSuccess: async () => {
      toast.success("SOAP note retained and marked entered in error");
      await utils.records.listSoapNotes.invalidate({ patientId });
    },
    onError: (error) => toast.error(error.message),
  });
  const {
    data: vaccinations,
    isLoading: isLoadingVaccinations,
    error: vaccinationsError,
    refetch: refetchVaccinations,
  } = trpc.records.listVaccinations.useQuery(
    { patientId },
    { enabled: !!patientId }
  );
  const vaccinationsMissing =
    Boolean(patientId) &&
    !isLoadingVaccinations &&
    !vaccinationsError &&
    !vaccinations;
  const correctVaccination =
    trpc.records.markVaccinationEnteredInError.useMutation({
      onSuccess: async () => {
        toast.success("Vaccination retained and marked entered in error");
        await utils.records.listVaccinations.invalidate({ patientId });
      },
      onError: (error) => toast.error(error.message),
    });
  const {
    data: prescriptionsList,
    isLoading: isLoadingPrescriptions,
    error: prescriptionsError,
    refetch: refetchPrescriptions,
  } =
    trpc.records.listPrescriptions.useQuery(
      { patientId },
      { enabled: !!patientId }
    );
  const prescriptionsMissing =
    Boolean(patientId) &&
    !isLoadingPrescriptions &&
    !prescriptionsError &&
    !prescriptionsList;
  const {
    data: problems,
    isLoading: isLoadingProblems,
    error: problemsError,
    refetch: refetchProblems,
  } = trpc.records.listProblems.useQuery(
    { patientId },
    { enabled: !!patientId }
  );
  const problemsMissing =
    Boolean(patientId) && !isLoadingProblems && !problemsError && !problems;
  const {
    data: labResultsList,
    isLoading: isLoadingLabResults,
    error: labResultsError,
    refetch: refetchLabResults,
  } =
    trpc.records.listLabResults.useQuery(
      { patientId },
      { enabled: !!patientId }
    );
  const labResultsMissing =
    Boolean(patientId) &&
    !isLoadingLabResults &&
    !labResultsError &&
    !labResultsList;
  const labTrendGroups = useMemo(
    () => buildLabTrends(labResultsList ?? [], recordsTimeZone),
    [labResultsList, recordsTimeZone]
  );
  const {
    data: proceduresList,
    isLoading: isLoadingProcedures,
    error: proceduresError,
    refetch: refetchProcedures,
  } =
    trpc.records.listProcedures.useQuery(
      { patientId },
      { enabled: !!patientId }
    );
  const proceduresMissing =
    Boolean(patientId) &&
    !isLoadingProcedures &&
    !proceduresError &&
    !proceduresList;
  const canPrescribe = userRole === "admin" || userRole === "veterinarian";
  const canCorrectClinicalRecords =
    userRole === "admin" || userRole === "veterinarian";
  const canCreateVaccinations =
    userRole === "admin" ||
    userRole === "veterinarian" ||
    userRole === "technician";
  const canManageProblems =
    userRole === "admin" ||
    userRole === "veterinarian" ||
    userRole === "technician";
  const canManageLabResults =
    userRole === "admin" ||
    userRole === "veterinarian" ||
    userRole === "technician";
  const canReviewLabResults =
    userRole === "admin" || userRole === "veterinarian";
  const canCreateProcedures =
    userRole === "admin" || userRole === "veterinarian";
  const medicationNameForSafety = prescriptionForm.medicationName.trim();
  const prescriptionSafetyEnabled =
    canPrescribe &&
    showPrescriptionForm &&
    !!patientId &&
    medicationNameForSafety.length >= 2;
  const prescriptionSafety = trpc.records.checkPrescriptionSafety.useQuery(
    { patientId, medicationName: medicationNameForSafety },
    {
      enabled: prescriptionSafetyEnabled,
    }
  );
  const prescriptionSafetyMissing =
    prescriptionSafetyEnabled &&
    !prescriptionSafety.isFetching &&
    !prescriptionSafety.error &&
    !prescriptionSafety.data;
  const prescriptionSafetyUnavailable =
    prescriptionSafetyEnabled &&
    (prescriptionSafety.isFetching ||
      Boolean(prescriptionSafety.error) ||
      prescriptionSafetyMissing ||
      !prescriptionSafety.data);
  const verifiedPrescriptionSafety =
    prescriptionSafetyEnabled &&
    !prescriptionSafetyUnavailable &&
    prescriptionSafety.data
      ? prescriptionSafety.data
      : null;
  const inventoryProducts = trpc.inventory.list.useQuery(
    { limit: 100, offset: 0 },
    {
      enabled: canPrescribe && showPrescriptionForm,
    }
  );
  const inventoryProductsMissing =
    canPrescribe &&
    showPrescriptionForm &&
    !inventoryProducts.isLoading &&
    !inventoryProducts.error &&
    !inventoryProducts.data;
  const verifiedInventoryProducts =
    inventoryProducts.error ||
    inventoryProductsMissing ||
    !inventoryProducts.data
      ? null
      : inventoryProducts.data;
  const selectedPrescriptionProduct = verifiedInventoryProducts
    ? verifiedInventoryProducts.items.find(
        (product) => product.id === prescriptionForm.productId
      )
    : undefined;
  const prescriptionQuantity = optionalNumber(prescriptionForm.quantity);
  const hasValidPrescriptionQuantityForInventory =
    !prescriptionForm.productId ||
    (isPrescriptionPositiveIntegerInputValid(prescriptionForm.quantity) &&
      selectedPrescriptionProduct !== undefined &&
      prescriptionQuantity !== undefined &&
      prescriptionQuantity <= selectedPrescriptionProduct.stockQuantity);
  const visibleTabs = tabs.filter(
    (tab) =>
      userRole !== "front_desk" || !frontDeskRestrictedTabs.includes(tab.id)
  );
  const currentTab = visibleTabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : visibleTabs[0]?.id;

  const createVaccination = trpc.records.createVaccination.useMutation({
    onSuccess: () => {
      toast.success("Vaccination recorded");
      refetchVaccinations();
      setShowVaccinationForm(false);
      setVaccinationForm(initialVaccinationForm());
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const createProblem = trpc.records.createProblem.useMutation({
    onSuccess: () => {
      toast.success("Problem added");
      refetchProblems();
      setShowProblemForm(false);
      setProblemForm(initialProblemForm());
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const updateProblemStatus = trpc.records.updateProblemStatus.useMutation({
    onSuccess: () => {
      toast.success("Problem status updated");
      refetchProblems();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const createLabResult = trpc.records.createLabResult.useMutation({
    onSuccess: async () => {
      toast.success("Lab result created");
      await Promise.all([
        refetchLabResults(),
        utils.records.listLabReviewInbox.invalidate(),
      ]);
      setShowLabForm(false);
      setLabForm(initialLabResultForm());
      labResultCreationOperationId.current = null;
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const updateLabResultStatus =
    trpc.records.updateLabResultStatus.useMutation({
      onSuccess: (result) => {
        toast.success("Lab result status updated");
        labReviewOperationIds.current.delete(result.id);
        refetchLabResults();
        utils.records.listLabReviewInbox.invalidate();
      },
      onError: (err) => {
        toast.error(err.message);
      },
    });
  const createProcedure = trpc.records.createProcedure.useMutation({
    onSuccess: () => {
      toast.success("Procedure recorded");
      refetchProcedures();
      setShowProcedureForm(false);
      setProcedureForm(initialProcedureForm());
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const createPrescription = trpc.records.createPrescription.useMutation({
    onSuccess: () => {
      toast.success("Prescription created");
      refetchPrescriptions();
      if (linkedAppointmentId) {
        utils.encounters.getCloseout.invalidate({
          appointmentId: linkedAppointmentId,
        });
      }
      setShowPrescriptionForm(false);
      setPrescriptionForm(initialPrescriptionForm(recordsTimeZone));
      prescriptionOperationId.current = null;
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const canSubmitVaccination =
    Boolean(patientId) &&
    isVaccinationRequiredTextInputValid(
      vaccinationForm.vaccineName,
      VACCINATION_NAME_MAX_LENGTH
    ) &&
    isVaccinationOptionalTextInputValid(
      vaccinationForm.lotNumber,
      VACCINATION_LOT_NUMBER_MAX_LENGTH
    ) &&
    isVaccinationOptionalTextInputValid(
      vaccinationForm.manufacturer,
      VACCINATION_MANUFACTURER_MAX_LENGTH
    ) &&
    isVaccinationOptionalDateInputValid(vaccinationForm.nextDueDate) &&
    !createVaccination.isPending;
  const canSubmitProblem =
    Boolean(patientId) &&
    isProblemRequiredTextInputValid(
      problemForm.description,
      PROBLEM_DESCRIPTION_MAX_LENGTH
    ) &&
    PROBLEM_STATUSES.includes(problemForm.status) &&
    isProblemOptionalDateInputValid(problemForm.onsetDate) &&
    !createProblem.isPending;
  const canSubmitLabResult =
    Boolean(patientId) &&
    isLabRequiredTextInputValid(labForm.testName, LAB_TEST_NAME_MAX_LENGTH) &&
    isLabOptionalTextInputValid(
      labForm.resultValue,
      LAB_RESULT_VALUE_MAX_LENGTH
    ) &&
    isLabOptionalTextInputValid(labForm.unit, LAB_UNIT_MAX_LENGTH) &&
    isLabOptionalReferenceInputValid(labForm.referenceRangeLow) &&
    isLabOptionalReferenceInputValid(labForm.referenceRangeHigh) &&
    isLabReferenceRangeOrdered(
      labForm.referenceRangeLow,
      labForm.referenceRangeHigh
    ) &&
    !createLabResult.isPending;
  const canSubmitProcedure =
    Boolean(patientId) &&
    isProcedureRequiredTextInputValid(
      procedureForm.name,
      PROCEDURE_NAME_MAX_LENGTH
    ) &&
    isProcedureOptionalTextInputValid(
      procedureForm.description,
      PROCEDURE_DESCRIPTION_MAX_LENGTH
    ) &&
    isProcedureOptionalTextInputValid(
      procedureForm.anesthesiaUsed,
      PROCEDURE_ANESTHESIA_MAX_LENGTH
    ) &&
    isProcedureOptionalDurationInputValid(procedureForm.durationMinutes) &&
    isProcedureOptionalTextInputValid(
      procedureForm.notes,
      PROCEDURE_NOTES_MAX_LENGTH
    ) &&
    !createProcedure.isPending;
  const canSubmitPrescription =
    isPrescriptionRequiredTextInputValid(
      prescriptionForm.medicationName,
      PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH
    ) &&
    isPrescriptionRequiredTextInputValid(
      prescriptionForm.dosage,
      PRESCRIPTION_DOSAGE_MAX_LENGTH
    ) &&
    isPrescriptionRequiredTextInputValid(
      prescriptionForm.frequency,
      PRESCRIPTION_FREQUENCY_MAX_LENGTH
    ) &&
    isPrescriptionOptionalPositiveIntegerInputValid(
      prescriptionForm.quantity
    ) &&
    isPrescriptionNonnegativeIntegerInputValid(
      prescriptionForm.refillsRemaining
    ) &&
    isPrescriptionOptionalTextInputValid(
      prescriptionForm.instructions,
      PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH
    ) &&
    Boolean(prescriptionForm.startDate) &&
    (!prescriptionForm.endDate ||
      prescriptionForm.endDate >= prescriptionForm.startDate) &&
    hasValidPrescriptionQuantityForInventory &&
    !prescriptionSafetyUnavailable &&
    (!verifiedPrescriptionSafety?.requiresOverride ||
      prescriptionForm.acknowledgeSafetyWarnings) &&
    !createPrescription.isPending;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">
            Medical Records
          </h2>
          <p className="text-sm text-muted-foreground">
            Clinical documentation and patient history
          </p>
        </div>
      </div>

      {/* Patient Search */}
      <div className="mt-6 relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search patients by name..."
            value={searchQuery}
            maxLength={PATIENT_SEARCH_MAX_LENGTH}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (!e.target.value) setSelectedPatient(null);
            }}
            className="pl-10"
          />
        </div>

        {/* Search Dropdown */}
        {canSearchPatients &&
          !selectedPatient &&
          (isSearchingPatients ||
            patientSearchError ||
            patientSearchMissing ||
            searchResults) && (
          <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-card shadow-lg">
            {patientSearchError || patientSearchMissing ? (
              <div className="px-4 py-3 text-sm text-destructive">
                {patientSearchError?.message ??
                  "Unable to search patients. Please retry."}
              </div>
            ) : isSearchingPatients ? (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Searching patients...
              </div>
            ) : searchResults && searchResults.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                No patients found
              </div>
            ) : (
              searchResults?.map((patient) => (
                <button
                  key={patient.id}
                  onClick={() => {
                    setSelectedPatient(patient);
                    setSearchQuery(patient.name);
                    setShowVaccinationForm(false);
                    setVaccinationForm(initialVaccinationForm());
                    setShowProblemForm(false);
                    setProblemForm(initialProblemForm());
                    setShowLabForm(false);
                    setLabForm(initialLabResultForm());
                    setShowProcedureForm(false);
                    setProcedureForm(initialProcedureForm());
                    setShowPrescriptionForm(false);
                    setPrescriptionForm(initialPrescriptionForm());
                  }}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-muted/50 first:rounded-t-lg last:rounded-b-lg transition-colors"
                >
                  <div>
                    <span className="font-medium">{patient.name}</span>
                    <span className="ml-2 text-muted-foreground">
                      {patient.species
                        ? patient.species.charAt(0).toUpperCase() +
                          patient.species.slice(1)
                        : ""}
                      {patient.breed ? ` - ${patient.breed}` : ""}
                    </span>
                  </div>
                  {patient.clientFirstName && (
                    <span className="text-xs text-muted-foreground">
                      Owner: {patient.clientFirstName}{" "}
                      {patient.clientLastName}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Selected Patient Banner */}
      {selectedPatient && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
          <div className="text-sm">
            <span className="font-medium">{selectedPatient.name}</span>
            <span className="ml-2 text-muted-foreground">
              {selectedPatient.species
                ? selectedPatient.species.charAt(0).toUpperCase() +
                  selectedPatient.species.slice(1)
                : ""}
              {selectedPatient.breed ? ` - ${selectedPatient.breed}` : ""}
            </span>
            {selectedPatient.clientFirstName && (
              <span className="ml-3 text-muted-foreground">
                Owner: {selectedPatient.clientFirstName}{" "}
                {selectedPatient.clientLastName}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedPatient(null);
              setSearchQuery("");
              setShowVaccinationForm(false);
              setVaccinationForm(initialVaccinationForm());
              setShowProblemForm(false);
              setProblemForm(initialProblemForm());
              setShowLabForm(false);
              setLabForm(initialLabResultForm());
              setShowProcedureForm(false);
              setProcedureForm(initialProcedureForm());
              setShowPrescriptionForm(false);
              setPrescriptionForm(initialPrescriptionForm());
            }}
          >
            Change Patient
          </Button>
        </div>
      )}

      {/* Tabs */}
      {selectedPatient && (
        <>
          <div className="mt-6 border-b border-border">
            <div className="flex gap-0">
              {visibleTabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      "relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors",
                      currentTab === tab.id
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                    {currentTab === tab.id && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tab Content */}
          <div className="mt-6">
            {recordsSettingsError || recordsSettingsMissing ? (
              <RecordsErrorPanel
                message={
                  recordsSettingsError
                    ? `Unable to load records settings. ${recordsSettingsError.message}`
                    : "Unable to load records settings. Please retry."
                }
              />
            ) : recordsSettingsLoading ? (
              <RecordsLoadingPanel label="Loading records settings..." />
            ) : (
              <>
            {/* SOAP Notes Tab */}
            {currentTab === "soap" && (
              <div>
                {soapNotesError || soapNotesMissing ? (
                  <RecordsErrorPanel
                    message={
                      soapNotesError
                        ? `Unable to load SOAP notes. ${soapNotesError.message}`
                        : "Unable to load SOAP notes. Please retry."
                    }
                  />
                ) : isLoadingSoapNotes ? (
                  <RecordsLoadingPanel label="Loading SOAP notes..." />
                ) : soapNotes && soapNotes.length > 0 ? (
                  <div className="space-y-3">
                    {soapNotes.map((note) => {
                      const isExpanded = expandedNoteId === note.id;
                      return (
                        <div
                          key={note.id}
                          className={cn(
                            "rounded-lg border border-border bg-card",
                            note.correctionId &&
                              "border-destructive/40 bg-destructive/5"
                          )}
                        >
                          <button
                            onClick={() =>
                              setExpandedNoteId(isExpanded ? null : note.id)
                            }
                            className="flex w-full items-center justify-between px-4 py-3 text-left"
                          >
                            <div className="flex items-center gap-4">
                              <FileText className="h-4 w-4 text-muted-foreground" />
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-medium">
                                    {note.createdAt
                                      ? formatClinicalDate(
                                          note.createdAt,
                                          recordsTimeZone
                                        )
                                      : "No date"}
                                  </p>
                                  {note.imported ? (
                                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                                      Imported
                                    </span>
                                  ) : null}
                                  {note.correctionId ? (
                                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                                      Entered in error
                                    </span>
                                  ) : null}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {note.imported
                                    ? note.authorName
                                      ? `Imported by ${note.authorName}`
                                      : "Imported record"
                                    : (note.authorName ?? "Unknown author")}
                                </p>
                              </div>
                              <p className="text-sm text-muted-foreground line-clamp-1 max-w-md">
                                {note.assessment ||
                                  note.subjective ||
                                  note.objective ||
                                  note.plan ||
                                  "No note recorded"}
                              </p>
                            </div>
                            {isExpanded ? (
                              <ChevronUp className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            )}
                          </button>
                          {isExpanded && (
                            <div className="border-t border-border px-4 py-4 space-y-4">
                              <div>
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                                  Subjective
                                </h4>
                                <p className="text-sm">
                                  {note.subjective || "--"}
                                </p>
                              </div>
                              <div>
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                                  Objective
                                </h4>
                                <p className="text-sm">
                                  {note.objective || "--"}
                                </p>
                              </div>
                              <div>
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                                  Assessment
                                </h4>
                                <p className="text-sm">
                                  {note.assessment || "--"}
                                </p>
                              </div>
                              <div>
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                                  Plan
                                </h4>
                                <p className="text-sm">{note.plan || "--"}</p>
                              </div>
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
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    icon={FileText}
                    title="No SOAP notes yet"
                    description="SOAP notes are created from an active visit so documentation stays attached to the correct encounter."
                  />
                )}
              </div>
            )}

            {/* Vaccinations Tab */}
            {currentTab === "vaccinations" && (
              <div>
                {canCreateVaccinations && (
                  <div className="mb-4 flex justify-end">
                    <Button
                      size="sm"
                      variant={showVaccinationForm ? "outline" : "default"}
                      onClick={() => {
                        if (showVaccinationForm) {
                          setVaccinationForm(initialVaccinationForm());
                        }
                        setShowVaccinationForm(!showVaccinationForm);
                      }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Vaccination
                    </Button>
                  </div>
                )}

                {canCreateVaccinations && showVaccinationForm && (
                  <form
                    className="mb-6 rounded-lg border border-border bg-card p-4 space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!canSubmitVaccination) return;
                      createVaccination.mutate({
                        patientId,
                        appointmentId:
                          linkedAppointmentId && linkedPatientId === patientId
                            ? linkedAppointmentId
                            : undefined,
                        vaccineName: vaccinationForm.vaccineName.trim(),
                        lotNumber:
                          vaccinationForm.lotNumber.trim() || undefined,
                        manufacturer:
                          vaccinationForm.manufacturer.trim() || undefined,
                        nextDueDate:
                          vaccinationForm.nextDueDate.trim() || undefined,
                      });
                    }}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2 sm:col-span-1">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Vaccine *
                        </label>
                        <Input
                          name="vaccineName"
                          required
                          value={vaccinationForm.vaccineName}
                          maxLength={VACCINATION_NAME_MAX_LENGTH}
                          onChange={(e) =>
                            setVaccinationForm((form) => ({
                              ...form,
                              vaccineName: e.target.value,
                            }))
                          }
                          placeholder="e.g. Rabies"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Next Due
                        </label>
                        <Input
                          name="nextDueDate"
                          type="date"
                          value={vaccinationForm.nextDueDate}
                          aria-invalid={
                            !isVaccinationOptionalDateInputValid(
                              vaccinationForm.nextDueDate
                            )
                          }
                          onChange={(e) =>
                            setVaccinationForm((form) => ({
                              ...form,
                              nextDueDate: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Lot Number
                        </label>
                        <Input
                          name="lotNumber"
                          value={vaccinationForm.lotNumber}
                          maxLength={VACCINATION_LOT_NUMBER_MAX_LENGTH}
                          onChange={(e) =>
                            setVaccinationForm((form) => ({
                              ...form,
                              lotNumber: e.target.value,
                            }))
                          }
                          placeholder="e.g. RAB-2026-04"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Manufacturer
                        </label>
                        <Input
                          name="manufacturer"
                          value={vaccinationForm.manufacturer}
                          maxLength={VACCINATION_MANUFACTURER_MAX_LENGTH}
                          onChange={(e) =>
                            setVaccinationForm((form) => ({
                              ...form,
                              manufacturer: e.target.value,
                            }))
                          }
                          placeholder="e.g. Zoetis"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!canSubmitVaccination}
                      >
                        {createVaccination.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowVaccinationForm(false);
                          setVaccinationForm(initialVaccinationForm());
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}

                {vaccinationsError || vaccinationsMissing ? (
                  <RecordsErrorPanel
                    message={
                      vaccinationsError
                        ? `Unable to load vaccination records. ${vaccinationsError.message}`
                        : "Unable to load vaccination records. Please retry."
                    }
                  />
                ) : isLoadingVaccinations ? (
                  <RecordsLoadingPanel label="Loading vaccinations..." />
                ) : vaccinations && vaccinations.length > 0 ? (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/50">
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Vaccine
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Date Administered
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Next Due
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Administered By
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Status
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {vaccinations.map((vax) => {
                          const dueStatus = getVaccineDueStatus(
                            vax.nextDueDate,
                            recordsTimeZone
                          );
                          return (
                            <tr
                              key={vax.id}
                              className={cn(
                                "border-b border-border last:border-0",
                                vax.correctionId &&
                                  "bg-destructive/5 text-muted-foreground"
                              )}
                            >
                              <td className="px-4 py-3 font-medium">
                                {vax.vaccineName}
                              </td>
                              <td className="px-4 py-3">
                                {vax.administeredAt
                                  ? formatClinicalDate(
                                      vax.administeredAt,
                                      recordsTimeZone
                                    )
                                  : "--"}
                              </td>
                              <td className="px-4 py-3">
                                {vax.nextDueDate
                                  ? formatClinicalDate(
                                      vax.nextDueDate,
                                      recordsTimeZone
                                    )
                                  : "--"}
                              </td>
                              <td className="px-4 py-3 text-muted-foreground">
                                {vax.administeredByName ?? "--"}
                              </td>
                              <td className="px-4 py-3">
                                {vax.correctionId ? (
                                  <span className="inline-flex items-center rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                                    Entered in error
                                  </span>
                                ) : (
                                  <span
                                    className={cn(
                                      "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                                      dueStatus.className
                                    )}
                                  >
                                    {dueStatus.label}
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
                                          correctedByName:
                                            vax.correctedByName,
                                        }
                                      : null
                                  }
                                  canCorrect={canCorrectClinicalRecords}
                                  isPending={
                                    correctVaccination.isPending &&
                                    correctVaccination.variables?.recordId ===
                                      vax.id
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
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState
                    icon={Syringe}
                    title="No vaccination records yet"
                  />
                )}
              </div>
            )}

            {/* Prescriptions Tab */}
            {currentTab === "prescriptions" && (
              <div>
                {canPrescribe && (
                  <div className="mb-4 flex justify-end">
                    <Button
                      size="sm"
                      variant={showPrescriptionForm ? "outline" : "default"}
                      onClick={() => {
                        if (showPrescriptionForm) {
                          prescriptionOperationId.current = null;
                          setShowPrescriptionForm(false);
                          setPrescriptionForm((current) => ({
                            ...current,
                            acknowledgeSafetyWarnings: false,
                          }));
                          return;
                        }
                        prescriptionOperationId.current = null;
                        setShowPrescriptionForm(true);
                        setPrescriptionForm(
                          initialPrescriptionForm(recordsTimeZone)
                        );
                      }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      New Prescription
                    </Button>
                  </div>
                )}

                {canPrescribe && showPrescriptionForm && (
                  <form
                    className="mb-6 rounded-lg border border-border bg-card p-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const warnings =
                        verifiedPrescriptionSafety?.warnings ?? [];
                      const requiresOverride =
                        verifiedPrescriptionSafety?.requiresOverride ?? false;
                      if (
                        requiresOverride &&
                        !prescriptionForm.acknowledgeSafetyWarnings
                      ) {
                        toast.error(
                          "Acknowledge prescription safety warnings before saving."
                        );
                        return;
                      }
                      if (!canSubmitPrescription) return;

                      prescriptionOperationId.current ??= crypto.randomUUID();
                      createPrescription.mutate({
                        patientId,
                        operationId: prescriptionOperationId.current,
                        appointmentId:
                          linkedAppointmentId && linkedPatientId === patientId
                            ? linkedAppointmentId
                            : undefined,
                        medicationName:
                          prescriptionForm.medicationName.trim(),
                        productId: prescriptionForm.productId || undefined,
                        dosage: prescriptionForm.dosage.trim(),
                        frequency: prescriptionForm.frequency.trim(),
                        quantity: optionalNumber(prescriptionForm.quantity),
                        refillsRemaining:
                          optionalNumber(
                            prescriptionForm.refillsRemaining
                          ) ?? 0,
                        startDate: prescriptionForm.startDate,
                        endDate:
                          prescriptionForm.endDate.trim() || undefined,
                        instructions:
                          prescriptionForm.instructions.trim() || undefined,
                        acknowledgeSafetyWarnings:
                          warnings.length > 0 &&
                          prescriptionForm.acknowledgeSafetyWarnings,
                      });
                    }}
                  >
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Medication *
                        </label>
                        <Input
                          required
                          value={prescriptionForm.medicationName}
                          maxLength={PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH}
                          onChange={(e) =>
                            setPrescriptionForm((current) => ({
                              ...current,
                              medicationName: e.target.value,
                              acknowledgeSafetyWarnings: false,
                            }))
                          }
                          placeholder="e.g. Carprofen"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Inventory Item
                        </label>
                        <select
                          value={prescriptionForm.productId}
                          onChange={(e) => {
                            const productId = e.target.value;
                            const selectedProduct = verifiedInventoryProducts
                              ? verifiedInventoryProducts.items.find(
                                  (product) => product.id === productId
                                )
                              : undefined;
                            setPrescriptionForm((current) => ({
                              ...current,
                              productId,
                              medicationName:
                                selectedProduct && !current.medicationName.trim()
                                  ? selectedProduct.name
                                  : current.medicationName,
                              acknowledgeSafetyWarnings: false,
                            }));
                          }}
                          className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">Not dispensed from inventory</option>
                          {inventoryProducts.isLoading ? (
                            <option disabled>Loading inventory...</option>
                          ) : null}
                          {inventoryProducts.error || inventoryProductsMissing ? (
                            <option disabled>Inventory unavailable</option>
                          ) : null}
                          {verifiedInventoryProducts
                            ? verifiedInventoryProducts.items.map((product) => (
                                <option key={product.id} value={product.id}>
                                  {product.name} ({product.stockQuantity} on
                                  hand)
                                </option>
                              ))
                            : null}
                        </select>
                        {inventoryProducts.error || inventoryProductsMissing ? (
                          <p className="mt-1 text-xs text-destructive">
                            {inventoryProducts.error?.message ??
                              "Unable to load inventory products. Please retry."}
                          </p>
                        ) : prescriptionForm.productId &&
                          selectedPrescriptionProduct ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Stock will be deducted by the dispensed quantity.
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Dosage *
                        </label>
                        <Input
                          required
                          value={prescriptionForm.dosage}
                          maxLength={PRESCRIPTION_DOSAGE_MAX_LENGTH}
                          onChange={(e) =>
                            setPrescriptionForm((current) => ({
                              ...current,
                              dosage: e.target.value,
                            }))
                          }
                          placeholder="e.g. 75 mg"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Frequency *
                        </label>
                        <Input
                          required
                          value={prescriptionForm.frequency}
                          maxLength={PRESCRIPTION_FREQUENCY_MAX_LENGTH}
                          onChange={(e) =>
                            setPrescriptionForm((current) => ({
                              ...current,
                              frequency: e.target.value,
                            }))
                          }
                          placeholder="e.g. Every 12 hours"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Quantity
                        </label>
                        <Input
                          type="number"
                          min={PRESCRIPTION_QUANTITY_MIN}
                          max={PRESCRIPTION_COUNT_MAX}
                          step={1}
                          value={prescriptionForm.quantity}
                          onChange={(e) =>
                            setPrescriptionForm((current) => ({
                              ...current,
                              quantity: e.target.value,
                            }))
                          }
                          placeholder="e.g. 30"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Refills
                        </label>
                        <Input
                          type="number"
                          min={PRESCRIPTION_REFILLS_MIN}
                          max={PRESCRIPTION_COUNT_MAX}
                          step={1}
                          value={prescriptionForm.refillsRemaining}
                          onChange={(e) =>
                            setPrescriptionForm((current) => ({
                              ...current,
                              refillsRemaining: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Start Date *
                        </label>
                        <Input
                          type="date"
                          required
                          value={prescriptionForm.startDate}
                          onChange={(e) =>
                            setPrescriptionForm((current) => ({
                              ...current,
                              startDate: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          End Date
                        </label>
                        <Input
                          type="date"
                          value={prescriptionForm.endDate}
                          min={prescriptionForm.startDate || undefined}
                          onChange={(e) =>
                            setPrescriptionForm((current) => ({
                              ...current,
                              endDate: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Instructions
                        </label>
                        <Input
                          value={prescriptionForm.instructions}
                          maxLength={PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH}
                          onChange={(e) =>
                            setPrescriptionForm((current) => ({
                              ...current,
                              instructions: e.target.value,
                            }))
                          }
                          placeholder="Give with food"
                        />
                      </div>
                    </div>

                    <div className="mt-4 space-y-3">
                      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        Controlled-substance recordkeeping is not automated.
                        When applicable, complete the clinic&apos;s required
                        controlled drug log separately.
                      </p>
                      <PrescriptionSafetyPanel
                        medicationName={medicationNameForSafety}
                        isLoading={prescriptionSafety.isFetching}
                        errorMessage={
                          prescriptionSafety.error?.message ??
                          (prescriptionSafetyMissing
                            ? "Please retry."
                            : undefined)
                        }
                        warnings={verifiedPrescriptionSafety?.warnings ?? []}
                      />

                      {verifiedPrescriptionSafety?.requiresOverride && (
                        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                          <Checkbox
                            checked={
                              prescriptionForm.acknowledgeSafetyWarnings
                            }
                            onChange={(e) =>
                              setPrescriptionForm((current) => ({
                                ...current,
                                acknowledgeSafetyWarnings:
                                  e.currentTarget.checked,
                              }))
                            }
                            className="mt-0.5"
                          />
                          <span>
                            Clinician reviewed and accepts these prescription
                            safety warnings.
                          </span>
                        </label>
                      )}
                    </div>

                    <div className="mt-4 flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!canSubmitPrescription}
                      >
                        {createPrescription.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        Save Prescription
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          prescriptionOperationId.current = null;
                          setShowPrescriptionForm(false);
                          setPrescriptionForm(
                            initialPrescriptionForm(recordsTimeZone)
                          );
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}

                {prescriptionsError || prescriptionsMissing ? (
                  <RecordsErrorPanel
                    message={
                      prescriptionsError
                        ? `Unable to load prescriptions. ${prescriptionsError.message}`
                        : "Unable to load prescriptions. Please retry."
                    }
                  />
                ) : isLoadingPrescriptions ? (
                  <RecordsLoadingPanel label="Loading prescriptions..." />
                ) : prescriptionsList && prescriptionsList.length > 0 ? (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/50">
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Medication
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Dosage
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Frequency
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Inventory
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Status
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Refills
                          </th>
                          <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {prescriptionsList.map((rx) => (
                          <tr
                            key={rx.id}
                            className="border-b border-border last:border-0"
                          >
                            <td className="px-4 py-3 font-medium">
                              {rx.medicationName}
                            </td>
                            <td className="px-4 py-3">{rx.dosage ?? "--"}</td>
                            <td className="px-4 py-3">
                              {rx.frequency ?? "--"}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {rx.productName ? (
                                <span>
                                  {rx.productName}
                                  {rx.quantity != null ? (
                                    <span className="block text-xs">
                                      Dispensed {rx.quantity}
                                    </span>
                                  ) : null}
                                </span>
                              ) : (
                                "--"
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={cn(
                                  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
                                  getPrescriptionStatusBadge(rx.effectiveStatus)
                                )}
                              >
                                {rx.effectiveStatus ?? "unknown"}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {rx.refillsRemaining ?? 0}
                            </td>
                            <td className="space-y-2 px-4 py-3 text-right align-top">
                              <div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title={
                                    rx.effectiveStatus === "active"
                                      ? "Print Label"
                                      : "Only active prescriptions can print a dispensing label"
                                  }
                                  disabled={rx.effectiveStatus !== "active"}
                                  onClick={async () => {
                                  const clientName = [
                                    selectedPatient?.clientFirstName,
                                    selectedPatient?.clientLastName,
                                  ]
                                    .filter(Boolean)
                                    .join(" ");
                                  const { generatePrescriptionLabelPdf } =
                                    await import("@/lib/pdf");
                                  generatePrescriptionLabelPdf({
                                    practiceName: recordsPracticeName,
                                    practicePhone:
                                      recordsPracticePhone ?? undefined,
                                    patientName: selectedPatient?.name ?? "",
                                    clientName,
                                    species: selectedPatient?.species ?? "",
                                    medicationName: rx.medicationName,
                                    dosage: rx.dosage ?? "",
                                    frequency: rx.frequency ?? "",
                                    instructions: rx.instructions ?? undefined,
                                    prescribedBy: rx.prescriberName ?? "",
                                    startDate: rx.startDate
                                      ? formatClinicalDate(
                                          rx.startDate,
                                          recordsTimeZone
                                        )
                                      : formatClinicalDate(
                                          dateInputValue(
                                            new Date(),
                                            recordsTimeZone
                                          ),
                                          recordsTimeZone
                                        ),
                                    quantity: rx.quantity != null ? String(rx.quantity) : undefined,
                                    refillsRemaining: rx.refillsRemaining ?? undefined,
                                  }).save(
                                    `label-${rx.medicationName.replace(/\s+/g, "-").toLowerCase()}.pdf`
                                  );
                                  }}
                                >
                                  <Tag className="mr-1 h-3.5 w-3.5" />
                                  Print Label
                                </Button>
                              </div>
                              <PrescriptionLifecycleControl
                                prescription={{
                                  id: rx.id,
                                  effectiveStatus: rx.effectiveStatus,
                                  productId: rx.productId,
                                  quantity: rx.quantity,
                                  refillsRemaining: rx.refillsRemaining,
                                }}
                                canManage={canPrescribe}
                                timeZone={recordsTimeZone}
                                onChanged={async () => {
                                  await refetchPrescriptions();
                                  if (linkedAppointmentId) {
                                    await utils.encounters.getCloseout.invalidate({
                                      appointmentId: linkedAppointmentId,
                                    });
                                  }
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState icon={Pill} title="No prescriptions yet" />
                )}
              </div>
            )}

            {/* Problems Tab */}
            {currentTab === "problems" && (
              <div>
                {canManageProblems && (
                  <div className="mb-4 flex justify-end">
                    <Button
                      size="sm"
                      variant={showProblemForm ? "outline" : "default"}
                      onClick={() => {
                        if (showProblemForm) {
                          setProblemForm(initialProblemForm());
                        }
                        setShowProblemForm(!showProblemForm);
                      }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Problem
                    </Button>
                  </div>
                )}

                {canManageProblems && showProblemForm && (
                  <form
                    className="mb-6 rounded-lg border border-border bg-card p-4 space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!canSubmitProblem) return;
                      createProblem.mutate({
                        patientId,
                        description: problemForm.description.trim(),
                        status: problemForm.status,
                        onsetDate: problemForm.onsetDate.trim() || undefined,
                      });
                    }}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Problem *
                        </label>
                        <Input
                          name="description"
                          required
                          value={problemForm.description}
                          maxLength={PROBLEM_DESCRIPTION_MAX_LENGTH}
                          onChange={(e) =>
                            setProblemForm((form) => ({
                              ...form,
                              description: e.target.value,
                            }))
                          }
                          placeholder="e.g. Chronic otitis"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Status
                        </label>
                        <select
                          name="status"
                          value={problemForm.status}
                          onChange={(e) =>
                            setProblemForm((form) => ({
                              ...form,
                              status: e.target.value as ProblemStatus,
                            }))
                          }
                          className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          {PROBLEM_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status.charAt(0).toUpperCase() + status.slice(1)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Onset Date
                        </label>
                        <Input
                          name="onsetDate"
                          type="date"
                          value={problemForm.onsetDate}
                          aria-invalid={
                            !isProblemOptionalDateInputValid(
                              problemForm.onsetDate
                            )
                          }
                          onChange={(e) =>
                            setProblemForm((form) => ({
                              ...form,
                              onsetDate: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!canSubmitProblem}
                      >
                        {createProblem.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowProblemForm(false);
                          setProblemForm(initialProblemForm());
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}

                {problemsError || problemsMissing ? (
                  <RecordsErrorPanel
                    message={
                      problemsError
                        ? `Unable to load problems. ${problemsError.message}`
                        : "Unable to load problems. Please retry."
                    }
                  />
                ) : isLoadingProblems ? (
                  <RecordsLoadingPanel label="Loading problems..." />
                ) : problems && problems.length > 0 ? (
                  <div className="space-y-2">
                    {problems.map((problem) => (
                      <div
                        key={problem.id}
                        className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <p
                            className={cn(
                              "text-sm",
                              problem.status === "active"
                                ? "font-semibold"
                                : "font-normal"
                            )}
                          >
                            {problem.description}
                          </p>
                          {problem.onsetDate && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Onset:{" "}
                              {formatClinicalDate(
                                problem.onsetDate,
                                recordsTimeZone
                              )}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
                              problem.status === "active"
                                ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                                : problem.status === "chronic"
                                  ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                                  : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                            )}
                          >
                            {problem.status ?? "active"}
                          </span>
                          {canManageProblems && (
                            <div className="flex flex-wrap gap-1">
                              {problem.status !== "active" && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={updateProblemStatus.isPending}
                                  onClick={() =>
                                    updateProblemStatus.mutate({
                                      id: problem.id,
                                      status: "active",
                                    })
                                  }
                                >
                                  Reopen
                                </Button>
                              )}
                              {problem.status !== "chronic" && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={updateProblemStatus.isPending}
                                  onClick={() =>
                                    updateProblemStatus.mutate({
                                      id: problem.id,
                                      status: "chronic",
                                    })
                                  }
                                >
                                  Chronic
                                </Button>
                              )}
                              {problem.status !== "resolved" && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={updateProblemStatus.isPending}
                                  onClick={() =>
                                    updateProblemStatus.mutate({
                                      id: problem.id,
                                      status: "resolved",
                                    })
                                  }
                                >
                                  Resolve
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={ClipboardList}
                    title="No problems recorded"
                  />
                )}
              </div>
            )}

            {/* Lab Results Tab */}
            {currentTab === "labResults" && (
              <div>
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-medium">
                        Manual lab entry only
                      </p>
                      <p className="mt-1 text-xs leading-5 text-amber-900 dark:text-amber-200">
                        Reference lab ordering is disabled until IDEXX, Antech,
                        or Zoetis provider credentials and a real adapter are
                        connected.
                      </p>
                    </div>
                  </div>
                  {canManageLabResults && (
                    <Button
                      size="sm"
                      onClick={() => {
                        if (showLabForm) setLabForm(initialLabResultForm());
                        setShowLabForm(!showLabForm);
                      }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Manual Lab Result
                    </Button>
                  )}
                </div>

                {canManageLabResults && showLabForm && (
                  <form
                    className="mb-6 rounded-lg border border-border bg-card p-4 space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!canSubmitLabResult) return;
                      labResultCreationOperationId.current ??= crypto.randomUUID();
                      createLabResult.mutate({
                        patientId,
                        appointmentId:
                          linkedAppointmentId && linkedPatientId === patientId
                            ? linkedAppointmentId
                            : undefined,
                        testName: labForm.testName.trim(),
                        resultValue: labForm.resultValue.trim() || undefined,
                        unit: labForm.unit.trim() || undefined,
                        referenceRangeLow:
                          labForm.referenceRangeLow.trim() || undefined,
                        referenceRangeHigh:
                          labForm.referenceRangeHigh.trim() || undefined,
                        status: labForm.resultValue.trim()
                          ? "completed"
                          : "pending",
                        resultFlag: labForm.resultValue.trim()
                          ? labForm.resultFlag
                          : "unknown",
                        operationId: labResultCreationOperationId.current,
                      });
                    }}
                  >
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                      <div className="col-span-2 sm:col-span-1">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Test Name *
                        </label>
                        <Input
                          name="testName"
                          required
                          value={labForm.testName}
                          maxLength={LAB_TEST_NAME_MAX_LENGTH}
                          onChange={(e) =>
                            setLabForm((form) => ({
                              ...form,
                              testName: e.target.value,
                            }))
                          }
                          placeholder="e.g. CBC"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Result Value
                        </label>
                        <Input
                          name="resultValue"
                          value={labForm.resultValue}
                          maxLength={LAB_RESULT_VALUE_MAX_LENGTH}
                          onChange={(e) =>
                            setLabForm((form) => ({
                              ...form,
                              resultValue: e.target.value,
                            }))
                          }
                          placeholder="e.g. 12.5"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="lab-result-flag"
                          className="block text-xs font-medium text-muted-foreground mb-1"
                        >
                          Clinical flag
                        </label>
                        <select
                          id="lab-result-flag"
                          value={labForm.resultFlag}
                          disabled={!labForm.resultValue.trim()}
                          onChange={(event) =>
                            setLabForm((form) => ({
                              ...form,
                              resultFlag: event.target.value as LabResultFormState["resultFlag"],
                            }))
                          }
                          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="unknown">Not assessed</option>
                          <option value="normal">Normal</option>
                          <option value="abnormal">Abnormal</option>
                          <option value="critical">Critical</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Unit
                        </label>
                        <Input
                          name="unit"
                          value={labForm.unit}
                          maxLength={LAB_UNIT_MAX_LENGTH}
                          onChange={(e) =>
                            setLabForm((form) => ({
                              ...form,
                              unit: e.target.value,
                            }))
                          }
                          placeholder="e.g. mg/dL"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Ref. Range Low
                        </label>
                        <Input
                          name="referenceRangeLow"
                          type="number"
                          value={labForm.referenceRangeLow}
                          min={LAB_REFERENCE_MIN}
                          max={LAB_REFERENCE_MAX}
                          step={LAB_REFERENCE_STEP}
                          aria-invalid={
                            !isLabOptionalReferenceInputValid(
                              labForm.referenceRangeLow
                            )
                          }
                          onChange={(e) =>
                            setLabForm((form) => ({
                              ...form,
                              referenceRangeLow: e.target.value,
                            }))
                          }
                          placeholder="e.g. 7.0"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Ref. Range High
                        </label>
                        <Input
                          name="referenceRangeHigh"
                          type="number"
                          value={labForm.referenceRangeHigh}
                          min={LAB_REFERENCE_MIN}
                          max={LAB_REFERENCE_MAX}
                          step={LAB_REFERENCE_STEP}
                          aria-invalid={
                            !isLabOptionalReferenceInputValid(
                              labForm.referenceRangeHigh
                            ) ||
                            !isLabReferenceRangeOrdered(
                              labForm.referenceRangeLow,
                              labForm.referenceRangeHigh
                            )
                          }
                          onChange={(e) =>
                            setLabForm((form) => ({
                              ...form,
                              referenceRangeHigh: e.target.value,
                            }))
                          }
                          placeholder="e.g. 27.0"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Entering a value records this result as completed and sends it to the clinic Lab Inbox for review. A result without values stays pending.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!canSubmitLabResult}
                      >
                        {createLabResult.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowLabForm(false);
                          setLabForm(initialLabResultForm());
                          labResultCreationOperationId.current = null;
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}

                {labResultsError || labResultsMissing ? (
                  <RecordsErrorPanel
                    message={
                      labResultsError
                        ? `Unable to load lab results. ${labResultsError.message}`
                        : "Unable to load lab results. Please retry."
                    }
                  />
                ) : isLoadingLabResults ? (
                  <RecordsLoadingPanel label="Loading lab results..." />
                ) : labResultsList && labResultsList.length > 0 ? (
                  <div className="space-y-4">
                    {labTrendGroups.length > 0 && (
                      <LabTrendCharts groups={labTrendGroups} />
                    )}
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/50">
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Test Name
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Result
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Unit
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Reference Range
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Status
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Review evidence
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Ordered By
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Date
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {labResultsList.map((lab) => {
                            const outOfRange = isOutOfRange(
                              lab.resultValue,
                              lab.referenceRangeLow,
                              lab.referenceRangeHigh
                            );
                            return (
                              <tr
                                key={lab.id}
                                className="border-b border-border last:border-0"
                              >
                                <td className="px-4 py-3 font-medium">
                                  {lab.testName}
                                </td>
                                <td
                                  className={cn(
                                    "px-4 py-3",
                                    outOfRange
                                      ? "text-red-600 font-semibold dark:text-red-400"
                                      : ""
                                  )}
                                >
                                  {lab.resultValue ?? "--"}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                  {lab.unit ?? "--"}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                  {lab.referenceRangeLow != null &&
                                  lab.referenceRangeHigh != null
                                    ? `${lab.referenceRangeLow} - ${lab.referenceRangeHigh}`
                                    : "--"}
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex flex-col items-start gap-1">
                                    <span
                                      className={cn(
                                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
                                        getLabStatusBadge(lab.status)
                                      )}
                                    >
                                      {lab.status}
                                    </span>
                                    {lab.resultFlag !== "unknown" ? (
                                      <span className={cn(
                                        "text-xs font-medium capitalize",
                                        lab.resultFlag === "critical"
                                          ? "text-red-700 dark:text-red-300"
                                          : lab.resultFlag === "abnormal"
                                            ? "text-amber-700 dark:text-amber-300"
                                            : "text-emerald-700 dark:text-emerald-300",
                                      )}>
                                        {lab.resultFlag}
                                      </span>
                                    ) : null}
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-xs text-muted-foreground">
                                  {lab.completedAt ? (
                                    <span className="block">
                                      Completed {formatClinicalDate(lab.completedAt, recordsTimeZone)} · {lab.completionActorName ?? "actor unavailable (legacy)"}
                                    </span>
                                  ) : (
                                    "Awaiting values"
                                  )}
                                  {lab.reviewedAt ? (
                                    <span className="mt-1 block">
                                      Reviewed {formatClinicalDate(lab.reviewedAt, recordsTimeZone)}{lab.reviewedByName ? ` by ${lab.reviewedByName}` : ""}
                                    </span>
                                  ) : null}
                                  {lab.followUpStatus === "open" ? (
                                    <span className="mt-1 block font-medium text-amber-700 dark:text-amber-300">
                                      Follow-up: {lab.followUpAssigneeName ?? "assigned"}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                  {lab.orderedByName ?? "--"}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                  {lab.createdAt
                                    ? formatClinicalDate(
                                        lab.createdAt,
                                        recordsTimeZone
                                      )
                                    : "--"}
                                </td>
                                <td className="px-4 py-3">
                                  {canReviewLabResults &&
                                  lab.status === "completed" &&
                                  (lab.resultFlag !== "critical" ||
                                    lab.followUpStatus !== "not_required") ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        updateLabResultStatus.mutate({
                                          id: lab.id,
                                          status: "reviewed",
                                          operationId:
                                            labReviewOperationIds.current.get(lab.id) ??
                                            (() => {
                                              const operationId = crypto.randomUUID();
                                              labReviewOperationIds.current.set(lab.id, operationId);
                                              return operationId;
                                            })(),
                                        })
                                      }
                                      disabled={
                                        updateLabResultStatus.isPending
                                      }
                                    >
                                      Mark Reviewed
                                    </Button>
                                  ) : lab.status === "completed" &&
                                    lab.resultFlag === "critical" &&
                                    lab.followUpStatus === "not_required" &&
                                    canManageLabResults ? (
                                    <Button asChild variant="ghost" size="sm">
                                      <Link href={`/lab-results?resultId=${lab.id}`}>
                                        Assign follow-up
                                      </Link>
                                    </Button>
                                  ) : lab.status === "pending" && canManageLabResults ? (
                                    <Button asChild variant="ghost" size="sm">
                                      <Link href={`/lab-results?resultId=${lab.id}`}>
                                        Open selected result
                                      </Link>
                                    </Button>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <EmptyState icon={FlaskConical} title="No lab results yet" />
                )}
              </div>
            )}

            {/* Procedures Tab */}
            {currentTab === "procedures" && (
              <div>
                {canCreateProcedures && (
                  <div className="flex justify-end mb-4">
                    <Button
                      size="sm"
                      onClick={() => {
                        if (showProcedureForm) {
                          setProcedureForm(initialProcedureForm());
                        }
                        setShowProcedureForm(!showProcedureForm);
                      }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Procedure
                    </Button>
                  </div>
                )}

                {canCreateProcedures && showProcedureForm && (
                  <form
                    className="mb-6 rounded-lg border border-border bg-card p-4 space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!canSubmitProcedure) return;
                      const durationMinutes =
                        procedureForm.durationMinutes.trim();
                      createProcedure.mutate({
                        patientId,
                        appointmentId:
                          linkedAppointmentId && linkedPatientId === patientId
                            ? linkedAppointmentId
                            : undefined,
                        name: procedureForm.name.trim(),
                        description:
                          procedureForm.description.trim() || undefined,
                        anesthesiaUsed:
                          procedureForm.anesthesiaUsed.trim() || undefined,
                        durationMinutes: durationMinutes
                          ? Number(durationMinutes)
                          : undefined,
                        notes: procedureForm.notes.trim() || undefined,
                      });
                    }}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2 sm:col-span-1">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Name *
                        </label>
                        <Input
                          name="name"
                          required
                          value={procedureForm.name}
                          maxLength={PROCEDURE_NAME_MAX_LENGTH}
                          onChange={(e) =>
                            setProcedureForm((form) => ({
                              ...form,
                              name: e.target.value,
                            }))
                          }
                          placeholder="e.g. Dental Prophylaxis"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Duration (minutes)
                        </label>
                        <Input
                          name="durationMinutes"
                          type="number"
                          value={procedureForm.durationMinutes}
                          min={PROCEDURE_DURATION_MIN_MINUTES}
                          max={PROCEDURE_DURATION_MAX_MINUTES}
                          step={1}
                          aria-invalid={
                            !isProcedureOptionalDurationInputValid(
                              procedureForm.durationMinutes
                            )
                          }
                          onChange={(e) =>
                            setProcedureForm((form) => ({
                              ...form,
                              durationMinutes: e.target.value,
                            }))
                          }
                          placeholder="e.g. 45"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Description
                        </label>
                        <Input
                          name="description"
                          value={procedureForm.description}
                          maxLength={PROCEDURE_DESCRIPTION_MAX_LENGTH}
                          onChange={(e) =>
                            setProcedureForm((form) => ({
                              ...form,
                              description: e.target.value,
                            }))
                          }
                          placeholder="Brief description of the procedure"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Anesthesia Used
                        </label>
                        <Input
                          name="anesthesiaUsed"
                          value={procedureForm.anesthesiaUsed}
                          maxLength={PROCEDURE_ANESTHESIA_MAX_LENGTH}
                          onChange={(e) =>
                            setProcedureForm((form) => ({
                              ...form,
                              anesthesiaUsed: e.target.value,
                            }))
                          }
                          placeholder="e.g. Isoflurane"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Notes
                        </label>
                        <Input
                          name="notes"
                          value={procedureForm.notes}
                          maxLength={PROCEDURE_NOTES_MAX_LENGTH}
                          onChange={(e) =>
                            setProcedureForm((form) => ({
                              ...form,
                              notes: e.target.value,
                            }))
                          }
                          placeholder="Additional notes"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!canSubmitProcedure}
                      >
                        {createProcedure.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowProcedureForm(false);
                          setProcedureForm(initialProcedureForm());
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}

                {proceduresError || proceduresMissing ? (
                  <RecordsErrorPanel
                    message={
                      proceduresError
                        ? `Unable to load procedures. ${proceduresError.message}`
                        : "Unable to load procedures. Please retry."
                    }
                  />
                ) : isLoadingProcedures ? (
                  <RecordsLoadingPanel label="Loading procedures..." />
                ) : proceduresList && proceduresList.length > 0 ? (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/50">
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Name
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Performed By
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Duration
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Anesthesia
                          </th>
                          <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                            Date
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {proceduresList.map((proc) => (
                          <tr
                            key={proc.id}
                            className="border-b border-border last:border-0"
                          >
                            <td className="px-4 py-3">
                              <p className="font-medium">{proc.name}</p>
                              {proc.description && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {proc.description}
                                </p>
                              )}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {proc.performedByName ?? "--"}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {proc.durationMinutes
                                ? `${proc.durationMinutes} min`
                                : "--"}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {proc.anesthesiaUsed ?? "--"}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {proc.createdAt
                                ? formatClinicalDate(
                                    proc.createdAt,
                                    recordsTimeZone
                                  )
                                : "--"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState icon={Scissors} title="No procedures recorded" />
                )}
              </div>
            )}
              </>
            )}
          </div>
        </>
      )}

      {/* Prompt to search if no patient selected */}
      {!selectedPatient && (
        <EmptyState
          className="mt-6"
          icon={Search}
          title="Search for a patient above to view their medical records"
        />
      )}
    </div>
  );
}

export default function RecordsPage() {
  return (
    <Suspense fallback={<RecordsLoadingPanel label="Loading records..." />}>
      <RecordsPageContent />
    </Suspense>
  );
}
