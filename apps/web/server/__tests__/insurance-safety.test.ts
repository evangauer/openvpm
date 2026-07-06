import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { insuranceRouter } = await import("../routers/insurance");
const { LIST_OFFSET_MAX } = await import("../routers/pagination");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const POLICY_ID = "00000000-0000-0000-0000-000000000004";
const INVOICE_ID = "00000000-0000-0000-0000-000000000005";
const CLAIM_ID = "00000000-0000-0000-0000-000000000006";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "frontdesk@example.com",
      name: "Front Desk",
      role: "front_desk",
      practiceId: PRACTICE_ID,
    },
  };
  return insuranceRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  practiceRows?: unknown[];
  insertedRows?: unknown[];
  updatedRows?: unknown[];
}) {
  const selectResults = [
    opts?.practiceRows ?? [{ id: PRACTICE_ID }],
    ...(opts?.selectResults ?? []),
  ];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
      offset: vi.fn(() => builder),
    };
    return builder;
  });

  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return { db, select, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("insurance policy safety", () => {
  it("rejects an inverted policy date window before writing", async () => {
    const { db, insertValues } = createDb();

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        effectiveDate: "2026-08-01",
        expirationDate: "2026-07-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid policy dates and currency fields before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        effectiveDate: "2026-02-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        deductible: "12.345",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        coveragePercent: 80.5,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid policy text before DB work", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: " ".repeat(4),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        policyNumber: "p".repeat(129),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        phoneNumber: "5".repeat(33),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        notes: "n".repeat(2001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePolicy({
        id: POLICY_ID,
        providerName: " ".repeat(4),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned client before creating a policy", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects policy reads and writes when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({ practiceRows: [] });
    const caller = callerWithDb(db);

    await expect(caller.listPolicies({})).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires the policy patient to belong to the selected client and practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: CLIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates a policy after validating the client and patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [{ id: PATIENT_ID }]],
      insertedRows: [{ id: POLICY_ID, clientId: CLIENT_ID, patientId: PATIENT_ID }],
    });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        effectiveDate: "2026-07-01",
      })
    ).resolves.toMatchObject({ id: POLICY_ID, clientId: CLIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "PawSure",
        effectiveDate: "2026-07-01",
      })
    );
  });

  it("trims policy text and money before writing", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [{ id: PATIENT_ID }]],
      insertedRows: [{ id: POLICY_ID, clientId: CLIENT_ID, patientId: PATIENT_ID }],
    });

    await expect(
      callerWithDb(db).createPolicy({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        providerName: "  PawSure  ",
        policyNumber: "  POL-123  ",
        groupNumber: "  GRP-9  ",
        phoneNumber: "  555-0100  ",
        coverageType: "  Accident  ",
        deductible: " 250.00 ",
        maxAnnualBenefit: " 5000.00 ",
        notes: "  Waiting period waived  ",
      })
    ).resolves.toMatchObject({ id: POLICY_ID, clientId: CLIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: "PawSure",
        policyNumber: "POL-123",
        groupNumber: "GRP-9",
        phoneNumber: "555-0100",
        coverageType: "Accident",
        deductible: "250.00",
        maxAnnualBenefit: "5000.00",
        notes: "Waiting period waived",
      })
    );
  });

  it("rejects stale, deleted, or cross-tenant policy updates", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).updatePolicy({
        id: POLICY_ID,
        providerName: "PawSure",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects no-op policy updates before DB work", async () => {
    const { db, select, updateSet } = createDb();

    await expect(
      callerWithDb(db).updatePolicy({
        id: POLICY_ID,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "No fields to update",
    });

    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects invalid policy updates before DB work", async () => {
    const { db, select, updateSet } = createDb();

    await expect(
      callerWithDb(db).updatePolicy({
        id: POLICY_ID,
        effectiveDate: "2026-08-01",
        expirationDate: "2026-07-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePolicy({
        id: POLICY_ID,
        maxAnnualBenefit: "100000000",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects partial policy date updates that conflict with stored dates", async () => {
    const expiration = createDb({
      selectResults: [
        [{ effectiveDate: "2026-08-01", expirationDate: "2026-12-31" }],
      ],
    });

    await expect(
      callerWithDb(expiration.db).updatePolicy({
        id: POLICY_ID,
        expirationDate: "2026-07-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(expiration.updateSet).not.toHaveBeenCalled();

    const effective = createDb({
      selectResults: [
        [{ effectiveDate: "2026-01-01", expirationDate: "2026-07-01" }],
      ],
    });

    await expect(
      callerWithDb(effective.db).updatePolicy({
        id: POLICY_ID,
        effectiveDate: "2026-08-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(effective.updateSet).not.toHaveBeenCalled();
  });

  it("updates a policy after validating its stored date window", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ effectiveDate: "2026-01-01", expirationDate: "2026-12-31" }],
      ],
      updatedRows: [{ id: POLICY_ID, providerName: "PawSure" }],
    });

    await expect(
      callerWithDb(db).updatePolicy({
        id: POLICY_ID,
        providerName: " PawSure ",
        expirationDate: "2026-11-30",
      })
    ).resolves.toMatchObject({ id: POLICY_ID });

    expect(updateSet).toHaveBeenCalledWith({
      providerName: "PawSure",
      expirationDate: "2026-11-30",
    });
  });

  it("rejects policy updates that lose the race to another date change", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ effectiveDate: "2026-01-01", expirationDate: "2026-12-31" }],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updatePolicy({
        id: POLICY_ID,
        expirationDate: "2026-11-30",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Policy changed while updating. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({
      expirationDate: "2026-11-30",
    });
  });
});

describe("insurance claim safety", () => {
  it("rejects invalid claim filters and amounts before DB work", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).listClaims({
        status: "lost",
        limit: 25,
        offset: 0,
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).listClaims({
        limit: 1.5,
        offset: 0,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).listClaims({
        limit: 25,
        offset: LIST_OFFSET_MAX + 1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createClaim({
        policyId: POLICY_ID,
        claimAmount: "1.234",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateClaimStatus({
        id: CLAIM_ID,
        status: "approved",
        approvedAmount: "12.345",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects invalid claim text before DB work", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).createClaim({
        policyId: POLICY_ID,
        claimNumber: "c".repeat(129),
        claimAmount: "125.00",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createClaim({
        policyId: POLICY_ID,
        claimAmount: "125.00",
        notes: "n".repeat(2001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateClaimStatus({
        id: CLAIM_ID,
        status: "denied",
        deniedReason: "d".repeat(2001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned policy before creating a claim", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createClaim({
        policyId: POLICY_ID,
        claimAmount: "125.00",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects claim reads and writes when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({ practiceRows: [] });
    const caller = callerWithDb(db);

    await expect(
      caller.listClaims({ limit: 25, offset: 0 })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.createClaim({
        policyId: POLICY_ID,
        claimAmount: "125.00",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.updateClaimStatus({
        id: CLAIM_ID,
        status: "submitted",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires an optional invoice to belong to the same insured client and patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: POLICY_ID, clientId: CLIENT_ID, patientId: PATIENT_ID }],
        [],
      ],
    });

    await expect(
      callerWithDb(db).createClaim({
        policyId: POLICY_ID,
        invoiceId: INVOICE_ID,
        claimAmount: "125.00",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates a claim after validating policy and invoice ownership", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: POLICY_ID, clientId: CLIENT_ID, patientId: PATIENT_ID }],
        [{ id: INVOICE_ID }],
      ],
      insertedRows: [{ id: CLAIM_ID, policyId: POLICY_ID, invoiceId: INVOICE_ID }],
    });

    await expect(
      callerWithDb(db).createClaim({
        policyId: POLICY_ID,
        invoiceId: INVOICE_ID,
        claimAmount: "125.00",
      })
    ).resolves.toMatchObject({ id: CLAIM_ID, policyId: POLICY_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        policyId: POLICY_ID,
        invoiceId: INVOICE_ID,
        claimAmount: "125.00",
        status: "draft",
      })
    );
  });

  it("trims claim text and money before writing", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: POLICY_ID, clientId: CLIENT_ID, patientId: PATIENT_ID }]],
      insertedRows: [{ id: CLAIM_ID, policyId: POLICY_ID }],
    });

    await expect(
      callerWithDb(db).createClaim({
        policyId: POLICY_ID,
        claimNumber: "  CLM-42  ",
        claimAmount: " 125.00 ",
        notes: "  Submitted from client receipt  ",
      })
    ).resolves.toMatchObject({ id: CLAIM_ID, policyId: POLICY_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        claimNumber: "CLM-42",
        claimAmount: "125.00",
        notes: "Submitted from client receipt",
      })
    );
  });

  it("rejects stale, deleted, or cross-tenant claim status updates", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).updateClaimStatus({
        id: CLAIM_ID,
        status: "submitted",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects invalid claim status transitions before writing", async () => {
    const draft = createDb({
      selectResults: [
        [
          {
            status: "draft",
            claimAmount: "125.00",
            approvedAmount: null,
            deniedReason: null,
            submittedAt: null,
            resolvedAt: null,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(draft.db).updateClaimStatus({
        id: CLAIM_ID,
        status: "paid",
        approvedAmount: "125.00",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot change insurance claim status from draft to paid.",
    });
    expect(draft.updateSet).not.toHaveBeenCalled();

    const denied = createDb({
      selectResults: [
        [
          {
            status: "denied",
            claimAmount: "125.00",
            approvedAmount: null,
            deniedReason: "Not covered",
            submittedAt: new Date("2026-06-01T00:00:00.000Z"),
            resolvedAt: new Date("2026-06-02T00:00:00.000Z"),
          },
        ],
      ],
    });

    await expect(
      callerWithDb(denied.db).updateClaimStatus({
        id: CLAIM_ID,
        status: "submitted",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot change insurance claim status from denied to submitted.",
    });
    expect(denied.updateSet).not.toHaveBeenCalled();
  });

  it("requires valid claim resolution details before writing", async () => {
    const approvedWithoutAmount = createDb({
      selectResults: [
        [
          {
            status: "submitted",
            claimAmount: "125.00",
            approvedAmount: null,
            deniedReason: null,
            submittedAt: new Date("2026-06-01T00:00:00.000Z"),
            resolvedAt: null,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(approvedWithoutAmount.db).updateClaimStatus({
        id: CLAIM_ID,
        status: "approved",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Approved claims require a positive approved amount.",
    });
    expect(approvedWithoutAmount.updateSet).not.toHaveBeenCalled();

    const tooMuch = createDb({
      selectResults: [
        [
          {
            status: "submitted",
            claimAmount: "125.00",
            approvedAmount: null,
            deniedReason: null,
            submittedAt: new Date("2026-06-01T00:00:00.000Z"),
            resolvedAt: null,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(tooMuch.db).updateClaimStatus({
        id: CLAIM_ID,
        status: "approved",
        approvedAmount: "126.00",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Approved amount cannot exceed the claim amount.",
    });
    expect(tooMuch.updateSet).not.toHaveBeenCalled();

    const deniedWithoutReason = createDb({
      selectResults: [
        [
          {
            status: "in_review",
            claimAmount: "125.00",
            approvedAmount: null,
            deniedReason: null,
            submittedAt: new Date("2026-06-01T00:00:00.000Z"),
            resolvedAt: null,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(deniedWithoutReason.db).updateClaimStatus({
        id: CLAIM_ID,
        status: "denied",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Denied claims require a denial reason.",
    });
    expect(deniedWithoutReason.updateSet).not.toHaveBeenCalled();
  });

  it("trims claim status text and money before updating", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            status: "in_review",
            claimAmount: "125.00",
            approvedAmount: null,
            deniedReason: null,
            submittedAt: new Date("2026-06-01T00:00:00.000Z"),
            resolvedAt: null,
          },
        ],
      ],
      updatedRows: [{ id: CLAIM_ID, status: "denied" }],
    });

    await expect(
      callerWithDb(db).updateClaimStatus({
        id: CLAIM_ID,
        status: "denied",
        approvedAmount: " 0.00 ",
        deniedReason: "  Not covered  ",
        notes: "  Client notified  ",
      })
    ).resolves.toMatchObject({ id: CLAIM_ID, status: "denied" });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedAmount: "0.00",
        deniedReason: "Not covered",
        notes: "Client notified",
      })
    );
  });

  it("sets claim lifecycle timestamps without resetting existing milestones", async () => {
    const submitted = createDb({
      selectResults: [
        [
          {
            status: "draft",
            claimAmount: "125.00",
            approvedAmount: null,
            deniedReason: null,
            submittedAt: null,
            resolvedAt: null,
          },
        ],
      ],
      updatedRows: [{ id: CLAIM_ID, status: "submitted" }],
    });

    await expect(
      callerWithDb(submitted.db).updateClaimStatus({
        id: CLAIM_ID,
        status: "submitted",
      })
    ).resolves.toMatchObject({ id: CLAIM_ID, status: "submitted" });

    expect(submitted.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        submittedAt: expect.any(Date),
      })
    );

    const paid = createDb({
      selectResults: [
        [
          {
            status: "approved",
            claimAmount: "125.00",
            approvedAmount: "100.00",
            deniedReason: null,
            submittedAt: new Date("2026-06-01T00:00:00.000Z"),
            resolvedAt: new Date("2026-06-02T00:00:00.000Z"),
          },
        ],
      ],
      updatedRows: [{ id: CLAIM_ID, status: "paid" }],
    });

    await expect(
      callerWithDb(paid.db).updateClaimStatus({
        id: CLAIM_ID,
        status: "paid",
        notes: "Reimbursed by carrier",
      })
    ).resolves.toMatchObject({ id: CLAIM_ID, status: "paid" });

    expect(paid.updateSet).toHaveBeenCalledWith({
      status: "paid",
      notes: "Reimbursed by carrier",
    });
  });

  it("rejects claim status updates that lose the race to another status or amount change", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            status: "submitted",
            claimAmount: "125.00",
            approvedAmount: null,
            deniedReason: null,
            submittedAt: new Date("2026-06-01T00:00:00.000Z"),
            resolvedAt: null,
          },
        ],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateClaimStatus({
        id: CLAIM_ID,
        status: "approved",
        approvedAmount: "100.00",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Claim changed while updating. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "approved",
        approvedAmount: "100.00",
        resolvedAt: expect.any(Date),
      })
    );
  });
});

describe("insurance list query scoping", () => {
  const source = readFileSync(
    new URL("../routers/insurance.ts", import.meta.url),
    "utf8"
  );

  it("keeps displayed policy client joins tenant scoped and active", () => {
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function activePracticeWhere");
    expect(source).toContain("throw practiceNotFound()");

    expect(source).toMatch(
      /leftJoin\(\s*clients,\s*and\(\s*eq\(insurancePolicies\.clientId, clients\.id\),\s*eq\(clients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(clients\.deletedAt\)\s*\)\s*\)/s
    );
  });

  it("keeps displayed policy patients tied to the policy client", () => {
    expect(source).toMatch(
      /leftJoin\(\s*patients,\s*and\(\s*eq\(insurancePolicies\.patientId, patients\.id\),\s*eq\(patients\.clientId, insurancePolicies\.clientId\),\s*eq\(patients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(patients\.deletedAt\)\s*\)\s*\)/s
    );
  });

  it("keeps displayed claim policy joins tenant scoped and active", () => {
    expect(source).toMatch(
      /leftJoin\(\s*insurancePolicies,\s*and\(\s*eq\(insuranceClaims\.policyId, insurancePolicies\.id\),\s*eq\(insurancePolicies\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(insurancePolicies\.deletedAt\)\s*\)\s*\)/s
    );
  });

  it("claims the observed claim status and approved amount before status writes", () => {
    expect(source).toContain("assertClaimStatusTransition(existing.status, input.status)");
    expect(source).toContain("eq(insuranceClaims.status, existing.status)");
    expect(source).toContain(
      "sql`${insuranceClaims.approvedAmount} is not distinct from ${existing.approvedAmount}`"
    );
  });
});
