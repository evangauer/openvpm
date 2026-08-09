import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));

const { encountersRouter } = await import("../routers/encounters");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const OTHER_PRACTICE_ID = "00000000-0000-0000-0000-0000000000bb";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000002";
const OTHER_APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const PATIENT_ID = "00000000-0000-0000-0000-000000000004";
const CLIENT_ID = "00000000-0000-0000-0000-000000000005";
const WORK_ITEM_ID = "00000000-0000-0000-0000-000000000006";
const INVOICE_ID = "00000000-0000-0000-0000-000000000007";
const INVOICE_ITEM_ID = "00000000-0000-0000-0000-000000000008";
const PRESCRIPTION_ID = "00000000-0000-0000-0000-000000000009";
const DISPENSE_CHARGE_ID = "00000000-0000-0000-0000-00000000000a";
const VACCINATION_ID = "00000000-0000-0000-0000-00000000000b";
const CORRECTION_ID = "00000000-0000-0000-0000-00000000000c";

const openAppointment = {
  id: APPOINTMENT_ID,
  status: "in_exam",
  startTime: new Date("2026-08-08T16:00:00.000Z"),
  patientId: PATIENT_ID,
  clientId: CLIENT_ID,
  requiresDoctor: 1,
};

const unresolvedWork = {
  id: WORK_ITEM_ID,
  practiceId: PRACTICE_ID,
  appointmentId: APPOINTMENT_ID,
  status: "unresolved",
  invoiceId: null,
  invoiceItemId: null,
  noChargeReason: null,
  voidReason: null,
};

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  return encountersRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: `${role}@example.com`,
        name: "Clinic Admin",
        role,
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function createDb(options: {
  selectResults: unknown[][];
  updateResults?: unknown[][];
}) {
  const selectResults = [...options.selectResults];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder: Record<string, any> = {};
    builder.from = vi.fn(() => builder);
    builder.leftJoin = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.for = vi.fn(async () => result);
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });
  const updateResults = [...(options.updateResults ?? [])];
  const updateSet = vi.fn((values: unknown) => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => updateResults.shift() ?? []),
    })),
    values,
  }));
  const insertValues = vi.fn(async () => undefined);
  const execute = vi.fn(async () => []);
  const db: Record<string, unknown> = {
    select,
    update: vi.fn(() => ({ set: updateSet })),
    insert: vi.fn(() => ({ values: insertValues })),
    execute,
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db, select, updateSet, insertValues, execute };
}

afterEach(() => vi.clearAllMocks());

describe("visit work reconciliation", () => {
  it("durably syncs visit-linked sources before returning the reconciliation", async () => {
    const listedItem = {
      ...unresolvedWork,
      sourceType: "procedure",
      sourceId: "00000000-0000-0000-0000-000000000010",
      sourceLabel: "Dental cleaning",
      invoiceItemDescription: null,
      invoiceItemDeletedAt: null,
      invoiceStatus: null,
      invoiceDeletedAt: null,
      resolvedAt: null,
      resolvedByName: null,
      suggestedProductId: null,
      suggestedProductName: null,
      suggestedProductPrice: null,
      createdAt: new Date("2026-08-08T16:30:00.000Z"),
    };
    const { db, execute } = createDb({
      selectResults: [
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
        [listedItem],
        [],
        [],
      ],
    });

    await expect(
      callerWithDb(db).getVisitReconciliation({
        appointmentId: APPOINTMENT_ID,
      }),
    ).resolves.toMatchObject({
      unresolvedCount: 1,
      items: [{ id: WORK_ITEM_ID, sourceLabel: "Dental cleaning" }],
    });
    // Tenant context, a deterministic vaccination-source lock, and four
    // bounded source upserts all finish before the list query resolves.
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("does not create unresolved ledger work for a historical closed visit", async () => {
    const { db, execute } = createDb({
      selectResults: [
        [{ id: APPOINTMENT_ID, status: "checked_out" }],
        [],
        [],
        [],
      ],
    });

    await expect(
      callerWithDb(db).getVisitReconciliation({
        appointmentId: APPOINTMENT_ID,
      })
    ).resolves.toMatchObject({ unresolvedCount: 0, items: [] });
    // The tenant-context statement still runs, but no source upserts do.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("serializes vaccination correction and work materialization on the source row", () => {
    const integrity = readFileSync(
      new URL("../visit-billing-integrity.ts", import.meta.url),
      "utf8"
    );
    const records = readFileSync(
      new URL("../routers/records.ts", import.meta.url),
      "utf8"
    );

    const syncTransaction = integrity.indexOf("await ctx.db.transaction");
    const syncSourceLock = integrity.indexOf(
      "select ${vaccinationRecords.id}",
      syncTransaction
    );
    const syncInsert = integrity.indexOf(
      "insert into ${visitWorkItems}",
      syncSourceLock
    );
    const freshCorrectionCheck = integrity.indexOf(
      "from ${clinicalRecordCorrections} as vaccination_correction",
      syncInsert
    );
    expect(syncTransaction).toBeGreaterThanOrEqual(0);
    expect(syncSourceLock).toBeGreaterThan(syncTransaction);
    expect(syncInsert).toBeGreaterThan(syncSourceLock);
    expect(freshCorrectionCheck).toBeGreaterThan(syncInsert);
    expect(integrity.slice(syncSourceLock, syncInsert)).toContain(
      "order by ${vaccinationRecords.id}"
    );
    expect(integrity.slice(syncSourceLock, syncInsert)).toContain("for update");

    const correctionStart = records.indexOf("markVaccinationEnteredInError");
    const correctionEnd = records.indexOf("createVaccination", correctionStart);
    const correctionMutation = records.slice(correctionStart, correctionEnd);
    const correctionSourceLock = correctionMutation.indexOf(
      '.for("update", { of: vaccinationRecords })'
    );
    const correctionInsert = correctionMutation.indexOf(
      ".insert(clinicalRecordCorrections)"
    );
    const correctionWorkUpdate = correctionMutation.indexOf(
      ".update(visitWorkItems)"
    );
    expect(correctionSourceLock).toBeGreaterThanOrEqual(0);
    expect(correctionInsert).toBeGreaterThan(correctionSourceLock);
    expect(correctionWorkUpdate).toBeGreaterThan(correctionInsert);

    // Sync-first inserts before releasing the source lock, so correction waits
    // and then voids that row. Correction-first commits before sync's lock wait
    // ends, so the later INSERT statement's fresh snapshot skips the source.
  });

  it("resolves an item against an explicitly selected same-visit charge", async () => {
    const resolved = {
      ...unresolvedWork,
      status: "charged",
      invoiceId: INVOICE_ID,
      invoiceItemId: INVOICE_ITEM_ID,
      resolvedBy: USER_ID,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [unresolvedWork],
        [{ invoiceId: INVOICE_ID }],
      ],
      updateResults: [[resolved]],
    });

    await expect(
      callerWithDb(db).resolveVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        resolution: { status: "charged", invoiceItemId: INVOICE_ITEM_ID },
      }),
    ).resolves.toMatchObject({
      status: "charged",
      invoiceId: INVOICE_ID,
      invoiceItemId: INVOICE_ITEM_ID,
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "charged",
        invoiceId: INVOICE_ID,
        invoiceItemId: INVOICE_ITEM_ID,
        resolvedBy: USER_ID,
      }),
    );
  });

  it("records an attributable no-charge reason", async () => {
    const resolved = {
      ...unresolvedWork,
      status: "no_charge",
      noChargeReason: "Included in wellness plan",
      resolvedBy: USER_ID,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [unresolvedWork],
      ],
      updateResults: [[resolved]],
    });

    await expect(
      callerWithDb(db).resolveVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        resolution: {
          status: "no_charge",
          reason: "Included in wellness plan",
        },
      }),
    ).resolves.toMatchObject({ status: "no_charge" });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "no_charge",
        noChargeReason: "Included in wellness plan",
        resolvedBy: USER_ID,
      }),
    );
  });

  it("waives the exact pending dispense when medication work is no charge", async () => {
    const prescriptionWork = {
      ...unresolvedWork,
      prescriptionId: PRESCRIPTION_ID,
    };
    const resolved = {
      ...prescriptionWork,
      status: "no_charge",
      noChargeReason: "Manufacturer replacement supplied",
      resolvedBy: USER_ID,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [prescriptionWork],
        [
          {
            id: DISPENSE_CHARGE_ID,
            status: "pending",
            invoiceId: null,
            invoiceItemId: null,
            resolutionReason: null,
          },
        ],
      ],
      updateResults: [[{ id: DISPENSE_CHARGE_ID }], [resolved]],
    });

    await expect(
      callerWithDb(db).resolveVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        resolution: {
          status: "no_charge",
          reason: "Manufacturer replacement supplied",
        },
      }),
    ).resolves.toMatchObject({ status: "no_charge" });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "waived",
        resolvedBy: USER_ID,
        resolvedByName: "Clinic Admin",
        resolutionReason: "Manufacturer replacement supplied",
      }),
    );
  });

  it("requires an administrator to waive dispensed medication from a visit", async () => {
    const prescriptionWork = {
      ...unresolvedWork,
      prescriptionId: PRESCRIPTION_ID,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [prescriptionWork],
        [
          {
            id: DISPENSE_CHARGE_ID,
            status: "pending",
            invoiceId: null,
            invoiceItemId: null,
            resolutionReason: null,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db, "front_desk").resolveVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        resolution: {
          status: "no_charge",
          reason: "Manufacturer replacement supplied",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("is idempotent for an identical resolution replay", async () => {
    const existing = {
      ...unresolvedWork,
      status: "no_charge",
      noChargeReason: "Included in wellness plan",
      resolvedBy: USER_ID,
    };
    const { db, updateSet } = createDb({
      selectResults: [[openAppointment], [{ id: PATIENT_ID }], [existing]],
    });

    await expect(
      callerWithDb(db).resolveVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        resolution: {
          status: "no_charge",
          reason: "Included in wellness plan",
        },
      }),
    ).resolves.toEqual(existing);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("reopens a wrong charge link with an append-only attributed audit event", async () => {
    const charged = {
      ...unresolvedWork,
      status: "charged",
      invoiceId: INVOICE_ID,
      invoiceItemId: INVOICE_ITEM_ID,
      resolvedBy: USER_ID,
      resolvedAt: new Date("2026-08-08T17:00:00.000Z"),
    };
    const reopened = { ...unresolvedWork };
    const { db, updateSet, insertValues } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [],
        [charged],
      ],
      updateResults: [[reopened]],
    });

    await expect(
      callerWithDb(db).reopenVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        reason: "Linked the wrong invoice line",
      }),
    ).resolves.toMatchObject({ status: "unresolved" });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        userId: USER_ID,
        action: "reopened",
        entityType: "visit_work_item",
        entityId: WORK_ITEM_ID,
        changes: expect.objectContaining({
          reason: "Linked the wrong invoice line",
          priorStatus: "charged",
          priorInvoiceItemId: INVOICE_ITEM_ID,
        }),
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unresolved",
        invoiceId: null,
        invoiceItemId: null,
        resolvedBy: null,
      }),
    );
  });

  it("does not reopen visit work for a vaccination entered in error", async () => {
    const correctedVaccinationWork = {
      ...unresolvedWork,
      vaccinationRecordId: VACCINATION_ID,
      status: "voided",
      voidReason: "Dose was recorded for the wrong patient.",
      resolvedBy: USER_ID,
      resolvedAt: new Date("2026-08-08T17:00:00.000Z"),
    };
    const { db, updateSet, insertValues } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [],
        [correctedVaccinationWork],
        [{ id: CORRECTION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).reopenVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        reason: "Review the reconciliation again",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "This vaccination was entered in error and its visit work cannot be reopened.",
    });

    // The correction check happens before an audit event or any clinical,
    // invoice, payment, or work-item update can be attempted.
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires the finalized invoice to be voided before reopening visit work", async () => {
    const { db, updateSet, insertValues } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [{ status: "sent" }],
      ],
    });

    await expect(
      callerWithDb(db).reopenVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        reason: "Linked the wrong invoice line",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Void the finalized visit invoice with a reason before reopening its reconciled work.",
    });
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("returns a waived medication dispense to pending when reopening no-charge work", async () => {
    const noChargeWork = {
      ...unresolvedWork,
      prescriptionId: PRESCRIPTION_ID,
      status: "no_charge",
      noChargeReason: "Manufacturer replacement supplied",
      resolvedBy: USER_ID,
      resolvedAt: new Date("2026-08-08T17:00:00.000Z"),
    };
    const reopened = {
      ...unresolvedWork,
      prescriptionId: PRESCRIPTION_ID,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [],
        [noChargeWork],
        [
          {
            id: DISPENSE_CHARGE_ID,
            status: "waived",
            invoiceId: null,
            invoiceItemId: null,
            resolutionReason: "Manufacturer replacement supplied",
          },
        ],
      ],
      updateResults: [[{ id: DISPENSE_CHARGE_ID }], [reopened]],
    });

    await expect(
      callerWithDb(db).reopenVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        reason: "Charge should be reviewed again",
      }),
    ).resolves.toMatchObject({ status: "unresolved" });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        invoiceId: null,
        invoiceItemId: null,
        resolvedBy: null,
        resolutionReason: null,
      }),
    );
  });

  it("rejects an invoice item outside the visit", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [unresolvedWork],
        [],
      ],
    });

    await expect(
      callerWithDb(db).resolveVisitWork({
        appointmentId: APPOINTMENT_ID,
        workItemId: WORK_ITEM_ID,
        resolution: { status: "charged", invoiceItemId: INVOICE_ITEM_ID },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("keeps practice, visit, source, and invoice targets bound in SQL", () => {
    const router = readFileSync(
      new URL("../routers/encounters.ts", import.meta.url),
      "utf8",
    );
    const recordsRouter = readFileSync(
      new URL("../routers/records.ts", import.meta.url),
      "utf8",
    );
    const integrity = readFileSync(
      new URL("../visit-billing-integrity.ts", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL(
        "../../../../packages/db/drizzle/0045_visit_work_ledger.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(router).toContain("eq(visitWorkItems.practiceId, ctx.practiceId)");
    expect(router).toContain(
      "eq(visitWorkItems.appointmentId, input.appointmentId)",
    );
    expect(router).toContain("eq(invoices.practiceId, ctx.practiceId)");
    expect(router).toContain("eq(invoices.appointmentId, input.appointmentId)");
    expect(integrity).toContain(
      "(practice_id, appointment_id, vaccination_record_id)",
    );
    expect(integrity).toContain(
      "from ${clinicalRecordCorrections} as vaccination_correction",
    );
    expect(integrity).toContain(
      "vaccination_correction.vaccination_record_id = ${vaccinationRecords.id}",
    );
    expect(integrity.match(/on conflict do nothing/g)).toHaveLength(4);
    expect(integrity).toContain(
      "eq(visitCloseouts.practiceId, ctx.practiceId)",
    );
    expect(integrity).toContain(
      "eq(visitCloseouts.appointmentId, input.appointmentId)",
    );
    expect(integrity).toContain(
      "eq(visitCloseouts.invoiceId, input.invoiceId)",
    );
    expect(integrity).toContain(
      'eq(visitCloseouts.chargeDisposition, "accounts_receivable")',
    );
    expect(recordsRouter).toContain(
      "(practice_id, appointment_id, vaccination_record_id)",
    );
    expect(router).not.toContain("(${visitWorkItems.practiceId}");
    expect(integrity).not.toContain("(${visitWorkItems.practiceId}");
    expect(recordsRouter).not.toContain("(${visitWorkItems.practiceId}");
    expect(migration).toContain("visit_work_items_vaccination_source_fk");
    expect(migration).toContain("visit_work_items_lab_result_source_fk");
    expect(migration).toContain("visit_work_items_procedure_source_fk");
    expect(migration).toContain("visit_work_items_prescription_source_fk");
    expect(migration).toContain("visit_work_items_invoice_visit_fk");
    expect(migration).toContain("visit_work_items_invoice_item_fk");
    expect(migration).toContain("visit_work_items_exactly_one_source_check");
    expect(migration).not.toContain(OTHER_PRACTICE_ID);
    expect(migration).not.toContain(OTHER_APPOINTMENT_ID);
  });
});
