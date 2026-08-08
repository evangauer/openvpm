import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.recordAuditLog }));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

const { recordsRouter } = await import("../routers/records");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const PRESCRIPTION_ID = "00000000-0000-0000-0000-000000000003";
const PRODUCT_ID = "00000000-0000-0000-0000-000000000004";
const OPERATION_ID = "00000000-0000-0000-0000-000000000005";

function callerWithDb(db: Record<string, unknown>) {
  return recordsRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: "doctor@example.com",
        name: "Doctor Rivera",
        role: "veterinarian",
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function queuedDb(input: {
  selects: unknown[][];
  updates?: unknown[][];
  inserts?: unknown[][];
}) {
  const selects = [...input.selects];
  const updates = [...(input.updates ?? [])];
  const inserts = [...(input.inserts ?? [])];

  const select = vi.fn(() => {
    const result = selects.shift() ?? [];
    const afterLimit = {
      for: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.leftJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(() => afterLimit);
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });

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
    values: vi.fn((values: Record<string, unknown>) => {
      insertValues.push(values);
      return { returning: vi.fn(async () => inserts.shift() ?? []) };
    }),
  }));

  const db: Record<string, unknown> = {
    execute: vi.fn(async () => undefined),
    select,
    update,
    insert,
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db, insertValues, updateValues, update, insert };
}

function activePrescription(overrides: Record<string, unknown> = {}) {
  return {
    id: PRESCRIPTION_ID,
    practiceId: PRACTICE_ID,
    patientId: PATIENT_ID,
    productId: PRODUCT_ID,
    quantity: 10,
    refillsRemaining: 2,
    status: "active",
    endDate: "2026-12-31",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("prescription lifecycle mutations", () => {
  it("deducts stock, decrements refills, and appends one attributed event", async () => {
    const updated = activePrescription({ refillsRemaining: 1 });
    const event = {
      id: "event-1",
      prescriptionId: PRESCRIPTION_ID,
      eventType: "refill_dispensed",
    };
    const { db, insertValues, updateValues } = queuedDb({
      selects: [
        [],
        [activePrescription()],
        [{ name: "Clinic", phone: null, timezone: "UTC" }],
        [{ id: PRODUCT_ID, name: "Carprofen", stockQuantity: 40 }],
      ],
      updates: [[{ id: PRODUCT_ID, stockQuantity: 30 }], [updated]],
      inserts: [[event]],
    });

    await expect(
      callerWithDb(db).recordPrescriptionRefill({
        id: PRESCRIPTION_ID,
        operationId: OPERATION_ID,
        note: "Bottle checked",
      }),
    ).resolves.toMatchObject({
      replayed: false,
      prescription: { refillsRemaining: 1 },
    });

    expect(updateValues).toHaveLength(2);
    expect(insertValues).toContainEqual({
      practiceId: PRACTICE_ID,
      prescriptionId: PRESCRIPTION_ID,
      patientId: PATIENT_ID,
      productId: PRODUCT_ID,
      quantity: 10,
      eventType: "refill_dispensed",
      statusBefore: "active",
      statusAfter: "active",
      refillsBefore: 2,
      refillsAfter: 1,
      reason: "Bottle checked",
      actorId: USER_ID,
      actorName: "Doctor Rivera",
      operationId: OPERATION_ID,
    });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledOnce();
  });

  it("replays an identical operation without another stock or event write", async () => {
    const existingEvent = {
      id: "event-1",
      prescriptionId: PRESCRIPTION_ID,
      eventType: "refill_dispensed",
      operationId: OPERATION_ID,
    };
    const { db, update, insert } = queuedDb({
      selects: [[existingEvent], [activePrescription({ refillsRemaining: 1 })]],
    });

    await expect(
      callerWithDb(db).recordPrescriptionRefill({
        id: PRESCRIPTION_ID,
        operationId: OPERATION_ID,
      }),
    ).resolves.toMatchObject({ replayed: true, event: existingEvent });

    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects operation ID reuse for another lifecycle action", async () => {
    const { db } = queuedDb({
      selects: [
        [
          {
            prescriptionId: PRESCRIPTION_ID,
            eventType: "completed",
            operationId: OPERATION_ID,
          },
        ],
        [activePrescription()],
      ],
    });

    await expect(
      callerWithDb(db).recordPrescriptionRefill({
        id: PRESCRIPTION_ID,
        operationId: OPERATION_ID,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an operation retry when the refill note changed", async () => {
    const { db, update, insert } = queuedDb({
      selects: [
        [
          {
            prescriptionId: PRESCRIPTION_ID,
            eventType: "refill_dispensed",
            operationId: OPERATION_ID,
            reason: "Original note",
          },
        ],
        [activePrescription({ refillsRemaining: 1 })],
      ],
    });

    await expect(
      callerWithDb(db).recordPrescriptionRefill({
        id: PRESCRIPTION_ID,
        operationId: OPERATION_ID,
        note: "Changed note",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("authorizes an external refill without changing clinic stock", async () => {
    const externalPrescription = activePrescription({
      productId: null,
      quantity: 30,
    });
    const updated = { ...externalPrescription, refillsRemaining: 1 };
    const { db, insertValues, updateValues } = queuedDb({
      selects: [
        [],
        [externalPrescription],
        [{ name: "Clinic", phone: null, timezone: "UTC" }],
      ],
      updates: [[updated]],
      inserts: [
        [
          {
            id: "event-external",
            eventType: "refill_authorized",
            prescriptionId: PRESCRIPTION_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).recordPrescriptionRefill({
        id: PRESCRIPTION_ID,
        operationId: OPERATION_ID,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      event: { eventType: "refill_authorized" },
    });

    expect(updateValues).toHaveLength(1);
    expect(insertValues[0]).toMatchObject({
      eventType: "refill_authorized",
      productId: null,
      quantity: 30,
      refillsBefore: 2,
      refillsAfter: 1,
    });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "prescription.refill_authorized",
      expect.objectContaining({ productId: null }),
    );
  });

  it("rejects a stale concurrent refill and appends no event", async () => {
    const { db, insert } = queuedDb({
      selects: [
        [],
        [activePrescription()],
        [{ name: "Clinic", phone: null, timezone: "UTC" }],
        [{ id: PRODUCT_ID, name: "Carprofen", stockQuantity: 40 }],
      ],
      updates: [[{ id: PRODUCT_ID, stockQuantity: 30 }], []],
    });

    await expect(
      callerWithDb(db).recordPrescriptionRefill({
        id: PRESCRIPTION_ID,
        operationId: OPERATION_ID,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not allow refills after the effective end date", async () => {
    const { db, update, insert } = queuedDb({
      selects: [
        [],
        [activePrescription({ endDate: "2020-01-01" })],
        [{ name: "Clinic", phone: null, timezone: "UTC" }],
      ],
    });

    await expect(
      callerWithDb(db).recordPrescriptionRefill({
        id: PRESCRIPTION_ID,
        operationId: OPERATION_ID,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("requires an attributed clinical reason for terminal transitions", async () => {
    const { db, update } = queuedDb({ selects: [] });
    await expect(
      callerWithDb(db).cancelPrescription({
        id: PRESCRIPTION_ID,
        operationId: OPERATION_ID,
        reason: "no",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(update).not.toHaveBeenCalled();
  });
});
