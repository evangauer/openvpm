export type InvoiceBalanceInput = {
  total: string | number | null | undefined;
  paidAmount: string | number | null | undefined;
};

export function moneyToCents(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

export function centsToMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function invoiceBalanceCents(
  invoice: InvoiceBalanceInput,
  adjustedCents = 0
): number {
  return Math.max(
    0,
    moneyToCents(invoice.total) -
      moneyToCents(invoice.paidAmount) -
      adjustedCents
  );
}
