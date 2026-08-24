import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalQuantity,
  priceTreatmentPlanLines,
  quantityToThousandths,
  TREATMENT_PLAN_AUTHORING_ENABLED_ENV,
  treatmentPlanAuthoringEnabled,
  treatmentPlanOperationHash,
} from "./policy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("treatment-plan authoring policy", () => {
  it("stays dark unless the launch flag is explicitly true", () => {
    vi.stubEnv(TREATMENT_PLAN_AUTHORING_ENABLED_ENV, "");
    expect(treatmentPlanAuthoringEnabled()).toBe(false);
    vi.stubEnv(TREATMENT_PLAN_AUTHORING_ENABLED_ENV, "false");
    expect(treatmentPlanAuthoringEnabled()).toBe(false);
    vi.stubEnv(TREATMENT_PLAN_AUTHORING_ENABLED_ENV, " TRUE ");
    expect(treatmentPlanAuthoringEnabled()).toBe(true);
  });

  it("normalizes positive quantities without floating-point arithmetic", () => {
    expect(quantityToThousandths("12.345")).toBe(12_345n);
    expect(canonicalQuantity("12.3")).toBe("12.300");
    expect(() => canonicalQuantity("0")).toThrow(/greater than zero/i);
    expect(() => canonicalQuantity("1.0001")).toThrow(/invalid/i);
  });

  it("matches aggregate tax and allocates rounding cents deterministically", () => {
    const priced = priceTreatmentPlanLines(
      [
        {
          sortOrder: 0,
          description: "Exam",
          offeredQuantity: "1",
          unitPriceCents: 5,
          taxable: true,
          itemType: "service",
          serviceId: "service-1",
          productId: null,
        },
        {
          sortOrder: 1,
          description: "Medication",
          offeredQuantity: "1",
          unitPriceCents: 5,
          taxable: true,
          itemType: "product",
          serviceId: null,
          productId: "product-1",
        },
      ],
      "10.00",
    );

    expect(priced).toMatchObject({
      subtotalCents: 10,
      taxCents: 1,
      totalCents: 11,
    });
    expect(priced.lines.map((line) => line.taxAmountCents)).toEqual([1, 0]);
    expect(priced.lines.map((line) => line.lineTotalCents)).toEqual([6, 5]);
  });

  it("rounds fractional quantities the same way as positive PostgreSQL numeric", () => {
    const priced = priceTreatmentPlanLines(
      [
        {
          sortOrder: 0,
          description: "Medication",
          offeredQuantity: "1.005",
          unitPriceCents: 100,
          taxable: false,
          itemType: "product",
          serviceId: null,
          productId: "product-1",
        },
      ],
      "8.00",
    );
    expect(priced.lines[0]).toMatchObject({
      offeredQuantity: "1.005",
      lineSubtotalCents: 101,
      taxAmountCents: 0,
      lineTotalCents: 101,
    });
  });

  it("hashes canonical operation payloads deterministically", () => {
    const payload = {
      version: 1,
      action: "create",
      items: [{ itemType: "service", itemId: "id", quantity: "1.000" }],
    };
    expect(treatmentPlanOperationHash(payload)).toMatch(/^[0-9a-f]{64}$/);
    expect(treatmentPlanOperationHash(payload)).toBe(
      treatmentPlanOperationHash(structuredClone(payload)),
    );
    expect(treatmentPlanOperationHash(payload)).not.toBe(
      treatmentPlanOperationHash({ ...payload, action: "revise" }),
    );
  });
});
