import { describe, expect, it } from "vitest";
import { isBillingInvoiceLineQuantityValid } from "../policy";
import { tryCalculateInvoiceTaxTotals } from "../invoice-tax";
import { isPrescriptionOptionalQuantityInputValid } from "@/lib/records/prescription-policy";

describe("Dr. Jayne fractional medication reproduction", () => {
  it("accepts 1.5 ml and sub-unit prescription quantities", () => {
    expect(isPrescriptionOptionalQuantityInputValid("1.5")).toBe(true);
    expect(isPrescriptionOptionalQuantityInputValid("0.125")).toBe(true);
  });
  it("accepts fractional invoice quantities", () => {
    expect(isBillingInvoiceLineQuantityValid(1.5)).toBe(true);
    expect(isBillingInvoiceLineQuantityValid(0.125)).toBe(true);
  });
  it("reproduces the tax error from an unrounded fractional-cent line", () => {
    expect(
      tryCalculateInvoiceTaxTotals(
        [{ lineTotalCents: 199 * 1.5, taxable: true }],
        "8.00",
      ),
    ).toBeNull();
  });
});

import { quantityLineTotalCents } from "@/lib/quantity";
import { priceWithMarkup } from "@/lib/inventory/markup";

describe("fractional line rounding and inventory markup", () => {
  it.each([
    [199, 1.5, 299],
    [199, 0.125, 25],
    [10, 0.25, 3],
    [199, 2, 398],
  ])("rounds %s cents times %s once", (price, quantity, total) => {
    expect(quantityLineTotalCents(price, quantity)).toBe(total);
  });
  it("calculates tax after rounding a fractional line", () => {
    expect(
      tryCalculateInvoiceTaxTotals(
        [{ lineTotalCents: quantityLineTotalCents(199, 1.5), taxable: true }],
        "8.00",
      ),
    ).toEqual({
      subtotalCents: 299,
      taxableSubtotalCents: 299,
      taxCents: 24,
      totalCents: 323,
    });
  });
  it.each([0, -1, NaN, Infinity, 1.0001])(
    "rejects invalid billing quantity %s",
    (quantity) => {
      expect(isBillingInvoiceLineQuantityValid(quantity)).toBe(false);
    },
  );
  it("calculates markup on cost, including zero and cent rounding", () => {
    expect(priceWithMarkup("10.00", "50")).toBe("15.00");
    expect(priceWithMarkup("1.99", "50")).toBe("2.99");
    expect(priceWithMarkup("10.00", "0")).toBe("10.00");
    expect(priceWithMarkup("0", "50")).toBe("0.00");
  });
  it.each([
    ["", "50"],
    ["10", "-1"],
    ["10", ""],
    ["10", "Infinity"],
    ["99999999.99", "50"],
  ])("rejects invalid or overflowing markup %s / %s", (cost, markup) => {
    expect(priceWithMarkup(cost, markup)).toBeNull();
  });
});
