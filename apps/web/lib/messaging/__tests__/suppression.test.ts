import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const deleteWhere = vi.fn(async (_condition: unknown) => undefined);
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  const insertConflict = vi.fn(async () => undefined);
  const insertValues = vi.fn(() => ({ onConflictDoNothing: insertConflict }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const tx = {
    delete: deleteFrom,
    insert,
  };
  return {
    tx,
    deleteWhere,
    insertValues,
    insertConflict,
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

const { addSuppression, removeSuppression } = await import("../suppression");

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
});
