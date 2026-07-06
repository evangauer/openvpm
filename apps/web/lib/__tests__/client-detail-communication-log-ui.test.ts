import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("client detail communication log UI", () => {
  it("uses shared top-level load and error states for client detail", () => {
    const source = readFileSync("app/(dashboard)/clients/[id]/page.tsx", "utf8");

    expect(source).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(source).toContain("AlertCircle");
    expect(source).toContain("function ClientDetailLoadingPanel");
    expect(source).toContain("return <ClientDetailLoadingPanel />");
    expect(source).toContain("if (error || !client)");
    expect(source).toContain('title="Unable to load client"');
    expect(source).toContain('label: "Back to Clients"');
    expect(source).toContain("router.push(\"/clients\")");
    expect(source).not.toContain(
      'className="text-center text-muted-foreground py-12"'
    );
    expect(source).not.toContain("if (!client) return null");
  });

  it("renders the client communication log from the tenant-scoped communications API", () => {
    const source = readFileSync("app/(dashboard)/clients/[id]/page.tsx", "utf8");

    expect(source).toContain("CommunicationLogPanel");
    expect(source).toContain("trpc.communications.getByClient.useQuery");
    expect(source).toContain("trpc.communications.settings.useQuery");
    expect(source).toContain(
      'import { communicationStatusLabel } from "@/lib/communications/status"'
    );
    expect(source).toContain("const statusLabel = communicationStatusLabel(message)");
    expect(source).not.toContain("const communicationStatusLabels =");
    expect(source).toContain("{ clientId }");
    expect(source).toContain('title="No communication log yet"');
    expect(source).toContain(
      "Messages, calls, and portal requests linked to this client will appear here."
    );
  });

  it("surfaces communication log errors before empty states", () => {
    const source = readFileSync("app/(dashboard)/clients/[id]/page.tsx", "utf8");

    expect(source).toContain("const communicationLogError = error ?? settingsError");
    expect(source).toContain(
      "const isCommunicationLogLoading = isLoading || settingsLoading"
    );
    expect(source).toContain("const communicationSettingsMissing =");
    expect(source).toContain("const communicationsMissing =");
    expect(source).toContain("const communicationLogMissing =");
    expect(source).toContain("{communicationLogError || communicationLogMissing ? (");
    expect(source).toContain("Unable to load communication log. Please retry.");
    expect(source).toContain(") : isCommunicationLogLoading ? (");
    expect(
      source.indexOf("communicationLogError || communicationLogMissing")
    ).toBeLessThan(source.indexOf('title="No communication log yet"'));
    expect(source).not.toContain("{error &&");
  });

  it("formats communication timestamps through the practice timezone contract", () => {
    const source = readFileSync("app/(dashboard)/clients/[id]/page.tsx", "utf8");

    expect(source).toContain("const verifiedCommunicationSettings =");
    expect(source).toContain(
      "communicationLogError || isCommunicationLogLoading || communicationLogMissing"
    );
    expect(source).toContain(
      "formatClinicalDateTime(\n                      message.createdAt,\n                      verifiedCommunicationSettings.timezone"
    );
    expect(source).not.toContain("communicationSettings?.timezone");
    expect(source).not.toContain("formatClinicalDateTime(message.createdAt)");
    expect(source).not.toContain("window.location.assign(`/inbox?clientId=${clientId}`)");
  });
});
