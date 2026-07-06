import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("reports export UI", () => {
  const source = readFileSync("app/(dashboard)/reports/page.tsx", "utf8");
  const routerSource = readFileSync("server/routers/reports.ts", "utf8");

  it("keeps CSV export reachable for empty services reports", () => {
    const servicesBlock = source.slice(
      source.indexOf("function ServicesTab"),
      source.indexOf("function InventoryTab")
    );

    expect(servicesBlock).toContain("if (data.items.length === 0)");
    expect(servicesBlock).toContain("onCsv={exportServices}");
    expect(source).toContain("Export CSV");
    expect(servicesBlock).toContain("No service data available");
  });

  it("exports every reports tab to CSV and PDF without loading jsPDF upfront", () => {
    expect(source).toContain("function ReportExportButtons");
    expect(source).toContain('import("@/lib/pdf")');
    expect(source).toContain("generateReportPdf");
    expect(source).toContain('Export CSV');
    expect(source).toContain('Export PDF');
    expect(source).toContain('title: "Revenue Report"');
    expect(source).toContain('title: "Appointments Report"');
    expect(source).toContain('title: "Services Report"');
    expect(source).toContain('title: "Inventory Alerts Report"');
    expect(source).toContain('filename: reportFilename("revenue", data.range, "pdf")');
    expect(source).toContain(
      'filename: reportFilename("appointments", data.range, "pdf")'
    );
    expect(source).toContain('filename: reportFilename("services", data.range, "pdf")');
    expect(source).toContain('filename: reportFilename("inventory", undefined, "pdf")');
    expect(source).not.toMatch(/from ["']@\/lib\/pdf["']/);
  });

  it("uses practice-timezone report presets", () => {
    expect(source).toContain('} from "@/lib/reports/date-range"');
    expect(source).toContain("trpc.reports.settings.useQuery");
    expect(source).toContain("const reportSettings = settingsQuery.data");
    expect(source).toContain(
      "defaultClientReportDateRange(new Date(), reportSettings.timezone)"
    );
    expect(source).toContain("const reportSettingsReady =");
    expect(source).toContain(
      "!needsDateRange || Boolean(reportSettings && !settingsQuery.error)"
    );
    expect(source).toContain("const canRenderDateRangeControls =");
    expect(source).toContain(
      "needsDateRange && dateRange && reportSettings && !settingsQuery.error"
    );
    expect(source).toContain("timeZone={reportSettings.timezone}");
    expect(source).toContain(
      "onChange(reportPresetDateRange(preset, new Date(), timeZone))"
    );
    expect(source).toContain(
      "const dateRangeError = needsDateRange ? settingsQuery.error : null"
    );
    expect(source).not.toContain("settingsQuery.data?.timezone");
    expect(source).not.toContain("const reportTimeZone =");
    expect(source).not.toContain("formatDateInputLocal");
  });

  it("gates report queries on complete valid custom date ranges", () => {
    expect(source).toContain("reportDateRangeInputError(dateRange)");
    expect(source).toContain(
      "isCompleteReportDateRangeInputValid(dateRange)"
    );
    expect(source).toContain("validationMessage={dateRangeValidationMessage}");
    expect(source).toContain(
      "aria-invalid={Boolean(validationMessage) || undefined}"
    );
    expect(source).toContain('id="reports-date-range-error"');
    expect(source).toContain("function ReportDateRangeInvalid");
    expect(source).toContain("Choose a valid report date range");
    expect(source).toContain(
      "activeTab === \"revenue\" && hasValidDateRange && dateRange"
    );
    expect(source).toContain(
      "hasValidDateRange && dateRange ? (\n            <AppointmentsTab dateRange={dateRange} />"
    );
    expect(source).toContain(
      "activeTab === \"services\" && hasValidDateRange && dateRange"
    );
  });

  it("uses shared empty states for report panels without data", () => {
    const revenueBlock = source.slice(
      source.indexOf("function RevenueTab"),
      source.indexOf("function AppointmentsTab")
    );
    const appointmentsBlock = source.slice(
      source.indexOf("function AppointmentsTab"),
      source.indexOf("function ServicesTab")
    );
    const inventoryBlock = source.slice(
      source.indexOf("function InventoryTab"),
      source.indexOf("export default function ReportsPage")
    );

    expect(source).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(revenueBlock).toContain('title="No revenue data for this period"');
    expect(appointmentsBlock).toContain('title="No doctor breakdown available"');
    expect(inventoryBlock).toContain('title="All stock levels OK"');
  });

  it("does not leave report tabs loading forever when payloads are missing", () => {
    const reportBlocks = [
      source.slice(
        source.indexOf("function RevenueTab"),
        source.indexOf("function AppointmentsTab")
      ),
      source.slice(
        source.indexOf("function AppointmentsTab"),
        source.indexOf("function ServicesTab")
      ),
      source.slice(
        source.indexOf("function ServicesTab"),
        source.indexOf("function InventoryTab")
      ),
      source.slice(
        source.indexOf("function InventoryTab"),
        source.indexOf("export default function ReportsPage")
      ),
    ];

    expect(source).toContain("function ReportMissingData");
    expect(source).toContain('title="Could not load report data"');
    expect(source).not.toContain("isLoading || !data");
    expect(source).toContain("const settingsMissingData =");
    expect(source).toContain("reportSettings === undefined");
    expect(source).toContain(
      "settingsMissingData ? (\n          <ReportMissingData onRetry={() => settingsQuery.refetch()} />"
    );

    for (const block of reportBlocks) {
      expect(block).toContain("if (isLoading) return <LoadingSkeleton />");
      expect(block).toContain(
        "if (!data) return <ReportMissingData onRetry={() => refetch()} />"
      );
    }
  });

  it("reports expired and expiring inventory alerts separately", () => {
    const inventoryBlock = source.slice(
      source.indexOf("function InventoryTab"),
      source.indexOf("export default function ReportsPage")
    );
    const apiDocs = readFileSync("app/api-docs/page.tsx", "utf8");

    expect(inventoryBlock).toContain("data.expired.length");
    expect(inventoryBlock).toContain("data.expiringSoon.length");
    expect(inventoryBlock).toContain("Expired Products");
    expect(inventoryBlock).toContain("Expiring Soon");
    expect(inventoryBlock).toContain('"expired"');
    expect(inventoryBlock).toContain('"expiring_soon"');
    expect(inventoryBlock).not.toContain("data.expiring.length");
    expect(apiDocs).toContain("expired: Product[]");
    expect(apiDocs).toContain("expiringSoon: Product[]");
    expect(apiDocs).not.toContain("expiring: Product[]");
  });

  it("gates reports to the roles that can access reporting data", () => {
    expect(source).toContain('import { useRouter } from "next/navigation"');
    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain(
      "function canViewReportsRole(role?: string | null): boolean"
    );
    expect(source).toContain('role === "admin" || role === "veterinarian"');
    expect(source).toContain("const { data: session, status } = useSession()");
    expect(source).toContain('if (status === "loading")');
    expect(source).toContain("if (!canViewReportsRole(session?.user?.role))");
    expect(source).toContain("Reports are restricted");
    expect(source).toContain("return <ReportsDashboard />");
    expect(source).toContain("function ReportsDashboard()");
    expect(source.indexOf("function ReportsDashboard()")).toBeLessThan(
      source.indexOf("trpc.reports.settings.useQuery")
    );
    expect(routerSource).toContain('requireRole("admin", "veterinarian")');
  });
});
