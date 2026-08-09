import { afterEach, describe, expect, it, vi } from "vitest";
import { smsSuppressions } from "@openpims/db";

const mocks = vi.hoisted(() => {
  const insertReturning = vi.fn(async () => [{ id: "event-1" }]);
  const insertConflict = vi.fn(() => ({ returning: insertReturning }));
  const insertValues = vi.fn(() => ({
    onConflictDoNothing: insertConflict,
    onConflictDoUpdate: insertConflict,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateReturning = vi.fn(async () => [{ id: "c1" }, { id: "c2" }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const execute = vi.fn(async () => undefined);
  const tx = {
    insert,
    update,
    execute,
  };
  return {
    tx,
    insertValues,
    insertConflict,
    insertReturning,
    updateSet,
    updateWhere,
    execute,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: {},
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

const { addSuppression, revokeSmsConsentByPhone } =
  await import("../suppression");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";

afterEach(() => {
  vi.clearAllMocks();
});

describe("SMS suppression helpers", () => {
  it("records bounce suppressions distinctly from stop suppressions", async () => {
    await addSuppression({
      practiceId: PRACTICE_ID,
      locationId: "00000000-0000-0000-0000-000000000002",
      phone: "(555) 555-0100",
      reason: "bounce",
      detail: "Delivery failed",
    });

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        locationId: "00000000-0000-0000-0000-000000000002",
        phone: "+15555550100",
        reason: "bounce",
        detail: "Delivery failed",
      }),
    );
    expect(mocks.insertConflict).toHaveBeenCalled();
  });

  it("writes one practice-wide manual suppression and clears every duplicate consent", async () => {
    await expect(
      revokeSmsConsentByPhone({
        practiceId: PRACTICE_ID,
        phone: "(555) 555-0100",
        reason: "manual",
        detail: "Staff request",
        evidence: {
          source: "staff_manual_revoke:v1",
          actorType: "staff",
          actorUserId: "00000000-0000-0000-0000-000000000001",
          actorName: "Test User",
          eventKey: "staff:test-manual",
        },
      }),
    ).resolves.toEqual({ phone: "+15555550100", clientsRevoked: 2 });

    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.insertValues).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      locationId: undefined,
      phone: "+15555550100",
      reason: "manual",
      detail: "Staff request",
    });
    expect(mocks.insertConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          reason: "manual",
          deletedAt: null,
        }),
      }),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith({
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });
  });

  it("rolls back a staff revocation when its immutable event is not inserted", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);

    await expect(
      revokeSmsConsentByPhone({
        practiceId: PRACTICE_ID,
        phone: "+15555550100",
        reason: "manual",
        evidence: {
          source: "staff_manual_revoke:v1",
          actorType: "staff",
          actorUserId: "00000000-0000-0000-0000-000000000001",
          actorName: "Test User",
          eventKey: "staff:duplicate",
        },
      }),
    ).rejects.toThrow("SMS consent revocation evidence could not be appended");

    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("does not let a later carrier STOP downgrade a staff suppression", async () => {
    await revokeSmsConsentByPhone({
      practiceId: PRACTICE_ID,
      phone: "(555) 555-0100",
      locationId: "00000000-0000-0000-0000-000000000002",
      reason: "stop",
      detail: "STOP",
      evidence: {
        source: "inbound_opt_out:v1",
        actorType: "client",
        provider: "telnyx",
        providerMessageId: "message-1",
        eventKey: "inbound:telnyx:message-1:revoked",
      },
    });

    expect(mocks.insertConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          locationId: smsSuppressions.locationId,
          reason: smsSuppressions.reason,
          detail: smsSuppressions.detail,
          deletedAt: null,
        }),
      }),
    );
  });
});
