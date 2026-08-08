import { describe, expect, it } from "vitest";
import {
  effectivePrescriptionStatus,
  isPrescriptionLifecycleReasonValid,
  prescriptionLifecycleHistoryLabel,
  prescriptionLifecycleLabel,
} from "../prescription-lifecycle";

describe("prescription lifecycle policy", () => {
  it("treats elapsed active prescriptions as effectively expired", () => {
    expect(
      effectivePrescriptionStatus({
        status: "active",
        endDate: "2026-08-07",
        today: "2026-08-08",
      }),
    ).toBe("expired");
  });

  it("keeps prescriptions active through their end date", () => {
    expect(
      effectivePrescriptionStatus({
        status: "active",
        endDate: "2026-08-08",
        today: "2026-08-08",
      }),
    ).toBe("active");
    expect(
      effectivePrescriptionStatus({
        status: "active",
        endDate: null,
        today: "2026-08-08",
      }),
    ).toBe("active");
  });

  it("never overrides an attributed terminal status", () => {
    expect(
      effectivePrescriptionStatus({
        status: "cancelled",
        endDate: "2026-01-01",
        today: "2026-08-08",
      }),
    ).toBe("cancelled");
  });

  it("requires a bounded meaningful lifecycle reason", () => {
    expect(isPrescriptionLifecycleReasonValid("done")).toBe(false);
    expect(isPrescriptionLifecycleReasonValid(" Course completed ")).toBe(true);
    expect(isPrescriptionLifecycleReasonValid("x".repeat(501))).toBe(false);
  });

  it("uses plain-language history labels", () => {
    expect(prescriptionLifecycleLabel("refill_dispensed")).toBe(
      "Refill dispensed",
    );
    expect(prescriptionLifecycleLabel("refill_authorized")).toBe(
      "External refill authorized",
    );
    expect(prescriptionLifecycleLabel("cancelled")).toBe(
      "Prescription cancelled",
    );
  });

  it("truthfully labels initial clinic inventory dispensing", () => {
    expect(
      prescriptionLifecycleHistoryLabel({
        eventType: "created",
        productId: "product-1",
        quantity: 30,
      }),
    ).toBe("Prescription created and 30 dispensed from clinic inventory");
    expect(
      prescriptionLifecycleHistoryLabel({
        eventType: "created",
        productId: null,
        quantity: 30,
      }),
    ).toBe("Prescription created");
  });
});
