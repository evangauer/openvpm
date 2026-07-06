import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wellness billing UI", () => {
  it("keeps due membership invoice generation reachable from Billing", () => {
    const source = readFileSync("app/(dashboard)/billing/page.tsx", "utf8");

    expect(source).toContain("Wellness invoices due");
    expect(source).toContain("Invoice schedule");
    expect(source).toContain("trpc.wellness.listDue.useQuery");
    expect(source).toContain("trpc.wellness.generateDueInvoices.useMutation");
    expect(source).toContain("utils.wellness.listDue.invalidate");
    expect(source).toContain("utils.billing.listInvoices.invalidate");
    expect(source).toContain("const verifiedDueMemberships =");
    expect(source).toContain("const dueMemberships = verifiedDueMemberships ?? []");
    expect(source).toContain("enrollmentIds: dueMemberships.map");
    expect(source).not.toContain("const dueMemberships = dueQuery.data ?? []");
  });

  it("surfaces missing due membership payloads before treating them as empty", () => {
    const source = readFileSync("app/(dashboard)/billing/page.tsx", "utf8");

    expect(source).toContain("const dueMembershipsMissing =");
    expect(source).toContain("const dueMembershipsUnavailable =");
    expect(source).toContain(
      "dueQuery.isLoading || dueMembershipsUnavailable || !dueQuery.data"
    );
    expect(source).toContain("dueMembershipsUnavailable ||");
    expect(source).toContain(
      "Unable to load due wellness memberships. Please retry."
    );
    expect(source.indexOf("!dueMembershipsMissing")).toBeLessThan(
      source.indexOf("dueMemberships.length === 0")
    );
  });

  it("waits for billing settings before rendering due membership dates", () => {
    const source = readFileSync("app/(dashboard)/billing/page.tsx", "utf8");

    expect(source).toContain("const verifiedBillingConfig =");
    expect(source).toContain("const billingSettingsReady = verifiedBillingConfig !== null");
    expect(source).toContain("settingsReady={billingSettingsReady}");
    expect(source).toContain("settingsReady: boolean");
    expect(source).toContain("enabled: settingsReady");
    expect(source).toContain("!settingsReady ||");
    expect(source).toContain(
      "formatBillingDateInput(\n                      row.nextBillingDate,\n                      billingTimeZone"
    );
  });

  it("describes wellness billing as invoice scheduling instead of autopay", () => {
    const source = readFileSync("app/(dashboard)/billing/page.tsx", "utf8");

    expect(source).toContain("scheduled invoice");
    expect(source).toContain("OpenVPM generates invoices for each billing date");
    expect(source).toContain("staff still");
    expect(source).toContain("collect payment on each invoice");
  });
});
