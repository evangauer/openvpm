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

  it("offers explicit hours, closed state, lunch windows, and destructive-change consent", () => {
    expect(providerHours).toContain("Use Mon–Fri, 8–6");
    expect(providerHours).toContain("Mark all closed");
    expect(providerHours).toContain("Add window");
    expect(providerHours).toContain("working windows cannot overlap");
    expect(providerHours).toContain(
      "clinic setup and do not yet limit the schedule or client requests",
    );
    expect(providerHours).toContain("Move ${provider.name} to");
    expect(providerHours).toContain(
      "Multi-location hours are not supported yet",
    );
    expect(providerHours).toContain("setEditingRevision(provider.revision)");
    expect(providerHours).toContain("expectedRevision: editingRevision!");
    expect(providerHours).toContain("moveToPrimaryLocation:");
    expect(providerHours).toContain("replaceOtherLocationHours:");
    expect(providerHours).toContain(
      "draft.length > 0 && !provider.assignedToPrimary",
    );
  });
});
