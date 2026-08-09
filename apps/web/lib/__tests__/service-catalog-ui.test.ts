import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BILLING_SERVICE_CATEGORY_MAX_LENGTH,
  BILLING_SERVICE_CODE_MAX_LENGTH,
  BILLING_SERVICE_NAME_MAX_LENGTH,
  isBillingServicePriceInputValid,
} from "../billing/policy";

describe("service catalog settings UX", () => {
  const settingsSource = readFileSync(
    "app/(dashboard)/settings/page.tsx",
    "utf8"
  );
  const source = readFileSync("components/settings/services-tab.tsx", "utf8");

  it("wires an administrator service-pricing section into settings", () => {
    expect(settingsSource).toContain(
      'import { ServicesTab } from "@/components/settings/services-tab"'
    );
    expect(settingsSource).toContain('| "services"');
    expect(settingsSource).toContain(
      '{ id: "services", label: "Services & Pricing", icon: ReceiptText }'
    );
    expect(settingsSource).toContain(
      'activeTab === "services" && <ServicesTab />'
    );
  });

  it("uses shared input bounds and rejects unsafe prices", () => {
    expect(BILLING_SERVICE_NAME_MAX_LENGTH).toBe(255);
    expect(BILLING_SERVICE_CODE_MAX_LENGTH).toBe(32);
    expect(BILLING_SERVICE_CATEGORY_MAX_LENGTH).toBe(128);
    expect(isBillingServicePriceInputValid("65")).toBe(true);
    expect(isBillingServicePriceInputValid("65.00")).toBe(true);
    expect(isBillingServicePriceInputValid("-1.00")).toBe(false);
    expect(isBillingServicePriceInputValid("1.001")).toBe(false);
    expect(isBillingServicePriceInputValid("100000000")).toBe(false);

    expect(source).toContain("maxLength={BILLING_SERVICE_NAME_MAX_LENGTH}");
    expect(source).toContain("maxLength={BILLING_SERVICE_CODE_MAX_LENGTH}");
    expect(source).toContain("maxLength={BILLING_SERVICE_CATEGORY_MAX_LENGTH}");
    expect(source).toContain("isBillingServicePriceInputValid");
    expect(source).toContain("max={BILLING_UNIT_PRICE_MAX}");
    expect(source).toContain('step="0.01"');
  });

  it("fails closed on missing data and exposes safe lifecycle actions", () => {
    expect(source).toContain("activeQuery.error ?? archivedQuery.error");
    expect(source).toContain("!services || !archivedServices");
    expect(source).toContain("Unable to load services");
    expect(source).toContain("No services configured");
    expect(source).toContain("window.confirm(");
    expect(source).toContain("Existing invoices stay unchanged");
    expect(source).toContain("trpc.billing.createService.useMutation");
    expect(source).toContain("trpc.billing.updateService.useMutation");
    expect(source).toContain("trpc.billing.archiveService.useMutation");
    expect(source).toContain("trpc.billing.restoreService.useMutation");
    expect(source).toContain("expected: expectedServiceSnapshot(service)");
    expect(source).toContain("utils.billing.listServices.invalidate()");
    expect(source).toContain("utils.billing.listArchivedServices.invalidate()");
    expect(source).toContain("disabled={mutationPending}");
  });

  it("freezes the edit baseline and closes stale forms after a conflict", () => {
    expect(source).toMatch(
      /const \[editExpected, setEditExpected\] = useState<ServiceSnapshot \| null>\(\s*null\s*\)/s
    );
    expect(source).toContain(
      "setEditExpected(expectedServiceSnapshot(service))"
    );
    expect(source).toMatch(
      /updateMutation\.mutate\(\{\s*id: service\.id,\s*expected: editExpected,/s
    );
    expect(source).not.toMatch(
      /updateMutation\.mutate\(\{\s*id: service\.id,\s*expected: expectedServiceSnapshot\(service\)/s
    );
    expect(source).toContain('if (error.data?.code === "CONFLICT")');
    expect(source).toContain("setEditForm(EMPTY_FORM)");
    expect(source).toContain("setEditExpected(null)");
    expect(source).toContain("onClick={resetEditState}");
  });

  it("lets clinics configure taxability while preserving invoice snapshots", () => {
    expect(source).toContain("Mark each service taxable");
    expect(source).toContain("historical snapshot");
    expect(source).toContain("taxable: form.taxable");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("Taxable");
  });
});
