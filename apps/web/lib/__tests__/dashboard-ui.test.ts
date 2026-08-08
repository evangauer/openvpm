import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard analytics UI", () => {
  it("passes doctor production data into the dashboard chart chunk", () => {
    const source = readFileSync("app/(dashboard)/page.tsx", "utf8");

    expect(source).toContain("chartData.productionByDoctor.some");
    expect(source).toContain(
      "productionByDoctor={chartData.productionByDoctor}",
    );
  });

  it("surfaces missing dashboard payloads before empty dashboard copy", () => {
    const source = readFileSync("app/(dashboard)/page.tsx", "utf8");

    expect(source).toContain("const statsMissing =");
    expect(source).toContain("const isUpcomingMissing =");
    expect(source).toContain("const chartsMissing =");
    expect(source).toContain("const taxConfigMissing =");
    expect(source).toContain("const verifiedTaxConfig =");
    expect(source).toContain("const verifiedCalendarSettings =");
    expect(source).toContain("const verifiedUpcomingAppointments =");
    expect(source).toContain(
      "upcomingError || isUpcomingLoading || isUpcomingMissing || !upcoming.data",
    );
    expect(source).toContain(
      "const upcomingAppointments = (verifiedUpcomingAppointments ?? [])",
    );
    expect(source).toContain("const dashboardStats =");
    expect(source).toContain(
      "const statsError = stats.error ?? taxConfig.error",
    );
    expect(source).toContain(
      "const chartsError = charts.error ?? taxConfig.error",
    );
    expect(source).toContain("statsError || statsDisplayMissing");
    expect(source).toContain("upcomingError || isUpcomingMissing");
    expect(source).toContain("chartsError || chartsDisplayMissing");
    expect(source.indexOf("statsError || statsDisplayMissing")).toBeLessThan(
      source.indexOf(
        "isStatsLoading",
        source.indexOf("statsError || statsDisplayMissing"),
      ),
    );
    expect(source.indexOf("upcomingError || isUpcomingMissing")).toBeLessThan(
      source.indexOf("No visits booked yet"),
    );
    expect(source.indexOf("chartsError || chartsDisplayMissing")).toBeLessThan(
      source.indexOf("Your charts show up once you start"),
    );
    expect(source).toContain("const value = dashboardStats[kpi.key] ?? 0");
    expect(source).not.toContain("charts.data?.appointmentsByDay ?? []");
    expect(source).not.toContain("charts.data?.speciesDistribution ?? []");
    expect(source).not.toContain("charts.data?.revenueByDay ?? []");
    expect(source).not.toContain("charts.data?.productionByDoctor ?? []");
    expect(source).not.toContain("stats.data?.");
    expect(source).not.toContain("taxConfig.data?.");
    expect(source).not.toContain("calendarSettings?.timezone");
    expect(source).not.toContain(
      "const upcomingAppointments = (upcoming.data ?? [])",
    );
  });

  it("renders a month-to-date production by doctor chart", () => {
    const source = readFileSync(
      "components/dashboard/dashboard-charts.tsx",
      "utf8",
    );

    expect(source).toContain("type ProductionByDoctorPoint");
    expect(source).toContain("Production by Doctor (MTD)");
    expect(source).toContain('dataKey="doctorName"');
    expect(source).toContain('dataKey="production"');
    expect(source).toContain(
      'formatter={(value: number) => [fmtMoney(value), "Production"]}',
    );
  });

  it("surfaces signed follow-up obligations as an actionable work queue", () => {
    const source = readFileSync("app/(dashboard)/page.tsx", "utf8");

    expect(source).toContain("trpc.encounters.listPendingFollowUps.useQuery");
    expect(source).toContain("Follow-up work queue");
    expect(source).toContain("No pending follow-up obligations.");
    expect(source).toContain(
      "`/encounters/${followUp.appointmentId}#visit-closeout`",
    );
    expect(source).toContain("Resolve follow-up");
  });
});
