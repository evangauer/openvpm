import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsPage = readFileSync(
  new URL("../../app/(dashboard)/settings/page.tsx", import.meta.url),
  "utf8",
);
const providerHours = readFileSync(
  new URL("../../components/settings/provider-hours.tsx", import.meta.url),
  "utf8",
);

describe("provider hours settings UI", () => {
  it("keeps working hours in the Staff tab", () => {
    const staffStart = settingsPage.indexOf("function StaffTab()");
    const nextTab = settingsPage.indexOf(
      "function AppointmentTypesTab()",
      staffStart,
    );
    const providerHoursPlacement = settingsPage.indexOf("<ProviderHours />");

    expect(providerHoursPlacement).toBeGreaterThan(staffStart);
    expect(providerHoursPlacement).toBeLessThan(nextTab);
    expect(settingsPage.match(/<ProviderHours \/>/g)).toHaveLength(1);
  });

  it("offers explicit multi-location hours, closed state, and lunch windows", () => {
    expect(providerHours).toContain("Use Mon–Fri, 8–6");
    expect(providerHours).toContain("Mark all closed");
    expect(providerHours).toContain("Add window");
    expect(providerHours).toContain("working windows cannot overlap");
    expect(providerHours).toContain("Provider hours clinic location");
    expect(providerHours).toContain("Doctor-required client requests");
    expect(providerHours).toContain("locationSchedules.find");
    expect(providerHours).toContain("Home base:");
    expect(providerHours).toContain("setEditingRevision(provider.revision)");
    expect(providerHours).toContain("expectedRevision: editingRevision!");
    expect(providerHours).toContain("locationId: selectedLocation.id");
    expect(providerHours).not.toContain(
      "Multi-location hours are not supported",
    );
  });
});
