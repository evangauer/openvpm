import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PDF_ACTION_PAGES = [
  "app/(dashboard)/billing/page.tsx",
  "app/(dashboard)/patients/[id]/page.tsx",
  "app/(dashboard)/encounters/[appointmentId]/page.tsx",
  "app/(dashboard)/records/page.tsx",
  "app/(dashboard)/reports/page.tsx",
  "app/portal/[token]/pets/[petId]/page.tsx",
];

const RECHARTS_PAGE_CHUNKS: Record<
  string,
  { chunk: string; loading: string; importCount: number }
> = {
  "app/(dashboard)/page.tsx": {
    chunk: "components/dashboard/dashboard-charts",
    loading: "DashboardChartsChunkLoading",
    importCount: 1,
  },
  "app/(dashboard)/reports/page.tsx": {
    chunk: "components/reports/report-charts",
    loading: "ReportChartChunkLoading",
    importCount: 2,
  },
  "app/(dashboard)/patients/[id]/page.tsx": {
    chunk: "components/patients/patient-trend-charts",
    loading: "PatientChartChunkLoading",
    importCount: 2,
  },
  "app/(dashboard)/records/page.tsx": {
    chunk: "components/patients/patient-trend-charts",
    loading: "RecordsChartChunkLoading",
    importCount: 1,
  },
};

describe("heavy client imports", () => {
  it("lazy-loads jsPDF generators at action time instead of page module load", () => {
    for (const file of PDF_ACTION_PAGES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from ["']@\/lib\/pdf["']/);
      expect(source).toContain('import("@/lib/pdf")');
    }
  });

  it("loads the Tiptap SOAP editor as a route-level dynamic chunk", () => {
    const source = readFileSync(
      "app/(dashboard)/records/new-soap/[patientId]/page.tsx",
      "utf8"
    );
    expect(source).toContain('from "next/dynamic"');
    expect(source).toContain('import("@/components/SoapNoteEditor")');
    expect(source).not.toMatch(/from ["']@\/components\/SoapNoteEditor["']/);
  });

  it("keeps Recharts out of initial dashboard page modules", () => {
    for (const [file, { chunk, loading, importCount }] of Object.entries(
      RECHARTS_PAGE_CHUNKS
    )) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('from "next/dynamic"');
      expect(
        source.match(new RegExp(`import\\("@/${chunk}"\\)`, "g")) ?? []
      ).toHaveLength(importCount);
      expect(
        source.match(new RegExp(`loading: ${loading}`, "g")) ?? []
      ).toHaveLength(importCount);
      expect(source).not.toMatch(/from ["']recharts["']/);
    }
  });
});
