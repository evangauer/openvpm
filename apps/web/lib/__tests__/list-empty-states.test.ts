import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("dashboard list empty/error states", () => {
  it("keeps Clients error rendering exclusive from the empty state", () => {
    const page = source("app/(dashboard)/clients/page.tsx");

    expect(page).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(page).toContain(
      'import { formatClinicalDate } from "@/lib/records/clinical-dates"'
    );
    expect(page).toContain(
      'import { CLIENT_SEARCH_MAX_LENGTH } from "@/lib/clients/policy"'
    );
    expect(page).toContain("const verifiedClientList =");
    expect(page).toContain(
      "const clientListTimeZone = verifiedClientList\n    ? verifiedClientList.timezone\n    : null"
    );
    expect(page).toContain("const trimmedSearch = search.trim()");
    expect(page).toContain("search: hasSearch ? trimmedSearch : undefined");
    expect(page).toContain("maxLength={CLIENT_SEARCH_MAX_LENGTH}");
    expect(page).toContain("const clientsMissing =");
    expect(page).toContain(
      "formatClinicalDate(\n                      client.createdAt,\n                      clientListTimeZone"
    );
    expect(page).toContain("{verifiedClientList && (");
    expect(page).toContain("verifiedClientList.items.map");
    expect(page).not.toContain("data?.timezone");
    expect(page).not.toContain(
      "new Date(client.createdAt).toLocaleDateString"
    );
    expect(page).toContain("{error || clientsMissing ? (");
    expect(page).toContain(") : isLoading ? (");
    expect(page.indexOf("error || clientsMissing")).toBeLessThan(
      page.indexOf("No clients yet")
    );
    expect(page).toContain("<EmptyState");
    expect(page).not.toContain("{error && (");
  });

  it("keeps Patients error rendering exclusive from the empty state", () => {
    const page = source("app/(dashboard)/patients/page.tsx");

    expect(page).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(page).toContain(
      'import { PATIENT_SEARCH_MAX_LENGTH } from "@/lib/patients/policy"'
    );
    expect(page).toContain("const trimmedSearch = search.trim()");
    expect(page).toContain("const hasFilters = hasSearch || Boolean(species)");
    expect(page).toContain("search: hasSearch ? trimmedSearch : undefined");
    expect(page).toContain("maxLength={PATIENT_SEARCH_MAX_LENGTH}");
    expect(page).toContain("const patientsMissing =");
    expect(page).toContain("{error || patientsMissing ? (");
    expect(page).toContain(") : isLoading ? (");
    expect(page.indexOf("error || patientsMissing")).toBeLessThan(
      page.indexOf("No patients yet")
    );
    expect(page).toContain("<EmptyState");
    expect(page).not.toContain("{error && (");
  });

  it("keeps Controlled Substances errors exclusive from empty states", () => {
    const page = source("app/(dashboard)/controlled-substances/page.tsx");

    expect(page).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(page).toContain(
      "const { data, isLoading, error } = trpc.controlledSubstances.summary.useQuery({});"
    );
    expect(page).toContain(") : isLoading ? (");
    expect(page).toContain("<EmptyState");
    expect(page).toContain('title={\n            search\n              ? "No entries match your filter"');
    expect(page).toContain("function InlineLookupError");
    expect(page).toContain("patientLookupUnavailable");
    expect(page).toContain("witnessLookupUnavailable");
    expect(page).toContain("const summaryMissing =");
    expect(page).toContain("error || summaryMissing");
    expect(page).toContain("const controlledSubstanceLogMissing =");
    expect(page).toContain("{logError || controlledSubstanceLogMissing ? (");
    expect(page.indexOf("logError || controlledSubstanceLogMissing")).toBeLessThan(
      page.indexOf("No controlled substance entries yet")
    );
    expect(page).toContain("Unable to load patients");
    expect(page).toContain("Unable to load witnesses");
    expect(page).toContain('title="No balance data yet"');
  });

  it("keeps Inventory product and supplier errors exclusive from empty states", () => {
    const page = source("app/(dashboard)/inventory/page.tsx");

    expect(page).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(page).toContain("const productsMissing =");
    expect(page).toContain("const suppliersMissing =");
    expect(page).toContain("{productsQuery.error || productsMissing ? (");
    expect(page).toContain(") : productsQuery.isLoading ? (");
    expect(page).toContain("{suppliersQuery.error || suppliersMissing ? (");
    expect(page).toContain(") : suppliersQuery.isLoading ? (");
    expect(page.indexOf("productsQuery.error || productsMissing")).toBeLessThan(
      page.indexOf("No products yet")
    );
    expect(page.indexOf("suppliersQuery.error || suppliersMissing")).toBeLessThan(
      page.indexOf("No suppliers yet")
    );
    expect(page).toContain('title="No suppliers yet"');
    expect(page).toContain('label: "Add first product"');
    expect(page).toContain('label: "Add first supplier"');
  });

  it("keeps Billing invoice-list errors exclusive from empty states", () => {
    const page = source("app/(dashboard)/billing/page.tsx");

    expect(page).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(page).toContain("const listError = billingConfig.error ?? error");
    expect(page).toContain("const isListLoading = billingConfig.isLoading || isLoading");
    expect(page).toContain("const billingListMissing =");
    expect(page).toContain("{listError || billingListMissing ? (");
    expect(page).toContain(") : isListLoading ? (");
    expect(page.indexOf("listError || billingListMissing")).toBeLessThan(
      page.indexOf("No invoices yet")
    );
    expect(page).toContain("<EmptyState");
    expect(page).toContain('label: tab.isEstimate ? "Create estimate" : "Create invoice"');
    expect(page).not.toContain("{error && (");
  });

  it("keeps Whiteboard errors exclusive from empty states", () => {
    const page = source("app/(dashboard)/whiteboard/page.tsx");

    expect(page).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(page).toContain("const hasWhiteboardPatients = columnData.some");
    expect(page).toContain("const pageError = error ?? settingsQuery.error");
    expect(page).toContain("const isPageLoading = isLoading || settingsQuery.isLoading");
    expect(page).toContain("const pageMissing =");
    expect(page).toContain("{pageError || pageMissing ? (");
    expect(page).toContain(") : isPageLoading ? (");
    expect(page).toContain(") : hasWhiteboardPatients ? (");
    expect(page.indexOf("pageError || pageMissing")).toBeLessThan(
      page.indexOf("No patients on the whiteboard")
    );
    expect(page).toContain("<EmptyState");
    expect(page).toContain('label: "Open schedule"');
    expect(page).not.toContain("{error && (");
  });

  it("keeps Dashboard query errors exclusive from fallback values and empty states", () => {
    const page = source("app/(dashboard)/page.tsx");

    expect(page).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(page).toContain('import { formatDateInputForTimeZone } from "@/lib/date-input"');
    expect(page).toContain(
      "const calendarSettingsQuery = trpc.appointments.calendarSettings.useQuery"
    );
    expect(page).toContain("const verifiedTaxConfig =");
    expect(page).toContain("const verifiedCalendarSettings =");
    expect(page).toContain(
      "const dashboardTimeZone = verifiedCalendarSettings\n    ? verifiedCalendarSettings.timezone\n    : null"
    );
    expect(page).toContain("const todayStr = formatDateInputForTimeZone(today, dashboardTimeZone)");
    expect(page).toContain("const tomorrowStr = addDateInputDays(todayStr, 1)");
    expect(page).toContain("endDate: tomorrowStr");
    expect(page).toContain("enabled: verifiedCalendarSettings !== null");
    expect(page).toContain("const upcomingError = calendarSettingsQuery.error ?? upcoming.error");
    expect(page).toContain("const isUpcomingLoading =");
    expect(page).toContain("calendarSettingsQuery.isLoading || upcoming.isLoading");
    expect(page).toContain("formatTime(appt.startTime, dashboardTimeZone)");
    expect(page).not.toContain("today.toISOString().slice(0, 10)");
    expect(page).not.toContain("formatDateInputLocal");
    expect(page).toContain("const statsMissing =");
    expect(page).toContain("const isUpcomingMissing =");
    expect(page).toContain("const chartsMissing =");
    expect(page).toContain("const taxConfigMissing =");
    expect(page).toContain("const verifiedUpcomingAppointments =");
    expect(page).toContain("const upcomingAppointments = (verifiedUpcomingAppointments ?? [])");
    expect(page).toContain("const dashboardStats =");
    expect(page).toContain("{statsError || statsDisplayMissing ? (");
    expect(page).toContain(") : isUpcomingLoading ? (");
    expect(page).toContain("{upcomingError || isUpcomingMissing ? (");
    expect(page).toContain("{chartsError || chartsDisplayMissing ? (");
    expect(page).toContain(") : isChartsLoading ? (");
    expect(page).not.toContain("charts.data?.appointmentsByDay ?? []");
    expect(page).not.toContain("taxConfig.data?.");
    expect(page).not.toContain("stats.data?.");
    expect(page).not.toContain("calendarSettings?.timezone");
    expect(page).not.toContain("const upcomingAppointments = (upcoming.data ?? [])");
    expect(page).toContain('title="No visits booked yet"');
    expect(page).toContain('title="Your charts show up once you start"');
    expect(page).toContain('label: "Book your first visit"');
  });

  it("supports icon-bearing empty-state actions", () => {
    const component = source("components/common/empty-state.tsx");

    expect(component).toContain("icon?: LucideIcon");
    expect(component).toContain("const ActionIcon = action?.icon");
    expect(component).toContain("<ActionIcon");
  });
});
