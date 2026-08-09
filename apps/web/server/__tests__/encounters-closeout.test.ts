import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { encountersRouter } = await import("../routers/encounters");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000002";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const CLIENT_ID = "00000000-0000-0000-0000-000000000004";
const CLOSEOUT_ID = "00000000-0000-0000-0000-000000000005";
const INVOICE_ID = "00000000-0000-0000-0000-000000000006";
const ASSIGNEE_ID = "00000000-0000-0000-0000-000000000007";
const WORK_ITEM_ID = "00000000-0000-0000-0000-000000000008";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  return encountersRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: `${role}@example.com`,
        name: "Clinic User",
        role,
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function createDb(opts: {
  selectResults?: unknown[][];
  updateResults?: unknown[][];
  insertResults?: unknown[][];
  executeResults?: unknown[];
}) {
  const selectResults = [...(opts.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder: Record<string, any> = {};
    builder.from = vi.fn(() => builder);
    builder.leftJoin = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.offset = vi.fn(() => builder);
    builder.for = vi.fn(async () => result);
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });

  const updateResults = [...(opts.updateResults ?? [])];
  const updateSet = vi.fn((values: unknown) => {
    const returning = vi.fn(async () => updateResults.shift() ?? []);
    return {
      where: vi.fn(() => ({ returning })),
      values,
    };
  });
  const update = vi.fn(() => ({ set: updateSet }));

  const insertResults = [...(opts.insertResults ?? [])];
  const insertValues = vi.fn((values: unknown) => ({
    returning: vi.fn(async () => insertResults.shift() ?? []),
    values,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const executeResults = [...(opts.executeResults ?? [])];
  const execute = vi.fn(async () => executeResults.shift());
  const db: Record<string, unknown> = {
    select,
    update,
    insert,
    execute,
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db, select, updateSet, insertValues, execute };
}

const openAppointment = {
  id: APPOINTMENT_ID,
  status: "in_exam",
  startTime: new Date("2026-08-08T16:00:00.000Z"),
  patientId: PATIENT_ID,
  clientId: CLIENT_ID,
  requiresDoctor: 1,
};

const clinicalFinalized = {
  id: CLOSEOUT_ID,
  practiceId: PRACTICE_ID,
  appointmentId: APPOINTMENT_ID,
  status: "clinical_finalized",
  revision: 2,
  diagnosisSummary: null,
  dischargeInstructions: "Give with food.",
  warningSigns: null,
  noInstructionsReason: null,
  prescriptionDisposition: "not_needed",
  followUpDisposition: "none",
  followUpNotes: null,
  followUpAppointmentId: null,
  followUpScheduledAt: null,
  followUpDueDate: null,
  followUpAssignedTo: null,
  followUpAssigneeName: null,
  followUpResolution: null,
  followUpResolutionAppointmentId: null,
  followUpResolutionScheduledAt: null,
  followUpResolutionNotes: null,
  followUpResolvedAt: null,
  followUpResolvedBy: null,
  followUpResolverName: null,
  medicationSnapshot: [],
  amendmentHistory: [],
  amendmentDraft: null,
  documentationExceptionReason: "Brief technician recheck",
  clinicalFinalizedAt: new Date("2026-08-08T17:00:00.000Z"),
  clinicalFinalizedBy: USER_ID,
  clinicalFinalizerName: "Clinic User",
  chargeDisposition: null,
  invoiceId: null,
  noChargeReason: null,
  handoffMethod: null,
};

const clinicalInput = {
  appointmentId: APPOINTMENT_ID,
  expectedRevision: 0,
  diagnosisSummary: null,
  dischargeInstructions: "Continue normal activity.",
  warningSigns: null,
  noInstructionsReason: null,
  prescriptionDisposition: "not_needed" as const,
  followUpDisposition: "none" as const,
  followUpNotes: null,
  followUpAppointmentId: null,
  documentationExceptionReason: "Brief technician recheck",
};

const activeAmendmentDraft = {
  baseRevision: 2,
  reason: "Correct the dosage wording",
  reopenedAt: "2026-08-08T18:00:00.000Z",
  reopenedBy: USER_ID,
  reopenedByName: "Clinic User",
  diagnosisSummary: null,
  dischargeInstructions: "Give with food.",
  warningSigns: null,
  noInstructionsReason: null,
  prescriptionDisposition: "not_needed" as const,
  followUpDisposition: "none" as const,
  followUpNotes: null,
  followUpAppointmentId: null,
  followUpDueDate: null,
  followUpAssignedTo: null,
  documentationExceptionReason: "Brief technician recheck",
};

afterEach(() => vi.clearAllMocks());

describe("encounter closeout database locking", () => {
  it("locks only the appointment row when its optional type is left joined", () => {
    const source = readFileSync(
      new URL("../routers/encounters.ts", import.meta.url),
      "utf8"
    );

    expect(source).toContain('.for("update", { of: appointments })');
  });
});

describe("encounter prescription lifecycle semantics", () => {
  it("retains all visit prescriptions for history but snapshots only effective-active take-home medication", () => {
    const routerSource = readFileSync(
      new URL("../routers/encounters.ts", import.meta.url),
      "utf8",
    );
    const finalizeMedicationQuery = routerSource.match(
      /const medicationSnapshot = await tx[\s\S]+?\.orderBy\(prescriptions\.createdAt\);/,
    )?.[0];
    expect(finalizeMedicationQuery).toContain(
      'eq(prescriptions.status, "active")',
    );
    expect(finalizeMedicationQuery).toContain("prescriptions.endDate");
    expect(finalizeMedicationQuery).toContain("appointment.practiceTimezone");
    expect(routerSource).toContain("medications: medicationHistory");
    expect(routerSource).toContain(
      'medication.effectiveStatus === "active"',
    );

    const pageSource = readFileSync(
      new URL(
        "../../app/(dashboard)/encounters/[appointmentId]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(pageSource).toContain(
      "linkedPrescriptions={closeoutQuery.data?.medications ?? []}",
    );
    expect(pageSource).toContain(
      "linkedMedicationCount={data.activeMedications.length}",
    );
  });
});

describe("encounter closeout safety", () => {
  it("blocks checkout when performed visit work is unresolved", async () => {
    const { db, updateSet, execute } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [clinicalFinalized],
      ],
      executeResults: [[], [], [], [], [], [], { rows: [{ id: WORK_ITEM_ID }] }],
    });

    const result = callerWithDb(db).completeVisit({
      appointmentId: APPOINTMENT_ID,
      expectedRevision: 2,
      chargeDisposition: "no_charge",
      noChargeReason: "Complimentary postoperative recheck",
      handoffMethod: "verbal",
    });
    const error = await result.catch((caught) => caught);
    expect(execute).toHaveBeenCalledTimes(7);
    expect(await execute.mock.results[6]?.value).toEqual({
      rows: [{ id: WORK_ITEM_ID }],
    });
    expect(error).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Resolve every performed vaccination"),
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("atomically completes an explicit no-charge visit", async () => {
    const completed = {
      ...clinicalFinalized,
      status: "completed",
      revision: 3,
      chargeDisposition: "no_charge",
      noChargeReason: "Complimentary postoperative recheck",
      handoffMethod: "verbal",
    };
    const checkedOut = { ...openAppointment, status: "checked_out" };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [clinicalFinalized],
        [],
      ],
      updateResults: [[completed], [checkedOut]],
    });

    await expect(
      callerWithDb(db).completeVisit({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 2,
        chargeDisposition: "no_charge",
        noChargeReason: "Complimentary postoperative recheck",
        handoffMethod: "verbal",
      })
    ).resolves.toEqual({ closeout: completed, appointment: checkedOut });

    expect(updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "completed",
        chargeDisposition: "no_charge",
        revision: 3,
      })
    );
    expect(updateSet).toHaveBeenNthCalledWith(2, { status: "checked_out" });
  });

  it("returns the stored result for an exact completion retry", async () => {
    const completed = {
      ...clinicalFinalized,
      status: "completed",
      revision: 3,
      chargeDisposition: "no_charge",
      noChargeReason: "Complimentary recheck",
      handoffMethod: "print",
    };
    const checkedOut = { ...openAppointment, status: "checked_out" };
    const { db, updateSet } = createDb({
      selectResults: [[checkedOut], [{ id: PATIENT_ID }], [completed]],
    });

    await expect(
      callerWithDb(db).completeVisit({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 2,
        chargeDisposition: "no_charge",
        noChargeReason: "Complimentary recheck",
        handoffMethod: "print",
      })
    ).resolves.toEqual({ closeout: completed, appointment: checkedOut });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not complete without a finalized clinical handoff", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[openAppointment], [{ id: PATIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).completeVisit({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 1,
        chargeDisposition: "no_charge",
        noChargeReason: "Complimentary recheck",
        handoffMethod: "verbal",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Finalize the clinical handoff before completing the visit.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not complete while an attributed clinical amendment is in progress", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [
          {
            ...clinicalFinalized,
            revision: 3,
            amendmentDraft: activeAmendmentDraft,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).completeVisit({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 3,
        chargeDisposition: "no_charge",
        noChargeReason: "Complimentary recheck",
        handoffMethod: "verbal",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Finish the attributed clinical amendment before completing the visit.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects paid checkout when the active invoice is still a draft", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [clinicalFinalized],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            total: "100.00",
            paidAmount: "0.00",
            dueDate: null,
          },
        ],
        [{ itemCount: 1 }],
        [{ adjustedAmount: "0" }],
      ],
    });

    await expect(
      callerWithDb(db).completeVisit({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 2,
        chargeDisposition: "paid",
        noChargeReason: null,
        handoffMethod: "print",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "The visit invoice is not fully paid.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "paid",
      chargeDisposition: "paid" as const,
      invoice: {
        id: INVOICE_ID,
        status: "paid",
        total: "100.00",
        paidAmount: "100.00",
        dueDate: null,
      },
    },
    {
      label: "accounts receivable",
      chargeDisposition: "accounts_receivable" as const,
      invoice: {
        id: INVOICE_ID,
        status: "sent",
        total: "100.00",
        paidAmount: "0.00",
        dueDate: "2026-09-01",
      },
    },
  ])("completes a verified $label visit", async ({ chargeDisposition, invoice }) => {
    const completed = {
      ...clinicalFinalized,
      status: "completed",
      revision: 3,
      chargeDisposition,
      invoiceId: INVOICE_ID,
      handoffMethod: "print",
    };
    const checkedOut = { ...openAppointment, status: "checked_out" };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [clinicalFinalized],
        [invoice],
        [{ itemCount: 1 }],
        [{ adjustedAmount: "0" }],
      ],
      updateResults: [[completed], [checkedOut]],
    });

    await expect(
      callerWithDb(db).completeVisit({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 2,
        chargeDisposition,
        noChargeReason: null,
        handoffMethod: "print",
      })
    ).resolves.toEqual({ closeout: completed, appointment: checkedOut });
    expect(updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "completed",
        chargeDisposition,
        invoiceId: INVOICE_ID,
      })
    );
  });

  it("requires a linked SOAP note or an attributable exception", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[openAppointment], [{ id: PATIENT_ID }], [], []],
    });

    await expect(
      callerWithDb(db, "veterinarian").finalizeClinical({
        ...clinicalInput,
        documentationExceptionReason: null,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Link a SOAP note or document why one is not required.",
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("finalizes a validated clinical handoff and increments its revision", async () => {
    const finalized = {
      ...clinicalFinalized,
      dischargeInstructions: "Continue normal activity.",
      revision: 1,
    };
    const { db, insertValues } = createDb({
      selectResults: [[openAppointment], [{ id: PATIENT_ID }], [], []],
      insertResults: [[finalized]],
    });

    await expect(
      callerWithDb(db, "veterinarian").finalizeClinical(clinicalInput)
    ).resolves.toEqual(finalized);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: APPOINTMENT_ID,
        status: "clinical_finalized",
        clinicalFinalizedBy: USER_ID,
        clinicalFinalizerName: "Clinic User",
        medicationSnapshot: [],
        revision: 1,
      })
    );
  });

  it("freezes active visit medications into the finalized handoff", async () => {
    const medication = {
      prescriptionId: "00000000-0000-0000-0000-000000000077",
      medicationName: "Carprofen",
      dosage: "75 mg",
      frequency: "Every 12 hours",
      instructions: "Give with food",
      quantity: 10,
    };
    const finalized = {
      ...clinicalFinalized,
      prescriptionDisposition: "prescribed",
      medicationSnapshot: [medication],
      revision: 1,
    };
    const { db, insertValues } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [],
        [{ id: "soap" }],
        [medication],
      ],
      insertResults: [[finalized]],
    });

    await expect(
      callerWithDb(db, "veterinarian").finalizeClinical({
        ...clinicalInput,
        prescriptionDisposition: "prescribed",
      })
    ).resolves.toEqual(finalized);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ medicationSnapshot: [medication] })
    );
  });

  it("rejects no-prescription disposition when active visit prescriptions exist", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [],
        [{ id: "soap" }],
        [
          {
            prescriptionId: "00000000-0000-0000-0000-000000000077",
            medicationName: "Carprofen",
            dosage: "75 mg",
            frequency: "Every 12 hours",
            instructions: null,
            quantity: 10,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db, "veterinarian").finalizeClinical(clinicalInput)
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "This visit has linked prescriptions. Confirm that prescriptions were provided.",
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires the exam to be started before clinical closeout", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ ...openAppointment, status: "checked_in" }],
        [{ id: PATIENT_ID }],
      ],
    });
    await expect(
      callerWithDb(db, "veterinarian").finalizeClinical(clinicalInput)
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Start the exam before preparing the clinical closeout.",
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("keeps front desk users from authoring clinical content", async () => {
    const { db, select } = createDb({});
    await expect(
      callerWithDb(db, "front_desk").finalizeClinical(clinicalInput)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(select).not.toHaveBeenCalled();
  });

  it("opens an amendment without replacing the operative signed handoff", async () => {
    const reopened = {
      ...clinicalFinalized,
      revision: 3,
      amendmentDraft: expect.any(Object),
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [clinicalFinalized],
      ],
      updateResults: [[reopened]],
    });

    await expect(
      callerWithDb(db).reopenClinical({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 2,
        reason: "Correct the dosage wording",
      })
    ).resolves.toEqual(reopened);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 3,
        amendmentDraft: expect.objectContaining({
            baseRevision: 2,
            reason: "Correct the dosage wording",
            reopenedBy: USER_ID,
            dischargeInstructions: "Give with food.",
          }),
      })
    );
    const values = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(values).not.toHaveProperty("status");
    expect(values).not.toHaveProperty("clinicalFinalizedAt");
    expect(values).not.toHaveProperty("medicationSnapshot");
    expect(values).not.toHaveProperty("amendmentHistory");
  });

  it("saves amendment edits inside the draft without mutating signed fields", async () => {
    const signedWithDraft = {
      ...clinicalFinalized,
      revision: 3,
      amendmentDraft: activeAmendmentDraft,
    };
    const saved = {
      ...signedWithDraft,
      revision: 4,
      amendmentDraft: {
        ...activeAmendmentDraft,
        dischargeInstructions: "Give one tablet with food.",
      },
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [signedWithDraft],
      ],
      updateResults: [[saved]],
    });

    await expect(
      callerWithDb(db, "technician").saveDraft({
        ...clinicalInput,
        expectedRevision: 3,
        dischargeInstructions: "Give one tablet with food.",
      })
    ).resolves.toEqual(saved);

    expect(updateSet).toHaveBeenCalledWith({
      amendmentDraft: expect.objectContaining({
        baseRevision: 2,
        reason: "Correct the dosage wording",
        dischargeInstructions: "Give one tablet with food.",
      }),
      revision: 4,
    });
    const values = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(values).not.toHaveProperty("dischargeInstructions");
    expect(values).not.toHaveProperty("clinicalFinalizedBy");
  });

  it("opens and atomically promotes an amendment after completed checkout", async () => {
    const checkedOut = { ...openAppointment, status: "checked_out" };
    const completed = {
      ...clinicalFinalized,
      status: "completed",
      revision: 3,
      chargeDisposition: "no_charge",
      noChargeReason: "Complimentary recheck",
      handoffMethod: "print",
      completedAt: new Date("2026-08-08T18:30:00.000Z"),
      completedBy: USER_ID,
    };
    const completedWithDraft = {
      ...completed,
      revision: 4,
      amendmentDraft: {
        ...activeAmendmentDraft,
        baseRevision: 3,
      },
    };
    const openDb = createDb({
      selectResults: [[checkedOut], [{ id: PATIENT_ID }], [completed]],
      updateResults: [[completedWithDraft]],
    });

    await expect(
      callerWithDb(openDb.db).reopenClinical({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 3,
        reason: "Correct the dosage wording",
      })
    ).resolves.toEqual(completedWithDraft);
    const openValues = openDb.updateSet.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(openValues).not.toHaveProperty("status");
    expect(openValues).not.toHaveProperty("chargeDisposition");
    expect(openValues).not.toHaveProperty("completedAt");

    const promoted = {
      ...completedWithDraft,
      revision: 5,
      dischargeInstructions: "Give one tablet with food.",
      amendmentDraft: null,
      amendmentHistory: [expect.any(Object)],
    };
    const promoteDb = createDb({
      selectResults: [
        [checkedOut],
        [{ id: PATIENT_ID }],
        [completedWithDraft],
        [],
        [],
      ],
      updateResults: [[promoted]],
    });

    await expect(
      callerWithDb(promoteDb.db, "veterinarian").finalizeClinical({
        ...clinicalInput,
        expectedRevision: 4,
        dischargeInstructions: "Give one tablet with food.",
      })
    ).resolves.toEqual(promoted);

    expect(promoteDb.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        dischargeInstructions: "Give one tablet with food.",
        amendmentDraft: null,
        amendmentHistory: [
          expect.objectContaining({
            priorRevision: 3,
            reason: "Correct the dosage wording",
            clinicalFinalizerName: "Clinic User",
            dischargeInstructions: "Give with food.",
          }),
        ],
        revision: 5,
      })
    );
    const promoteValues = promoteDb.updateSet.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(promoteValues).not.toHaveProperty("chargeDisposition");
    expect(promoteValues).not.toHaveProperty("invoiceId");
    expect(promoteValues).not.toHaveProperty("completedAt");
  });

  it("preserves operational resolution when an amendment leaves the needed follow-up unchanged", async () => {
    const checkedOut = { ...openAppointment, status: "checked_out" };
    const resolutionAppointmentId =
      "00000000-0000-0000-0000-000000000008";
    const resolvedAt = new Date("2026-08-09T17:00:00.000Z");
    const resolutionScheduledAt = new Date("2099-01-02T17:00:00.000Z");
    const completedWithDraft = {
      ...clinicalFinalized,
      status: "completed",
      revision: 5,
      followUpDisposition: "needed",
      followUpDueDate: "2099-01-01",
      followUpAssignedTo: ASSIGNEE_ID,
      followUpAssigneeName: "Alex Coordinator",
      followUpResolution: "scheduled",
      followUpResolutionAppointmentId: resolutionAppointmentId,
      followUpResolutionScheduledAt: resolutionScheduledAt,
      followUpResolvedAt: resolvedAt,
      followUpResolvedBy: USER_ID,
      followUpResolverName: "Clinic User",
      chargeDisposition: "no_charge",
      noChargeReason: "Complimentary recheck",
      handoffMethod: "print",
      completedAt: new Date("2026-08-08T18:30:00.000Z"),
      completedBy: USER_ID,
      amendmentDraft: {
        ...activeAmendmentDraft,
        baseRevision: 3,
        followUpDisposition: "needed",
        followUpDueDate: "2099-01-01",
        followUpAssignedTo: ASSIGNEE_ID,
      },
    };
    const finalized = {
      ...completedWithDraft,
      revision: 6,
      dischargeInstructions: "Updated activity instructions.",
      amendmentDraft: null,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [checkedOut],
        [{ id: PATIENT_ID }],
        [completedWithDraft],
        [],
        [],
        [{ name: "Alex Coordinator", email: "alex@example.com" }],
      ],
      updateResults: [[finalized]],
    });

    await expect(
      callerWithDb(db, "veterinarian").finalizeClinical({
        ...clinicalInput,
        expectedRevision: 5,
        dischargeInstructions: "Updated activity instructions.",
        followUpDisposition: "needed",
        followUpDueDate: "2099-01-01",
        followUpAssignedTo: ASSIGNEE_ID,
      })
    ).resolves.toEqual(finalized);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        followUpResolution: "scheduled",
        followUpResolutionAppointmentId: resolutionAppointmentId,
        followUpResolutionScheduledAt: resolutionScheduledAt,
        followUpResolvedAt: resolvedAt,
        followUpResolvedBy: USER_ID,
        amendmentHistory: [
          expect.objectContaining({
            followUpDisposition: "needed",
            followUpResolution: "scheduled",
            followUpResolutionAppointmentId: resolutionAppointmentId,
            followUpResolvedBy: USER_ID,
          }),
        ],
      })
    );
  });

  it("finalizes an accountable needed follow-up for the pending queue", async () => {
    const finalized = {
      ...clinicalFinalized,
      revision: 1,
      followUpDisposition: "needed",
      followUpDueDate: "2099-01-01",
      followUpAssignedTo: ASSIGNEE_ID,
      followUpAssigneeName: "Alex Coordinator",
    };
    const { db, insertValues } = createDb({
      selectResults: [
        [openAppointment],
        [{ id: PATIENT_ID }],
        [],
        [],
        [],
        [{ name: "Alex Coordinator", email: "alex@example.com" }],
      ],
      insertResults: [[finalized]],
    });

    await expect(
      callerWithDb(db, "veterinarian").finalizeClinical({
        ...clinicalInput,
        followUpDisposition: "needed",
        followUpDueDate: "2099-01-01",
        followUpAssignedTo: ASSIGNEE_ID,
      })
    ).resolves.toEqual(finalized);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        followUpDisposition: "needed",
        followUpDueDate: "2099-01-01",
        followUpAssignedTo: ASSIGNEE_ID,
        followUpAssigneeName: "Alex Coordinator",
        followUpAppointmentId: null,
        followUpScheduledAt: null,
      })
    );
  });

  it("returns completed visits with unresolved needed follow-ups", async () => {
    const pending = {
      closeoutId: CLOSEOUT_ID,
      appointmentId: APPOINTMENT_ID,
      closeoutStatus: "completed",
      dueDate: "2099-01-01",
      assignedTo: ASSIGNEE_ID,
      assigneeName: "Alex Coordinator",
    };
    const { db } = createDb({ selectResults: [[pending]] });

    await expect(
      callerWithDb(db, "front_desk").listPendingFollowUps()
    ).resolves.toEqual([pending]);
  });

  it("resolves a needed follow-up operationally without rewriting the signed disposition", async () => {
    const checkedOut = { ...openAppointment, status: "checked_out" };
    const pending = {
      ...clinicalFinalized,
      status: "completed",
      revision: 4,
      followUpDisposition: "needed",
      followUpDueDate: "2099-01-01",
      followUpAssignedTo: ASSIGNEE_ID,
      followUpAssigneeName: "Alex Coordinator",
      chargeDisposition: "no_charge",
      noChargeReason: "Complimentary recheck",
      handoffMethod: "print",
      completedAt: new Date("2026-08-08T18:30:00.000Z"),
      completedBy: USER_ID,
    };
    const scheduledAppointment = {
      id: "00000000-0000-0000-0000-000000000008",
      startTime: new Date("2099-01-02T17:00:00.000Z"),
    };
    const resolved = {
      ...pending,
      revision: 5,
      followUpResolution: "scheduled",
      followUpResolutionAppointmentId: scheduledAppointment.id,
      followUpResolutionScheduledAt: scheduledAppointment.startTime,
      followUpResolvedAt: expect.any(Date),
      followUpResolvedBy: USER_ID,
      followUpResolverName: "Clinic User",
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [checkedOut],
        [{ id: PATIENT_ID }],
        [pending],
        [scheduledAppointment],
      ],
      updateResults: [[resolved]],
    });

    await expect(
      callerWithDb(db, "front_desk").resolveNeededFollowUp({
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 4,
        resolution: "scheduled",
        resolutionAppointmentId: scheduledAppointment.id,
        notes: null,
      })
    ).resolves.toEqual(resolved);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        followUpResolution: "scheduled",
        followUpResolutionAppointmentId: scheduledAppointment.id,
        followUpResolutionScheduledAt: scheduledAppointment.startTime,
        followUpResolvedBy: USER_ID,
        followUpResolverName: "Clinic User",
        revision: 5,
      })
    );
    const values = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(values).not.toHaveProperty("followUpDisposition");
    expect(values).not.toHaveProperty("followUpDueDate");
    expect(values).not.toHaveProperty("clinicalFinalizedAt");
  });

  it("keeps technicians from finalizing doctor-required visits", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[openAppointment], [{ id: PATIENT_ID }]],
    });
    await expect(
      callerWithDb(db, "technician").finalizeClinical(clinicalInput)
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "A veterinarian must finalize instructions for a doctor-required visit.",
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("fails closed for a missing or cross-tenant appointment", async () => {
    const { db, updateSet, insertValues } = createDb({ selectResults: [[]] });
    await expect(
      callerWithDb(db).saveDraft(clinicalInput)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
