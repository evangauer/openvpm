import { describe, expect, it } from "vitest";
import {
  centsToMoney,
  invoiceBalanceCents,
  moneyToCents,
} from "../invoice-balance";

describe("invoice balance helpers", () => {
  it("rounds decimal money values to cents", () => {
    expect(moneyToCents("12.345")).toBe(1235);
    expect(moneyToCents("12.344")).toBe(1234);
    expect(centsToMoney(1235)).toBe("12.35");
  });

  it("subtracts paid and adjusted amounts from the collectible balance", () => {
    expect(
      invoiceBalanceCents(
        { total: "100.00", paidAmount: "25.00" },
        moneyToCents("30.00")
      )
    ).toBe(4500);
  });

  it("never returns a negative collectible balance", () => {
    expect(
      invoiceBalanceCents(
        { total: "100.00", paidAmount: "80.00" },
        moneyToCents("40.00")
      )
    ).toBe(0);
  });
});
