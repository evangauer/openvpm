import { afterEach, describe, expect, it, vi } from "vitest";
import { smsSuppressions } from "@openpims/db";

const mocks = vi.hoisted(() => {
  const deleteWhere = vi.fn(async (_condition: unknown) => undefined);
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  const insertConflict = vi.fn(async () => undefined);
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
    delete: deleteFrom,
    insert,
    update,
    execute,
  };
  return {
    tx,
    deleteWhere,
    insertValues,
    insertConflict,
    updateSet,
    updateWhere,
    execute,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: {},
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

const { addSuppression, removeSuppression, revokeSmsConsentByPhone } =
  await import("../suppression");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";

function sqlIncludesColumnParamPair(
  value: unknown,
  columnName: string,
  paramValue: unknown
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const chunk = value as { name?: unknown; queryChunks?: unknown[] };
  if (!Array.isArray(chunk.queryChunks)) {
    return false;
  }

  const hasColumn = chunk.queryChunks.some(
    (item) =>
      !!item &&
      typeof item === "object" &&
      (item as { name?: unknown }).name === columnName
  );
  const hasParam = chunk.queryChunks.some((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const candidate = item as { value?: unknown };
    return Object.prototype.hasOwnProperty.call(candidate, "value")
      ? Object.is(candidate.value, paramValue)
      : false;
  });

  return (
    (hasColumn && hasParam) ||
    chunk.queryChunks.some((item) =>
      sqlIncludesColumnParamPair(item, columnName, paramValue)
    )
  );
}

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
      })
    );
    expect(mocks.insertConflict).toHaveBeenCalled();
  });

  it("removes only stop suppressions when a recipient texts start", async () => {
    await removeSuppression(PRACTICE_ID, "(555) 555-0100");

    const condition = mocks.deleteWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumnParamPair(condition, "reason", "stop")).toBe(true);
  });

  it("writes one practice-wide manual suppression and clears every duplicate consent", async () => {
    await expect(
      revokeSmsConsentByPhone({
        practiceId: PRACTICE_ID,
        phone: "(555) 555-0100",
        reason: "manual",
        detail: "Staff request",
      })
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
      })
    );
    expect(mocks.updateSet).toHaveBeenCalledWith({
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });
  });

  it("does not let a later carrier STOP downgrade a staff suppression", async () => {
    await revokeSmsConsentByPhone({
      practiceId: PRACTICE_ID,
      phone: "(555) 555-0100",
      locationId: "00000000-0000-0000-0000-000000000002",
      reason: "stop",
      detail: "STOP",
    });

    expect(mocks.insertConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          locationId: smsSuppressions.locationId,
          reason: smsSuppressions.reason,
          detail: smsSuppressions.detail,
          deletedAt: null,
        }),
      })
    );
  });
});
