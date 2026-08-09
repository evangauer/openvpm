import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  appointments,
  clinicalRecordCorrections,
  practices,
  soapNoteAddenda,
  soapNoteReplacements,
  soapNotes,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  hasSoapContent,
  normalizeSoapSection,
} from "@/lib/records/soap-content";
import { hasUnresolvedSoapTemplatePrompts } from "@/lib/records/soap-templates";
import { lockOpenVisitForClinicalAppend } from "@/lib/records/visit-integrity";

export interface SoapSections {
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
  plan?: string | null;
}

export interface SoapActor {
  id: string;
  name: string;
}

export type SoapDraft = typeof soapNotes.$inferSelect;

export class SoapLifecycleError extends Error {
  constructor(
    readonly code:
      | "BAD_REQUEST"
      | "NOT_FOUND"
      | "CONFLICT"
      | "PRECONDITION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SoapLifecycleError";
  }
}

export function normalizeSoapSections(sections: SoapSections) {
  return {
    subjective: normalizeSoapSection(sections.subjective) ?? null,
    objective: normalizeSoapSection(sections.objective) ?? null,
    assessment: normalizeSoapSection(sections.assessment) ?? null,
    plan: normalizeSoapSection(sections.plan) ?? null,
  };
}

function sectionsMatch(left: SoapSections, right: SoapSections): boolean {
  const a = normalizeSoapSections(left);
  const b = normalizeSoapSections(right);
  return (
    a.subjective === b.subjective &&
    a.objective === b.objective &&
    a.assessment === b.assessment &&
    a.plan === b.plan
  );
}

async function assertOpenSoapVisit(
  db: Database,
  input: { practiceId: string; patientId: string; appointmentId: string },
) {
  const visit = await lockOpenVisitForClinicalAppend(db, input);
  if (!visit.ok && visit.reason === "appointment_not_found") {
    throw new SoapLifecycleError("NOT_FOUND", "Appointment not found");
  }
  if (!visit.ok) {
    throw new SoapLifecycleError(
      "PRECONDITION_FAILED",
      "SOAP documentation can only be changed while the visit is in exam.",
    );
  }
  return visit.appointment;
}

async function getScopedFinalizedSoapNote(
  db: Database,
  input: {
    practiceId: string;
    patientId: string;
    appointmentId: string;
    noteId?: string;
  },
) {
  const predicates = [
    eq(soapNotes.practiceId, input.practiceId),
    eq(soapNotes.patientId, input.patientId),
    eq(soapNotes.appointmentId, input.appointmentId),
    eq(soapNotes.status, "finalized"),
    isNull(soapNotes.deletedAt),
    sql`not exists (
      select 1 from ${clinicalRecordCorrections}
      where ${clinicalRecordCorrections.practiceId} = ${input.practiceId}
        and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id}
    )`,
  ];
  if (input.noteId) {
    predicates.push(eq(soapNotes.id, input.noteId));
  }
  const [note] = await db
    .select()
    .from(soapNotes)
    .where(and(...predicates))
    .limit(1);
  return note ?? null;
}

async function assertOpenSoapVisitWithFinalizedRecovery(
  db: Database,
  input: {
    practiceId: string;
    patientId: string;
    appointmentId: string;
    noteId?: string;
  },
) {
  try {
    await assertOpenSoapVisit(db, input);
    return null;
  } catch (error) {
    if (
      error instanceof SoapLifecycleError &&
      error.code === "PRECONDITION_FAILED"
    ) {
      const finalized = await getScopedFinalizedSoapNote(db, input);
      if (finalized) return finalized;
    }
    throw error;
  }
}

export function finalizedSoapInsertValues(input: {
  actor: SoapActor;
  sections: SoapSections;
  finalizedAt?: Date;
  imported?: boolean;
}) {
  const finalizedAt = input.finalizedAt ?? new Date();
  return {
    ...normalizeSoapSections(input.sections),
    authorId: input.actor.id,
    authorName: input.actor.name,
    status: "finalized" as const,
    revision: 1,
    finalizedAt,
    finalizedBy: input.actor.id,
    finalizerName: input.actor.name,
    imported: input.imported ?? false,
  };
}

export async function getAppointmentSoapDraft(
  db: Database,
  input: { practiceId: string; patientId: string; appointmentId: string },
) {
  const [draft] = await db
    .select()
    .from(soapNotes)
    .where(
      and(
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.patientId, input.patientId),
        eq(soapNotes.appointmentId, input.appointmentId),
        eq(soapNotes.status, "draft"),
        isNull(soapNotes.deletedAt),
      ),
    )
    .limit(1);
  return draft ?? null;
}

export type SaveSoapDraftResult =
  | { outcome: "saved"; draft: SoapDraft }
  | { outcome: "conflict"; draft: SoapDraft }
  | { outcome: "already_finalized"; note: SoapDraft };

export async function saveAppointmentSoapDraft(
  db: Database,
  input: {
    practiceId: string;
    patientId: string;
    appointmentId: string;
    noteId?: string;
    expectedRevision: number;
    actor: SoapActor;
    sections: SoapSections;
  },
): Promise<SaveSoapDraftResult> {
  const finalizedAfterClose = await assertOpenSoapVisitWithFinalizedRecovery(
    db,
    input,
  );
  if (finalizedAfterClose) {
    if (!input.noteId || finalizedAfterClose.id === input.noteId) {
      return { outcome: "already_finalized", note: finalizedAfterClose };
    }
    throw new SoapLifecycleError(
      "CONFLICT",
      "This encounter already has finalized SOAP documentation.",
    );
  }
  const sections = normalizeSoapSections(input.sections);
  const [existing] = await db
    .select()
    .from(soapNotes)
    .where(
      and(
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.patientId, input.patientId),
        eq(soapNotes.appointmentId, input.appointmentId),
        eq(soapNotes.status, "draft"),
        isNull(soapNotes.deletedAt),
      ),
    )
    .limit(1)
    .for("update");

  if (!existing) {
    if (input.expectedRevision !== 0 || input.noteId) {
      if (input.noteId) {
        const [finalizedNote] = await db
          .select()
          .from(soapNotes)
          .where(
            and(
              eq(soapNotes.id, input.noteId),
              eq(soapNotes.practiceId, input.practiceId),
              eq(soapNotes.patientId, input.patientId),
              eq(soapNotes.appointmentId, input.appointmentId),
              eq(soapNotes.status, "finalized"),
              isNull(soapNotes.deletedAt),
            ),
          )
          .limit(1);
        if (finalizedNote) {
          return { outcome: "already_finalized", note: finalizedNote };
        }
      }
      throw new SoapLifecycleError("NOT_FOUND", "SOAP draft not found");
    }
    const [finalized] = await db
      .select()
      .from(soapNotes)
      .where(
        and(
          eq(soapNotes.practiceId, input.practiceId),
          eq(soapNotes.patientId, input.patientId),
          eq(soapNotes.appointmentId, input.appointmentId),
          eq(soapNotes.status, "finalized"),
          isNull(soapNotes.deletedAt),
          sql`not exists (
            select 1 from ${clinicalRecordCorrections}
            where ${clinicalRecordCorrections.practiceId} = ${input.practiceId}
              and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id}
          )`,
        ),
      )
      .limit(1);
    if (finalized) {
      return { outcome: "already_finalized", note: finalized };
    }
    const [created] = await db
      .insert(soapNotes)
      .values({
        practiceId: input.practiceId,
        patientId: input.patientId,
        appointmentId: input.appointmentId,
        authorId: input.actor.id,
        authorName: input.actor.name,
        status: "draft",
        revision: 1,
        finalizedAt: null,
        finalizedBy: null,
        finalizerName: null,
        imported: false,
        ...sections,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { outcome: "saved", draft: created };
    const concurrent = await getAppointmentSoapDraft(db, input);
    if (!concurrent) {
      throw new SoapLifecycleError(
        "CONFLICT",
        "SOAP draft changed while saving.",
      );
    }
    return sectionsMatch(concurrent, sections)
      ? { outcome: "saved", draft: concurrent }
      : { outcome: "conflict", draft: concurrent };
  }

  if (input.noteId && existing.id !== input.noteId) {
    return { outcome: "conflict", draft: existing };
  }
  if (
    existing.revision === input.expectedRevision + 1 &&
    sectionsMatch(existing, sections)
  ) {
    return { outcome: "saved", draft: existing };
  }
  if (existing.revision !== input.expectedRevision) {
    return { outcome: "conflict", draft: existing };
  }
  if (sectionsMatch(existing, sections)) {
    return { outcome: "saved", draft: existing };
  }

  const [saved] = await db
    .update(soapNotes)
    .set({ ...sections, revision: existing.revision + 1 })
    .where(
      and(
        eq(soapNotes.id, existing.id),
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.status, "draft"),
        eq(soapNotes.revision, existing.revision),
        isNull(soapNotes.deletedAt),
      ),
    )
    .returning();
  if (!saved) {
    const latest = await getAppointmentSoapDraft(db, input);
    if (!latest) {
      const [finalizedNote] = await db
        .select()
        .from(soapNotes)
        .where(
          and(
            eq(soapNotes.id, existing.id),
            eq(soapNotes.practiceId, input.practiceId),
            eq(soapNotes.status, "finalized"),
            isNull(soapNotes.deletedAt),
          ),
        )
        .limit(1);
      if (finalizedNote) {
        return { outcome: "already_finalized", note: finalizedNote };
      }
      throw new SoapLifecycleError(
        "CONFLICT",
        "SOAP draft changed while saving.",
      );
    }
    return { outcome: "conflict", draft: latest };
  }
  return { outcome: "saved", draft: saved };
}

export type FinalizeSoapResult =
  | { outcome: "finalized"; note: SoapDraft; transitioned: boolean }
  | { outcome: "conflict"; note: SoapDraft };

export async function finalizeAppointmentSoapDraft(
  db: Database,
  input: {
    practiceId: string;
    patientId: string;
    appointmentId: string;
    noteId: string;
    expectedRevision: number;
    actor: SoapActor;
  },
): Promise<FinalizeSoapResult> {
  const finalizedAfterClose = await assertOpenSoapVisitWithFinalizedRecovery(
    db,
    input,
  );
  if (finalizedAfterClose) {
    return finalizedAfterClose.revision === input.expectedRevision
      ? {
          outcome: "finalized",
          note: finalizedAfterClose,
          transitioned: false,
        }
      : { outcome: "conflict", note: finalizedAfterClose };
  }
  const [note] = await db
    .select()
    .from(soapNotes)
    .where(
      and(
        eq(soapNotes.id, input.noteId),
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.patientId, input.patientId),
        eq(soapNotes.appointmentId, input.appointmentId),
        isNull(soapNotes.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!note) {
    throw new SoapLifecycleError("NOT_FOUND", "SOAP draft not found");
  }
  if (note.status === "finalized") {
    return note.revision === input.expectedRevision
      ? { outcome: "finalized", note, transitioned: false }
      : { outcome: "conflict", note };
  }
  if (note.revision !== input.expectedRevision) {
    return { outcome: "conflict", note };
  }
  const storedSections = normalizeSoapSections(note);
  if (!hasSoapContent(storedSections)) {
    throw new SoapLifecycleError(
      "BAD_REQUEST",
      "SOAP note must include at least one section before finalization.",
    );
  }
  if (hasUnresolvedSoapTemplatePrompts(storedSections)) {
    throw new SoapLifecycleError(
      "BAD_REQUEST",
      "Replace or delete every SOAP template prompt before finalization.",
    );
  }

  const [finalized] = await db
    .update(soapNotes)
    .set({
      status: "finalized",
      finalizedAt: new Date(),
      finalizedBy: input.actor.id,
      finalizerName: input.actor.name,
    })
    .where(
      and(
        eq(soapNotes.id, note.id),
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.status, "draft"),
        eq(soapNotes.revision, note.revision),
        isNull(soapNotes.deletedAt),
      ),
    )
    .returning();
  if (!finalized) {
    const [latest] = await db
      .select()
      .from(soapNotes)
      .where(
        and(
          eq(soapNotes.id, note.id),
          eq(soapNotes.practiceId, input.practiceId),
          isNull(soapNotes.deletedAt),
        ),
      )
      .limit(1);
    if (!latest) {
      throw new SoapLifecycleError(
        "CONFLICT",
        "SOAP draft changed while finalizing.",
      );
    }
    if (latest.status === "finalized") {
      return latest.revision === input.expectedRevision
        ? { outcome: "finalized", note: latest, transitioned: false }
        : { outcome: "conflict", note: latest };
    }
    return { outcome: "conflict", note: latest };
  }
  return { outcome: "finalized", note: finalized, transitioned: true };
}

export type DiscardSoapDraftResult =
  | { outcome: "discarded"; noteId: string }
  | { outcome: "conflict"; draft: SoapDraft }
  | { outcome: "already_finalized"; note: SoapDraft };

export async function discardAppointmentSoapDraft(
  db: Database,
  input: {
    practiceId: string;
    patientId: string;
    appointmentId: string;
    noteId: string;
    expectedRevision: number;
  },
): Promise<DiscardSoapDraftResult> {
  const finalizedAfterClose = await assertOpenSoapVisitWithFinalizedRecovery(
    db,
    input,
  );
  if (finalizedAfterClose) {
    return { outcome: "already_finalized", note: finalizedAfterClose };
  }
  const [draft] = await db
    .select()
    .from(soapNotes)
    .where(
      and(
        eq(soapNotes.id, input.noteId),
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.patientId, input.patientId),
        eq(soapNotes.appointmentId, input.appointmentId),
        eq(soapNotes.status, "draft"),
        isNull(soapNotes.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!draft) {
    const [finalizedNote] = await db
      .select()
      .from(soapNotes)
      .where(
        and(
          eq(soapNotes.id, input.noteId),
          eq(soapNotes.practiceId, input.practiceId),
          eq(soapNotes.patientId, input.patientId),
          eq(soapNotes.appointmentId, input.appointmentId),
          eq(soapNotes.status, "finalized"),
          isNull(soapNotes.deletedAt),
        ),
      )
      .limit(1);
    if (finalizedNote) {
      return { outcome: "already_finalized", note: finalizedNote };
    }
    throw new SoapLifecycleError("NOT_FOUND", "SOAP draft not found");
  }
  if (draft.revision !== input.expectedRevision) {
    return { outcome: "conflict", draft };
  }
  const [deleted] = await db
    .delete(soapNotes)
    .where(
      and(
        eq(soapNotes.id, draft.id),
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.status, "draft"),
        eq(soapNotes.revision, draft.revision),
      ),
    )
    .returning({ id: soapNotes.id });
  if (!deleted) {
    const latest = await getAppointmentSoapDraft(db, input);
    if (latest) return { outcome: "conflict", draft: latest };
    const [finalizedNote] = await db
      .select()
      .from(soapNotes)
      .where(
        and(
          eq(soapNotes.id, draft.id),
          eq(soapNotes.practiceId, input.practiceId),
          eq(soapNotes.status, "finalized"),
          isNull(soapNotes.deletedAt),
        ),
      )
      .limit(1);
    if (finalizedNote) {
      return { outcome: "already_finalized", note: finalizedNote };
    }
    throw new SoapLifecycleError(
      "CONFLICT",
      "SOAP draft changed while discarding.",
    );
  }
  return { outcome: "discarded", noteId: deleted.id };
}

export async function createFinalizedAppointmentSoapNote(
  db: Database,
  input: {
    practiceId: string;
    patientId: string;
    appointmentId: string;
    actor: SoapActor;
    sections: SoapSections;
  },
) {
  const sections = normalizeSoapSections(input.sections);
  if (!hasSoapContent(sections)) {
    throw new SoapLifecycleError(
      "BAD_REQUEST",
      "SOAP note must include at least one section.",
    );
  }
  if (hasUnresolvedSoapTemplatePrompts(sections)) {
    throw new SoapLifecycleError(
      "BAD_REQUEST",
      "Replace or delete every SOAP template prompt before finalization.",
    );
  }
  await assertOpenSoapVisit(db, input);
  const draft = await getAppointmentSoapDraft(db, input);
  if (draft) {
    throw new SoapLifecycleError(
      "CONFLICT",
      "A SOAP draft already exists. Resume and finalize it instead.",
    );
  }
  const [existingFinalized] = await db
    .select({ id: soapNotes.id })
    .from(soapNotes)
    .where(
      and(
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.patientId, input.patientId),
        eq(soapNotes.appointmentId, input.appointmentId),
        eq(soapNotes.status, "finalized"),
        isNull(soapNotes.deletedAt),
        sql`not exists (
          select 1 from ${clinicalRecordCorrections}
          where ${clinicalRecordCorrections.practiceId} = ${input.practiceId}
            and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id}
        )`,
      ),
    )
    .limit(1);
  if (existingFinalized) {
    throw new SoapLifecycleError(
      "CONFLICT",
      "This encounter already has finalized SOAP documentation.",
    );
  }
  const [note] = await db
    .insert(soapNotes)
    .values({
      practiceId: input.practiceId,
      patientId: input.patientId,
      appointmentId: input.appointmentId,
      ...finalizedSoapInsertValues({ actor: input.actor, sections }),
    })
    .returning();
  return note!;
}

export async function replaceFinalizedSoapNote(
  db: Database,
  input: {
    practiceId: string;
    patientId: string;
    sourceNoteId: string;
    operationId: string;
    reason: string;
    actor: SoapActor;
    sections: SoapSections;
  },
) {
  const practiceId = input.practiceId.toLowerCase();
  const patientId = input.patientId.toLowerCase();
  const sourceNoteId = input.sourceNoteId.toLowerCase();
  const actorId = input.actor.id.toLowerCase();
  const operationId = input.operationId.toLowerCase();
  const sections = normalizeSoapSections(input.sections);
  const reason = input.reason.trim();
  if (!hasSoapContent(sections)) {
    throw new SoapLifecycleError(
      "BAD_REQUEST",
      "Replacement SOAP note must include at least one section.",
    );
  }
  if (hasUnresolvedSoapTemplatePrompts(sections)) {
    throw new SoapLifecycleError(
      "BAD_REQUEST",
      "Replace or delete every SOAP template prompt before finalization.",
    );
  }

  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify({
        patientId,
        sourceNoteId,
        actorId,
        reason,
        ...sections,
      }),
    )
    .digest("hex");

  await db.execute(
    sql`select pg_advisory_xact_lock(
      hashtextextended(${`soap-replacement:${practiceId}:${operationId}`}, 0)
    )`,
  );

  const replay = async () => {
    const [existing] = await db
      .select({
        sourceNoteId: soapNoteReplacements.sourceSoapNoteId,
        replacementNote: soapNotes,
        operationPayloadHash: soapNoteReplacements.operationPayloadHash,
        correctionReason: clinicalRecordCorrections.reason,
        correctionSoapNoteId: clinicalRecordCorrections.soapNoteId,
      })
      .from(soapNoteReplacements)
      .innerJoin(
        soapNotes,
        and(
          eq(soapNotes.id, soapNoteReplacements.replacementSoapNoteId),
          eq(soapNotes.practiceId, practiceId),
        ),
      )
      .innerJoin(
        clinicalRecordCorrections,
        and(
          eq(clinicalRecordCorrections.id, soapNoteReplacements.correctionId),
          eq(clinicalRecordCorrections.practiceId, practiceId),
        ),
      )
      .where(
        and(
          eq(soapNoteReplacements.practiceId, practiceId),
          eq(soapNoteReplacements.operationId, operationId),
        ),
      )
      .limit(1);
    if (!existing) return null;
    if (
      existing.sourceNoteId !== sourceNoteId ||
      existing.replacementNote.patientId !== patientId ||
      existing.operationPayloadHash !== payloadHash ||
      existing.correctionSoapNoteId !== sourceNoteId ||
      existing.correctionReason !== reason
    ) {
      throw new SoapLifecycleError(
        "CONFLICT",
        "This replacement operation was already used for different SOAP details.",
      );
    }
    return { note: existing.replacementNote, replayed: true as const };
  };

  const existingReplay = await replay();
  if (existingReplay) return existingReplay;

  const sourcePredicate = and(
    eq(soapNotes.id, sourceNoteId),
    eq(soapNotes.practiceId, practiceId),
    eq(soapNotes.patientId, patientId),
    eq(soapNotes.status, "finalized"),
    isNull(soapNotes.deletedAt),
    sql`exists (
      select 1 from ${practices}
      where ${practices.id} = ${practiceId}
        and ${practices.deletedAt} is null
    )`,
  );
  const [sourceIdentity] = await db
    .select({ appointmentId: soapNotes.appointmentId })
    .from(soapNotes)
    .where(sourcePredicate)
    .limit(1);
  if (!sourceIdentity) {
    throw new SoapLifecycleError("NOT_FOUND", "Finalized SOAP note not found.");
  }

  // Closeout and correction both lock appointment first. Preserve that order
  // so a late replacement cannot race a closeout against different SOAP state.
  if (sourceIdentity.appointmentId) {
    const [appointment] = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.id, sourceIdentity.appointmentId),
          eq(appointments.practiceId, practiceId),
          isNull(appointments.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!appointment) {
      throw new SoapLifecycleError(
        "PRECONDITION_FAILED",
        "The source appointment is no longer available for a signed SOAP replacement.",
      );
    }
  }

  const [source] = await db
    .select()
    .from(soapNotes)
    .where(sourcePredicate)
    .limit(1)
    .for("update");
  if (!source) {
    throw new SoapLifecycleError(
      "CONFLICT",
      "The source SOAP note changed. Refresh the chart and try again.",
    );
  }

  const [existingReplacement] = await db
    .select({ id: soapNoteReplacements.id })
    .from(soapNoteReplacements)
    .where(
      and(
        eq(soapNoteReplacements.practiceId, practiceId),
        eq(soapNoteReplacements.sourceSoapNoteId, source.id),
      ),
    )
    .limit(1);
  if (existingReplacement) {
    throw new SoapLifecycleError(
      "CONFLICT",
      "This SOAP note already has a replacement. Refresh the chart.",
    );
  }

  if (source.appointmentId) {
    const [competingDraft] = await db
      .select({ id: soapNotes.id })
      .from(soapNotes)
      .where(
        and(
          eq(soapNotes.practiceId, practiceId),
          eq(soapNotes.appointmentId, source.appointmentId),
          eq(soapNotes.status, "draft"),
          isNull(soapNotes.deletedAt),
        ),
      )
      .limit(1);
    if (competingDraft) {
      throw new SoapLifecycleError(
        "CONFLICT",
        "This encounter has a SOAP draft. Review or discard it before creating a signed replacement.",
      );
    }
    const [competingFinal] = await db
      .select({ id: soapNotes.id })
      .from(soapNotes)
      .where(
        and(
          eq(soapNotes.practiceId, practiceId),
          eq(soapNotes.appointmentId, source.appointmentId),
          eq(soapNotes.status, "finalized"),
          isNull(soapNotes.deletedAt),
          sql`${soapNotes.id} <> ${source.id}`,
          sql`not exists (
            select 1 from ${clinicalRecordCorrections}
            where ${clinicalRecordCorrections.practiceId} = ${practiceId}
              and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id}
          )`,
        ),
      )
      .limit(1);
    if (competingFinal) {
      throw new SoapLifecycleError(
        "CONFLICT",
        "This encounter already has current finalized SOAP documentation.",
      );
    }
  }

  let [correction] = await db
    .select()
    .from(clinicalRecordCorrections)
    .where(
      and(
        eq(clinicalRecordCorrections.practiceId, practiceId),
        eq(clinicalRecordCorrections.soapNoteId, source.id),
      ),
    )
    .limit(1);
  if (correction && correction.reason !== reason) {
    throw new SoapLifecycleError(
      "CONFLICT",
      "Use the existing permanent correction reason when replacing this SOAP note.",
    );
  }
  if (!correction) {
    [correction] = await db
      .insert(clinicalRecordCorrections)
      .values({
        practiceId,
        recordType: "soap_note",
        action: "entered_in_error",
        soapNoteId: source.id,
        patientId: source.patientId,
        appointmentId: source.appointmentId,
        reason,
        correctedBy: actorId,
        correctedByName: input.actor.name,
      })
      .returning();
  }
  if (!correction) {
    throw new SoapLifecycleError(
      "CONFLICT",
      "The SOAP correction could not be recorded. Refresh and try again.",
    );
  }

  const [replacement] = await db
    .insert(soapNotes)
    .values({
      practiceId,
      patientId: source.patientId,
      appointmentId: source.appointmentId,
      ...finalizedSoapInsertValues({ actor: input.actor, sections }),
      // Keep finalization, correction, and evidence timestamps on the same
      // PostgreSQL transaction clock. Application wall time can be later than
      // transaction_timestamp() (or skewed across hosts), which would make an
      // otherwise valid atomic replacement fail its chronology trigger.
      finalizedAt: sql`transaction_timestamp()`,
    })
    .returning();
  if (!replacement) {
    throw new SoapLifecycleError(
      "CONFLICT",
      "The replacement SOAP note could not be finalized.",
    );
  }

  await db.insert(soapNoteReplacements).values({
    practiceId,
    correctionId: correction.id,
    sourceSoapNoteId: source.id,
    replacementSoapNoteId: replacement.id,
    actorId,
    actorName: input.actor.name,
    operationId,
    operationPayloadHash: payloadHash,
  });
  return { note: replacement, replayed: false as const };
}

export async function addFinalizedSoapAddendum(
  db: Database,
  input: {
    practiceId: string;
    patientId: string;
    noteId: string;
    operationId: string;
    content: string;
    actor: SoapActor;
  },
) {
  const content = input.content.trim();
  if (!content) {
    throw new SoapLifecycleError(
      "BAD_REQUEST",
      "Addendum content is required.",
    );
  }
  if (content.length > 10_000) {
    throw new SoapLifecycleError(
      "BAD_REQUEST",
      "Addendum content must be 10,000 characters or fewer.",
    );
  }
  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify({
        noteId: input.noteId,
        authorId: input.actor.id,
        content,
      }),
    )
    .digest("hex");

  const [existing] = await db
    .select()
    .from(soapNoteAddenda)
    .where(
      and(
        eq(soapNoteAddenda.practiceId, input.practiceId),
        eq(soapNoteAddenda.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.operationPayloadHash === payloadHash) return existing;
    throw new SoapLifecycleError(
      "CONFLICT",
      "This addendum operation was already used for different content.",
    );
  }

  const [note] = await db
    .select({ id: soapNotes.id })
    .from(soapNotes)
    .where(
      and(
        eq(soapNotes.id, input.noteId),
        eq(soapNotes.practiceId, input.practiceId),
        eq(soapNotes.patientId, input.patientId),
        eq(soapNotes.status, "finalized"),
        isNull(soapNotes.deletedAt),
        sql`not exists (
          select 1 from ${clinicalRecordCorrections}
          where ${clinicalRecordCorrections.practiceId} = ${input.practiceId}
            and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id}
        )`,
      ),
    )
    .limit(1)
    .for("update");
  if (!note) {
    throw new SoapLifecycleError(
      "PRECONDITION_FAILED",
      "Addenda require an active finalized SOAP note.",
    );
  }

  const [created] = await db
    .insert(soapNoteAddenda)
    .values({
      practiceId: input.practiceId,
      soapNoteId: note.id,
      authorId: input.actor.id,
      authorName: input.actor.name,
      content,
      operationId: input.operationId,
      operationPayloadHash: payloadHash,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [concurrent] = await db
    .select()
    .from(soapNoteAddenda)
    .where(
      and(
        eq(soapNoteAddenda.practiceId, input.practiceId),
        eq(soapNoteAddenda.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (concurrent?.operationPayloadHash === payloadHash) return concurrent;
  throw new SoapLifecycleError(
    "CONFLICT",
    "This addendum operation was already used for different content.",
  );
}
