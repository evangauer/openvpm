import { describe, expect, it } from "vitest";
import { generateInvoicePdf, type InvoiceData } from "../pdf";

const invoice: InvoiceData = {
  practiceName: "Synthetic Veterinary Clinic",
  clientName: "Synthetic Client",
  invoiceDate: "November 4, 2026",
  status: "sent",
  items: [{ description: "Consultation", quantity: 1, unitPrice: "$100.00", total: "$100.00" }],
  subtotal: "$100.00", tax: "$0.00", total: "$100.00",
  paidAmount: "$20.00", adjustedAmount: "$30.00", balanceDue: "$50.00",
};

describe("invoice PDF ledger totals", () => {
  it("shows adjustments alongside payments and the remaining balance", () => {
    const output = generateInvoicePdf(invoice).output();
    for (const text of ["Credits / write-offs:", "$30.00", "Paid:", "$20.00", "Balance Due:", "$50.00"]) {
      expect(output).toContain(`(${text}) Tj`);
    }
    expect(output).not.toContain("($80.00) Tj");
  });

  it("retains localized amounts and a fully settled balance verbatim", () => {
    const output = generateInvoicePdf({ ...invoice,
      subtotal: "1.000,00", total: "1.000,00", tax: "0,00",
      paidAmount: "200,00", adjustedAmount: "800,00", balanceDue: "0,00",
    }).output();
    expect(output).toContain("(800,00) Tj");
    expect(output).toContain("(0,00) Tj");
    expect(output).not.toContain("NaN");
  });

  it("moves totals together to a new page for a long invoice", () => {
    const doc = generateInvoicePdf({ ...invoice,
      items: Array.from({ length: 24 }, () => invoice.items[0]!),
    });
    expect(doc.getNumberOfPages()).toBe(2);
    const pages = (doc.internal as unknown as { pages: string[][] }).pages;
    expect(pages[1]!.join("\n")).not.toContain("(Subtotal:) Tj");
    for (const label of ["Subtotal:", "Total:", "Paid:", "Credits / write-offs:", "Balance Due:"]) {
      expect(pages[2]!.join("\n")).toContain(`(${label}) Tj`);
    }
  });
});
