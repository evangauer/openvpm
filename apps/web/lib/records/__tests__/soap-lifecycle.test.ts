import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@openpims/db/client";
import {
  addFinalizedSoapAddendum,
  createFinalizedAppointmentSoapNote,
  discardAppointmentSoapDraft,
  finalizeAppointmentSoapDraft,
  replaceFinalizedSoapNote,
  saveAppointmentSoapDraft,
} from "../soap-lifecycle";

const PRACTICE_ID = "00000000-0000-4000-8000-000000000001";
const PATIENT_ID = "00000000-0000-4000-8000-000000000002";
const APPOINTMENT_ID = "00000000-0000-4000-8000-000000000003";
const NOTE_ID = "00000000-0000-4000-8000-000000000004";
const USER_ID = "00000000-0000-4000-8000-000000000005";
const OPERATION_ID = "00000000-0000-4000-8000-000000000006";
const actor = { id: USER_ID, name: "Dr. Rivera" };
const openVisit = {
  id: APPOINTMENT_ID,
  doctorId: USER_ID,
  status: "in_exam",
};

function note(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_ID,
    createdAt: new Date("2026-08-09T16:00:00.000Z"),
    updatedAt: new Date("2026-08-09T16:05:00.000Z"),
    deletedAt: null,
    practiceId: PRACTICE_ID,
    patientId: PATIENT_ID,
    appointmentId: APPOINTMENT_ID,
    authorId: USER_ID,
    authorName: "Dr. Rivera",
    status: "draft",
    revision: 1,
    finalizedAt: null,
    finalizedBy: null,
    finalizerName: null,
    subjective: "Eating less",
    objective: null,
    assessment: null,
    plan: null,
    imported: false,
    importFingerprint: null,
    ...overrides,
  };
}

function lifecycleDb(opts: {
  selectResults: unknown[][];
  insertResults?: unknown[][];
  updateResults?: unknown[][];
  deleteResults?: unknown[][];
}) {
  const selectResults = [...opts.selectResults];
  const select = vi.fn(() => {
    const rows = selectResults.shift() ?? [];
    const builder: Record<string, any> = {};
    builder.from = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.for = vi.fn(async () => rows);
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return builder;
  });

  const insertResults = [...(opts.insertResults ?? [])];
  const insertValues = vi.fn((values: unknown) => ({
    onConflictDoNothing: vi.fn(() => ({
      returning: vi.fn(async () => insertResults.shift() ?? []),
    })),
    returning: vi.fn(async () => insertResults.shift() ?? []),
    values,
  }));
  const updateResults = [...(opts.updateResults ?? [])];
  const updateSet = vi.fn((values: unknown) => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => updateResults.shift() ?? []),
    })),
    values,
  }));
  const deleteResults = [...(opts.deleteResults ?? [])];
  const deleteWhere = vi.fn(() => ({
    returning: vi.fn(async () => deleteResults.shift() ?? []),
  }));
  const db = {
    select,
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
    execute: vi.fn(async () => undefined),
  };
  return {
    db: db as unknown as Database,
    insertValues,
    updateSet,
    deleteWhere,
  };
}

function visitPrefix() {
  return [[openVisit], []] as unknown[][];
}

describe("SOAP lifecycle service", () => {
  it("atomically finalizes a replacement after checkout and records immutable lineage", async () => {
    const source = note({
      status: "finalized",
      finalizedAt: new Date("2026-08-09T16:10:00.000Z"),
      finalizedBy: USER_ID,
      finalizerName: actor.name,
    });
    const correction = {
      id: "00000000-0000-4000-8000-000000000007",
      reason: "Assessment was signed on the wrong encounter.",
    };
    const replacement = note({
      id: "00000000-0000-4000-8000-000000000008",
      status: "finalized",
      subjective: "Corrected history",
      finalizedAt: new Date("2026-08-09T17:00:00.000Z"),
      finalizedBy: USER_ID,
      finalizerName: actor.name,
    });
    const { db, insertValues } = lifecycleDb({
      selectResults: [
        [],
        [{ appointmentId: APPOINTMENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [source],
        [],
        [],
        [],
        [],
      ],
      insertResults: [[correction], [replacement]],
    });

    await expect(
      replaceFinalizedSoapNote(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        sourceNoteId: NOTE_ID,
        operationId: OPERATION_ID,
        reason: correction.reason,
        actor,
        sections: { subjective: " Corrected history " },
      }),
    ).resolves.toEqual({ note: replacement, replayed: false });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: "soap_note",
        soapNoteId: NOTE_ID,
        reason: correction.reason,
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSoapNoteId: NOTE_ID,
        replacementSoapNoteId: replacement.id,
        correctionId: correction.id,
        operationId: OPERATION_ID,
      }),
    );
    const finalizedReplacementValues = insertValues.mock.calls
      .map(([values]) => values as Record<string, unknown>)
      .find((values) => values.status === "finalized");
    expect(finalizedReplacementValues?.finalizedAt).not.toBeInstanceOf(Date);
  });

  it("requires the existing permanent reason when recovering an already-corrected SOAP", async () => {
    const source = note({
      status: "finalized",
      finalizedAt: new Date(),
      finalizedBy: USER_ID,
      finalizerName: actor.name,
    });
    const { db, insertValues } = lifecycleDb({
      selectResults: [
        [],
        [{ appointmentId: APPOINTMENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [source],
        [],
        [],
        [],
        [
          {
            id: "00000000-0000-4000-8000-000000000007",
            reason: "Permanent reason",
          },
        ],
      ],
    });
    await expect(
      replaceFinalizedSoapNote(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        sourceNoteId: NOTE_ID,
        operationId: OPERATION_ID,
        reason: "Different reason",
        actor,
        sections: { plan: "Corrected plan" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("replays the exact SOAP replacement operation without creating another note", async () => {
    const replacement = note({
      id: "00000000-0000-4000-8000-000000000008",
      status: "finalized",
      subjective: "Corrected history",
      finalizedAt: new Date(),
      finalizedBy: USER_ID,
      finalizerName: actor.name,
    });
    const reason = "Assessment was signed on the wrong encounter.";
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          patientId: PATIENT_ID,
          sourceNoteId: NOTE_ID,
          actorId: USER_ID,
          reason,
          subjective: "Corrected history",
          objective: null,
          assessment: null,
          plan: null,
        }),
      )
      .digest("hex");
    const { db, insertValues } = lifecycleDb({
      selectResults: [
        [
          {
            sourceNoteId: NOTE_ID,
            replacementNote: replacement,
            operationPayloadHash: payloadHash,
            correctionReason: reason,
            correctionSoapNoteId: NOTE_ID,
          },
        ],
      ],
    });
    await expect(
      replaceFinalizedSoapNote(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        sourceNoteId: NOTE_ID,
        operationId: OPERATION_ID,
        reason,
        actor,
        sections: { subjective: "Corrected history" },
      }),
    ).resolves.toEqual({ note: replacement, replayed: true });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates one persisted draft with server attribution and explicit null sections", async () => {
    const created = note();
    const { db, insertValues } = lifecycleDb({
      selectResults: [...visitPrefix(), [], []],
      insertResults: [[created]],
    });

    await expect(
      saveAppointmentSoapDraft(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 0,
        actor,
        sections: { subjective: " Eating less ", objective: "<p><br></p>" },
      }),
    ).resolves.toEqual({ outcome: "saved", draft: created });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: USER_ID,
        authorName: "Dr. Rivera",
        status: "draft",
        revision: 1,
        subjective: "Eating less",
        objective: null,
      }),
    );
  });

  it("treats an exact save retry as success without rewriting the draft", async () => {
    const existing = note({ revision: 2 });
    const { db, updateSet } = lifecycleDb({
      selectResults: [...visitPrefix(), [existing]],
    });
    await expect(
      saveAppointmentSoapDraft(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 1,
        actor,
        sections: { subjective: "Eating less" },
      }),
    ).resolves.toEqual({ outcome: "saved", draft: existing });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("updates existing draft content through CAS and advances its revision", async () => {
    const existing = note({ revision: 2, subjective: "Eating less" });
    const saved = note({
      revision: 3,
      subjective: "Eating normally",
      assessment: "Appetite improved",
    });
    const { db, updateSet } = lifecycleDb({
      selectResults: [...visitPrefix(), [existing]],
      updateResults: [[saved]],
    });

    await expect(
      saveAppointmentSoapDraft(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 2,
        actor,
        sections: {
          subjective: " Eating normally ",
          assessment: "Appetite improved",
        },
      }),
    ).resolves.toEqual({ outcome: "saved", draft: saved });
    expect(updateSet).toHaveBeenCalledWith({
      subjective: "Eating normally",
      objective: null,
      assessment: "Appetite improved",
      plan: null,
      revision: 3,
    });
  });

  it("returns the current draft on a stale CAS save", async () => {
    const current = note({ revision: 3, subjective: "Server version" });
    const { db } = lifecycleDb({
      selectResults: [...visitPrefix(), [current]],
    });
    await expect(
      saveAppointmentSoapDraft(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 1,
        actor,
        sections: { subjective: "Local version" },
      }),
    ).resolves.toEqual({ outcome: "conflict", draft: current });
  });

  it("is idempotent only for the exact finalized revision", async () => {
    const finalized = note({
      status: "finalized",
      revision: 2,
      finalizedAt: new Date(),
      finalizedBy: USER_ID,
      finalizerName: "Dr. Rivera",
    });
    const exact = lifecycleDb({
      selectResults: [...visitPrefix(), [finalized]],
    });
    await expect(
      finalizeAppointmentSoapDraft(exact.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 2,
        actor,
      }),
    ).resolves.toEqual({
      outcome: "finalized",
      note: finalized,
      transitioned: false,
    });

    const stale = lifecycleDb({
      selectResults: [...visitPrefix(), [finalized]],
    });
    await expect(
      finalizeAppointmentSoapDraft(stale.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 1,
        actor,
      }),
    ).resolves.toEqual({ outcome: "conflict", note: finalized });
  });

  it("recovers exact finalize retries after the visit closes", async () => {
    const finalized = note({
      status: "finalized",
      revision: 2,
      finalizedAt: new Date(),
      finalizedBy: USER_ID,
      finalizerName: "Dr. Rivera",
    });
    const closedVisit = { ...openVisit, status: "checked_out" };
    const exact = lifecycleDb({ selectResults: [[closedVisit], [finalized]] });

    await expect(
      finalizeAppointmentSoapDraft(exact.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 2,
        actor,
      }),
    ).resolves.toEqual({
      outcome: "finalized",
      note: finalized,
      transitioned: false,
    });

    const stale = lifecycleDb({ selectResults: [[closedVisit], [finalized]] });
    await expect(
      finalizeAppointmentSoapDraft(stale.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 1,
        actor,
      }),
    ).resolves.toEqual({ outcome: "conflict", note: finalized });
  });

  it("does not misreport an entered-in-error finalized note as a successful stale retry", async () => {
    const closedVisit = { ...openVisit, status: "checked_out" };
    const corrected = lifecycleDb({ selectResults: [[closedVisit], []] });
    await expect(
      finalizeAppointmentSoapDraft(corrected.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 1,
        actor,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("reports remote finalization to save and discard after visit close", async () => {
    const finalized = note({
      status: "finalized",
      revision: 2,
      finalizedAt: new Date(),
      finalizedBy: USER_ID,
      finalizerName: "Dr. Rivera",
    });
    const closedVisit = { ...openVisit, status: "checked_out" };
    const save = lifecycleDb({ selectResults: [[closedVisit], [finalized]] });
    await expect(
      saveAppointmentSoapDraft(save.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 1,
        actor,
        sections: { subjective: "Local version" },
      }),
    ).resolves.toEqual({ outcome: "already_finalized", note: finalized });

    const discard = lifecycleDb({
      selectResults: [[closedVisit], [finalized]],
    });
    await expect(
      discardAppointmentSoapDraft(discard.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ outcome: "already_finalized", note: finalized });
  });

  it("preserves a first unsaved edit when another session finalizes", async () => {
    const finalized = note({
      status: "finalized",
      revision: 1,
      finalizedAt: new Date(),
      finalizedBy: USER_ID,
      finalizerName: "Dr. Rivera",
    });
    const closedVisit = { ...openVisit, status: "checked_out" };
    const closed = lifecycleDb({
      selectResults: [[closedVisit], [finalized]],
    });
    await expect(
      saveAppointmentSoapDraft(closed.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 0,
        actor,
        sections: { subjective: "First local edit" },
      }),
    ).resolves.toEqual({ outcome: "already_finalized", note: finalized });

    const stillOpen = lifecycleDb({
      selectResults: [...visitPrefix(), [], [finalized]],
    });
    await expect(
      saveAppointmentSoapDraft(stillOpen.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 0,
        actor,
        sections: { subjective: "First local edit" },
      }),
    ).resolves.toEqual({ outcome: "already_finalized", note: finalized });
  });

  it("finalizes the matching draft with signer attribution", async () => {
    const draft = note({ revision: 4 });
    const finalized = note({
      status: "finalized",
      revision: 4,
      finalizedAt: new Date("2026-08-09T16:10:00.000Z"),
      finalizedBy: USER_ID,
      finalizerName: "Dr. Rivera",
    });
    const { db, updateSet } = lifecycleDb({
      selectResults: [...visitPrefix(), [draft]],
      updateResults: [[finalized]],
    });

    await expect(
      finalizeAppointmentSoapDraft(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 4,
        actor,
      }),
    ).resolves.toEqual({
      outcome: "finalized",
      note: finalized,
      transitioned: true,
    });
    expect(updateSet).toHaveBeenCalledWith({
      status: "finalized",
      finalizedAt: expect.any(Date),
      finalizedBy: USER_ID,
      finalizerName: "Dr. Rivera",
    });
  });

  it("enforces discard CAS and deletes only the matching open-visit draft", async () => {
    const current = note({ revision: 2 });
    const stale = lifecycleDb({
      selectResults: [...visitPrefix(), [current]],
    });
    await expect(
      discardAppointmentSoapDraft(stale.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ outcome: "conflict", draft: current });
    expect(stale.deleteWhere).not.toHaveBeenCalled();

    const exact = lifecycleDb({
      selectResults: [...visitPrefix(), [current]],
      deleteResults: [[{ id: NOTE_ID }]],
    });
    await expect(
      discardAppointmentSoapDraft(exact.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        noteId: NOTE_ID,
        expectedRevision: 2,
      }),
    ).resolves.toEqual({ outcome: "discarded", noteId: NOTE_ID });
  });

  it("makes addendum retries idempotent and rejects operation reuse", async () => {
    const content = "Owner clarified the dose was given at 8 AM.";
    const payloadHash = createHash("sha256")
      .update(JSON.stringify({ noteId: NOTE_ID, authorId: USER_ID, content }))
      .digest("hex");
    const existing = {
      id: "addendum-1",
      practiceId: PRACTICE_ID,
      soapNoteId: NOTE_ID,
      operationId: OPERATION_ID,
      operationPayloadHash: payloadHash,
    };
    const exact = lifecycleDb({ selectResults: [[existing]] });
    await expect(
      addFinalizedSoapAddendum(exact.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        noteId: NOTE_ID,
        operationId: OPERATION_ID,
        content,
        actor,
      }),
    ).resolves.toBe(existing);

    const reused = lifecycleDb({
      selectResults: [[{ ...existing, operationPayloadHash: "f".repeat(64) }]],
    });
    await expect(
      addFinalizedSoapAddendum(reused.db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        noteId: NOTE_ID,
        operationId: OPERATION_ID,
        content,
        actor,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("creates an addendum with actor, content, operation, and payload binding", async () => {
    const content = "Owner clarified the dose was given at 8 AM.";
    const payloadHash = createHash("sha256")
      .update(JSON.stringify({ noteId: NOTE_ID, authorId: USER_ID, content }))
      .digest("hex");
    const created = {
      id: "addendum-1",
      practiceId: PRACTICE_ID,
      soapNoteId: NOTE_ID,
      authorId: USER_ID,
      authorName: "Dr. Rivera",
      content,
      operationId: OPERATION_ID,
      operationPayloadHash: payloadHash,
    };
    const { db, insertValues } = lifecycleDb({
      selectResults: [[], [{ id: NOTE_ID }]],
      insertResults: [[created]],
    });

    await expect(
      addFinalizedSoapAddendum(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        noteId: NOTE_ID,
        operationId: OPERATION_ID,
        content: `  ${content}  `,
        actor,
      }),
    ).resolves.toEqual(created);
    expect(insertValues).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      soapNoteId: NOTE_ID,
      authorId: USER_ID,
      authorName: "Dr. Rivera",
      content,
      operationId: OPERATION_ID,
      operationPayloadHash: payloadHash,
    });
  });

  it("rejects addenda when the finalized source is missing or entered in error", async () => {
    const { db } = lifecycleDb({ selectResults: [[], []] });
    await expect(
      addFinalizedSoapAddendum(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        noteId: NOTE_ID,
        operationId: OPERATION_ID,
        content: "Clarification",
        actor,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects a second effective finalized note for the encounter", async () => {
    const { db, insertValues } = lifecycleDb({
      selectResults: [...visitPrefix(), [], [{ id: "existing-final" }]],
    });
    await expect(
      createFinalizedAppointmentSoapNote(db, {
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        actor,
        sections: { subjective: "Reviewed" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertValues).not.toHaveBeenCalled();
  });
});
