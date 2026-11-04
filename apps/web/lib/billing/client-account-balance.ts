import { invoiceBalanceCents, moneyToCents } from "./invoice-balance";

export type ClientAccountInvoice = {
  status: string;
  isEstimate: boolean;
  deletedAt?: Date | string | null;
  total: string | number | null;
  paidAmount: string | number | null;
  adjustedAmount: string | number | null;
};

/** Issued balances across the client's patients, using the invoice ledger math. */
export function summarizeClientAccountBalance(
  invoices: readonly ClientAccountInvoice[],
) {
  let outstandingCents = 0;
  let overdueCents = 0;
  let openInvoiceCount = 0;

  for (const invoice of invoices) {
    if (
      invoice.deletedAt ||
      invoice.isEstimate ||
      (invoice.status !== "sent" && invoice.status !== "overdue")
    ) {
      continue;
    }
    const balanceCents = invoiceBalanceCents(
      invoice,
      moneyToCents(invoice.adjustedAmount),
    );
    if (balanceCents === 0) continue;

    outstandingCents += balanceCents;
    openInvoiceCount += 1;
    if (invoice.status === "overdue") overdueCents += balanceCents;
  }

  return { outstandingCents, overdueCents, openInvoiceCount };
}
