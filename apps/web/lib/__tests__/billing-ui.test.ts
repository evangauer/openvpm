import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BILLING_ADJUSTMENT_REASON_MAX_LENGTH,
  BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH,
  BILLING_INVOICE_LINE_QUANTITY_MAX,
  BILLING_INVOICE_LINE_QUANTITY_MIN,
  BILLING_INVOICE_MAX_ITEMS,
  BILLING_NOTES_MAX_LENGTH,
  BILLING_PAYMENT_AMOUNT_MIN,
  BILLING_UNIT_PRICE_MAX,
  isBillingAmountWithinBalance,
  isBillingCurrencyAmountInputValid,
  isBillingInvoiceLineQuantityValid,
  isBillingInvoiceLineTotalValid,
  isBillingInvoiceSubtotalValid,
} from "../billing/policy";
import {
  CLIENT_SEARCH_MAX_LENGTH,
  isClientSearchInputValid,
} from "../clients/policy";

describe("billing invoice form UX", () => {
  const source = readFileSync("app/(dashboard)/billing/new/page.tsx", "utf8");

  it("keeps invoice line item controls aligned to shared bounds", () => {
    expect(BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH).toBe(500);
    expect(BILLING_INVOICE_LINE_QUANTITY_MIN).toBe(1);
    expect(BILLING_INVOICE_LINE_QUANTITY_MAX).toBe(10000);
    expect(BILLING_INVOICE_MAX_ITEMS).toBe(200);
    expect(BILLING_UNIT_PRICE_MAX).toBe(99999999.99);
    expect(isBillingInvoiceLineQuantityValid(1)).toBe(true);
    expect(isBillingInvoiceLineQuantityValid(0)).toBe(false);
    expect(isBillingCurrencyAmountInputValid("15.00")).toBe(true);
    expect(isBillingCurrencyAmountInputValid("15.123")).toBe(false);
    expect(isBillingCurrencyAmountInputValid("100000000")).toBe(false);
    expect(isBillingInvoiceLineTotalValid("15.00", 2)).toBe(true);
    expect(isBillingInvoiceLineTotalValid("99999999.99", 2)).toBe(false);
    expect(
      isBillingInvoiceSubtotalValid([
        { quantity: 100, unitPrice: "99999999.99" },
      ])
    ).toBe(false);
    expect(source).toContain(
      "maxLength={BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH}"
    );
    expect(source).toContain("min={BILLING_INVOICE_LINE_QUANTITY_MIN}");
    expect(source).toContain("max={BILLING_INVOICE_LINE_QUANTITY_MAX}");
    expect(source).toContain("max={BILLING_UNIT_PRICE_MAX}");
    expect(source).toContain("const canAddItem =");
    expect(source).toContain("items.length < BILLING_INVOICE_MAX_ITEMS");
    expect(source).toContain("isBillingInvoiceLineTotalValid");
    expect(source).toContain("const canSubmitInvoice =");
    expect(source).toContain("isBillingInvoiceSubtotalValid(items)");
    expect(source).toContain("disabled={!canAddItem}");
    expect(source).toContain("disabled={\n              !canSubmitInvoice");
    expect(source).toContain("description: trimmedItemDescription");
    expect(source).toContain("unitPrice: itemUnitPrice.trim()");
  });

  it("uses currency inputs for invoice unit prices", () => {
    expect(source).toMatch(
      /type="number"[\s\S]*?step="0\.01"[\s\S]*?min=\{0\}[\s\S]*?max=\{BILLING_UNIT_PRICE_MAX\}[\s\S]*?placeholder="Unit Price"/
    );
  });

  it("defaults invoice due dates from the practice timezone", () => {
    expect(source).toContain(
      'import { formatDateInputForTimeZone } from "@/lib/date-input"'
    );
    expect(source).toContain(
      "function defaultDueDate(timeZone?: string | null)",
    );
    expect(source).toContain(
      "const today = formatDateInputForTimeZone(new Date(), timeZone)",
    );
    expect(source).toContain("return addDateInputDays(today, 30)");
    expect(source).toContain('const [dueDate, setDueDate] = useState("")');
    expect(source).toContain(
      "const [dueDateTouched, setDueDateTouched] = useState(false)",
    );
    expect(source).toContain("const taxConfig = taxConfigQuery.data");
    expect(source).toContain(
      "const taxConfigReady = taxConfig !== undefined && !taxConfigQuery.error",
    );
    expect(source).toContain(
      "if (!dueDateTouched && taxConfigReady && taxConfig)",
    );
    expect(source).toContain("setDueDate(defaultDueDate(taxConfig.timezone))");
    expect(source).toContain("dueDate.trim().length > 0");
    expect(source).toContain("setDueDateTouched(true)");
    expect(source).toContain("Loading practice date settings...");
    expect(source).toContain(
      "Choose a due date manually. Practice settings could not load."
    );
    expect(source).not.toContain("taxConfigQuery.data?.timezone");
    expect(source).not.toContain("formatDateInputLocal");
    expect(source).not.toContain('toISOString().split("T")[0]');
  });

  it("surfaces invoice form lookup and service query states", () => {
    expect(CLIENT_SEARCH_MAX_LENGTH).toBe(100);
    expect(isClientSearchInputValid(" Ada ")).toBe(true);
    expect(isClientSearchInputValid(" ".repeat(8))).toBe(false);
    expect(isClientSearchInputValid("A".repeat(101))).toBe(false);

    expect(source).toContain("function InlineQueryMessage");
    expect(source).toContain("isClientSearchInputValid(clientSearch)");
    expect(source).toContain("maxLength={CLIENT_SEARCH_MAX_LENGTH}");
    expect(source).toContain("clientResults.error");
    expect(source).toContain("clientResults.isLoading");
    expect(source).toContain("const clientResultsMissing =");
    expect(source).toContain("const clientOptions =");
    expect(source).toContain("clientOptions.map((client)");
    expect(source).toContain("clientResults.error || clientResultsMissing");
    expect(source).toContain("Unable to search clients. Please retry.");
    expect(source.indexOf("clientResults.error || clientResultsMissing")).toBeLessThan(
      source.indexOf("No clients found")
    );
    expect(source).toContain("patientResults.error");
    expect(source).toContain("patientResults.isLoading");
    expect(source).toContain("const patientResultsMissing =");
    expect(source).toContain("const patientOptions =");
    expect(source).toContain("patientOptions.map((patient)");
    expect(source).toContain("patientResults.error || patientResultsMissing");
    expect(source).toContain("Unable to load client patients. Please retry.");
    expect(source).toContain("servicesQuery.error");
    expect(source).toContain("servicesQuery.isLoading");
    expect(source).toContain("const servicesMissing =");
    expect(source).toContain("const serviceOptions =");
    // The plain select gave way to the searchable picker (service-picker-ui
    // tests cover its behavior); the page still feeds it the guarded options.
    expect(source).toContain("<ServicePicker");
    expect(source).toContain("services={serviceOptions}");
    expect(source).toContain("serviceOptions.find((s) => s.id === serviceId)");
    expect(source).toContain(
      "serviceOptions.find((s) => s.id === selectedServiceId)"
    );
    expect(source).toContain("servicesQuery.error || servicesMissing");
    expect(source).toContain("Unable to load billing services");
    expect(source).toContain("Unable to load billing services. Please retry.");
    expect(source).toContain("!servicesMissing");
    expect(source).toContain("Searching clients...");
    expect(source).not.toContain("clientResults.data?.map");
    expect(source).not.toContain("patientResults.data?.map");
    expect(source).not.toContain("servicesQuery.data?.map");
    expect(source).not.toContain("servicesQuery.data?.find");
  });

  it("warns when invoice preview tax settings fail to load", () => {
    expect(source).toContain("taxConfigQuery.error");
    expect(source).toContain("const taxConfigMissing =");
    expect(source).toContain("taxConfigQuery.error || taxConfigMissing");
    expect(source).toContain("Unable to load practice tax settings");
    expect(source).toContain("Preview totals omit tax");
    expect(source).toContain("Loading practice tax settings...");
    expect(source).toContain("taxConfigQuery.error || taxConfigMissing");
    expect(source).toContain(
      'taxConfigReady && taxConfig ? taxConfig.taxRatePercent : "0.00"'
    );
    expect(source).toContain(
      'taxConfigReady && taxConfig ? taxConfig.currency : "usd"'
    );
    expect(source).toContain(
      'taxConfigReady && taxConfig ? taxConfig.country : "US"'
    );
    expect(source).not.toContain("taxConfigQuery.data?.taxRatePercent");
    expect(source).not.toContain("taxConfigQuery.data?.currency");
    expect(source).not.toContain("taxConfigQuery.data?.country");
  });

  it("guards direct invoice creation to billing managers", () => {
    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain("function canManageBillingRole");
    expect(source).toContain('role === "admin" || role === "front_desk"');
    expect(source).toContain("function NewInvoiceForm()");
    expect(source).toContain(
      "if (!canManageBillingRole(session?.user?.role))"
    );
    expect(source).toContain("Billing actions are read-only");
    expect(source).toContain(
      "Only admins and front desk staff can create invoices or estimates."
    );
  });
});

describe("billing invoice payment actions", () => {
  const source = readFileSync("app/(dashboard)/billing/page.tsx", "utf8");

  it("only offers payment collection for sent or overdue invoice balances", () => {
    expect(source).toContain(
      'canManageBilling &&\n    (invoiceStatus === "sent" || invoiceStatus === "overdue") &&\n    remaining > 0',
    );
    expect(source).not.toContain(
      'invoiceStatus !== "paid" && invoiceStatus !== "void" && remaining > 0'
    );
  });

  it("does not offer a status-only path for settling an invoice", () => {
    expect(source).not.toContain('title="Mark as Paid"');
    expect(source).not.toContain('onStatusChange(e, invoice.id, "paid")');
    expect(source).toContain("Record Payment");
    expect(source).toContain("Take Card");
  });

  it("offers invoice email only while a balance-bearing invoice is sent or overdue", () => {
    expect(source).toContain(
      '(invoice.status === "sent" ||\n                          invoice.status === "overdue")'
    );
    expect(source).not.toContain(
      'invoice.status === "overdue" ||\n                          invoice.status === "paid"'
    );
  });

  it("uses accessible in-app dialogs for irreversible billing actions", () => {
    expect(source).toContain("<ActionConfirmationDialog");
    expect(source).toContain('title="Void invoice?"');
    expect(source).toContain('label: "Reason for voiding"');
    expect(source).toContain('title="Refund payment?"');
    expect(source).toContain('confirmLabel="Refund payment"');
    expect(source).not.toContain("window.prompt");
    expect(source).not.toContain("window.confirm");
  });

  it("keeps one operation ID across payment and adjustment retries", () => {
    expect(source).toContain("paymentOperationId.current ??= crypto.randomUUID()");
    expect(source).toContain("operationId: paymentOperationId.current");
    expect(source).toContain(
      "adjustmentOperationId.current ??= crypto.randomUUID()"
    );
    expect(source).toContain("operationId: adjustmentOperationId.current");
  });

  it("disables card checkout when Stripe checkout is not configured", () => {
    expect(source).toContain("trpc.billing.cardPaymentStatus.useQuery");
    expect(source).toContain("const cardPaymentStatusMissing =");
    expect(source).toContain("const verifiedCardPaymentStatus =");
    expect(source).toContain("const cardPaymentsEnabled =");
    expect(source).toContain("const cardPaymentsUnavailable =");
    expect(source).toContain("!cardPaymentsEnabled");
    expect(source).toContain("Card payments are not configured");
    expect(source).toContain(
      'import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect"'
    );
    expect(source).toContain("if (!isSafeCheckoutRedirectUrl(url))");
    expect(source).not.toContain("cardPaymentStatus.data?.enabled");
    expect(source).not.toContain(
      "disabled={cardCheckout.isPending}"
    );
  });

  it("hides write-only billing controls for non-billing roles", () => {
    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain("function canManageBillingRole");
    expect(source).toContain('role === "admin" || role === "front_desk"');
    expect(source).toContain(
      "const canManageBilling = canManageBillingRole(session?.user?.role)"
    );
    expect(source).toContain("{canManageBilling && (");
    expect(source).toContain("canManageBilling={canManageBilling}");
    expect(source).toContain("enabled: canManageBilling");
    expect(source).toContain("canManageBilling &&\n    (invoiceStatus");
    expect(source).toContain(
      "canManageBilling &&\n    isBillingAmountWithinBalance(paymentAmount"
    );
    expect(source).toContain("<EmailInvoiceButton invoiceId={invoice.id} />");
  });

  it("keeps payment and adjustment forms aligned to shared billing bounds", () => {
    expect(BILLING_PAYMENT_AMOUNT_MIN).toBe(0.01);
    expect(BILLING_NOTES_MAX_LENGTH).toBe(2000);
    expect(BILLING_ADJUSTMENT_REASON_MAX_LENGTH).toBe(500);
    expect(isBillingAmountWithinBalance("30.00", "80.00")).toBe(true);
    expect(isBillingAmountWithinBalance("0.00", "80.00")).toBe(false);
    expect(isBillingAmountWithinBalance("30.001", "80.00")).toBe(false);
    expect(isBillingAmountWithinBalance("81.00", "80.00")).toBe(false);
    expect(source).toContain("const amountInputMax = Math.min");
    expect(source).toContain("const canRecordPayment =");
    expect(source).toContain(
      "isBillingAmountWithinBalance(paymentAmount, invoiceBalanceDue)"
    );
    expect(source).toContain(
      "paymentNotes.trim().length <= BILLING_NOTES_MAX_LENGTH"
    );
    expect(source).toContain("const canApplyAdjustment =");
    expect(source).toContain(
      "isBillingAmountWithinBalance(adjustmentAmount, invoiceBalanceDue)"
    );
    expect(source).toContain(
      "adjustmentReason.trim().length <= BILLING_ADJUSTMENT_REASON_MAX_LENGTH"
    );
    expect(source).toContain("min={BILLING_PAYMENT_AMOUNT_MIN}");
    expect(source).toContain("max={amountInputMax}");
    expect(source).toContain("maxLength={BILLING_NOTES_MAX_LENGTH}");
    expect(source).toContain(
      "maxLength={BILLING_ADJUSTMENT_REASON_MAX_LENGTH}"
    );
    expect(source).toContain("amount: paymentAmount.trim()");
    expect(source).toContain("notes: paymentNotes.trim() || undefined");
    expect(source).toContain("amount: adjustmentAmount.trim()");
    expect(source).toContain("reason: adjustmentReason.trim() || undefined");
    expect(source).toContain("disabled={!canRecordPayment}");
    expect(source).toContain("disabled={!canApplyAdjustment}");
    expect(source).not.toContain("parseFloat(paymentAmount) <= 0");
    expect(source).not.toContain("parseFloat(adjustmentAmount) <= 0");
  });

  it("renders billing dates from the practice timezone contract", () => {
    expect(source).toContain(
      "const billingConfig = trpc.billing.getTaxConfig.useQuery",
    );
    expect(source).toContain("const verifiedBillingConfig =");
    expect(source).toContain(
      "const billingSettingsReady = verifiedBillingConfig !== null",
    );
    expect(source).toContain(
      "const billingTimeZone = verifiedBillingConfig\n    ? verifiedBillingConfig.timezone\n    : null",
    );
    expect(source).toContain("const listError = billingConfig.error ?? error");
    expect(source).toContain(
      "const isListLoading = billingConfig.isLoading || isLoading",
    );
    expect(source).toContain("billingTimeZone={billingTimeZone}");
    expect(source).toContain("settingsReady={billingSettingsReady}");
    expect(source).toContain(
      "formatBillingDateInput(invoice.dueDate, billingTimeZone)",
    );
    expect(source).toContain(
      "formatBillingInstantDate(invoice.createdAt, billingTimeZone)",
    );
    expect(source).toMatch(/formatBillingDateInput\(\s*row\.nextBillingDate/);
    expect(source).toMatch(
      /formatBillingInstantDate\(\s*payment\.receivedAt/,
    );
    expect(source).toMatch(
      /formatBillingInstantDate\(\s*adjustment\.createdAt/,
    );
    expect(source).toMatch(/formatBillingDateInput\(\s*d\.dueDate/);
    expect(source).not.toContain(
      "new Date(invoice.dueDate).toLocaleDateString"
    );
    expect(source).not.toContain(
      "new Date(payment.receivedAt).toLocaleDateString"
    );
    expect(source).not.toContain(
      "new Date(adjustment.createdAt).toLocaleDateString"
    );
    expect(source).not.toContain("billingConfig.data?.timezone");
  });
});

describe("medication dispense billing queue", () => {
  const source = readFileSync("app/(dashboard)/billing/page.tsx", "utf8");

  it("shows every pending clinic-stock dispense with explicit outcomes", () => {
    expect(source).toContain("Unbilled medication dispenses");
    expect(source).toContain("trpc.billing.listDispenseChargeQueue.useQuery");
    expect(source).toContain(
      "trpc.billing.createDispenseChargeInvoice.useMutation",
    );
    expect(source).toContain("trpc.billing.waiveDispenseCharge.useMutation");
    expect(source).toContain("trpc.billing.reopenDispenseCharge.useMutation");
    expect(source).toContain("Create draft");
    expect(source).toContain("Review & create");
    expect(source).toContain("Verify it was not already billed");
    expect(source).toContain('title="Review legacy dispense"');
    expect(source).toContain('confirmLabel="Verified — create draft"');
    expect(source).toContain("Open visit");
    expect(source).toContain("Standalone refill");
    expect(source).toContain("Waive");
    expect(source).toContain('title="Waive medication charge?"');
    expect(source).toContain('label: "Reason for no charge"');
    expect(source).toContain("the audit trail");
    expect(source).toContain("Inventory has");
    expect(source).toContain("already been deducted and will not move again");
  });

  it("limits no-charge decisions and reopening to admins", () => {
    expect(source).toContain(
      'const canWaiveDispenseCharges = session?.user?.role === "admin"',
    );
    expect(source).toContain("canWaive={canWaiveDispenseCharges}");
    expect(source).toContain("Recently waived");
  });
});
