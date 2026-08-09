import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const replacementPage = readFileSync(
  "app/(dashboard)/records/replace-soap/[patientId]/page.tsx",
  "utf8",
);
const patientPage = readFileSync(
  "app/(dashboard)/patients/[id]/page.tsx",
  "utf8",
);
const recordsPage = readFileSync("app/(dashboard)/records/page.tsx", "utf8");
const encounterPage = readFileSync(
  "app/(dashboard)/encounters/[appointmentId]/page.tsx",
  "utf8",
);

describe("SOAP replacement workflow UI", () => {
  it("limits access, prefills the retained source, and uses an idempotent finalization", () => {
    expect(replacementPage).toContain(
      'role === "admin" || role === "veterinarian"',
    );
    expect(replacementPage).toContain(
      "const source = notes.data?.find((note) => note.id === sourceNoteId)",
    );
    expect(replacementPage).toContain('subjective: source.subjective ?? ""');
    expect(replacementPage).toContain('source.correctionReason ?? ""');
    expect(replacementPage).toContain(
      "operationId.current ??= crypto.randomUUID()",
    );
    expect(replacementPage).toContain(
      "trpc.records.replaceSoapNote.useMutation",
    );
    expect(replacementPage).toContain("disabled={!valid || replace.isPending}");
  });

  it("states the permanent clinical and operational consequences", () => {
    expect(replacementPage).toContain(
      "The original remains permanently visible as entered in error",
    );
    expect(replacementPage).toContain(
      "invoice, payment, discharge, and signed handoffs are not reopened",
    );
    expect(replacementPage).toContain("This page is not an autosaved draft");
    expect(replacementPage).toContain(
      "later clarification requires an attributed addendum",
    );
    expect(replacementPage).toContain(
      "Review the signed discharge separately if owner-facing instructions changed.",
    );
  });

  it("shows reciprocal lineage on both chart surfaces", () => {
    for (const source of [patientPage, recordsPage]) {
      expect(source).toContain("Current replacement SOAP");
      expect(source).toContain("View retained original");
      expect(source).toContain("View signed replacement");
      expect(source).toContain("Replace finalized SOAP");
      expect(source).toContain("Create missing replacement");
      expect(source).toContain("Void without replacement");
    }
  });

  it("exposes checked-out recovery and permits only a documented exception", () => {
    expect(encounterPage).toContain("Create missing SOAP replacement");
    expect(encounterPage).toContain("!closeoutQuery.data?.soapDraft");
    expect(encounterPage).toContain("The signed SOAP was voided");
    expect(encounterPage).toContain("Why a replacement SOAP is not required");
    expect(encounterPage).toMatch(
      /props\.linkedSoapCount === 0 && !props\.documentationExceptionReason\.trim\(\)/,
    );
    for (const source of [patientPage, recordsPage]) {
      expect(source).toContain("hasAppointmentSoapDraft");
      expect(source).toContain("Review encounter SOAP draft");
    }
  });
});
