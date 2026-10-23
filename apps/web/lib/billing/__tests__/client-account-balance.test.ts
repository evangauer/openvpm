import { describe, expect, it } from "vitest";
import {
  summarizeClientAccountBalance,
  type ClientAccountInvoice,
} from "../client-account-balance";

function invoice(
  overrides: Partial<ClientAccountInvoice> = {},
): ClientAccountInvoice {
  return {
    status: "sent",
    isEstimate: false,
    total: "100.00",
    paidAmount: "0.00",
    adjustedAmount: "0.00",
    ...overrides,
  };
}

describe("client account balance", () => {
  it("uses net recorded payments and credits across issued invoices", () => {
    expect(
      summarizeClientAccountBalance([
        invoice({ paidAmount: "25.00", adjustedAmount: "10.00" }),
        invoice({ status: "overdue", total: "70.00", paidAmount: "20.00" }),
      ]),
    ).toEqual({
      outstandingCents: 11_500,
      overdueCents: 5_000,
      openInvoiceCount: 2,
    });
  });

  it("excludes draft, estimate, paid, void, and deleted invoices", () => {
    expect(
      summarizeClientAccountBalance([
        invoice({ status: "draft" }),
        invoice({ isEstimate: true }),
        invoice({ status: "paid" }),
        invoice({ status: "void" }),
        invoice({ deletedAt: new Date("2026-10-04T12:00:00Z") }),
      ]),
    ).toEqual({ outstandingCents: 0, overdueCents: 0, openInvoiceCount: 0 });
  });

  it("does not count settled or over-adjusted invoices as open debt", () => {
    expect(
      summarizeClientAccountBalance([
        invoice({ paidAmount: "100.00" }),
        invoice({ status: "overdue", paidAmount: "80.00", adjustedAmount: "40.00" }),
      ]),
    ).toEqual({ outstandingCents: 0, overdueCents: 0, openInvoiceCount: 0 });
  });

  it("counts a reopened overdue balance after a refund reduces net paid amount", () => {
    expect(
      summarizeClientAccountBalance([
        invoice({ status: "overdue", paidAmount: "60.00" }),
      ]),
    ).toEqual({ outstandingCents: 4_000, overdueCents: 4_000, openInvoiceCount: 1 });
  });

  it("sums cents without truncating to a billing list page", () => {
    expect(
      summarizeClientAccountBalance(
        Array.from({ length: 125 }, () => invoice({ total: "0.10" })),
      ),
    ).toEqual({ outstandingCents: 1_250, overdueCents: 0, openInvoiceCount: 125 });
  });
});
