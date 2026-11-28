import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  appointments,
  captureSessions,
  clinicalRecordCorrections,
  patients,
  scribeRecordings,
  scribeTranscriptSegments,
  soapNotes,
  visitCloseouts,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { SCRIBE_RECORDING_RETENTION_MS } from "./recordings";

/**
 * Storage for a visit's working transcript and its phone recording links.
 * Database only, so the SOAP lifecycle can clear a transcript without pulling
 * in anything that talks to an AI provider.
 */

/** A phone link lasts a little longer than the longest recording. */
export const SCRIBE_PHONE_LINK_TTL_MS = 60 * 60 * 1000;
/** Transcripts left behind by visits that never finalized a note. */
export const SCRIBE_TRANSCRIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

export type ScribeSegmentSource = "browser" | "phone";

/** A transcript write failed. Carries no detail, on purpose. */
export class ScribeStoreError extends Error {
  constructor() {
    super("The transcript could not be saved.");
    this.name = "ScribeStoreError";
  }
}

export interface ScribeVisit {
  id: string;
  patientId: string;
  status: string;
  patientName: string;
  species: string;
}

/**
 * The visit, if it is this clinic's. With `patientId`, also only if the visit
 * is that patient's: the chart a clinician is recording from names the
 * patient, so a visit id from another chart is treated as not found.
 */
export async function findScribeVisit(
  db: Database,
  practiceId: string,
  appointmentId: string,
  patientId?: string,
): Promise<ScribeVisit | null> {
  const [visit] = await db
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      status: appointments.status,
      patientName: patients.name,
      species: patients.species,
    })
    .from(appointments)
    .innerJoin(
      patients,
      and(
        eq(patients.id, appointments.patientId),
        eq(patients.practiceId, practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.practiceId, practiceId),
        isNull(appointments.deletedAt),
      ),
    )
    .limit(1);
  if (!visit?.patientId) return null;
  if (patientId !== undefined && visit.patientId !== patientId) return null;
  return { ...visit, patientId: visit.patientId };
}

export type ScribeVisitState = "open" | "not_found" | "not_in_exam" | "finalized";

/**
 * Whether a visit can still take a recording: it is in exam, and its note has
 * not been finalized. With `lock`, the appointment row is share-locked until
 * the transaction ends, so finalizing the note (which locks the same row)
 * cannot slip between this check and a transcript insert that follows it.
 */
export async function scribeVisitState(
  db: Database,
  practiceId: string,
  appointmentId: string,
  options: { lock?: boolean } = {},
): Promise<ScribeVisitState> {
  const query = db
    .select({ status: appointments.status })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.practiceId, practiceId),
        isNull(appointments.deletedAt),
      ),
    )
    .limit(1);
  const [appointment] = options.lock ? await query.for("share") : await query;
  if (!appointment) return "not_found";
  if (appointment.status !== "in_exam") return "not_in_exam";

  const [closeout] = await db
    .select({ status: visitCloseouts.status })
    .from(visitCloseouts)
    .where(
      and(
        eq(visitCloseouts.appointmentId, appointmentId),
        eq(visitCloseouts.practiceId, practiceId),
        isNull(visitCloseouts.deletedAt),
      ),
    )
    .limit(1);
  if (
    closeout?.status === "clinical_finalized" ||
    closeout?.status === "completed"
  ) {
    return "finalized";
  }

  // The same test the visit page uses for "this visit has its note": a
  // finalized SOAP note that has not been struck out by a correction.
  const [finalNote] = await db
    .select({ id: soapNotes.id })
    .from(soapNotes)
    .where(
      and(
        eq(soapNotes.appointmentId, appointmentId),
        eq(soapNotes.practiceId, practiceId),
        eq(soapNotes.status, "finalized"),
        isNull(soapNotes.deletedAt),
        sql`not exists (
          select 1
          from ${clinicalRecordCorrections}
          where ${clinicalRecordCorrections.practiceId} = ${practiceId}
            and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id}
        )`,
      ),
    )
    .limit(1);
  return finalNote ? "finalized" : "open";
}

export async function listVisitSegments(
  db: Database,
  practiceId: string,
  appointmentId: string,
) {
  return db
    .select({
      id: scribeTranscriptSegments.id,
      text: scribeTranscriptSegments.text,
      source: scribeTranscriptSegments.source,
      createdAt: scribeTranscriptSegments.createdAt,
    })
    .from(scribeTranscriptSegments)
    .where(
      and(
        eq(scribeTranscriptSegments.practiceId, practiceId),
        eq(scribeTranscriptSegments.appointmentId, appointmentId),
      ),
    )
    .orderBy(
      asc(scribeTranscriptSegments.createdAt),
      asc(scribeTranscriptSegments.id),
    );
}

export async function findSegmentByClientKey(
  db: Database,
  practiceId: string,
  appointmentId: string,
  clientKey: string,
) {
  const [segment] = await db
    .select({ text: scribeTranscriptSegments.text })
    .from(scribeTranscriptSegments)
    .where(
      and(
        eq(scribeTranscriptSegments.practiceId, practiceId),
        eq(scribeTranscriptSegments.appointmentId, appointmentId),
        eq(scribeTranscriptSegments.clientKey, clientKey),
      ),
    )
    .limit(1);
  return segment ?? null;
}

export async function insertVisitSegment(
  db: Database,
  input: {
    practiceId: string;
    appointmentId: string;
    userId: string;
    clientKey: string;
    source: ScribeSegmentSource;
    text: string;
  },
): Promise<string> {
  let inserted: { text: string } | undefined;
  try {
    [inserted] = await db
      .insert(scribeTranscriptSegments)
      .values({
        practiceId: input.practiceId,
        appointmentId: input.appointmentId,
        createdBy: input.userId,
        clientKey: input.clientKey,
        source: input.source,
        text: input.text,
      })
      .onConflictDoNothing()
      .returning({ text: scribeTranscriptSegments.text });
  } catch {
    // The database driver puts query parameters in its error message, and that
    // message is reported onward. The parameters here are what was said.
    throw new ScribeStoreError();
  }
  if (inserted) return inserted.text;
  // A retry of an upload that already landed keeps the first text.
  const existing = await findSegmentByClientKey(
    db,
    input.practiceId,
    input.appointmentId,
    input.clientKey,
  );
  return existing?.text ?? input.text;
}

/** Drop a visit's transcript and close its phone links. */
export async function clearVisitTranscript(
  db: Database,
  practiceId: string,
  appointmentId: string,
): Promise<void> {
  await db
    .delete(scribeTranscriptSegments)
    .where(
      and(
        eq(scribeTranscriptSegments.practiceId, practiceId),
        eq(scribeTranscriptSegments.appointmentId, appointmentId),
      ),
    );
  await endPhoneLinks(db, practiceId, appointmentId);
}

export async function endPhoneLinks(
  db: Database,
  practiceId: string,
  appointmentId: string,
): Promise<void> {
  await db
    .update(captureSessions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(captureSessions.practiceId, practiceId),
        eq(captureSessions.appointmentId, appointmentId),
        eq(captureSessions.purpose, "scribe"),
        isNull(captureSessions.deletedAt),
      ),
    );
}

export async function activePhoneLink(
  db: Database,
  practiceId: string,
  appointmentId: string,
) {
  const [link] = await db
    .select({ id: captureSessions.id, expiresAt: captureSessions.expiresAt })
    .from(captureSessions)
    .where(
      and(
        eq(captureSessions.practiceId, practiceId),
        eq(captureSessions.appointmentId, appointmentId),
        eq(captureSessions.purpose, "scribe"),
        isNull(captureSessions.deletedAt),
        gt(captureSessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(captureSessions.createdAt))
    .limit(1);
  return link ?? null;
}

/** Is this exact phone link still open? */
export async function phoneLinkLive(
  db: Database,
  practiceId: string,
  linkId: string,
): Promise<boolean> {
  const [link] = await db
    .select({ id: captureSessions.id })
    .from(captureSessions)
    .where(
      and(
        eq(captureSessions.id, linkId),
        eq(captureSessions.practiceId, practiceId),
        eq(captureSessions.purpose, "scribe"),
        isNull(captureSessions.deletedAt),
        gt(captureSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(link);
}

/**
 * Remove transcripts of visits that have had no new speech for the retention
 * window, and old recording counts. A visit is judged as a whole by its newest
 * part, so a long stay never loses the start of its transcript while it is
 * still being recorded. Pass a practice to sweep just that clinic (run under
 * its own tenant scope); leave it out to sweep every clinic (system scope).
 */
export async function purgeStaleScribeTranscripts(
  db: Database,
  options: { now?: Date; practiceId?: string } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - SCRIBE_TRANSCRIPT_RETENTION_MS);
  const scope = options.practiceId
    ? sql`and ${scribeTranscriptSegments.practiceId} = ${options.practiceId}`
    : sql``;
  const removed = await db
    .delete(scribeTranscriptSegments)
    .where(
      sql`(${scribeTranscriptSegments.practiceId}, ${scribeTranscriptSegments.appointmentId}) in (
        select ${scribeTranscriptSegments.practiceId}, ${scribeTranscriptSegments.appointmentId}
        from ${scribeTranscriptSegments}
        where true ${scope}
        group by ${scribeTranscriptSegments.practiceId}, ${scribeTranscriptSegments.appointmentId}
        having max(${scribeTranscriptSegments.createdAt}) < ${cutoff.toISOString()}::timestamptz
      )`,
    )
    .returning({ id: scribeTranscriptSegments.id });

  const recordingCutoff = new Date(
    now.getTime() - SCRIBE_RECORDING_RETENTION_MS,
  );
  await db
    .delete(scribeRecordings)
    .where(
      options.practiceId
        ? and(
            eq(scribeRecordings.practiceId, options.practiceId),
            lt(scribeRecordings.updatedAt, recordingCutoff),
          )
        : lt(scribeRecordings.updatedAt, recordingCutoff),
    );
  return removed.length;
}

/**
 * A clinic turned Scribe off: delete every transcript it still holds and close
 * its phone links, so nothing is left behind that nobody can see.
 */
export async function purgePracticeScribeData(
  db: Database,
  practiceId: string,
): Promise<void> {
  await db
    .delete(scribeTranscriptSegments)
    .where(eq(scribeTranscriptSegments.practiceId, practiceId));
  await db
    .update(captureSessions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(captureSessions.practiceId, practiceId),
        eq(captureSessions.purpose, "scribe"),
        isNull(captureSessions.deletedAt),
      ),
    );
}

export function joinSegments(segments: Array<{ text: string }>): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join("\n");
}
