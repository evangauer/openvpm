import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceSource = readFileSync(
  "app/(dashboard)/encounters/[appointmentId]/page.tsx",
  "utf8",
);
const scheduleSource = readFileSync(
  "app/(dashboard)/schedule/page.tsx",
  "utf8",
);
const soapSource = readFileSync(
  "app/(dashboard)/records/new-soap/[patientId]/page.tsx",
  "utf8",
);
const encounterVitalsSource = readFileSync(
  "components/records/encounter-vitals-card.tsx",
  "utf8",
);
const patientChartSource = readFileSync(
  "app/(dashboard)/patients/[id]/page.tsx",
  "utf8",
);
const recordsSource = readFileSync(
  "app/(dashboard)/records/page.tsx",
  "utf8",
);

describe("clinic encounter workspace", () => {
  it("opens from an appointment and keeps visit and patient context together", () => {
    expect(scheduleSource).toContain("Open visit");
    expect(scheduleSource).toContain(
      "`/encounters/${appointment.id}#visit-closeout`",
    );
    expect(scheduleSource).toContain("`/encounters/${appointment.id}`");
    expect(workspaceSource).toContain("trpc.appointments.getById.useQuery");
    expect(workspaceSource).toContain("trpc.patients.getById.useQuery");
    expect(workspaceSource).toContain("Clinical work");
    expect(workspaceSource).toContain("Invoice state");
    expect(workspaceSource).toContain("Charge capture");
  });

  it("links SOAP documentation to the appointment and returns to the visit", () => {
    expect(workspaceSource).toContain("?appointmentId=${appointmentId}");
    expect(soapSource).toContain(
      'const appointmentId = searchParams.get("appointmentId") ?? undefined',
    );
    expect(soapSource).toContain("appointmentId,");
    expect(soapSource).toContain(
      "`/encounters/${encodeURIComponent(appointmentId)}`",
    );
    expect(soapSource).toContain("Draft will save after you begin typing");
    expect(soapSource).toContain("Finalize SOAP note");
  });

  it("opens every SOAP editor entry as a separate document history entry", () => {
    expect(workspaceSource).toMatch(
      /<a\s+href=\{`\/records\/new-soap\/\$\{appointment\.patientId\}/,
    );
    expect(workspaceSource).toContain("<a href={props.soapDraftHref}>");
    expect(recordsSource).toMatch(
      /<a\s+href=\{`\/records\/new-soap\/\$\{encodeURIComponent\(patientId\)\}/,
    );
    expect(patientChartSource).toMatch(
      /<a\s+href=\{`\/records\/new-soap\/\$\{encodeURIComponent\(patientId\)\}/,
    );
    for (const source of [workspaceSource, recordsSource, patientChartSource]) {
      expect(source).not.toMatch(
        /<Link\s+href=\{`\/records\/new-soap\//,
      );
    }
    expect(workspaceSource).not.toContain(
      "<Link href={props.soapDraftHref}>",
    );
  });

  it("keeps visit vitals appointment-owned and readable after closeout", () => {
    expect(workspaceSource).toContain(
      "function canRecordVitals(role?: string | null): boolean",
    );
    expect(workspaceSource).toContain('appointment.status === "in_exam"');
    expect(workspaceSource).toContain(
      'closeoutQuery.data?.closeout?.status !== "clinical_finalized"',
    );
    expect(workspaceSource).toContain(
      'closeoutQuery.data?.closeout?.status !== "completed"',
    );
    expect(workspaceSource).toContain("patientId={appointment.patientId}");
    expect(workspaceSource).toContain("appointmentId={appointment.id}");
    expect(workspaceSource).toContain(
      "visitStateReady={visitClinicalStateReady}",
    );
    expect(encounterVitalsSource).toContain(
      "trpc.vitals.listByAppointment.useQuery",
    );
    expect(encounterVitalsSource).toContain("recordVitals.mutate({");
    expect(encounterVitalsSource).toContain(
      "const vitalsReady = Boolean(vitalsQuery.data) && !vitalsQuery.error",
    );
    expect(encounterVitalsSource).toContain("canRecord &&\n    vitalsReady &&");
    expect(encounterVitalsSource).toMatch(
      /recordVitals\.mutate\(\{\s+patientId,\s+appointmentId,/,
    );
    expect(encounterVitalsSource).toContain(
      "Checking whether this visit accepts new vitals...",
    );
    expect(encounterVitalsSource).toContain(
      "This visit is closed to new vitals. Recorded values remain read-only.",
    );
    expect(encounterVitalsSource).toContain(
      "Only an administrator, veterinarian, or technician can record visit vitals.",
    );
    expect(encounterVitalsSource).toContain(
      "utils.vitals.listByPatient.invalidate({ patientId })",
    );
  });

  it("preserves patient-only vitals for historical chart entry", () => {
    expect(patientChartSource).toContain(
      "trpc.vitals.listByPatient.useQuery({ patientId })",
    );
    expect(patientChartSource).toMatch(
      /record\.mutate\(\{\s+patientId,\s+temperatureC:/,
    );
  });

  it("creates appointment-linked service and product charges with role guards", () => {
    expect(workspaceSource).toContain(
      'role === "admin" || role === "front_desk"',
    );
    expect(workspaceSource).toContain('itemType: "service" as const');
    expect(workspaceSource).toContain('itemType: "product" as const');
    expect(workspaceSource).toContain("trpc.billing.createInvoice.useMutation");
    expect(workspaceSource).toContain("appointmentId,");
    expect(workspaceSource).toContain("Product stock is");
    expect(workspaceSource).toContain("deducted atomically");
    expect(workspaceSource).toContain("formatPrice={fmt}");
  });

  it("edits an existing unpaid draft without creating a duplicate invoice", () => {
    expect(workspaceSource).toContain(
      "trpc.billing.updateInvoiceItems.useMutation",
    );
    expect(workspaceSource).toContain("Loading existing visit charges...");
    expect(workspaceSource).toContain("Only unpaid");
    expect(workspaceSource).toContain("Update visit invoice");
    expect(workspaceSource).toContain(
      "Visit-prescription stock was already dispensed and is not moved twice.",
    );
    expect(workspaceSource).toContain("isBillingInvoiceLineTotalValid");
  });

  it("locks charge creation until invoice state is known and surfaces failures", () => {
    expect(workspaceSource).toContain("invoiceStateReady");
    expect(workspaceSource).toContain("Confirming visit invoice state...");
    expect(workspaceSource).toContain(
      "Charge capture is locked because invoice state could not be",
    );
    expect(workspaceSource).toContain(
      "Unable to load invoice state. Do not create duplicate charges",
    );
    expect(workspaceSource).toContain("No active invoice for this visit");
    expect(workspaceSource).toContain("!invoice.isEstimate");
    expect(workspaceSource).toContain("Charge catalog is empty");
    expect(workspaceSource).toContain(
      "Charge capture is locked because tax and currency settings could",
    );
  });

  it("requires the durable two-stage closeout instead of a direct checkout", () => {
    expect(workspaceSource).toContain("trpc.encounters.getCloseout.useQuery");
    expect(workspaceSource).toContain(
      "trpc.encounters.finalizeClinical.useMutation",
    );
    expect(workspaceSource).toContain(
      "trpc.encounters.completeVisit.useMutation",
    );
    expect(workspaceSource).toContain("Finalize clinical handoff");
    expect(workspaceSource).toContain("Billing and owner handoff");
    expect(workspaceSource).toContain("Download discharge");
    expect(workspaceSource).not.toContain(
      'return { label: "Check out", status: "checked_out" }',
    );
  });

  it("makes clinical finalization explanatory and prevents late validation", () => {
    expect(workspaceSource).toContain("finalizationIssues");
    expect(workspaceSource).toContain("Before finalizing");
    expect(workspaceSource).toContain("Documented exception");
    expect(workspaceSource).toContain("linkedMedicationCount");
    expect(workspaceSource).toContain("disabled={!canFinalizeNow}");
  });

  it("keeps the signed owner handoff reviewable and mobile billing reachable", () => {
    expect(workspaceSource).toContain("Diagnosis or visit summary");
    expect(workspaceSource).toContain("Warning signs and when to call");
    expect(workspaceSource).toContain("Prior finalized versions");
    expect(workspaceSource).toContain("downloadHistoricalDischarge");
    expect(workspaceSource).toContain('id="charge-capture"');
    expect(workspaceSource).toContain('href="#charge-capture"');
    expect(workspaceSource).toContain("tabIndex={-1}");
  });

  it("links prescriptions to the visit and preserves their inventory ownership", () => {
    expect(workspaceSource).toContain("tab=prescriptions&new=1");
    expect(workspaceSource).toContain("sourceDispenseChargeId");
    expect(workspaceSource).toContain('dispenseChargeStatus === "pending"');
    expect(workspaceSource).toContain("inventory already dispensed");
    expect(workspaceSource).toContain("expectedUpdatedAt");
  });

  it("makes performed work reconciliation explicit without automatic billing", () => {
    expect(workspaceSource).toContain(
      "trpc.encounters.getVisitReconciliation.useQuery",
    );
    expect(workspaceSource).toContain(
      "trpc.encounters.resolveVisitWork.useMutation",
    );
    expect(workspaceSource).toContain("Performed work reconciliation");
    expect(workspaceSource).toContain("Link confirmed charge");
    expect(workspaceSource).toContain("No charge");
    expect(workspaceSource).toContain("Void/corrected");
    expect(workspaceSource).toContain("never bills a suggestion automatically");
  });
});
