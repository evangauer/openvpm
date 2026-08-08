"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import type { inferRouterOutputs } from "@trpc/server";
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  Check,
  ClipboardCheck,
  ClipboardList,
  Download,
  FileText,
  Loader2,
  Package,
  Pill,
  Plus,
  Receipt,
  Stethoscope,
  Save,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { formatCurrency } from "@/lib/locale/format";
import {
  BILLING_INVOICE_MAX_ITEMS,
  isBillingInvoiceLineTotalValid,
  isBillingInvoiceSubtotalValid,
} from "@/lib/billing/policy";
import { ServicePicker } from "@/components/billing/service-picker";
import { CapturePhotos } from "@/components/records/capture-photos";
import { ConsentSign } from "@/components/records/consent-sign";
import { EncounterVitalsCard } from "@/components/records/encounter-vitals-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import type { AppRouter } from "@/server/routers/_app";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type CloseoutQueryState = {
  data: RouterOutputs["encounters"]["getCloseout"] | undefined;
  error: { message: string } | null;
  isLoading: boolean;
};
type InvoiceQueryState = {
  data: RouterOutputs["billing"]["listInvoices"] | undefined;
  error: { message: string } | null;
  isLoading: boolean;
};

type ChargeItem = {
  key: string;
  description: string;
  quantity: number;
  unitPrice: string;
  itemType: "service" | "product";
  itemId?: string;
  sourcePrescriptionId?: string;
};

const APPOINTMENT_STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  in_exam: "In exam",
  checked_out: "Checked out",
  no_show: "No show",
  cancelled: "Cancelled",
};

function canManageVisit(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function canCreateSoap(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

function canRecordVitals(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian" || role === "technician";
}

function canManageBilling(role?: string | null): boolean {
  return role === "admin" || role === "front_desk";
}

function nextVisitAction(status: string): {
  label: string;
  status: "checked_in" | "in_exam";
} | null {
  if (status === "scheduled" || status === "confirmed") {
    return { label: "Check in", status: "checked_in" };
  }
  if (status === "checked_in") {
    return { label: "Start exam", status: "in_exam" };
  }
  return null;
}

function formatAppointmentTime(
  value: Date | string,
  timeZone?: string | null,
): string {
  try {
    return new Date(value).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return new Date(value).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
}

function formatClinicDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString(
    "en-US",
    {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    },
  );
}

function EncounterLoading() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-12 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading visit workspace...
    </div>
  );
}

export default function EncounterWorkspacePage() {
  const params = useParams<{ appointmentId: string }>();
  const { data: session, status: sessionStatus } = useSession();
  const appointmentId = params.appointmentId;
  const utils = trpc.useUtils();

  const appointmentQuery = trpc.appointments.getById.useQuery(
    { id: appointmentId },
    { enabled: Boolean(appointmentId) },
  );
  const appointment = appointmentQuery.data;
  const patientQuery = trpc.patients.getById.useQuery(
    { id: appointment?.patientId ?? "" },
    { enabled: Boolean(appointment?.patientId) },
  );
  const taxConfigQuery = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const invoicesQuery = trpc.billing.listInvoices.useQuery(
    { appointmentId, limit: 25, offset: 0 },
    { enabled: Boolean(appointmentId) },
  );
  const closeoutQuery = trpc.encounters.getCloseout.useQuery(
    { appointmentId },
    { enabled: Boolean(appointmentId) },
  );

  const updateStatus = trpc.appointments.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("Visit status updated");
      utils.appointments.getById.invalidate({ id: appointmentId });
      utils.appointments.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  if (sessionStatus === "loading" || appointmentQuery.isLoading) {
    return <EncounterLoading />;
  }

  if (appointmentQuery.error || !appointment) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Unable to load this visit"
        description={
          appointmentQuery.error?.message ??
          "The appointment may have been removed or belongs to another clinic."
        }
        action={{
          label: "Back to schedule",
          onClick: () => window.location.assign("/schedule"),
          icon: ArrowLeft,
        }}
      />
    );
  }

  const role = session?.user?.role;
  const patient = patientQuery.data;
  const clientName = [appointment.clientFirstName, appointment.clientLastName]
    .filter(Boolean)
    .join(" ");
  const nextAction = nextVisitAction(appointment.status);
  const visitClinicalStateReady =
    Boolean(closeoutQuery.data) && !closeoutQuery.error;
  const visitOpenForClinicalEntry =
    visitClinicalStateReady &&
    appointment.status === "in_exam" &&
    closeoutQuery.data?.closeout?.status !== "clinical_finalized" &&
    closeoutQuery.data?.closeout?.status !== "completed";
  const activeInvoices =
    invoicesQuery.data?.items.filter(
      (invoice) => !invoice.isEstimate && invoice.status !== "void",
    ) ?? [];
  const visitInvoices = invoicesQuery.data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/schedule">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to schedule
          </Link>
        </Button>
      </div>

      <header className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Stethoscope className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-2xl font-semibold">
                {appointment.patientName ?? "Unassigned visit"}
              </h1>
              <Badge variant="outline">
                {APPOINTMENT_STATUS_LABELS[appointment.status] ??
                  appointment.status}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {appointment.typeName ?? "Appointment"} ·{" "}
              {clientName || "No client"}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4" />
                {formatAppointmentTime(
                  appointment.startTime,
                  taxConfigQuery.data?.timezone,
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="h-4 w-4" />
                {appointment.doctorName
                  ? `Dr. ${appointment.doctorName}`
                  : "Unassigned provider"}
              </span>
              {appointment.roomName ? (
                <span>{appointment.roomName}</span>
              ) : null}
            </div>
          </div>
        </div>
        {nextAction && canManageVisit(role) ? (
          <Button
            disabled={updateStatus.isPending}
            onClick={() =>
              updateStatus.mutate({
                id: appointmentId,
                status: nextAction.status,
              })
            }
          >
            {updateStatus.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            {nextAction.label}
          </Button>
        ) : appointment.status === "in_exam" && canManageVisit(role) ? (
          <Button
            onClick={() => {
              const closeout = document.getElementById("visit-closeout");
              closeout?.scrollIntoView({ behavior: "smooth", block: "start" });
              closeout?.focus({ preventScroll: true });
            }}
          >
            <ClipboardCheck className="mr-2 h-4 w-4" />
            Review closeout
          </Button>
        ) : null}
      </header>

      {appointment.notes ? (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
          <span className="font-medium">Visit note:</span> {appointment.notes}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Clinical work</CardTitle>
              <CardDescription>
                Document and capture visit work without losing the appointment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!appointment.patientId ? (
                <EmptyState
                  icon={UserRound}
                  title="Attach a patient first"
                  description="Clinical documentation and billing need a patient and client on the appointment."
                  className="p-8"
                />
              ) : patientQuery.error ||
                (!patientQuery.isLoading && !patient) ? (
                <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
                  Unable to load the patient chart. Refresh before documenting.
                </div>
              ) : patientQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading patient context...
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="rounded-md border border-border bg-muted/20 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{patient?.name}</p>
                        <p className="text-sm capitalize text-muted-foreground">
                          {[patient?.species, patient?.breed]
                            .filter(Boolean)
                            .join(" · ") || "Patient details unavailable"}
                        </p>
                      </div>
                      {patient?.allergies.length ? (
                        <Badge variant="destructive">
                          {patient.allergies.length} allerg
                          {patient.allergies.length === 1 ? "y" : "ies"}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">No recorded allergies</Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {canCreateSoap(role) &&
                    appointment.status === "in_exam" &&
                    closeoutQuery.data?.closeout?.status !==
                      "clinical_finalized" &&
                    closeoutQuery.data?.closeout?.status !== "completed" ? (
                      <Button size="sm" asChild>
                        <Link
                          href={`/records/new-soap/${appointment.patientId}?appointmentId=${appointmentId}`}
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Write SOAP note
                        </Link>
                      </Button>
                    ) : null}
                    {canCreateSoap(role) &&
                    appointment.status === "in_exam" &&
                    closeoutQuery.data?.closeout?.status !==
                      "clinical_finalized" &&
                    closeoutQuery.data?.closeout?.status !== "completed" ? (
                      <Button size="sm" variant="outline" asChild>
                        <Link
                          href={`/records?patientId=${appointment.patientId}&appointmentId=${appointmentId}&tab=prescriptions&new=1`}
                        >
                          <Pill className="mr-2 h-4 w-4" />
                          Prescribe
                        </Link>
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/patients/${appointment.patientId}`}>
                        <ClipboardList className="mr-2 h-4 w-4" />
                        Open patient chart
                      </Link>
                    </Button>
                    {canManageVisit(role) ? (
                      <>
                        <CapturePhotos
                          patientId={appointment.patientId}
                          appointmentId={appointmentId}
                        />
                        <ConsentSign
                          patientId={appointment.patientId}
                          appointmentId={appointmentId}
                        />
                      </>
                    ) : null}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    SOAP notes created here are linked to this appointment.
                    Photos and signatures captured during an open visit attach
                    to the active visit automatically.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {appointment.patientId ? (
            <EncounterVitalsCard
              patientId={appointment.patientId}
              appointmentId={appointment.id}
              canRecord={visitOpenForClinicalEntry && canRecordVitals(role)}
              visitStateReady={visitClinicalStateReady}
              visitOpen={visitOpenForClinicalEntry}
              timeZone={taxConfigQuery.data?.timezone}
            />
          ) : null}

          <VisitCloseout
            appointment={appointment}
            appointmentId={appointmentId}
            role={role}
            closeoutQuery={closeoutQuery}
            invoicesQuery={invoicesQuery}
          />

          <EncounterInvoices
            appointmentId={appointmentId}
            invoicesQuery={invoicesQuery}
            visitInvoices={visitInvoices}
            canManage={
              canManageBilling(role) &&
              closeoutQuery.data?.closeout?.status !== "completed"
            }
          />

          <VisitWorkReconciliation
            appointmentId={appointmentId}
            canManage={canManageVisit(role) && appointment.status === "in_exam"}
            canCorrect={
              appointment.status === "in_exam" &&
              (role === "admin" ||
                role === "veterinarian" ||
                role === "front_desk")
            }
            canVoid={role === "admin" || role === "veterinarian"}
          />
        </div>

        <div id="charge-capture" className="scroll-mt-4">
          <ChargeCapture
            appointmentId={appointmentId}
            clientId={appointment.clientId}
            patientId={appointment.patientId}
            canManage={
              canManageBilling(role) &&
              appointment.status === "in_exam" &&
              closeoutQuery.data?.closeout?.status !== "completed"
            }
            activeInvoice={
              activeInvoices[0]
                ? {
                    id: activeInvoices[0].id,
                    status: activeInvoices[0].status,
                  }
                : null
            }
            invoiceStateReady={
              Boolean(invoicesQuery.data) && !invoicesQuery.error
            }
            invoiceStateLoading={invoicesQuery.isLoading}
            linkedPrescriptions={closeoutQuery.data?.medications ?? []}
          />
        </div>
      </div>
    </div>
  );
}

function splitOwnerInstructions(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function VisitCloseout({
  appointment,
  appointmentId,
  role,
  closeoutQuery,
  invoicesQuery,
}: {
  appointment: {
    status: string;
    patientName: string | null;
    patientSpecies: string | null;
    clientFirstName: string | null;
    clientLastName: string | null;
    doctorName: string | null;
    startTime: Date | string;
    typeRequiresDoctor: number | null;
  };
  appointmentId: string;
  role?: string | null;
  closeoutQuery: CloseoutQueryState;
  invoicesQuery: InvoiceQueryState;
}) {
  const utils = trpc.useUtils();
  const data = closeoutQuery.data;
  const closeout = data?.closeout ?? null;
  const hydratedRevision = useRef<string | null>(null);
  const [diagnosisSummary, setDiagnosisSummary] = useState("");
  const [dischargeInstructions, setDischargeInstructions] = useState("");
  const [warningSigns, setWarningSigns] = useState("");
  const [noInstructionsReason, setNoInstructionsReason] = useState("");
  const [prescriptionDisposition, setPrescriptionDisposition] = useState<
    "" | "prescribed" | "not_needed"
  >("");
  const [followUpDisposition, setFollowUpDisposition] = useState<
    "" | "none" | "needed" | "scheduled"
  >("");
  const [followUpNotes, setFollowUpNotes] = useState("");
  const [followUpAppointmentId, setFollowUpAppointmentId] = useState("");
  const [followUpDueDate, setFollowUpDueDate] = useState("");
  const [followUpAssignedTo, setFollowUpAssignedTo] = useState("");
  const [documentationExceptionReason, setDocumentationExceptionReason] =
    useState("");
  const [chargeDisposition, setChargeDisposition] = useState<
    "" | "paid" | "accounts_receivable" | "no_charge"
  >("");
  const [noChargeReason, setNoChargeReason] = useState("");
  const [handoffMethod, setHandoffMethod] = useState<
    "" | "print" | "verbal" | "declined"
  >("");
  const [amendmentReason, setAmendmentReason] = useState("");
  const [followUpResolution, setFollowUpResolution] = useState<
    "" | "scheduled" | "completed" | "not_needed"
  >("");
  const [resolutionAppointmentId, setResolutionAppointmentId] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");

  useEffect(() => {
    if (!data) return;
    const key = closeout ? `${closeout.id}:${closeout.revision}` : "empty";
    if (hydratedRevision.current === key) return;
    const clinicalSource = closeout?.amendmentDraft ?? closeout;
    setDiagnosisSummary(clinicalSource?.diagnosisSummary ?? "");
    setDischargeInstructions(clinicalSource?.dischargeInstructions ?? "");
    setWarningSigns(clinicalSource?.warningSigns ?? "");
    setNoInstructionsReason(clinicalSource?.noInstructionsReason ?? "");
    setPrescriptionDisposition(clinicalSource?.prescriptionDisposition ?? "");
    setFollowUpDisposition(clinicalSource?.followUpDisposition ?? "");
    setFollowUpNotes(clinicalSource?.followUpNotes ?? "");
    setFollowUpAppointmentId(clinicalSource?.followUpAppointmentId ?? "");
    setFollowUpDueDate(clinicalSource?.followUpDueDate ?? "");
    setFollowUpAssignedTo(clinicalSource?.followUpAssignedTo ?? "");
    setDocumentationExceptionReason(
      clinicalSource?.documentationExceptionReason ?? "",
    );
    setChargeDisposition(closeout?.chargeDisposition ?? "");
    setNoChargeReason(closeout?.noChargeReason ?? "");
    setHandoffMethod(closeout?.handoffMethod ?? "");
    hydratedRevision.current = key;
  }, [closeout, data]);

  const refresh = async () => {
    await Promise.all([
      utils.encounters.getCloseout.invalidate({ appointmentId }),
      utils.appointments.getById.invalidate({ id: appointmentId }),
      utils.appointments.list.invalidate(),
      utils.whiteboard.getActive.invalidate(),
    ]);
  };

  const saveDraft = trpc.encounters.saveDraft.useMutation({
    onSuccess: async () => {
      toast.success("Clinical closeout draft saved");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const finalizeClinical = trpc.encounters.finalizeClinical.useMutation({
    onSuccess: async () => {
      toast.success("Clinical handoff finalized");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const completeVisit = trpc.encounters.completeVisit.useMutation({
    onSuccess: async () => {
      toast.success("Visit completed safely");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const reopenClinical = trpc.encounters.reopenClinical.useMutation({
    onSuccess: async () => {
      toast.success(
        "Amendment draft started; the signed handoff remains active",
      );
      setAmendmentReason("");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const resolveNeededFollowUp =
    trpc.encounters.resolveNeededFollowUp.useMutation({
      onSuccess: async () => {
        toast.success("Follow-up obligation resolved with attribution");
        setFollowUpResolution("");
        setResolutionAppointmentId("");
        setResolutionNotes("");
        await refresh();
        await utils.encounters.listPendingFollowUps.invalidate();
      },
      onError: (error) => toast.error(error.message),
    });

  const canDraftClinical =
    role === "admin" || role === "veterinarian" || role === "technician";
  const canFinalizeClinical =
    role === "veterinarian" ||
    (appointment.typeRequiresDoctor === 0 &&
      (role === "admin" || role === "technician"));
  const signedClinical =
    closeout?.status === "clinical_finalized" ||
    closeout?.status === "completed";
  const amendingClinical = Boolean(closeout?.amendmentDraft);
  const clinicalLocked = signedClinical && !amendingClinical;
  const isCompleted = closeout?.status === "completed";
  const clinicalInput = {
    appointmentId,
    expectedRevision: closeout?.revision ?? 0,
    diagnosisSummary: diagnosisSummary || null,
    dischargeInstructions: dischargeInstructions || null,
    warningSigns: warningSigns || null,
    noInstructionsReason: noInstructionsReason || null,
    prescriptionDisposition: prescriptionDisposition || null,
    followUpDisposition: followUpDisposition || null,
    followUpNotes: followUpNotes || null,
    followUpAppointmentId: followUpAppointmentId || null,
    followUpDueDate: followUpDueDate || null,
    followUpAssignedTo: followUpAssignedTo || null,
    documentationExceptionReason: documentationExceptionReason || null,
  } as const;
  const activeInvoice = data?.invoices[0] ?? null;
  const clientName = [appointment.clientFirstName, appointment.clientLastName]
    .filter(Boolean)
    .join(" ");

  async function downloadDischarge() {
    if (!data || !signedClinical) return;
    try {
      const { generateDischargeInstructions } = await import("@/lib/pdf");
      const followUpDate = closeout?.followUpScheduledAt
        ? new Date(closeout.followUpScheduledAt).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: data.practice.timezone ?? undefined,
          })
        : closeout?.followUpDisposition === "needed" && closeout.followUpDueDate
          ? `Needed by ${formatClinicDate(closeout.followUpDueDate)}`
          : undefined;
      const instructions = closeout?.dischargeInstructions
        ? splitOwnerInstructions(closeout.dischargeInstructions)
        : closeout?.noInstructionsReason
          ? [
              `No additional home-care instructions: ${closeout.noInstructionsReason}`,
            ]
          : [];
      generateDischargeInstructions({
        practiceName: data.practice.name,
        practicePhone: data.practice.phone ?? undefined,
        patientName: appointment.patientName ?? "Patient",
        species: appointment.patientSpecies ?? "",
        clientName: clientName || "Owner",
        visitDate: formatAppointmentTime(
          appointment.startTime,
          data.practice.timezone,
        ),
        doctorName: closeout?.clinicalFinalizerName ?? undefined,
        diagnosis: closeout?.diagnosisSummary ?? undefined,
        medications: (closeout?.medicationSnapshot ?? []).map((medication) => ({
          name: medication.medicationName,
          dosage: medication.dosage,
          frequency: medication.frequency,
          instructions: medication.instructions ?? undefined,
        })),
        instructions,
        followUpDate,
        followUpNotes: closeout?.followUpNotes ?? undefined,
        emergencyNotes: closeout?.warningSigns ?? undefined,
      }).save(
        `discharge_${(appointment.patientName ?? "patient").replace(/\s+/g, "_")}.pdf`,
      );
      toast.success("Discharge instructions downloaded");
    } catch {
      toast.error("Discharge instructions could not be generated");
    }
  }

  type HistoricalCloseout = NonNullable<
    typeof closeout
  >["amendmentHistory"][number];

  async function downloadHistoricalDischarge(amendment: HistoricalCloseout) {
    if (!data) return;
    try {
      const { generateDischargeInstructions } = await import("@/lib/pdf");
      const followUpDate = amendment.followUpScheduledAt
        ? new Date(amendment.followUpScheduledAt).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: data.practice.timezone ?? undefined,
          })
        : amendment.followUpDisposition === "needed" &&
            amendment.followUpDueDate
          ? `Needed by ${formatClinicDate(amendment.followUpDueDate)}`
          : undefined;
      const instructions = amendment.dischargeInstructions
        ? splitOwnerInstructions(amendment.dischargeInstructions)
        : amendment.noInstructionsReason
          ? [
              `No additional home-care instructions: ${amendment.noInstructionsReason}`,
            ]
          : [];
      generateDischargeInstructions({
        practiceName: data.practice.name,
        practicePhone: data.practice.phone ?? undefined,
        patientName: appointment.patientName ?? "Patient",
        species: appointment.patientSpecies ?? "",
        clientName: clientName || "Owner",
        visitDate: formatAppointmentTime(
          appointment.startTime,
          data.practice.timezone,
        ),
        doctorName: amendment.clinicalFinalizerName,
        diagnosis: amendment.diagnosisSummary ?? undefined,
        medications: amendment.medicationSnapshot.map((medication) => ({
          name: medication.medicationName,
          dosage: medication.dosage,
          frequency: medication.frequency,
          instructions: medication.instructions ?? undefined,
        })),
        instructions,
        followUpDate,
        followUpNotes: amendment.followUpNotes ?? undefined,
        emergencyNotes: amendment.warningSigns ?? undefined,
      }).save(
        `discharge_${(appointment.patientName ?? "patient").replace(/\s+/g, "_")}_revision_${amendment.priorRevision}.pdf`,
      );
      toast.success(`Discharge revision ${amendment.priorRevision} downloaded`);
    } catch {
      toast.error("Prior discharge instructions could not be generated");
    }
  }

  if (closeoutQuery.isLoading) {
    return (
      <Card id="visit-closeout">
        <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading closeout readiness...
        </CardContent>
      </Card>
    );
  }
  if (closeoutQuery.error || !data) {
    return (
      <Card id="visit-closeout" className="border-destructive">
        <CardHeader>
          <CardTitle>Visit closeout unavailable</CardTitle>
          <CardDescription className="text-destructive">
            {closeoutQuery.error?.message ??
              "Readiness could not be verified. The visit cannot be checked out."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card id="visit-closeout" className="scroll-mt-4" tabIndex={-1}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Visit closeout</CardTitle>
            <CardDescription>
              Finalize clinical instructions, then verify billing and owner
              handoff before checkout.
            </CardDescription>
          </div>
          <Badge variant={isCompleted ? "success" : "outline"}>
            {amendingClinical
              ? isCompleted
                ? "Completed · amendment draft"
                : "Signed · amendment draft"
              : isCompleted
                ? "Completed"
                : clinicalLocked
                  ? "Clinical handoff finalized"
                  : closeout
                    ? "Draft saved"
                    : "Not started"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <ReadinessTile
            label="Clinical note"
            value={
              data.linkedSoapCount > 0
                ? `${data.linkedSoapCount} linked SOAP note${data.linkedSoapCount === 1 ? "" : "s"}`
                : closeout?.documentationExceptionReason
                  ? "Documented exception"
                  : "Missing"
            }
          />
          <ReadinessTile
            label="Visit medications"
            value={
              data.medications.length > 0
                ? `${data.medications.length} linked prescription${data.medications.length === 1 ? "" : "s"}`
                : "None linked"
            }
          />
          <ReadinessTile
            label="Billing"
            value={
              activeInvoice
                ? `${activeInvoice.status} · ${activeInvoice.itemCount} line${activeInvoice.itemCount === 1 ? "" : "s"}`
                : "No active invoice"
            }
          />
        </div>

        {!clinicalLocked ? (
          appointment.status !== "in_exam" && !amendingClinical ? (
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              Check the patient in and start the exam before preparing the
              clinical closeout.
            </div>
          ) : canDraftClinical ? (
            <ClinicalCloseoutForm
              diagnosisSummary={diagnosisSummary}
              setDiagnosisSummary={setDiagnosisSummary}
              dischargeInstructions={dischargeInstructions}
              setDischargeInstructions={setDischargeInstructions}
              warningSigns={warningSigns}
              setWarningSigns={setWarningSigns}
              noInstructionsReason={noInstructionsReason}
              setNoInstructionsReason={setNoInstructionsReason}
              prescriptionDisposition={prescriptionDisposition}
              setPrescriptionDisposition={setPrescriptionDisposition}
              followUpDisposition={followUpDisposition}
              setFollowUpDisposition={setFollowUpDisposition}
              followUpNotes={followUpNotes}
              setFollowUpNotes={setFollowUpNotes}
              followUpAppointmentId={followUpAppointmentId}
              setFollowUpAppointmentId={setFollowUpAppointmentId}
              followUpDueDate={followUpDueDate}
              setFollowUpDueDate={setFollowUpDueDate}
              followUpAssignedTo={followUpAssignedTo}
              setFollowUpAssignedTo={setFollowUpAssignedTo}
              documentationExceptionReason={documentationExceptionReason}
              setDocumentationExceptionReason={setDocumentationExceptionReason}
              linkedSoapCount={data.linkedSoapCount}
              linkedMedicationCount={data.medications.length}
              followUpAppointments={data.followUpAppointments}
              followUpAssignees={data.followUpAssignees}
              timeZone={data.practice.timezone}
              isAmendment={amendingClinical}
              isSaving={saveDraft.isPending || finalizeClinical.isPending}
              isFinalizing={finalizeClinical.isPending}
              canFinalize={canFinalizeClinical}
              onSave={() => saveDraft.mutate(clinicalInput)}
              onFinalize={() => finalizeClinical.mutate(clinicalInput)}
            />
          ) : (
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              Your role cannot prepare clinical closeout instructions.
            </div>
          )
        ) : null}

        {signedClinical ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium">1. Clinical handoff finalized</h3>
                <p className="text-sm text-muted-foreground">
                  {closeout?.medicationSnapshot.length ?? 0} visit medication
                  {closeout?.medicationSnapshot.length === 1 ? "" : "s"} ·{" "}
                  {closeout?.followUpDisposition?.replace("_", " ")}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={downloadDischarge}>
                <Download className="mr-2 h-4 w-4" />
                Download discharge
              </Button>
            </div>
            <dl className="grid gap-3 rounded-md border border-border bg-background p-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Finalized by
                </dt>
                <dd className="mt-1">
                  {closeout?.clinicalFinalizerName ?? "Unknown clinician"}
                  {closeout?.clinicalFinalizedAt
                    ? ` · ${formatAppointmentTime(
                        closeout.clinicalFinalizedAt,
                        data.practice.timezone,
                      )}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Follow-up
                </dt>
                <dd className="mt-1">
                  {closeout?.followUpDisposition === "scheduled" &&
                  closeout.followUpScheduledAt
                    ? `Scheduled ${formatAppointmentTime(
                        closeout.followUpScheduledAt,
                        data.practice.timezone,
                      )}`
                    : closeout?.followUpDisposition === "needed" &&
                        closeout.followUpDueDate
                      ? `Needed by ${formatClinicDate(closeout.followUpDueDate)} · Assigned to ${closeout.followUpAssigneeName ?? "clinic team"}`
                      : "No follow-up needed"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Diagnosis or visit summary
                </dt>
                <dd className="mt-1 whitespace-pre-wrap">
                  {closeout?.diagnosisSummary || "Not recorded"}
                </dd>
              </div>
            </dl>
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Medications</h4>
              {closeout?.medicationSnapshot.length ? (
                <ul className="space-y-2">
                  {closeout.medicationSnapshot.map((medication) => (
                    <li
                      key={medication.prescriptionId}
                      className="rounded-md border border-border bg-background p-3 text-sm"
                    >
                      <p className="font-medium">{medication.medicationName}</p>
                      <p className="text-muted-foreground">
                        {medication.dosage} · {medication.frequency}
                        {medication.quantity
                          ? ` · Quantity ${medication.quantity}`
                          : ""}
                      </p>
                      {medication.instructions ? (
                        <p className="mt-1 whitespace-pre-wrap">
                          {medication.instructions}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No visit medications.
                </p>
              )}
            </div>
            <div className="space-y-3 rounded-md border border-border bg-background p-3 text-sm">
              <div>
                <h4 className="font-medium">Home care</h4>
                {closeout?.dischargeInstructions ? (
                  <p className="mt-1 whitespace-pre-wrap">
                    {closeout.dischargeInstructions}
                  </p>
                ) : (
                  <p className="mt-1 text-muted-foreground">
                    No additional instructions: {closeout?.noInstructionsReason}
                  </p>
                )}
              </div>
              {closeout?.warningSigns ? (
                <div>
                  <h4 className="font-medium">
                    Warning signs and when to call
                  </h4>
                  <p className="mt-1 whitespace-pre-wrap">
                    {closeout.warningSigns}
                  </p>
                </div>
              ) : null}
              {closeout?.followUpNotes ? (
                <div>
                  <h4 className="font-medium">Follow-up notes</h4>
                  <p className="mt-1 whitespace-pre-wrap">
                    {closeout.followUpNotes}
                  </p>
                </div>
              ) : null}
            </div>
            {closeout?.amendmentHistory.length ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Prior finalized versions ({closeout.amendmentHistory.length})
                </p>
                {closeout.amendmentHistory.map((amendment) => (
                  <details
                    key={`${amendment.priorRevision}:${amendment.reopenedAt}`}
                    className="rounded-md border border-border bg-background p-3 text-sm"
                  >
                    <summary className="cursor-pointer font-medium">
                      Revision {amendment.priorRevision} · {amendment.reason}
                    </summary>
                    <div className="mt-3 space-y-2 text-muted-foreground">
                      <p>
                        Finalized by {amendment.clinicalFinalizerName} on{" "}
                        {formatAppointmentTime(
                          amendment.clinicalFinalizedAt,
                          data.practice.timezone,
                        )}
                        . Correction opened by {amendment.reopenedByName} on{" "}
                        {formatAppointmentTime(
                          amendment.reopenedAt,
                          data.practice.timezone,
                        )}
                        .
                      </p>
                      <p className="whitespace-pre-wrap">
                        {amendment.dischargeInstructions ||
                          `No additional instructions: ${amendment.noInstructionsReason}`}
                      </p>
                      {amendment.diagnosisSummary ? (
                        <p className="whitespace-pre-wrap">
                          <span className="font-medium text-foreground">
                            {"Visit summary: "}
                          </span>
                          {amendment.diagnosisSummary}
                        </p>
                      ) : null}
                      {amendment.warningSigns ? (
                        <p className="whitespace-pre-wrap">
                          <span className="font-medium text-foreground">
                            {"Warning signs: "}
                          </span>
                          {amendment.warningSigns}
                        </p>
                      ) : null}
                      <p>
                        <span className="font-medium text-foreground">
                          {"Follow-up: "}
                        </span>
                        {amendment.followUpDisposition === "scheduled" &&
                        amendment.followUpScheduledAt
                          ? formatAppointmentTime(
                              amendment.followUpScheduledAt,
                              data.practice.timezone,
                            )
                          : amendment.followUpDisposition === "needed" &&
                              amendment.followUpDueDate
                            ? `Needed by ${formatClinicDate(amendment.followUpDueDate)} · Assigned to ${amendment.followUpAssigneeName ?? "clinic team"}`
                            : "None needed"}
                        {amendment.followUpNotes
                          ? ` · ${amendment.followUpNotes}`
                          : ""}
                      </p>
                      {amendment.medicationSnapshot.length ? (
                        <ul className="list-disc pl-5">
                          {amendment.medicationSnapshot.map((medication) => (
                            <li key={medication.prescriptionId}>
                              {medication.medicationName} · {medication.dosage}{" "}
                              · {medication.frequency}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => downloadHistoricalDischarge(amendment)}
                      >
                        <Download className="mr-2 h-4 w-4" />
                        Download revision {amendment.priorRevision}
                      </Button>
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
            {(role === "admin" || role === "veterinarian") &&
            !amendingClinical ? (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
                <label
                  className="text-sm font-medium"
                  htmlFor="closeout-amendment-reason"
                >
                  Create an attributed correction
                </label>
                <Input
                  id="closeout-amendment-reason"
                  value={amendmentReason}
                  onChange={(event) => setAmendmentReason(event.target.value)}
                  placeholder="Reason this signed handoff needs correction"
                />
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      amendmentReason.trim().length < 5 ||
                      reopenClinical.isPending
                    }
                    onClick={() =>
                      reopenClinical.mutate({
                        appointmentId,
                        expectedRevision: closeout!.revision,
                        reason: amendmentReason,
                      })
                    }
                  >
                    {reopenClinical.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Start amendment
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {signedClinical && closeout?.followUpDisposition === "needed" ? (
          <FollowUpResolutionPanel
            dueDate={closeout.followUpDueDate}
            assigneeName={closeout.followUpAssigneeName}
            resolution={closeout.followUpResolution}
            resolutionNotes={closeout.followUpResolutionNotes}
            resolutionScheduledAt={closeout.followUpResolutionScheduledAt}
            resolvedAt={closeout.followUpResolvedAt}
            resolverName={closeout.followUpResolverName}
            selectedResolution={followUpResolution}
            setSelectedResolution={setFollowUpResolution}
            resolutionAppointmentId={resolutionAppointmentId}
            setResolutionAppointmentId={setResolutionAppointmentId}
            notes={resolutionNotes}
            setNotes={setResolutionNotes}
            followUpAppointments={data.followUpAppointments}
            timeZone={data.practice.timezone}
            canResolve={canManageVisit(role)}
            isPending={resolveNeededFollowUp.isPending}
            onResolve={() => {
              if (!followUpResolution || !closeout) return;
              resolveNeededFollowUp.mutate({
                appointmentId,
                expectedRevision: closeout.revision,
                resolution: followUpResolution,
                resolutionAppointmentId:
                  followUpResolution === "scheduled"
                    ? resolutionAppointmentId || null
                    : null,
                notes: resolutionNotes || null,
              });
            }}
          />
        ) : null}

        {clinicalLocked && !isCompleted && canManageVisit(role) ? (
          <OperationalCloseoutForm
            activeInvoice={activeInvoice}
            chargeDisposition={chargeDisposition}
            setChargeDisposition={setChargeDisposition}
            noChargeReason={noChargeReason}
            setNoChargeReason={setNoChargeReason}
            handoffMethod={handoffMethod}
            setHandoffMethod={setHandoffMethod}
            isPending={completeVisit.isPending || invoicesQuery.isLoading}
            onDownload={downloadDischarge}
            onComplete={() => {
              if (!chargeDisposition || !handoffMethod || !closeout) return;
              completeVisit.mutate({
                appointmentId,
                expectedRevision: closeout.revision,
                chargeDisposition,
                noChargeReason:
                  chargeDisposition === "no_charge"
                    ? noChargeReason || null
                    : null,
                handoffMethod,
              });
            }}
          />
        ) : null}

        {isCompleted ? (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
            <p className="font-medium">
              Visit completed with a durable closeout.
            </p>
            <p className="mt-1 text-muted-foreground">
              Billing: {closeout?.chargeDisposition?.replace("_", " ")} · Owner
              handoff: {closeout?.handoffMethod}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReadinessTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}

type ClinicalCloseoutFormProps = {
  diagnosisSummary: string;
  setDiagnosisSummary: (value: string) => void;
  dischargeInstructions: string;
  setDischargeInstructions: (value: string) => void;
  warningSigns: string;
  setWarningSigns: (value: string) => void;
  noInstructionsReason: string;
  setNoInstructionsReason: (value: string) => void;
  prescriptionDisposition: "" | "prescribed" | "not_needed";
  setPrescriptionDisposition: (value: "" | "prescribed" | "not_needed") => void;
  followUpDisposition: "" | "none" | "needed" | "scheduled";
  setFollowUpDisposition: (value: "" | "none" | "needed" | "scheduled") => void;
  followUpNotes: string;
  setFollowUpNotes: (value: string) => void;
  followUpAppointmentId: string;
  setFollowUpAppointmentId: (value: string) => void;
  followUpDueDate: string;
  setFollowUpDueDate: (value: string) => void;
  followUpAssignedTo: string;
  setFollowUpAssignedTo: (value: string) => void;
  documentationExceptionReason: string;
  setDocumentationExceptionReason: (value: string) => void;
  linkedSoapCount: number;
  linkedMedicationCount: number;
  followUpAppointments: Array<{ id: string; startTime: Date | string }>;
  followUpAssignees: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>;
  timeZone?: string | null;
  isAmendment: boolean;
  isSaving: boolean;
  isFinalizing: boolean;
  canFinalize: boolean;
  onSave: () => void;
  onFinalize: () => void;
};

function ClinicalCloseoutForm(props: ClinicalCloseoutFormProps) {
  const finalizationIssues = [
    !props.dischargeInstructions.trim() && !props.noInstructionsReason.trim()
      ? "Enter home-care instructions or a clinical reason why none are needed."
      : null,
    !props.prescriptionDisposition
      ? "Confirm the prescription disposition."
      : props.linkedMedicationCount > 0 &&
          props.prescriptionDisposition !== "prescribed"
        ? "Linked visit prescriptions must be included in the handoff."
        : props.linkedMedicationCount === 0 &&
            props.prescriptionDisposition !== "not_needed"
          ? "No active visit prescription is linked."
          : null,
    !props.followUpDisposition
      ? "Choose a follow-up disposition."
      : props.followUpDisposition === "scheduled" &&
          !props.followUpAppointmentId
        ? "Choose the scheduled follow-up appointment."
        : props.followUpDisposition === "needed" && !props.followUpDueDate
          ? "Set the date by which follow-up is needed."
          : props.followUpDisposition === "needed" && !props.followUpAssignedTo
            ? "Assign a staff member to own the follow-up."
            : null,
    props.linkedSoapCount === 0 && !props.documentationExceptionReason.trim()
      ? "Link a SOAP note or document why one is not required."
      : null,
  ].filter((issue): issue is string => Boolean(issue));
  const canFinalizeNow =
    props.canFinalize && finalizationIssues.length === 0 && !props.isSaving;

  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      <div>
        <h3 className="font-medium">
          1. Clinical owner handoff{props.isAmendment ? " amendment" : ""}
        </h3>
        <p className="text-sm text-muted-foreground">
          {props.isAmendment
            ? "The current signed discharge remains active until this attributed replacement is finalized."
            : "Finalized content becomes the durable discharge record and cannot be silently edited."}
        </p>
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="closeout-diagnosis">
          Diagnosis or visit summary{" "}
          <span className="text-muted-foreground">(optional)</span>
        </label>
        <Textarea
          id="closeout-diagnosis"
          value={props.diagnosisSummary}
          onChange={(event) => props.setDiagnosisSummary(event.target.value)}
          rows={3}
          className="mt-1"
        />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="closeout-instructions">
          Home-care instructions <span aria-hidden="true">*</span>
        </label>
        <Textarea
          id="closeout-instructions"
          value={props.dischargeInstructions}
          onChange={(event) => {
            props.setDischargeInstructions(event.target.value);
            if (event.target.value) props.setNoInstructionsReason("");
          }}
          rows={5}
          className="mt-1"
          placeholder="Medication administration, diet, activity, wound care, or monitoring instructions reviewed with the owner."
        />
      </div>
      <div>
        <label
          className="text-sm font-medium"
          htmlFor="closeout-no-instructions"
        >
          If none, clinical reason <span aria-hidden="true">*</span>
        </label>
        <Input
          id="closeout-no-instructions"
          value={props.noInstructionsReason}
          onChange={(event) => {
            props.setNoInstructionsReason(event.target.value);
            if (event.target.value) props.setDischargeInstructions("");
          }}
          className="mt-1"
          placeholder="Example: No additional home care needed for this technician visit"
        />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="closeout-warning-signs">
          Warning signs and when to call{" "}
          <span className="text-muted-foreground">(optional)</span>
        </label>
        <Textarea
          id="closeout-warning-signs"
          value={props.warningSigns}
          onChange={(event) => props.setWarningSigns(event.target.value)}
          rows={3}
          className="mt-1"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            className="text-sm font-medium"
            htmlFor="closeout-prescriptions"
          >
            Prescriptions <span aria-hidden="true">*</span>
          </label>
          <select
            id="closeout-prescriptions"
            value={props.prescriptionDisposition}
            onChange={(event) =>
              props.setPrescriptionDisposition(
                event.target.value as typeof props.prescriptionDisposition,
              )
            }
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Choose...</option>
            <option
              value="prescribed"
              disabled={props.linkedMedicationCount === 0}
            >
              Prescription created for this visit
            </option>
            <option
              value="not_needed"
              disabled={props.linkedMedicationCount > 0}
            >
              No prescription needed
            </option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="closeout-follow-up">
            Follow-up <span aria-hidden="true">*</span>
          </label>
          <select
            id="closeout-follow-up"
            value={props.followUpDisposition}
            onChange={(event) => {
              const next = event.target
                .value as typeof props.followUpDisposition;
              props.setFollowUpDisposition(next);
              if (next !== "scheduled") props.setFollowUpAppointmentId("");
              if (next !== "needed") {
                props.setFollowUpDueDate("");
                props.setFollowUpAssignedTo("");
              }
            }}
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Choose...</option>
            <option value="none">No follow-up needed</option>
            <option value="needed">Needed — not scheduled yet</option>
            <option value="scheduled">Already scheduled</option>
          </select>
        </div>
      </div>
      {props.followUpDisposition === "scheduled" ? (
        <div>
          <label
            className="text-sm font-medium"
            htmlFor="closeout-follow-up-appointment"
          >
            Scheduled appointment
          </label>
          <select
            id="closeout-follow-up-appointment"
            value={props.followUpAppointmentId}
            onChange={(event) =>
              props.setFollowUpAppointmentId(event.target.value)
            }
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Choose...</option>
            {props.followUpAppointments.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {formatAppointmentTime(candidate.startTime, props.timeZone)}
              </option>
            ))}
          </select>
          {props.followUpAppointments.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No future appointment is scheduled. Save this draft, create the
              follow-up from the schedule, then return to finalize.
            </p>
          ) : null}
        </div>
      ) : null}
      {props.followUpDisposition === "needed" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="closeout-follow-up-due-date"
            >
              Follow-up due date <span aria-hidden="true">*</span>
            </label>
            <Input
              id="closeout-follow-up-due-date"
              type="date"
              value={props.followUpDueDate}
              onChange={(event) => props.setFollowUpDueDate(event.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="closeout-follow-up-assignee"
            >
              Accountable staff owner <span aria-hidden="true">*</span>
            </label>
            <select
              id="closeout-follow-up-assignee"
              value={props.followUpAssignedTo}
              onChange={(event) =>
                props.setFollowUpAssignedTo(event.target.value)
              }
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Choose...</option>
              {props.followUpAssignees.map((assignee) => (
                <option key={assignee.id} value={assignee.id}>
                  {assignee.name || assignee.email} ·{" "}
                  {assignee.role.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      {props.followUpDisposition && props.followUpDisposition !== "none" ? (
        <div>
          <label
            className="text-sm font-medium"
            htmlFor="closeout-follow-up-notes"
          >
            Follow-up notes{" "}
            <span className="text-muted-foreground">(optional)</span>
          </label>
          <Textarea
            id="closeout-follow-up-notes"
            value={props.followUpNotes}
            onChange={(event) => props.setFollowUpNotes(event.target.value)}
            rows={2}
            className="mt-1"
          />
        </div>
      ) : null}
      {props.linkedSoapCount === 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-sm font-medium">No SOAP note is linked</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Link a SOAP note, or document the bounded exception below.
          </p>
          <Input
            aria-label="SOAP documentation exception"
            value={props.documentationExceptionReason}
            onChange={(event) =>
              props.setDocumentationExceptionReason(event.target.value)
            }
            className="mt-2"
            placeholder="Why a SOAP note is not required"
          />
        </div>
      ) : null}
      {finalizationIssues.length > 0 ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          role="status"
        >
          <p className="text-sm font-medium">Before finalizing</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {finalizationIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          disabled={props.isSaving}
          onClick={props.onSave}
        >
          <Save className="mr-2 h-4 w-4" />
          Save draft
        </Button>
        <Button disabled={!canFinalizeNow} onClick={props.onFinalize}>
          {props.isFinalizing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ClipboardCheck className="mr-2 h-4 w-4" />
          )}
          Finalize clinical handoff
        </Button>
      </div>
      {!props.canFinalize ? (
        <p className="text-right text-xs text-muted-foreground">
          A veterinarian must finalize doctor-required visit instructions.
        </p>
      ) : null}
    </div>
  );
}

function FollowUpResolutionPanel({
  dueDate,
  assigneeName,
  resolution,
  resolutionNotes,
  resolutionScheduledAt,
  resolvedAt,
  resolverName,
  selectedResolution,
  setSelectedResolution,
  resolutionAppointmentId,
  setResolutionAppointmentId,
  notes,
  setNotes,
  followUpAppointments,
  timeZone,
  canResolve,
  isPending,
  onResolve,
}: {
  dueDate: string | null;
  assigneeName: string | null;
  resolution: "scheduled" | "completed" | "not_needed" | null;
  resolutionNotes: string | null;
  resolutionScheduledAt: Date | string | null;
  resolvedAt: Date | string | null;
  resolverName: string | null;
  selectedResolution: "" | "scheduled" | "completed" | "not_needed";
  setSelectedResolution: (
    value: "" | "scheduled" | "completed" | "not_needed",
  ) => void;
  resolutionAppointmentId: string;
  setResolutionAppointmentId: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  followUpAppointments: Array<{ id: string; startTime: Date | string }>;
  timeZone?: string | null;
  canResolve: boolean;
  isPending: boolean;
  onResolve: () => void;
}) {
  const ready = Boolean(
    selectedResolution &&
    (selectedResolution === "scheduled"
      ? resolutionAppointmentId
      : notes.trim()),
  );

  return (
    <div className="space-y-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
      <div>
        <h3 className="font-medium">Follow-up obligation</h3>
        <p className="text-sm text-muted-foreground">
          Due {dueDate ? formatClinicDate(dueDate) : "date unavailable"} ·
          Assigned to {assigneeName ?? "clinic team"}. This queue state is
          audited separately from the signed discharge.
        </p>
      </div>
      {resolvedAt && resolution ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
          <p className="font-medium">
            Resolved as {resolution.replace("_", " ")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {resolverName ?? "Clinic staff"} ·{" "}
            {formatAppointmentTime(resolvedAt, timeZone)}
            {resolutionScheduledAt
              ? ` · Scheduled ${formatAppointmentTime(
                  resolutionScheduledAt,
                  timeZone,
                )}`
              : ""}
          </p>
          {resolutionNotes ? (
            <p className="mt-2 whitespace-pre-wrap">{resolutionNotes}</p>
          ) : null}
        </div>
      ) : canResolve ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                className="text-sm font-medium"
                htmlFor="closeout-follow-up-resolution"
              >
                Resolution
              </label>
              <select
                id="closeout-follow-up-resolution"
                value={selectedResolution}
                onChange={(event) => {
                  const next = event.target.value as typeof selectedResolution;
                  setSelectedResolution(next);
                  if (next !== "scheduled") setResolutionAppointmentId("");
                }}
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Choose...</option>
                <option value="scheduled">Follow-up scheduled</option>
                <option value="completed">
                  Follow-up completed another way
                </option>
                <option value="not_needed">Clinically no longer needed</option>
              </select>
            </div>
            {selectedResolution === "scheduled" ? (
              <div>
                <label
                  className="text-sm font-medium"
                  htmlFor="closeout-resolution-appointment"
                >
                  Scheduled appointment
                </label>
                <select
                  id="closeout-resolution-appointment"
                  value={resolutionAppointmentId}
                  onChange={(event) =>
                    setResolutionAppointmentId(event.target.value)
                  }
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Choose...</option>
                  {followUpAppointments.map((appointment) => (
                    <option key={appointment.id} value={appointment.id}>
                      {formatAppointmentTime(appointment.startTime, timeZone)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
          {selectedResolution && selectedResolution !== "scheduled" ? (
            <div>
              <label
                className="text-sm font-medium"
                htmlFor="closeout-resolution-notes"
              >
                Resolution notes
              </label>
              <Textarea
                id="closeout-resolution-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={2}
                className="mt-1"
                placeholder="Document the owner contact or clinical reason."
              />
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button disabled={!ready || isPending} onClick={onResolve}>
              {isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Resolve follow-up
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          A clinic staff member must resolve this obligation from the visit.
        </p>
      )}
    </div>
  );
}

function OperationalCloseoutForm({
  activeInvoice,
  chargeDisposition,
  setChargeDisposition,
  noChargeReason,
  setNoChargeReason,
  handoffMethod,
  setHandoffMethod,
  isPending,
  onDownload,
  onComplete,
}: {
  activeInvoice: {
    id: string;
    status: string;
    itemCount: number;
    balanceDueCents: number;
    dueDate: Date | string | null;
  } | null;
  chargeDisposition: "" | "paid" | "accounts_receivable" | "no_charge";
  setChargeDisposition: (
    value: "" | "paid" | "accounts_receivable" | "no_charge",
  ) => void;
  noChargeReason: string;
  setNoChargeReason: (value: string) => void;
  handoffMethod: "" | "print" | "verbal" | "declined";
  setHandoffMethod: (value: "" | "print" | "verbal" | "declined") => void;
  isPending: boolean;
  onDownload: () => void;
  onComplete: () => void;
}) {
  const paidReady = Boolean(
    activeInvoice &&
    activeInvoice.itemCount > 0 &&
    activeInvoice.status === "paid" &&
    activeInvoice.balanceDueCents === 0,
  );
  const accountsReceivableReady = Boolean(
    activeInvoice &&
    activeInvoice.itemCount > 0 &&
    (activeInvoice.status === "sent" || activeInvoice.status === "overdue") &&
    activeInvoice.dueDate &&
    activeInvoice.balanceDueCents > 0,
  );
  const noChargeReady = !activeInvoice;
  const selectedDispositionReady =
    (chargeDisposition === "paid" && paidReady) ||
    (chargeDisposition === "accounts_receivable" && accountsReceivableReady) ||
    (chargeDisposition === "no_charge" &&
      noChargeReady &&
      noChargeReason.trim().length > 0);
  const canComplete =
    selectedDispositionReady && Boolean(handoffMethod) && !isPending;

  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      <div>
        <h3 className="font-medium">2. Billing and owner handoff</h3>
        <p className="text-sm text-muted-foreground">
          Resolve payment or explicitly place the invoice in accounts receivable
          before completing the visit.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            className="text-sm font-medium"
            htmlFor="closeout-charge-state"
          >
            Billing disposition
          </label>
          <select
            id="closeout-charge-state"
            value={chargeDisposition}
            onChange={(event) =>
              setChargeDisposition(
                event.target.value as typeof chargeDisposition,
              )
            }
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Choose...</option>
            <option value="paid" disabled={!paidReady}>
              Invoice fully paid{paidReady ? "" : " — not ready"}
            </option>
            <option
              value="accounts_receivable"
              disabled={!accountsReceivableReady}
            >
              Pay later — sent with due date
            </option>
            <option value="no_charge" disabled={!noChargeReady}>
              No charge for this visit{noChargeReady ? "" : " — invoice exists"}
            </option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="closeout-handoff">
            Owner handoff
          </label>
          <select
            id="closeout-handoff"
            value={handoffMethod}
            onChange={(event) =>
              setHandoffMethod(event.target.value as typeof handoffMethod)
            }
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Choose...</option>
            <option value="print">Printed or downloaded for owner</option>
            <option value="verbal">Reviewed verbally with owner</option>
            <option value="declined">Owner declined instructions</option>
          </select>
        </div>
      </div>
      {chargeDisposition === "no_charge" ? (
        <div>
          <label className="text-sm font-medium" htmlFor="closeout-no-charge">
            No-charge reason
          </label>
          <Input
            id="closeout-no-charge"
            value={noChargeReason}
            onChange={(event) => setNoChargeReason(event.target.value)}
            className="mt-1"
          />
        </div>
      ) : null}
      {activeInvoice ? (
        <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
          Invoice is <strong>{activeInvoice.status}</strong>, has{" "}
          {activeInvoice.itemCount} line
          {activeInvoice.itemCount === 1 ? "" : "s"}, and a balance of{" "}
          {formatCurrency(activeInvoice.balanceDueCents / 100)}.{" "}
          {paidReady
            ? "Ready for paid checkout. "
            : accountsReceivableReady
              ? "Ready for accounts-receivable checkout. "
              : "Resolve the invoice status, balance, and due date before checkout. "}
          <Button variant="link" size="sm" asChild className="h-auto p-0">
            <Link href={`/billing?expand=${activeInvoice.id}`}>
              Open billing
            </Link>
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p>
            No active invoice exists. Choose no charge with a reason, or save
            visit charges first.
          </p>
          <Button variant="outline" size="sm" asChild>
            <a href="#charge-capture">Capture visit charges</a>
          </Button>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onDownload}>
          <Download className="mr-2 h-4 w-4" />
          Download discharge
        </Button>
        <Button disabled={!canComplete} onClick={onComplete}>
          {isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Check className="mr-2 h-4 w-4" />
          )}
          Complete visit
        </Button>
      </div>
    </div>
  );
}

function EncounterInvoices({
  appointmentId,
  invoicesQuery,
  visitInvoices,
  canManage,
}: {
  appointmentId: string;
  invoicesQuery: InvoiceQueryState;
  visitInvoices: Array<{
    id: string;
    status: string;
    total: string;
    paidAmount: string;
    adjustedAmount: string;
    isEstimate: boolean;
  }>;
  canManage: boolean;
}) {
  const fmt = useCurrencyFormatterWithConfig();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice state</CardTitle>
        <CardDescription>
          Charges and payment status linked directly to this visit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {invoicesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading visit invoices...
          </div>
        ) : invoicesQuery.error || !invoicesQuery.data ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Unable to load invoice state. Do not create duplicate charges until
            this is resolved.
          </div>
        ) : visitInvoices.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No active invoice for this visit"
            description={
              canManage
                ? "Add all known services and products in Charge capture to create a visit-linked draft."
                : "An admin or front desk teammate can create this visit's charges."
            }
            className="p-8"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {visitInvoices.map((invoice) => {
              const paid = Number(invoice.paidAmount ?? 0);
              const adjusted = Number(invoice.adjustedAmount ?? 0);
              const balance = Math.max(
                0,
                Number(invoice.total ?? 0) - paid - adjusted,
              );
              return (
                <div
                  key={invoice.id}
                  className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">
                        {invoice.isEstimate ? "Estimate" : "Invoice"}
                      </p>
                      <Badge
                        variant={
                          invoice.status === "paid" ? "success" : "outline"
                        }
                      >
                        {invoice.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Total {fmt(invoice.total)} · Balance {fmt(balance)}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/billing?expand=${invoice.id}`}>
                      Open invoice
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <span className="sr-only">Appointment {appointmentId}</span>
      </CardContent>
    </Card>
  );
}

function useCurrencyFormatterWithConfig() {
  const config = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  return (value: number | string | null | undefined) =>
    formatCurrency(
      value,
      config.data?.currency ?? "usd",
      config.data?.country ?? "US",
    );
}

function VisitWorkReconciliation({
  appointmentId,
  canManage,
  canCorrect,
  canVoid,
}: {
  appointmentId: string;
  canManage: boolean;
  canCorrect: boolean;
  canVoid: boolean;
}) {
  const utils = trpc.useUtils();
  const fmt = useCurrencyFormatterWithConfig();
  const reconciliation = trpc.encounters.getVisitReconciliation.useQuery({
    appointmentId,
  });
  const [selectedCharges, setSelectedCharges] = useState<
    Record<string, string>
  >({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const resolve = trpc.encounters.resolveVisitWork.useMutation({
    onSuccess: () => {
      toast.success("Performed item reconciled");
      utils.encounters.getVisitReconciliation.invalidate({ appointmentId });
    },
    onError: (error) => toast.error(error.message),
  });
  const reopen = trpc.encounters.reopenVisitWork.useMutation({
    onSuccess: () => {
      toast.success("Reconciliation reopened for correction");
      utils.encounters.getVisitReconciliation.invalidate({ appointmentId });
      utils.billing.listInvoices.invalidate({
        appointmentId,
        limit: 25,
        offset: 0,
      });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Card id="visit-work-reconciliation" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>Performed work reconciliation</CardTitle>
        <CardDescription>
          Every vaccination, lab, procedure, and visit prescription must be
          linked to a confirmed invoice line or given an attributable no-charge
          or void/correction reason before checkout.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {reconciliation.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking performed work...
          </div>
        ) : reconciliation.error || !reconciliation.data ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Reconciliation state is unavailable. Checkout remains blocked until
            it can be verified.
          </div>
        ) : reconciliation.data.items.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No visit-owned vaccinations, labs, procedures, or prescriptions have
            been recorded.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-sm">
              <span>Items requiring attention</span>
              <Badge
                variant={
                  reconciliation.data.unresolvedCount > 0
                    ? "destructive"
                    : "success"
                }
              >
                {reconciliation.data.unresolvedCount}
              </Badge>
            </div>
            {reconciliation.data.items.map((item) => {
              const unresolved = item.status === "unresolved";
              const staleCharge =
                item.status === "charged" && !item.chargeLinkActive;
              const suggestedCatalog = item.suggestedProductId
                ? `${item.suggestedProductName} (${fmt(item.suggestedProductPrice)})`
                : item.suggestedService
                  ? `${item.suggestedService.name} (${fmt(item.suggestedService.defaultPrice)})`
                  : null;
              const reason = reasons[item.id] ?? "";
              const selectedCharge = selectedCharges[item.id] ?? "";
              return (
                <div
                  key={item.id}
                  className="rounded-md border border-border p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{item.sourceLabel}</p>
                      <p className="text-xs capitalize text-muted-foreground">
                        {item.sourceType}
                      </p>
                    </div>
                    <Badge
                      variant={
                        unresolved || staleCharge ? "destructive" : "outline"
                      }
                    >
                      {staleCharge
                        ? "charge removed"
                        : item.status.replace("_", " ")}
                    </Badge>
                  </div>

                  {unresolved || staleCharge ? (
                    <div className="mt-4 flex flex-col gap-3">
                      <p className="text-xs text-muted-foreground">
                        {suggestedCatalog
                          ? `Suggested catalog match: ${suggestedCatalog}. Add and save it in Charge capture, then link the saved invoice line here.`
                          : "Add and save the appropriate service or product in Charge capture, then link the saved invoice line here. OpenVPM never bills a suggestion automatically."}
                      </p>
                      {unresolved && canManage ? (
                        <>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <select
                              className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                              aria-label={`Invoice charge for ${item.sourceLabel}`}
                              value={selectedCharge}
                              disabled={resolve.isPending || reopen.isPending}
                              onChange={(event) =>
                                setSelectedCharges((current) => ({
                                  ...current,
                                  [item.id]: event.target.value,
                                }))
                              }
                            >
                              <option value="">
                                Choose saved invoice line
                              </option>
                              {reconciliation.data.invoiceItemOptions.map(
                                (charge) => (
                                  <option key={charge.id} value={charge.id}>
                                    {charge.description} · qty {charge.quantity}{" "}
                                    · {fmt(charge.total)}
                                  </option>
                                ),
                              )}
                            </select>
                            <Button
                              variant="outline"
                              disabled={
                                !selectedCharge ||
                                resolve.isPending ||
                                reopen.isPending
                              }
                              onClick={() =>
                                resolve.mutate({
                                  appointmentId,
                                  workItemId: item.id,
                                  resolution: {
                                    status: "charged",
                                    invoiceItemId: selectedCharge,
                                  },
                                })
                              }
                            >
                              Link confirmed charge
                            </Button>
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                              value={reason}
                              maxLength={500}
                              placeholder="Reason required for no charge or void/correction"
                              aria-label={`Reconciliation reason for ${item.sourceLabel}`}
                              disabled={resolve.isPending || reopen.isPending}
                              onChange={(event) =>
                                setReasons((current) => ({
                                  ...current,
                                  [item.id]: event.target.value,
                                }))
                              }
                            />
                            <Button
                              variant="outline"
                              disabled={
                                reason.trim().length < 3 ||
                                resolve.isPending ||
                                reopen.isPending
                              }
                              onClick={() =>
                                resolve.mutate({
                                  appointmentId,
                                  workItemId: item.id,
                                  resolution: {
                                    status: "no_charge",
                                    reason: reason.trim(),
                                  },
                                })
                              }
                            >
                              No charge
                            </Button>
                            {canVoid ? (
                              <Button
                                variant="outline"
                                disabled={
                                  reason.trim().length < 3 ||
                                  resolve.isPending ||
                                  reopen.isPending
                                }
                                onClick={() =>
                                  resolve.mutate({
                                    appointmentId,
                                    workItemId: item.id,
                                    resolution: {
                                      status: "voided",
                                      reason: reason.trim(),
                                    },
                                  })
                                }
                              >
                                Void/corrected
                              </Button>
                            ) : null}
                          </div>
                        </>
                      ) : staleCharge ? (
                        <p className="text-sm text-destructive">
                          The linked invoice line is no longer active. Reopen
                          this resolution with a correction reason, fix the
                          invoice, and link the replacement line before
                          checkout.
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          A clinic teammate with visit access must reconcile
                          this item.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {item.status === "charged"
                        ? `Linked charge: ${item.invoiceItemDescription}`
                        : item.status === "no_charge"
                          ? `No-charge reason: ${item.noChargeReason}`
                          : `Void/correction reason: ${item.voidReason}`}
                      {item.resolvedByName ? ` · ${item.resolvedByName}` : ""}
                    </p>
                  )}

                  {!unresolved && canCorrect ? (
                    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row">
                      <Input
                        value={reason}
                        maxLength={500}
                        placeholder="Why does this reconciliation need correction?"
                        aria-label={`Correction reason for ${item.sourceLabel}`}
                        disabled={resolve.isPending || reopen.isPending}
                        onChange={(event) =>
                          setReasons((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        variant="outline"
                        disabled={
                          reason.trim().length < 5 ||
                          resolve.isPending ||
                          reopen.isPending
                        }
                        onClick={() =>
                          reopen.mutate({
                            appointmentId,
                            workItemId: item.id,
                            reason: reason.trim(),
                          })
                        }
                      >
                        Reopen for correction
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChargeCapture({
  appointmentId,
  clientId,
  patientId,
  canManage,
  activeInvoice,
  invoiceStateReady,
  invoiceStateLoading,
  linkedPrescriptions,
}: {
  appointmentId: string;
  clientId: string | null;
  patientId: string | null;
  canManage: boolean;
  activeInvoice: { id: string; status: string } | null;
  invoiceStateReady: boolean;
  invoiceStateLoading: boolean;
  linkedPrescriptions: Array<{
    id: string;
    medicationName: string;
    dosage: string;
    quantity: number | null;
    productId: string | null;
    productName: string | null;
    productUnitPrice: string | null;
  }>;
}) {
  const utils = trpc.useUtils();
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [items, setItems] = useState<ChargeItem[]>([]);
  const [loadedInvoiceId, setLoadedInvoiceId] = useState<string | null>(null);
  const configQuery = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const configReady = Boolean(configQuery.data) && !configQuery.error;
  const activeInvoiceIsDraft = activeInvoice?.status === "draft";
  const invoiceDetailQuery = trpc.billing.getInvoice.useQuery(
    {
      id: activeInvoice?.id ?? "00000000-0000-0000-0000-000000000000",
    },
    { enabled: Boolean(canManage && activeInvoiceIsDraft) },
  );
  const invoiceDetailReady =
    !activeInvoice ||
    (activeInvoiceIsDraft && Boolean(invoiceDetailQuery.data));
  const servicesQuery = trpc.billing.listServices.useQuery(undefined, {
    enabled:
      canManage &&
      configReady &&
      invoiceStateReady &&
      (!activeInvoice || (activeInvoiceIsDraft && invoiceDetailReady)),
  });
  const productsQuery = trpc.billing.listProducts.useQuery(
    { limit: 100 },
    {
      enabled:
        canManage &&
        configReady &&
        invoiceStateReady &&
        (!activeInvoice || (activeInvoiceIsDraft && invoiceDetailReady)),
    },
  );

  useEffect(() => {
    if (!activeInvoice) {
      if (loadedInvoiceId) {
        setItems([]);
        setLoadedInvoiceId(null);
      }
      return;
    }
    if (
      activeInvoiceIsDraft &&
      invoiceDetailQuery.data?.id === activeInvoice.id &&
      loadedInvoiceId !== activeInvoice.id
    ) {
      setItems(
        invoiceDetailQuery.data.items.map((item) => ({
          key: item.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          itemType: item.itemType,
          itemId: item.itemId ?? undefined,
          sourcePrescriptionId: item.sourcePrescriptionId ?? undefined,
        })),
      );
      setLoadedInvoiceId(activeInvoice.id);
    }
  }, [
    activeInvoice,
    activeInvoiceIsDraft,
    invoiceDetailQuery.data,
    loadedInvoiceId,
  ]);

  const catalog = useMemo(() => {
    const services = (servicesQuery.data ?? []).map((service) => ({
      id: `service:${service.id}`,
      itemId: service.id,
      itemType: "service" as const,
      name: service.name,
      code: service.code,
      category: ["Service", service.category].filter(Boolean).join(" · "),
      defaultPrice: service.defaultPrice,
      stockQuantity: null as number | null,
      quantity: null as number | null,
      sourcePrescriptionId: undefined as string | undefined,
    }));
    const linkedProductIds = new Set(
      linkedPrescriptions
        .map((prescription) => prescription.productId)
        .filter((id): id is string => Boolean(id)),
    );
    const prescriptionCharges = linkedPrescriptions
      .filter(
        (prescription) =>
          prescription.productId &&
          prescription.productName &&
          prescription.productUnitPrice &&
          prescription.quantity,
      )
      .map((prescription) => ({
        id: `prescription:${prescription.id}`,
        itemId: prescription.productId!,
        itemType: "product" as const,
        name: `${prescription.productName} — ${prescription.medicationName}`,
        category: "Visit prescription · inventory already dispensed",
        defaultPrice: prescription.productUnitPrice!,
        stockQuantity: null as number | null,
        quantity: prescription.quantity!,
        sourcePrescriptionId: prescription.id,
      }));
    const products = (productsQuery.data ?? [])
      .filter((product) => !linkedProductIds.has(product.id))
      .map((product) => ({
        id: `product:${product.id}`,
        itemId: product.id,
        itemType: "product" as const,
        name: product.name,
        category: `Product · ${product.stockQuantity} in stock`,
        defaultPrice: product.unitPrice,
        stockQuantity: product.stockQuantity,
        quantity: null as number | null,
        sourcePrescriptionId: undefined as string | undefined,
      }));
    return [...prescriptionCharges, ...services, ...products];
  }, [linkedPrescriptions, productsQuery.data, servicesQuery.data]);

  const selected = catalog.find((entry) => entry.id === selectedCatalogId);
  useEffect(() => {
    setQuantity(selected?.quantity ?? 1);
  }, [selected?.id, selected?.quantity]);
  const subtotal = items.reduce(
    (sum, item) => sum + item.quantity * Number(item.unitPrice),
    0,
  );
  const taxRate = Number(configQuery.data?.taxRatePercent ?? 0) / 100;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const total = subtotal + tax;
  const fmt = (value: number | string | null | undefined) =>
    formatCurrency(
      value,
      configQuery.data?.currency ?? "usd",
      configQuery.data?.country ?? "US",
    );
  const selectedHasStock =
    selected?.itemType !== "product" ||
    Boolean(selected.sourcePrescriptionId) ||
    (selected.stockQuantity !== null && quantity <= selected.stockQuantity);
  const canAdd =
    Boolean(selected) &&
    Number.isInteger(quantity) &&
    quantity > 0 &&
    selectedHasStock &&
    items.length < BILLING_INVOICE_MAX_ITEMS;
  const canSubmit =
    Boolean(clientId && patientId) &&
    items.length > 0 &&
    items.every((item) =>
      isBillingInvoiceLineTotalValid(item.unitPrice, item.quantity),
    ) &&
    isBillingInvoiceSubtotalValid(items) &&
    configReady &&
    invoiceStateReady &&
    invoiceDetailReady &&
    (!activeInvoice || activeInvoiceIsDraft);

  const createInvoice = trpc.billing.createInvoice.useMutation({
    onSuccess: () => {
      toast.success("Visit charges saved as a draft invoice");
      setItems([]);
      setSelectedCatalogId("");
      setQuantity(1);
      utils.billing.listInvoices.invalidate({
        appointmentId,
        limit: 25,
        offset: 0,
      });
      utils.encounters.getCloseout.invalidate({ appointmentId });
    },
    onError: (error) => toast.error(error.message),
  });
  const updateInvoiceItems = trpc.billing.updateInvoiceItems.useMutation({
    onSuccess: () => {
      toast.success("Visit invoice charges updated");
      utils.billing.listInvoices.invalidate({
        appointmentId,
        limit: 25,
        offset: 0,
      });
      utils.encounters.getCloseout.invalidate({ appointmentId });
      if (activeInvoice) {
        utils.billing.getInvoice.invalidate({ id: activeInvoice.id });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const isSaving = createInvoice.isPending || updateInvoiceItems.isPending;

  function addSelectedItem() {
    if (!selected || !canAdd) return;
    setItems((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        description: selected.name,
        quantity,
        unitPrice: selected.defaultPrice,
        itemType: selected.itemType,
        itemId: selected.itemId,
        sourcePrescriptionId: selected.sourcePrescriptionId,
      },
    ]);
    setSelectedCatalogId("");
    setQuantity(1);
  }

  function saveCharges() {
    if (!clientId || !patientId || !canSubmit) return;
    const lineItems = items.map(
      ({
        description,
        quantity,
        unitPrice,
        itemType,
        itemId,
        sourcePrescriptionId,
      }) => ({
        description,
        quantity,
        unitPrice,
        itemType,
        itemId,
        sourcePrescriptionId,
      }),
    );
    if (activeInvoice) {
      if (!invoiceDetailQuery.data) return;
      updateInvoiceItems.mutate({
        id: activeInvoice.id,
        expectedUpdatedAt: invoiceDetailQuery.data.updatedAt,
        items: lineItems,
      });
      return;
    }
    createInvoice.mutate({
      appointmentId,
      clientId,
      patientId,
      items: lineItems,
      isEstimate: false,
    });
  }

  return (
    <Card className="h-fit lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle>Charge capture</CardTitle>
        <CardDescription>
          {activeInvoiceIsDraft
            ? "Correct or add services and products before this invoice is sent."
            : "Add the services and products performed or dispensed during this visit."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!canManage ? (
          <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            Charge capture is read-only for your role. An admin or front desk
            teammate can create the invoice.
          </div>
        ) : invoiceStateLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Confirming visit invoice state...
          </div>
        ) : !invoiceStateReady ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Charge capture is locked because invoice state could not be
            confirmed. Refresh before creating charges.
          </div>
        ) : activeInvoice && !activeInvoiceIsDraft ? (
          <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            This visit invoice is already {activeInvoice.status}. Open it from
            Invoice state to collect payment or review the balance. Only unpaid
            draft charges can be edited.
          </div>
        ) : activeInvoiceIsDraft && invoiceDetailQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading existing visit charges...
          </div>
        ) : activeInvoiceIsDraft &&
          (invoiceDetailQuery.error || !invoiceDetailQuery.data) ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Existing charges could not be loaded. Refresh before editing this
            draft invoice.
          </div>
        ) : configQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading practice tax and currency settings...
          </div>
        ) : !configReady ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Charge capture is locked because tax and currency settings could not
            be confirmed. Refresh before creating charges.
          </div>
        ) : !clientId || !patientId ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Add both a client and patient to the appointment before capturing
            charges.
          </div>
        ) : servicesQuery.error || productsQuery.error ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Unable to load the charge catalog. Refresh before creating an
            invoice.
          </div>
        ) : servicesQuery.isLoading || productsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading services and products...
          </div>
        ) : catalog.length === 0 && items.length === 0 ? (
          <EmptyState
            icon={Package}
            title="Charge catalog is empty"
            description="Add services or inventory products before building a visit invoice."
            className="p-8"
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_auto] lg:grid-cols-1 xl:grid-cols-[minmax(0,1fr)_80px_auto]">
              <ServicePicker
                services={catalog}
                value={selectedCatalogId}
                onSelect={setSelectedCatalogId}
                disabled={isSaving}
                formatPrice={fmt}
              />
              <Input
                type="number"
                min={1}
                max={selected?.stockQuantity ?? undefined}
                value={quantity}
                aria-label="Charge quantity"
                aria-invalid={!selectedHasStock}
                onChange={(event) =>
                  setQuantity(Math.max(1, Number(event.target.value) || 1))
                }
              />
              <Button
                type="button"
                variant="outline"
                disabled={!canAdd || isSaving}
                onClick={addSelectedItem}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </div>

            {!selectedHasStock ? (
              <p className="text-xs font-medium text-destructive">
                Quantity exceeds available inventory.
              </p>
            ) : null}

            {items.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                No charges added yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {items.map((item) => (
                  <div
                    key={item.key}
                    className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.description}
                      </p>
                      <p className="text-xs capitalize text-muted-foreground">
                        {item.itemType}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Qty
                        <Input
                          type="number"
                          min={1}
                          max={10000}
                          value={item.quantity}
                          aria-label={`${item.description} quantity`}
                          className="w-20 text-foreground"
                          disabled={isSaving}
                          onChange={(event) =>
                            setItems((current) =>
                              current.map((candidate) =>
                                candidate.key === item.key
                                  ? {
                                      ...candidate,
                                      quantity: Math.max(
                                        1,
                                        Number(event.target.value) || 1,
                                      ),
                                    }
                                  : candidate,
                              ),
                            )
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Unit price
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={item.unitPrice}
                          aria-label={`${item.description} unit price`}
                          className="w-28 text-foreground"
                          disabled={isSaving}
                          onChange={(event) =>
                            setItems((current) =>
                              current.map((candidate) =>
                                candidate.key === item.key
                                  ? {
                                      ...candidate,
                                      unitPrice: event.target.value,
                                    }
                                  : candidate,
                              ),
                            )
                          }
                        />
                      </label>
                      <span className="flex w-24 flex-col gap-1 text-right text-xs text-muted-foreground">
                        Line total
                        <span className="text-sm font-medium text-foreground tabular-nums">
                          {fmt(item.quantity * Number(item.unitPrice || 0))}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="self-end"
                        aria-label={`Remove ${item.description}`}
                        disabled={isSaving}
                        onClick={() =>
                          setItems((current) =>
                            current.filter(
                              (candidate) => candidate.key !== item.key,
                            ),
                          )
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {items.length > 0 ? (
              <div className="flex flex-col gap-1 rounded-md bg-muted/30 p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{fmt(subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Tax ({configQuery.data?.taxRatePercent ?? "0.00"}%)
                  </span>
                  <span>{fmt(tax)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-border pt-2 font-semibold">
                  <span>Draft total</span>
                  <span>{fmt(total)}</span>
                </div>
              </div>
            ) : null}

            <Button disabled={!canSubmit || isSaving} onClick={saveCharges}>
              {isSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Receipt className="mr-2 h-4 w-4" />
              )}
              {activeInvoiceIsDraft
                ? "Update visit invoice"
                : "Create visit invoice"}
            </Button>
            <p className="text-xs text-muted-foreground">
              {activeInvoiceIsDraft
                ? "Unsourced product stock is restored and re-deducted atomically when draft charges change. Visit-prescription stock was already dispensed and is not moved twice."
                : "This creates a draft linked to the appointment. Product stock is deducted atomically; visit prescriptions retain their original dispensation."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
