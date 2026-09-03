"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Pill,
  Plus,
  Syringe,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  VaccinationFormFields,
  initialVaccinationForm,
  isVaccinationFormValid,
} from "@/components/records/vaccination-form-fields";
import { trpc } from "@/lib/trpc";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { useOnlineStatus } from "@/lib/use-online-status";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  PROBLEM_DESCRIPTION_MAX_LENGTH,
  isProblemRequiredTextInputValid,
} from "@/lib/records/problem-policy";
import { isRabiesVaccineName } from "@/lib/records/vaccination-policy";
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
  isPrescriptionRequiredTextInputValid,
} from "@/lib/records/prescription-policy";

type OpenForm = "problem" | "vaccination" | "prescription" | null;

type PrescriptionForm = {
  medicationName: string;
  dosage: string;
  frequency: string;
  quantity: string;
  refillsRemaining: string;
  startDate: string;
  endDate: string;
  instructions: string;
  acknowledgeSafetyWarnings: boolean;
};

function emptyPrescription(timeZone?: string | null): PrescriptionForm {
  return {
    medicationName: "",
    dosage: "",
    frequency: "",
    quantity: "",
    refillsRemaining: "0",
    startDate: formatDateInputForTimeZone(new Date(), timeZone),
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

export function AmbulatoryVisitRecordsCard({
  patientId,
  appointmentId,
  role,
  visitOpen,
  timeZone,
}: {
  patientId: string;
  appointmentId: string;
  role?: string | null;
  visitOpen: boolean;
  timeZone?: string | null;
}) {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const isOnline = useOnlineStatus();
  const [openForm, setOpenForm] = useState<OpenForm>(null);
  const [problemDescription, setProblemDescription] = useState("");
  const [vaccination, setVaccination] = useState(initialVaccinationForm);
  const [prescription, setPrescription] = useState(() =>
    emptyPrescription(timeZone),
  );
  const prescriptionOperationId = useRef<string | null>(null);

  const canRecord =
    role === "admin" || role === "veterinarian" || role === "technician";
  const canPrescribe = role === "admin" || role === "veterinarian";
  const problems = trpc.records.listProblems.useQuery({ patientId });
  const vaccinations = trpc.records.listVaccinations.useQuery({ patientId });
  const prescriptions = trpc.records.listPrescriptions.useQuery({ patientId });
  const providers = trpc.records.listVaccinationProviders.useQuery(undefined, {
    enabled: canRecord && openForm === "vaccination",
  });
  const medicationName = prescription.medicationName.trim();
  const safetyEnabled =
    canPrescribe && openForm === "prescription" && medicationName.length >= 2;
  const safety = trpc.records.checkPrescriptionSafety.useQuery(
    { patientId, medicationName },
    { enabled: safetyEnabled },
  );

  const anyUnsaved =
    problemDescription.trim().length > 0 ||
    Object.values(vaccination).some((value) => value.trim().length > 0) ||
    prescription.medicationName.trim().length > 0 ||
    prescription.dosage.trim().length > 0 ||
    prescription.frequency.trim().length > 0 ||
    prescription.quantity.trim().length > 0 ||
    prescription.endDate.trim().length > 0 ||
    prescription.instructions.trim().length > 0;
  useUnsavedChangesGuard(
    anyUnsaved,
    "Visit records have not been saved on the server. Leave and lose these values?",
  );

  async function refreshVisitRecords() {
    await Promise.all([
      utils.records.listProblems.invalidate({ patientId }),
      utils.records.listVaccinations.invalidate({ patientId }),
      utils.records.listPrescriptions.invalidate({ patientId }),
      utils.encounters.getCloseout.invalidate({ appointmentId }),
      utils.encounters.getVisitReconciliation.invalidate({ appointmentId }),
    ]);
  }

  const createProblem = trpc.records.createProblem.useMutation({
    onSuccess: async () => {
      setProblemDescription("");
      setOpenForm(null);
      await refreshVisitRecords();
      toast.success("Problem added");
    },
    onError: (error) => toast.error(error.message),
  });
  const createVaccination = trpc.records.createVaccination.useMutation({
    onSuccess: async () => {
      setVaccination(initialVaccinationForm());
      setOpenForm(null);
      await refreshVisitRecords();
      toast.success("Vaccination recorded");
    },
    onError: (error) => toast.error(error.message),
  });
  const createPrescription = trpc.records.createPrescription.useMutation({
    onSuccess: async () => {
      setPrescription(emptyPrescription(timeZone));
      prescriptionOperationId.current = null;
      setOpenForm(null);
      await refreshVisitRecords();
      toast.success("Prescription created");
    },
    onError: (error) => toast.error(error.message),
  });

  const safetyReady =
    safetyEnabled &&
    !safety.isFetching &&
    !safety.error &&
    Boolean(safety.data);
  const rabiesProviderStateReady =
    !isRabiesVaccineName(vaccination.vaccineName) ||
    (!providers.isLoading && !providers.error);
  const canSubmitPrescription =
    visitOpen &&
    isOnline &&
    safetyReady &&
    isPrescriptionRequiredTextInputValid(
      prescription.medicationName,
      PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH,
    ) &&
    isPrescriptionRequiredTextInputValid(
      prescription.dosage,
      PRESCRIPTION_DOSAGE_MAX_LENGTH,
    ) &&
    isPrescriptionRequiredTextInputValid(
      prescription.frequency,
      PRESCRIPTION_FREQUENCY_MAX_LENGTH,
    ) &&
    isPrescriptionOptionalPositiveIntegerInputValid(prescription.quantity) &&
    isPrescriptionNonnegativeIntegerInputValid(prescription.refillsRemaining) &&
    isPrescriptionOptionalTextInputValid(
      prescription.instructions,
      PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH,
    ) &&
    Boolean(prescription.startDate) &&
    (!prescription.endDate || prescription.endDate >= prescription.startDate) &&
    (!safety.data?.requiresOverride ||
      prescription.acknowledgeSafetyWarnings) &&
    !createPrescription.isPending;

  const activeProblems = (problems.data ?? []).filter(
    (problem) => problem.status === "active",
  );
  const recentVaccinations = (vaccinations.data ?? [])
    .filter((record) => !record.correctionId)
    .slice(0, 3);
  const activePrescriptions = (prescriptions.data ?? [])
    .filter((record) => record.effectiveStatus === "active")
    .slice(0, 3);

  function updatePrescription<Field extends keyof PrescriptionForm>(
    field: Field,
    value: PrescriptionForm[Field],
  ) {
    prescriptionOperationId.current = null;
    setPrescription((current) => ({ ...current, [field]: value }));
  }

  return (
    <Card id="ambulatory-visit-records" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>Problems, vaccines, and prescriptions</CardTitle>
        <CardDescription>
          Add common visit records in place. Problems remain on the permanent
          chart; vaccines and prescriptions also reconcile to this visit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!isOnline ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            Offline — keep this page open. New records require server
            confirmation before they become part of the chart.
          </div>
        ) : null}

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Active problems</h3>
              <Badge variant="secondary">{activeProblems.length}</Badge>
            </div>
            {canRecord && visitOpen ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setOpenForm(openForm === "problem" ? null : "problem")
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                Add problem
              </Button>
            ) : null}
          </div>
          {problems.error ? (
            <p className="text-sm text-destructive">Problems unavailable.</p>
          ) : activeProblems.length ? (
            <div className="flex flex-wrap gap-2">
              {activeProblems.map((problem) => (
                <Badge key={problem.id} variant="outline">
                  {problem.description}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No active problems recorded.
            </p>
          )}
          {openForm === "problem" ? (
            <form
              className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !visitOpen ||
                  !isOnline ||
                  !isProblemRequiredTextInputValid(
                    problemDescription,
                    PROBLEM_DESCRIPTION_MAX_LENGTH,
                  )
                ) {
                  return;
                }
                createProblem.mutate({
                  patientId,
                  description: problemDescription.trim(),
                  status: "active",
                });
              }}
            >
              <Input
                value={problemDescription}
                maxLength={PROBLEM_DESCRIPTION_MAX_LENGTH}
                placeholder="Problem or diagnosis"
                onChange={(event) => setProblemDescription(event.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                disabled={
                  !isOnline ||
                  !isProblemRequiredTextInputValid(
                    problemDescription,
                    PROBLEM_DESCRIPTION_MAX_LENGTH,
                  ) ||
                  createProblem.isPending
                }
              >
                {createProblem.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Save
              </Button>
            </form>
          ) : null}
        </section>

        <section className="space-y-3 border-t border-border pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Syringe className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Vaccinations</h3>
            </div>
            {canRecord && visitOpen ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setOpenForm(openForm === "vaccination" ? null : "vaccination")
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                Record vaccine
              </Button>
            ) : null}
          </div>
          {recentVaccinations.length ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {recentVaccinations.map((record) => (
                <div key={record.id} className="rounded-md border p-2 text-sm">
                  <p className="font-medium">{record.vaccineName}</p>
                  <p className="text-xs text-muted-foreground">
                    {record.nextDueDate
                      ? `Due ${record.nextDueDate}`
                      : "No due date"}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No vaccination history recorded.
            </p>
          )}
          {openForm === "vaccination" ? (
            <form
              className="space-y-4 rounded-md border border-border bg-muted/20 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !visitOpen ||
                  !isOnline ||
                  !isVaccinationFormValid(vaccination)
                ) {
                  return;
                }
                createVaccination.mutate({
                  patientId,
                  appointmentId,
                  vaccineName: vaccination.vaccineName.trim(),
                  productName: vaccination.productName.trim() || undefined,
                  lotNumber: vaccination.lotNumber.trim() || undefined,
                  manufacturer: vaccination.manufacturer.trim() || undefined,
                  productExpirationDate:
                    vaccination.productExpirationDate || undefined,
                  doseType: vaccination.doseType || undefined,
                  licensedDurationMonths: optionalNumber(
                    vaccination.licensedDurationMonths,
                  ),
                  rabiesTagNumber:
                    vaccination.rabiesTagNumber.trim() || undefined,
                  supervisingVeterinarianId:
                    vaccination.supervisingVeterinarianId || undefined,
                  nextDueDate: vaccination.nextDueDate || undefined,
                });
              }}
            >
              <VaccinationFormFields
                form={vaccination}
                setForm={setVaccination}
                providers={providers.data}
                currentUserId={session?.user?.id}
              />
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    !isOnline ||
                    !isVaccinationFormValid(vaccination) ||
                    !rabiesProviderStateReady ||
                    createVaccination.isPending
                  }
                >
                  {createVaccination.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Save vaccination
                </Button>
              </div>
            </form>
          ) : null}
        </section>

        <section className="space-y-3 border-t border-border pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Pill className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Active prescriptions</h3>
            </div>
            {canPrescribe && visitOpen ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setOpenForm(
                    openForm === "prescription" ? null : "prescription",
                  )
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                Prescribe
              </Button>
            ) : null}
          </div>
          {activePrescriptions.length ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {activePrescriptions.map((record) => (
                <div key={record.id} className="rounded-md border p-2 text-sm">
                  <p className="font-medium">{record.medicationName}</p>
                  <p className="text-xs text-muted-foreground">
                    {[record.dosage, record.frequency]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No active prescriptions recorded.
            </p>
          )}
          {openForm === "prescription" ? (
            <form
              className="space-y-4 rounded-md border border-border bg-muted/20 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSubmitPrescription) return;
                prescriptionOperationId.current ??= crypto.randomUUID();
                createPrescription.mutate({
                  patientId,
                  appointmentId,
                  operationId: prescriptionOperationId.current,
                  medicationName,
                  dosage: prescription.dosage.trim(),
                  frequency: prescription.frequency.trim(),
                  quantity: optionalNumber(prescription.quantity),
                  refillsRemaining:
                    optionalNumber(prescription.refillsRemaining) ?? 0,
                  startDate: prescription.startDate,
                  endDate: prescription.endDate || undefined,
                  instructions: prescription.instructions.trim() || undefined,
                  acknowledgeSafetyWarnings:
                    Boolean(safety.data?.warnings.length) &&
                    prescription.acknowledgeSafetyWarnings,
                });
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <FieldInput
                  label="Medication *"
                  value={prescription.medicationName}
                  maxLength={PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH}
                  onChange={(value) => {
                    updatePrescription("medicationName", value);
                    updatePrescription("acknowledgeSafetyWarnings", false);
                  }}
                />
                <FieldInput
                  label="Dosage *"
                  value={prescription.dosage}
                  maxLength={PRESCRIPTION_DOSAGE_MAX_LENGTH}
                  onChange={(value) => updatePrescription("dosage", value)}
                />
                <FieldInput
                  label="Frequency *"
                  value={prescription.frequency}
                  maxLength={PRESCRIPTION_FREQUENCY_MAX_LENGTH}
                  onChange={(value) => updatePrescription("frequency", value)}
                />
                <FieldInput
                  label="Quantity"
                  value={prescription.quantity}
                  type="number"
                  min={PRESCRIPTION_QUANTITY_MIN}
                  max={PRESCRIPTION_COUNT_MAX}
                  onChange={(value) => updatePrescription("quantity", value)}
                />
                <FieldInput
                  label="Refills"
                  value={prescription.refillsRemaining}
                  type="number"
                  min={PRESCRIPTION_REFILLS_MIN}
                  max={PRESCRIPTION_COUNT_MAX}
                  onChange={(value) =>
                    updatePrescription("refillsRemaining", value)
                  }
                />
                <FieldInput
                  label="Start date *"
                  value={prescription.startDate}
                  type="date"
                  onChange={(value) => updatePrescription("startDate", value)}
                />
                <FieldInput
                  label="End date"
                  value={prescription.endDate}
                  type="date"
                  min={prescription.startDate}
                  onChange={(value) => updatePrescription("endDate", value)}
                />
                <label className="space-y-1 sm:col-span-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Instructions
                  </span>
                  <Textarea
                    rows={2}
                    value={prescription.instructions}
                    maxLength={PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH}
                    onChange={(event) =>
                      updatePrescription("instructions", event.target.value)
                    }
                  />
                </label>
              </div>

              {medicationName.length >= 2 ? (
                safety.isFetching ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Checking prescription safety...
                  </div>
                ) : safety.error || !safety.data ? (
                  <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                    Prescription safety could not be verified. Saving is locked.
                  </div>
                ) : safety.data.warnings.length ? (
                  <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                    <div className="flex items-center gap-2 font-medium">
                      <AlertTriangle className="h-4 w-4" />
                      Prescription safety warnings
                    </div>
                    {safety.data.warnings.map((warning, index) => (
                      <p key={`${warning.type}-${index}`}>{warning.message}</p>
                    ))}
                    {safety.data.requiresOverride ? (
                      <label className="flex items-start gap-2">
                        <Checkbox
                          checked={prescription.acknowledgeSafetyWarnings}
                          onChange={(event) =>
                            updatePrescription(
                              "acknowledgeSafetyWarnings",
                              event.currentTarget.checked,
                            )
                          }
                        />
                        <span>
                          Clinician reviewed and accepts these warnings.
                        </span>
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                    <CheckCircle2 className="h-4 w-4" />
                    No allergy or active-medication warnings found.
                  </div>
                )
              ) : null}

              <p className="text-xs text-muted-foreground">
                Controlled-substance recordkeeping is not automated. Complete
                the clinic’s required controlled drug log when applicable.
              </p>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!canSubmitPrescription}
                >
                  {createPrescription.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Save prescription
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = "text",
  min,
  max,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date";
  min?: number | string;
  max?: number;
  maxLength?: number;
}) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        type={type}
        value={value}
        min={min}
        max={max}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
