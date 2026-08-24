import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync(
  "components/patients/patient-history-search.tsx",
  "utf8",
);
const patientPage = readFileSync(
  "app/(dashboard)/patients/[id]/page.tsx",
  "utf8",
);
const recordsRouter = readFileSync("server/routers/records.ts", "utf8");
const providers = readFileSync("lib/providers.tsx", "utf8");
const trpcRoute = readFileSync("app/api/trpc/[trpc]/route.ts", "utf8");

describe("patient history search UI", () => {
  it("keeps the existing SOAP timeline until read-only filters are applied", () => {
    const medicalRecordsTab = patientPage.slice(
      patientPage.indexOf("function MedicalRecordsTab"),
      patientPage.indexOf("function SoapAddendumControl"),
    );
    expect(patientPage).toContain("const [historySearchActive");
    expect(medicalRecordsTab).toContain("!historySearchActive ? (");
    expect(medicalRecordsTab).toContain("notes.map((note)");
    expect(medicalRecordsTab.indexOf("<PatientHistorySearch")).toBeLessThan(
      medicalRecordsTab.indexOf("error ? ("),
    );
    expect(component).toContain("onSearchModeChange(true)");
    expect(component).toContain("onSearchModeChange(false)");
    expect(component).toContain(
      "The complete SOAP\n          timeline remains below.",
    );
  });

  it("uses an explicit POST operation so clinical terms never enter URLs", () => {
    expect(component).toContain("trpc.records.searchPatientHistory.useQuery(");
    expect(recordsRouter).toContain("searchPatientHistory: protectedProcedure");
    expect(recordsRouter).toContain(
      "The client sends this query over POST so clinical terms stay out of URLs",
    );
    expect(providers).toContain('"records.searchPatientHistory"');
    expect(providers).toContain('methodOverride: "POST"');
    expect(trpcRoute).toContain("allowMethodOverride: true");
    expect(component).not.toContain("useSearchParams");
    expect(component).not.toContain("localStorage");
    expect(component).not.toContain("sessionStorage");
    expect(component).not.toContain("window.history");
  });

  it("is clinical-role gated and leaves front desk on the existing SOAP view", () => {
    expect(patientPage).toContain(
      "function canSearchPatientHistoryRole(role?: string | null): boolean",
    );
    expect(patientPage).toContain('role === "viewer"');
    const roleBlock = patientPage.slice(
      patientPage.indexOf("function canSearchPatientHistoryRole"),
      patientPage.indexOf("type VitalsFormState"),
    );
    expect(roleBlock).not.toContain('role === "front_desk"');
    expect(recordsRouter).toContain(
      '.use(requireRole("admin", "veterinarian", "technician", "viewer"))',
    );
  });

  it("provides responsive accessible filters, result states, counts, and paging", () => {
    for (const marker of [
      'aria-label="Find in patient history"',
      "aria-pressed={selected}",
      "aria-pressed={state === value}",
      'aria-live="polite"',
      "aria-busy={search.isFetching}",
      'role="alert"',
      "No history matches these filters",
      "Unable to search patient history",
      "Clear filters",
      "Previous",
      "Next",
      "min-h-11",
      "sm:grid-cols-2",
    ]) {
      expect(component).toContain(marker);
    }
    expect(patientPage).toContain('role="tablist"');
    expect(patientPage).toContain('role="tab"');
    expect(patientPage).toContain('role="tabpanel"');
    expect(patientPage).toContain("overflow-x-auto border-b");
  });

  it("labels provenance and immutable correction/replacement semantics", () => {
    for (const label of [
      "Imported",
      "Corrected · retained",
      "Current replacement",
      "Original replaced",
      "Private staff notes and worklists are never",
    ]) {
      expect(component).toContain(label);
    }
    expect(component).toContain("item.authorLabel");
    expect(component).toContain("Finalized by ${item.finalizerName}");
  });
});
