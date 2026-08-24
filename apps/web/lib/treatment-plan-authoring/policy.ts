import { createHash } from "node:crypto";

import { BILLING_MAX_MONEY_CENTS } from "@/lib/billing/policy";
import { taxRateToBasisPoints } from "@/lib/billing/invoice-tax";

export const TREATMENT_PLAN_AUTHORING_ENABLED_ENV =
  "TREATMENT_PLAN_AUTHORING_ENABLED";
export const TREATMENT_PLAN_MAX_ITEMS = 100;
export const TREATMENT_PLAN_QUANTITY_PATTERN =
  /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/;

export type TreatmentPlanCatalogItemInput = {
  itemType: "service" | "product";
  itemId: string;
  quantity: string;
};

export type PricedTreatmentPlanLine = {
  sortOrder: number;
  description: string;
  offeredQuantity: string;
  unitPriceCents: number;
  taxable: boolean;
  itemType: "service" | "product";
  serviceId: string | null;
  productId: string | null;
};

export type TreatmentPlanStoredLine = PricedTreatmentPlanLine & {
  lineSubtotalCents: number;
  taxAmountCents: number;
  lineTotalCents: number;
};

export function treatmentPlanAuthoringEnabled(): boolean {
  return (
    process.env[TREATMENT_PLAN_AUTHORING_ENABLED_ENV]?.trim().toLowerCase() ===
    "true"
  );
}

export function quantityToThousandths(value: string): bigint {
  const normalized = value.trim();
  if (!TREATMENT_PLAN_QUANTITY_PATTERN.test(normalized)) {
    throw new Error("Invalid treatment-plan quantity.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const thousandths = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
  if (thousandths <= 0n) {
    throw new Error("Treatment-plan quantity must be greater than zero.");
  }
  return thousandths;
}

export function canonicalQuantity(value: string): string {
  const thousandths = quantityToThousandths(value);
  const whole = thousandths / 1000n;
  const fraction = (thousandths % 1000n).toString().padStart(3, "0");
  return `${whole}.${fraction}`;
}

function checkedCents(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(BILLING_MAX_MONEY_CENTS)) {
    throw new Error(`${label} exceeds the supported currency range.`);
  }
  return Number(value);
}

function lineSubtotalCents(unitPriceCents: number, quantity: string): number {
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) {
    throw new Error("Unit price must be a supported nonnegative amount.");
  }
  const numerator = BigInt(unitPriceCents) * quantityToThousandths(quantity);
  return checkedCents((numerator + 500n) / 1000n, "Line subtotal");
}

/**
 * Match invoice-level tax rounding, then allocate its cents deterministically
 * across taxable lines by largest remainder and stable line order.
 */
export function priceTreatmentPlanLines(
  lines: readonly PricedTreatmentPlanLine[],
  taxRatePercent: string,
): {
  lines: TreatmentPlanStoredLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
} {
  const basisPoints = BigInt(taxRateToBasisPoints(taxRatePercent));
  const denominator = 10_000n;
  const calculated = lines.map((line) => {
    const subtotal = lineSubtotalCents(
      line.unitPriceCents,
      line.offeredQuantity,
    );
    const taxNumerator = line.taxable ? BigInt(subtotal) * basisPoints : 0n;
    return {
      line,
      subtotal,
      baseTax: Number(taxNumerator / denominator),
      remainder: taxNumerator % denominator,
    };
  });

  const subtotalBig = calculated.reduce(
    (sum, line) => sum + BigInt(line.subtotal),
    0n,
  );
  const taxableBig = calculated.reduce(
    (sum, line) => sum + (line.line.taxable ? BigInt(line.subtotal) : 0n),
    0n,
  );
  const taxBig = (taxableBig * basisPoints + denominator / 2n) / denominator;
  const baseTaxBig = calculated.reduce(
    (sum, line) => sum + BigInt(line.baseTax),
    0n,
  );
  const extraTaxCents = Number(taxBig - baseTaxBig);
  const taxAwards = new Set(
    calculated
      .map((line, index) => ({
        index,
        remainder: line.remainder,
        sortOrder: line.line.sortOrder,
      }))
      .filter((line) => line.remainder > 0n)
      .sort((left, right) => {
        if (left.remainder !== right.remainder) {
          return left.remainder > right.remainder ? -1 : 1;
        }
        return left.sortOrder - right.sortOrder;
      })
      .slice(0, extraTaxCents)
      .map((line) => line.index),
  );

  const subtotalCents = checkedCents(subtotalBig, "Treatment-plan subtotal");
  const taxCents = checkedCents(taxBig, "Treatment-plan tax");
  const totalCents = checkedCents(subtotalBig + taxBig, "Treatment-plan total");

  return {
    lines: calculated.map((calculatedLine, index) => {
      const taxAmountCents =
        calculatedLine.baseTax + (taxAwards.has(index) ? 1 : 0);
      return {
        ...calculatedLine.line,
        offeredQuantity: canonicalQuantity(calculatedLine.line.offeredQuantity),
        lineSubtotalCents: calculatedLine.subtotal,
        taxAmountCents,
        lineTotalCents: calculatedLine.subtotal + taxAmountCents,
      };
    }),
    subtotalCents,
    taxCents,
    totalCents,
  };
}

export function treatmentPlanOperationHash(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}
