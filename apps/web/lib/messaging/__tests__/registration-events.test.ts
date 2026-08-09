import { describe, expect, it, vi } from "vitest";
import {
  clinicMessagingRegistrationActor,
  platformMessagingRegistrationActor,
  recordMessagingRegistrationEvent,
} from "../registration-events";

describe("messaging registration event evidence", () => {
  it("redacts platform identity and never stores a cross-tenant actor id", () => {
    expect(
      platformMessagingRegistrationActor({
        email: "Operator.Name@Example.com",
        name: " Platform Operator ",
      }),
    ).toEqual({
      actorType: "platform_operator",
      actorUserId: null,
      actorIdentity: "o***@example.com",
      actorName: "Platform Operator",
    });
  });

  it("uses a bounded clinic actor label when the user profile name is blank", () => {
    expect(
      clinicMessagingRegistrationActor({
        id: "00000000-0000-0000-0000-000000000004",
        name: "   ",
      }),
    ).toMatchObject({
      actorType: "clinic_user",
      actorUserId: "00000000-0000-0000-0000-000000000004",
      actorName: "Clinic admin",
    });
  });

  it("stores only the bounded PHI-free lifecycle projection", async () => {
    const values = vi.fn(async (_row: Record<string, unknown>) => undefined);
    const insert = vi.fn(() => ({ values }));
    await recordMessagingRegistrationEvent({ insert } as never, {
      registration: {
        id: "00000000-0000-0000-0000-000000000001",
        practiceId: "00000000-0000-0000-0000-000000000002",
        provider: "telnyx",
        status: "pending",
        providerBrandId: "brand-123",
        providerCampaignId: null,
        providerBrandStatus: "VERIFIED",
        providerCampaignStatus: null,
      },
      eventType: "provider_operation_succeeded",
      operation: "brand_submission",
      statusBefore: "pending",
      operationId: "00000000-0000-0000-0000-000000000003",
      reasonCode: "carrier_brand_submitted",
      actor: clinicMessagingRegistrationActor({
        id: "00000000-0000-0000-0000-000000000004",
        name: " Clinic Admin ",
      }),
    });

    expect(values).toHaveBeenCalledTimes(1);
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      eventType: "provider_operation_succeeded",
      operation: "brand_submission",
      reasonCode: "carrier_brand_submitted",
      actorName: "Clinic Admin",
      actorIdentity: null,
    });
    for (const forbidden of [
      "taxId",
      "taxIdEncrypted",
      "taxIdLast4",
      "patientId",
      "clientId",
      "providerPayload",
      "providerError",
      "detail",
    ]) {
      expect(row).not.toHaveProperty(forbidden);
    }
  });
});
