import { describe, expect, it } from "vitest";
import {
  getProvider,
  LabProviderNotConfiguredError,
  type LabOrder,
} from "../lab-integration";

const order: LabOrder = {
  orderId: "lab-order-1",
  patientId: "patient-1",
  practiceId: "practice-1",
  provider: "in_house",
  testCodes: ["CBC"],
  status: "pending",
  orderedAt: "2026-06-27T12:00:00Z",
};

describe("lab integration providers", () => {
  it("keeps in-house/manual lab entry available", async () => {
    const provider = getProvider("in_house");
    expect(provider).toBeDefined();

    await expect(provider!.submitOrder(order)).resolves.toEqual({
      success: true,
      externalOrderId: "lab-order-1",
    });
  });

  it.each([
    ["idexx", "IDEXX VetConnect"],
    ["antech", "Antech Diagnostics"],
    ["zoetis", "Zoetis Reference Labs"],
  ])(
    "fails closed for %s until a real adapter is configured",
    async (providerId, providerName) => {
      const provider = getProvider(providerId);
      expect(provider).toBeDefined();

      await expect(
        provider!.submitOrder({
          ...order,
          provider: providerId as LabOrder["provider"],
        })
      ).rejects.toBeInstanceOf(LabProviderNotConfiguredError);
      await expect(provider!.checkStatus("external-1")).rejects.toThrow(
        `${providerName} lab integration is not configured`
      );
      await expect(provider!.getResults("external-1")).rejects.toThrow(
        `${providerName} lab integration is not configured`
      );
    }
  );
});
