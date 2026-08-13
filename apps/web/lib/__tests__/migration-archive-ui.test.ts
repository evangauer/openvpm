import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../../app/(dashboard)/migration-archive/page.tsx", import.meta.url),
  "utf8",
);
const sidebar = readFileSync(
  new URL("../../components/layout/sidebar.tsx", import.meta.url),
  "utf8",
);
const router = readFileSync(
  new URL("../../server/routers/migration-archive.ts", import.meta.url),
  "utf8",
);
const checklist = readFileSync(
  new URL("../../components/migration/migration-review-checklist.tsx", import.meta.url),
  "utf8",
);

describe("imported history workspace", () => {
  it("is discoverable and explains its non-operational safety boundary", () => {
    expect(sidebar).toContain('href: "/migration-archive"');
    expect(sidebar).toContain('label: "Imported History"');
    expect(page).toContain("Source-attributed history from a prior system");
    expect(page).toContain("do not silently create live");
  });

  it("provides keyboard-readable tabs, search, pagination, and linked context", () => {
    expect(page).toContain('role="tablist"');
    expect(page).toContain('role="tab"');
    expect(page).toContain("aria-selected={section === item.id}");
    expect(page).toContain("Search ${activeSection.label.toLowerCase()}");
    expect(page).toContain("Previous");
    expect(page).toContain("Next");
    expect(page).toContain("href={`/patients/${item.patientId}`}");
    expect(page).toContain("href={`/clients/${item.clientId}`}");
    expect(page).toContain("href={item.fileUrl}");
    expect(page).toContain("Open document");
    expect(page).toContain('rel="noopener noreferrer"');
  });

  it("keeps every query tenant-scoped and surfaces review state", () => {
    expect(router).toContain("eq(clientContacts.practiceId, practiceId)");
    expect(router).toContain(
      "eq(historicalAppointments.practiceId, practiceId)",
    );
    expect(router).toContain(
      "eq(externalPrescriptions.practiceId, practiceId)",
    );
    expect(router).toContain("eq(externalLabReports.practiceId, practiceId)");
    expect(router).toContain(
      "eq(legacyFinancialDocuments.practiceId, practiceId)",
    );
    expect(router).toContain("eq(historicalDocuments.practiceId, practiceId)");
    expect(page).toContain("Needs review");
    expect(page).toContain("Never restored automatically");
    expect(page).toContain("messaging consent");
    expect(page).toContain("stock counts require a fresh");
  });

  it("guides a privacy-safe, local-only validation workflow", () => {
    expect(page).toContain("MigrationReviewChecklist");
    expect(page).toContain("Practice data snapshot");
    expect(router).toContain("eq(careReminders.practiceId, practiceId)");
    expect(router).toContain("eq(services.practiceId, practiceId)");
    expect(router).toContain("eq(products.practiceId, practiceId)");
    expect(checklist).toContain("sessionStorage");
    expect(checklist).not.toContain("useMutation");
    expect(checklist).toContain("never paste names, contact information");
    expect(checklist).toContain('href="/clients"');
    expect(checklist).toContain('href="/patients"');
    expect(checklist).toContain("OpenVPM remains responsible for the bulk reconciliation queue");
    expect(checklist).toContain("never releases");
    expect(checklist).toContain('role="progressbar"');
  });
});
