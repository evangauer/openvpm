import { BILLING_MAX_MONEY_CENTS } from "./policy";
import { isValidSettingsTaxRate } from "@/lib/settings-policy";

export type TaxableInvoiceLine = {
  lineTotalCents: number;
  taxable: boolean;
};

export type InvoiceTaxTotals = {
  subtotalCents: number;
  taxableSubtotalCents: number;
  taxCents: number;
  totalCents: number;
};

const TAX_RATE_DENOMINATOR = 10_000n;
const TAX_RATE_PARTS_PATTERN = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

export type InvoiceTaxCalculationErrorReason =
  | "invalid_tax_rate"
  | "unsupported_total";

export class InvoiceTaxCalculationError extends Error {
  constructor(
    public readonly reason: InvoiceTaxCalculationErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "InvoiceTaxCalculationError";
  }
}

/** Convert a percent string such as `8.25` to hundredths of one percent. */
export function taxRateToBasisPoints(taxRatePercent: string): number {
  const normalized = taxRatePercent.trim();
  const match = TAX_RATE_PARTS_PATTERN.exec(normalized);
  if (!match || !isValidSettingsTaxRate(normalized)) {
    throw new InvoiceTaxCalculationError(
      "invalid_tax_rate",
      "Set the practice tax rate to a value between 0 and 100 percent with at most two decimals.",
    );
  }

  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const basisPoints = whole * 100 + fraction;
  if (!Number.isSafeInteger(basisPoints) || basisPoints > 10_000) {
    throw new InvoiceTaxCalculationError(
      "invalid_tax_rate",
      "Set the practice tax rate to a value between 0 and 100 percent with at most two decimals.",
    );
  }
  return basisPoints;
}

function checkedCents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvoiceTaxCalculationError(
      "unsupported_total",
      `${label} must be a supported nonnegative currency amount.`,
    );
  }
  return value;
}

export function assertInvoiceTaxTotalsStorable(
  totals: Pick<InvoiceTaxTotals, "subtotalCents" | "taxCents" | "totalCents">,
): void {
  if (
    totals.subtotalCents > BILLING_MAX_MONEY_CENTS ||
    totals.taxCents > BILLING_MAX_MONEY_CENTS ||
    totals.totalCents > BILLING_MAX_MONEY_CENTS
  ) {
    throw new InvoiceTaxCalculationError(
      "unsupported_total",
      "Invoice subtotal, tax, and total must fit the supported currency range.",
    );
  }
}

/**
 * Round tax once at the invoice level using integer cents. Non-taxable lines
 * still contribute to the subtotal, while only taxable snapshots contribute
 * to tax. Credits/write-offs remain separate invoice adjustments and do not
 * rewrite either the line snapshots or the original tax calculation.
 */
export function calculateInvoiceTaxTotals(
  lines: readonly TaxableInvoiceLine[],
  taxRatePercent: string,
): InvoiceTaxTotals {
  let subtotalCents = 0;
  let taxableSubtotalCents = 0;
  for (const line of lines) {
    const lineTotalCents = checkedCents(line.lineTotalCents, "Line total");
    subtotalCents = checkedCents(subtotalCents + lineTotalCents, "Subtotal");
    if (line.taxable) {
      taxableSubtotalCents = checkedCents(
        taxableSubtotalCents + lineTotalCents,
        "Taxable subtotal",
      );
    }
  }

  const basisPoints = taxRateToBasisPoints(taxRatePercent);
  const numerator = BigInt(taxableSubtotalCents) * BigInt(basisPoints);
  const taxCents = Number(
    (numerator + TAX_RATE_DENOMINATOR / 2n) / TAX_RATE_DENOMINATOR,
  );
  const totalCents = checkedCents(subtotalCents + taxCents, "Invoice total");

  assertInvoiceTaxTotalsStorable({ subtotalCents, taxCents, totalCents });

  return { subtotalCents, taxableSubtotalCents, taxCents, totalCents };
}

export function tryCalculateInvoiceTaxTotals(
  lines: readonly TaxableInvoiceLine[],
  taxRatePercent: string,
): InvoiceTaxTotals | null {
  try {
    return calculateInvoiceTaxTotals(lines, taxRatePercent);
  } catch (error) {
    if (error instanceof InvoiceTaxCalculationError) return null;
    throw error;
  }
}
