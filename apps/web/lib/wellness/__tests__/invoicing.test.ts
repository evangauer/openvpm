import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { generateDueWellnessInvoices } from "../invoicing";

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000c1";
const PATIENT_ID = "00000000-0000-0000-0000-0000000000d1";
const ENROLLMENT_ID = "00000000-0000-0000-0000-0000000000e1";
const INVOICE_ID = "00000000-0000-0000-0000-0000000000f1";

function createDb(opts?: {
  selectResults?: unknown[][];
  insertReturns?: unknown[][];
  updateReturns?: unknown[][];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const insertReturns = [...(opts?.insertReturns ?? [[{ id: INVOICE_ID }]])];
  const insertReturning = vi.fn(async () => insertReturns.shift() ?? []);
  const insertValues = vi.fn(() => ({
    returning: insertReturning,
    then: (resolve: (value: undefined) => unknown) =>
      Promise.resolve(undefined).then(resolve),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturns = [
    ...(opts?.updateReturns ?? [[{ nextBillingDate: "2026-08-31" }]]),
  ];
  const updateReturning = vi.fn(async () => updateReturns.shift() ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return { db, insertValues, updateSet };
}

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    enrollmentId: ENROLLMENT_ID,
    clientId: CLIENT_ID,
    patientId: PATIENT_ID,
    patientName: "Rex",
    planName: "Puppy Wellness",
    price: "100.00",
    billingInterval: "monthly",
    nextBillingDate: "2026-07-31",
    ...overrides,
  };
}

describe("generateDueWellnessInvoices", () => {
  it("creates an invoice and advances the enrollment billing date", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ taxRatePercent: "8.00" }], [dueRow()]],
    });

    await expect(
      generateDueWellnessInvoices({
        db: db as never,
        practiceId: PRACTICE_ID,
        asOf: "2026-08-01",
      })
    ).resolves.toEqual({
      generated: 1,
      invoices: [
        {
          enrollmentId: ENROLLMENT_ID,
          invoiceId: INVOICE_ID,
          nextBillingDate: "2026-08-31",
          amount: "108.00",
        },
      ],
    });

    expect(insertValues).toHaveBeenNthCalledWith(1, {
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      patientId: PATIENT_ID,
      status: "sent",
      subtotal: "100.00",
      tax: "8.00",
      total: "108.00",
      paidAmount: "0.00",
      dueDate: "2026-07-31",
      isEstimate: false,
    });
    expect(insertValues).toHaveBeenNthCalledWith(2, {
      invoiceId: INVOICE_ID,
      description: "Wellness plan: Puppy Wellness (Rex)",
      quantity: 1,
      unitPrice: "100.00",
      total: "100.00",
      taxable: true,
      itemType: "service",
      itemId: null,
    });
    expect(updateSet).toHaveBeenCalledWith({ nextBillingDate: "2026-08-31" });
  });

  it("does not create invoices when no enrollments are due", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ taxRatePercent: "8.00" }], []],
    });

    await expect(
      generateDueWellnessInvoices({
        db: db as never,
        practiceId: PRACTICE_ID,
        asOf: "2026-08-01",
      })
    ).resolves.toEqual({ generated: 0, invoices: [] });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("treats an explicitly empty target list as no selected enrollments", async () => {
    const { db, insertValues, updateSet } = createDb();

    await expect(
      generateDueWellnessInvoices({
        db: db as never,
        practiceId: PRACTICE_ID,
        asOf: "2026-08-01",
        enrollmentIds: [],
      })
    ).resolves.toEqual({ generated: 0, invoices: [] });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not create invoices when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[]],
    });

    await expect(
      generateDueWellnessInvoices({
        db: db as never,
        practiceId: PRACTICE_ID,
        asOf: "2026-08-01",
      })
    ).resolves.toEqual({ generated: 0, invoices: [] });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rolls back by throwing if the enrollment advances concurrently", async () => {
    const { db } = createDb({
      selectResults: [[{ taxRatePercent: "0.00" }], [dueRow()]],
      updateReturns: [[]],
    });

    await expect(
      generateDueWellnessInvoices({
        db: db as never,
        practiceId: PRACTICE_ID,
        asOf: "2026-08-01",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("joins due enrollment plan and client rows through active tenant predicates", () => {
    const source = readFileSync(new URL("../invoicing.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /select\(\{ taxRatePercent: practices\.taxRatePercent \}\)[\s\S]+?where\(and\(eq\(practices\.id, opts\.practiceId\), isNull\(practices\.deletedAt\)\)\)/s
    );
    expect(source).toContain("if (!practice) {");
    expect(source).toContain("calculateInvoiceTaxTotals(");
    expect(source).toContain('practice.taxRatePercent ?? "8.00"');
    expect(source).toContain("taxable: true");
    expect(source).not.toContain("practice?.taxRatePercent");
    expect(source).toContain("patientId: patients.id");
    expect(source).toMatch(
      /innerJoin\(\s*wellnessPlans,\s*and\(\s*eq\(wellnessEnrollments\.planId, wellnessPlans\.id\),\s*eq\(wellnessPlans\.practiceId, opts\.practiceId\),\s*eq\(wellnessPlans\.active, true\),\s*isNull\(wellnessPlans\.deletedAt\)\s*\)\s*\)/s
    );
    expect(source).toMatch(
      /innerJoin\(\s*clients,\s*and\(\s*eq\(wellnessEnrollments\.clientId, clients\.id\),\s*eq\(clients\.practiceId, opts\.practiceId\),\s*isNull\(clients\.deletedAt\)\s*\)\s*\)/s
    );
    expect(source).toContain(
      "eq(patients.clientId, wellnessEnrollments.clientId)"
    );
  });
});
