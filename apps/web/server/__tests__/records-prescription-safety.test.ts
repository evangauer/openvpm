import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

const { recordsRouter } = await import("../routers/records");
const {
  PRESCRIPTION_COUNT_MAX,
  PRESCRIPTION_DOSAGE_MAX_LENGTH,
  PRESCRIPTION_FREQUENCY_MAX_LENGTH,
  PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH,
  PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH,
} = await import("@/lib/records/prescription-policy");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const PRODUCT_ID = "00000000-0000-0000-0000-000000000004";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000005";
const OPERATION_ID = "00000000-0000-0000-0000-000000000009";

function callerWithDb(db: Record<string, unknown>, injectOperationId = true) {
  const session = {
    user: {
      id: USER_ID,
      email: "doctor@example.com",
      name: "Doctor",
      role: "veterinarian",
      practiceId: PRACTICE_ID,
    },
  };
  const caller = recordsRouter.createCaller({ db, session } as never);
  if (!injectOperationId) return caller as any;
  return new Proxy(caller, {
    get(target, property, receiver) {
      if (property === "createPrescription") {
        return (input: Record<string, unknown>) =>
          target.createPrescription({
            operationId: OPERATION_ID,
            ...input,
          } as never);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as any;
}

function createThenableResult(result: unknown[]) {
  const afterWhere = {
    limit: vi.fn(async () => result),
    for: vi.fn(async () => result),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  return afterWhere;
}

function createDb(opts: {
  selectResults: unknown[][];
  inserted?: Record<string, unknown>;
  existingPrescription?: Record<string, unknown>;
  updateReturns?: unknown[][];
}) {
  const selectResults = [
    opts.existingPrescription ? [opts.existingPrescription] : [],
    ...opts.selectResults,
  ];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = createThenableResult(result);
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      orderBy: vi.fn(async () => result),
      where: vi.fn(() => afterWhere),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const inserted = opts.inserted ?? {
    id: "00000000-0000-0000-0000-000000000003",
    practiceId: PRACTICE_ID,
    patientId: PATIENT_ID,
    medicationName: "Carprofen 75 mg",
    prescribedBy: USER_ID,
    productId: null,
  };
  const insertReturning = vi.fn(async () => [inserted]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturns = [...(opts.updateReturns ?? [[]])];
  const updateSet = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => updateReturns.shift() ?? []),
    })),
  }));
  const update = vi.fn(() => ({ set: updateSet }));

  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const db: Record<string, unknown> = {
    transaction,
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return { db, select, insertValues, transaction, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("records.createPrescription safety enforcement", () => {
  const patientRow = [{ id: PATIENT_ID }];
  const carprofenAllergy = [
    {
      allergen: "carprofen",
      severity: "severe",
      reaction: "Facial swelling",
    },
  ];

  it("requires an operation ID before prescription DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db, false).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("blocks allergy warnings unless the clinician acknowledges them", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, carprofenAllergy, [], []],
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        operationId: OPERATION_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates a prescription after an explicit warning acknowledgement", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, carprofenAllergy, [], []],
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        operationId: OPERATION_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
        acknowledgeSafetyWarnings: true,
      }),
    ).resolves.toMatchObject({ medicationName: "Carprofen 75 mg" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.not.objectContaining({ acknowledgeSafetyWarnings: true }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        prescribedBy: USER_ID,
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        operationId: OPERATION_ID,
      }),
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "prescription.created",
      {
        id: "00000000-0000-0000-0000-000000000003",
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        prescribedBy: USER_ID,
        productId: null,
        source: "dashboard",
      },
    );
  });

  it("returns the original prescription for an exact operation retry", async () => {
    const existingPrescription = {
      id: "00000000-0000-0000-0000-000000000003",
      practiceId: PRACTICE_ID,
      patientId: PATIENT_ID,
      appointmentId: null,
      medicationName: "Carprofen 75 mg",
      dosage: "75 mg",
      frequency: "Every 12 hours",
      quantity: 10,
      productId: PRODUCT_ID,
      refillsRemaining: 0,
      startDate: "2026-06-27",
      endDate: null,
      instructions: null,
      prescribedBy: USER_ID,
      operationId: OPERATION_ID,
    };
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ refillsAfter: 0 }]],
      existingPrescription,
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        operationId: OPERATION_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        quantity: 10,
        productId: PRODUCT_ID,
        startDate: "2026-06-27",
      }),
    ).resolves.toMatchObject(existingPrescription);

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects reuse of a prescription operation ID with changed details", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ refillsAfter: 0 }]],
      existingPrescription: {
        id: "00000000-0000-0000-0000-000000000003",
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: null,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        quantity: null,
        productId: null,
        refillsRemaining: 0,
        startDate: "2026-06-27",
        endDate: null,
        instructions: null,
        prescribedBy: USER_ID,
        operationId: OPERATION_ID,
      },
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        operationId: OPERATION_ID,
        medicationName: "Meloxicam 7.5 mg",
        dosage: "7.5 mg",
        frequency: "Daily",
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("replays creation after a refill using the immutable initial refill snapshot", async () => {
    const existingPrescription = {
      id: "00000000-0000-0000-0000-000000000003",
      practiceId: PRACTICE_ID,
      patientId: PATIENT_ID,
      appointmentId: null,
      medicationName: "Carprofen 75 mg",
      dosage: "75 mg",
      frequency: "Every 12 hours",
      quantity: 10,
      productId: PRODUCT_ID,
      refillsRemaining: 1,
      startDate: "2026-06-27",
      endDate: null,
      instructions: null,
      prescribedBy: USER_ID,
      operationId: OPERATION_ID,
    };
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ refillsAfter: 2 }]],
      existingPrescription,
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        operationId: OPERATION_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        quantity: 10,
        productId: PRODUCT_ID,
        refillsRemaining: 2,
        startDate: "2026-06-27",
      }),
    ).resolves.toMatchObject({ refillsRemaining: 1 });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("links a prescription only to a visit for the same tenant and patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        patientRow,
        [{ id: APPOINTMENT_ID }],
        [],
        [],
        [],
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
        [],
      ],
      inserted: {
        id: "00000000-0000-0000-0000-000000000003",
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        medicationName: "Carprofen 75 mg",
        prescribedBy: USER_ID,
        productId: null,
      },
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
      }),
    ).resolves.toMatchObject({ appointmentId: APPOINTMENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
      }),
    );
  });

  it("rejects visit prescriptions after the clinical handoff is finalized", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        patientRow,
        [{ id: APPOINTMENT_ID }],
        [],
        [],
        [],
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
        [{ status: "clinical_finalized" }],
      ],
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Clinical handoff is finalized. Use an attributed amendment before changing visit prescriptions.",
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects a missing, cross-tenant, or wrong-patient visit link", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, []],
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Appointment not found",
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects a linked inventory product outside the practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, [], [], [], []],
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        quantity: 10,
        productId: PRODUCT_ID,
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires a dispensed quantity when linking inventory stock", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        patientRow,
        [],
        [],
        [],
        [{ id: PRODUCT_ID, name: "Carprofen", stockQuantity: 12 }],
      ],
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        productId: PRODUCT_ID,
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid prescription quantity and refill counts before DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        quantity: -1,
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        quantity: PRESCRIPTION_COUNT_MAX + 1,
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        refillsRemaining: 1.5,
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        refillsRemaining: PRESCRIPTION_COUNT_MAX + 1,
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        instructions: "A".repeat(PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH + 1),
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects prescription text that exceeds backing columns before DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).checkPrescriptionSafety({
        patientId: PATIENT_ID,
        medicationName: "A".repeat(PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "A".repeat(PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH + 1),
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "A".repeat(PRESCRIPTION_DOSAGE_MAX_LENGTH + 1),
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "A".repeat(PRESCRIPTION_FREQUENCY_MAX_LENGTH + 1),
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid prescription dates before DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-02-31",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        startDate: "2026-06-27",
        endDate: "2026-06-26",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("deducts inventory stock when a product-backed prescription is dispensed", async () => {
    const { db, insertValues, transaction, updateSet } = createDb({
      selectResults: [
        patientRow,
        [],
        [],
        [],
        [{ id: PRODUCT_ID, name: "Carprofen", stockQuantity: 12 }],
      ],
      updateReturns: [[{ id: PRODUCT_ID, stockQuantity: 2 }]],
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        quantity: 10,
        productId: PRODUCT_ID,
        startDate: "2026-06-27",
      }),
    ).resolves.toMatchObject({ medicationName: "Carprofen 75 mg" });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: PRODUCT_ID,
        quantity: 10,
      }),
    );
  });

  it("does not insert a prescription when a stock deduction race is lost", async () => {
    const { db, insertValues, transaction, updateSet } = createDb({
      selectResults: [
        patientRow,
        [],
        [],
        [],
        [{ id: PRODUCT_ID, name: "Carprofen", stockQuantity: 12 }],
      ],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).createPrescription({
        patientId: PATIENT_ID,
        medicationName: "Carprofen 75 mg",
        dosage: "75 mg",
        frequency: "Every 12 hours",
        quantity: 10,
        productId: PRODUCT_ID,
        startDate: "2026-06-27",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
  });
});

describe("records list query scoping", () => {
  const source = readFileSync(
    new URL("../routers/records.ts", import.meta.url),
    "utf8",
  );

  it("keeps historical clinical actors tenant scoped after deactivation", () => {
    for (const foreignKey of [
      "vaccinationRecords.administeredBy",
      "prescriptions.prescribedBy",
      "procedures.performedBy",
    ]) {
      expect(source).toMatch(
        new RegExp(
          `leftJoin\\(\\s*users,\\s*and\\(\\s*eq\\(${foreignKey.replace(
            ".",
            "\\.",
          )}, users\\.id\\),\\s*eq\\(users\\.practiceId, ctx\\.practiceId\\)\\s*,?\\s*\\)\\s*,?\\s*\\)`,
          "s",
        ),
      );
      expect(source).not.toMatch(
        new RegExp(
          `eq\\(${foreignKey.replace(
            ".",
            "\\.",
          )}, users\\.id\\)[\\s\\S]{0,120}?isNull\\(users\\.deletedAt\\)`,
          "s",
        ),
      );
    }
    expect(source).toContain("authorName: soapNotes.authorName");
    expect(source).not.toMatch(
      /leftJoin\(\s*users,\s*and\(\s*eq\(soapNotes\.authorId, users\.id\)/s,
    );
    expect(source).toMatch(
      /leftJoin\(\s*orderedBy,\s*and\(\s*eq\(labResults\.orderedBy, orderedBy\.id\),\s*eq\(orderedBy\.practiceId, ctx\.practiceId\)\s*,?\s*\)\s*,?\s*\)/s,
    );
  });

  it("keeps prescription inventory joins tenant scoped and active", () => {
    expect(source).toMatch(
      /leftJoin\(\s*products,\s*and\(\s*eq\(prescriptions\.productId, products\.id\),\s*eq\(products\.practiceId, ctx\.practiceId\),\s*isNull\(products\.deletedAt\)\s*,?\s*\)\s*,?\s*\)/s,
    );
  });

  it("scopes prescription safety allergy reads through the tenant patient", () => {
    const allergySafetyBlock = source.match(
      /\.from\(patientAllergies\)[\s\S]+?isNull\(patientAllergies\.deletedAt\)/,
    )?.[0];
    expect(allergySafetyBlock).toContain(
      "eq(patientAllergies.patientId, patientId)",
    );
    expect(allergySafetyBlock).toContain("from ${patients}");
    expect(allergySafetyBlock).toContain(
      "${patients.id} = ${patientAllergies.patientId}",
    );
    expect(allergySafetyBlock).toContain(
      "${patients.practiceId} = ${ctx.practiceId}",
    );
    expect(allergySafetyBlock).toContain("${patients.deletedAt} is null");
  });
});

describe("records prescription retry UX", () => {
  const source = readFileSync(
    new URL("../../app/(dashboard)/records/page.tsx", import.meta.url),
    "utf8",
  );

  it("keeps one operation ID until prescription creation succeeds or is cancelled", () => {
    expect(source).toMatch(
      /prescriptionOperationId\.current\s*\?\?=\s*crypto\.randomUUID\(\)/,
    );
    expect(source).toContain("operationId: prescriptionOperationId.current");
    expect(source).toContain("prescriptionOperationId.current = null");
  });

  it("keeps URL-linked prescription creation behind a prerender-safe boundary", () => {
    expect(source).toContain("function RecordsPageContent()");
    expect(source).toContain(
      '<Suspense fallback={<RecordsLoadingPanel label="Loading records..." />}>',
    );
    expect(source).toContain("<RecordsPageContent />");
  });
});
