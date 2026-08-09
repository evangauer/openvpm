import { describe, expect, it } from "vitest";
import {
  calculateInvoiceTaxTotals,
  InvoiceTaxCalculationError,
  taxRateToBasisPoints,
  tryCalculateInvoiceTaxTotals,
} from "../invoice-tax";
import { BILLING_MAX_MONEY_CENTS } from "../policy";

describe("invoice tax snapshots", () => {
  it("taxes only taxable invoice lines and rounds once in integer cents", () => {
    expect(
      calculateInvoiceTaxTotals(
        [
          { lineTotalCents: 10_00, taxable: true },
          { lineTotalCents: 20_00, taxable: false },
          { lineTotalCents: 5_55, taxable: true },
        ],
        "8.25",
      ),
    ).toEqual({
      subtotalCents: 35_55,
      taxableSubtotalCents: 15_55,
      taxCents: 128,
      totalCents: 36_83,
    });
  });

  it("preserves all-taxable legacy behavior", () => {
    expect(
      calculateInvoiceTaxTotals(
        [
          { lineTotalCents: 1, taxable: true },
          { lineTotalCents: 1, taxable: true },
        ],
        "8.00",
      ),
    ).toMatchObject({ subtotalCents: 2, taxableSubtotalCents: 2, taxCents: 0 });
  });

  it("parses percent strings without floating point math", () => {
    expect(taxRateToBasisPoints("0")).toBe(0);
    expect(taxRateToBasisPoints("8.5")).toBe(850);
    expect(taxRateToBasisPoints("100.00")).toBe(10_000);
    expect(() => taxRateToBasisPoints("100.01")).toThrow();
    expect(() => taxRateToBasisPoints("8.125")).toThrow();
  });

  it("fails safely for stored tax rates outside the supported range", () => {
    expect(tryCalculateInvoiceTaxTotals([], "100.01")).toBeNull();
    expect(() => calculateInvoiceTaxTotals([], "100.01")).toThrowError(
      expect.objectContaining<Partial<InvoiceTaxCalculationError>>({
        reason: "invalid_tax_rate",
      }),
    );
  });

  it("accepts the largest storable total and rejects calculated overflow", () => {
    expect(
      calculateInvoiceTaxTotals(
        [
          {
            lineTotalCents: Math.floor(BILLING_MAX_MONEY_CENTS / 2),
            taxable: true,
          },
        ],
        "100.00",
      ).totalCents,
    ).toBe(BILLING_MAX_MONEY_CENTS - 1);

    expect(() =>
      calculateInvoiceTaxTotals(
        [{ lineTotalCents: 5_000_000_000, taxable: true }],
        "100.00",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<InvoiceTaxCalculationError>>({
        reason: "unsupported_total",
      }),
    );
  });
});
