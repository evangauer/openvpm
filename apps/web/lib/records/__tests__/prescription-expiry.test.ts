import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/tenant-db", () => ({
  withSystem: async (database: unknown, fn: (tx: unknown) => unknown) =>
    fn(database),
}));

const { expireDuePrescriptions, PRESCRIPTION_EXPIRY_BATCH_SIZE } = await import(
  "../prescription-expiry"
);

const duePrescription = {
  id: "00000000-0000-0000-0000-000000000001",
  practiceId: "00000000-0000-0000-0000-000000000002",
  patientId: "00000000-0000-0000-0000-000000000003",
  productId: "00000000-0000-0000-0000-000000000004",
  quantity: 10,
  refillsRemaining: 1,
};

function expiryDb(input: { due: unknown[]; updates?: unknown[][] }) {
  const updates = [...(input.updates ?? [])];
  let whereClause: unknown;
  const forUpdate = vi.fn(async () => input.due);
  const limit = vi.fn(() => selectBuilder);
  const selectBuilder: Record<string, unknown> = {};
  selectBuilder.from = vi.fn(() => selectBuilder);
  selectBuilder.innerJoin = vi.fn(() => selectBuilder);
  selectBuilder.where = vi.fn((condition: unknown) => {
    whereClause = condition;
    return selectBuilder;
  });
  selectBuilder.limit = limit;
  selectBuilder.for = forUpdate;

  const updateValues: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updateValues.push(values);
      return {
        where: vi.fn(() => ({
          returning: vi.fn(async () => updates.shift() ?? []),
        })),
      };
    }),
  }));
  const insertValues: Record<string, unknown>[] = [];
  const insert = vi.fn(() => ({
    values: vi.fn(async (values: Record<string, unknown>) => {
      insertValues.push(values);
      return undefined;
    }),
  }));
  const db = {
    select: vi.fn(() => selectBuilder),
    update,
    insert,
  };
  return {
    db,
    forUpdate,
    insert,
    insertValues,
    limit,
    update,
    updateValues,
    whereClause: () => whereClause,
  };
}

describe("expireDuePrescriptions", () => {
  it("uses a strict before-today boundary in each practice timezone", async () => {
    const mock = expiryDb({ due: [] });
    await expect(expireDuePrescriptions(mock.db as never)).resolves.toEqual({
      expired: 0,
      prescriptions: [],
    });

    const query = new PgDialect().sqlToQuery(mock.whereClause() as SQL);
    expect(query.sql).toContain('"prescriptions"."end_date" <');
    expect(query.sql).toContain("now() at time zone");
    expect(query.sql).toContain('"practices"."timezone"');
    expect(query.sql).toContain("::date");
    expect(query.sql).not.toContain('"prescriptions"."end_date" <=');
    expect(mock.forUpdate).toHaveBeenCalledWith("update", {
      of: expect.anything(),
      skipLocked: true,
    });
  });

  it("locks a bounded batch, updates status, and appends the expiry event", async () => {
    const updated = {
      id: duePrescription.id,
      practiceId: duePrescription.practiceId,
      patientId: duePrescription.patientId,
    };
    const mock = expiryDb({ due: [duePrescription], updates: [[updated]] });

    await expect(expireDuePrescriptions(mock.db as never)).resolves.toEqual({
      expired: 1,
      prescriptions: [updated],
    });
    expect(mock.limit).toHaveBeenCalledWith(PRESCRIPTION_EXPIRY_BATCH_SIZE);
    expect(mock.updateValues[0]).toMatchObject({ status: "expired" });
    expect(mock.insertValues).toEqual([
      {
        practiceId: duePrescription.practiceId,
        prescriptionId: duePrescription.id,
        patientId: duePrescription.patientId,
        productId: duePrescription.productId,
        quantity: duePrescription.quantity,
        eventType: "expired",
        statusBefore: "active",
        statusAfter: "expired",
        refillsBefore: 1,
        refillsAfter: 1,
        reason: "Prescription end date elapsed.",
        actorId: null,
        actorName: "OpenVPM system",
        operationId: null,
      },
    ]);
  });

  it("does not append a duplicate event when another worker won the update", async () => {
    const mock = expiryDb({ due: [duePrescription], updates: [[]] });

    await expect(expireDuePrescriptions(mock.db as never)).resolves.toEqual({
      expired: 0,
      prescriptions: [],
    });
    expect(mock.update).toHaveBeenCalledOnce();
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("keeps the expiry batch bounded", () => {
    expect(PRESCRIPTION_EXPIRY_BATCH_SIZE).toBe(250);
  });
});
