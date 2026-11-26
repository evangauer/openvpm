import { and, eq, gt, ne, sql } from "drizzle-orm";
import { scribeRecordings } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { SCRIBE_MAX_RECORDING_SECONDS } from "./audio";

/**
 * Server-side bookkeeping for a recording: how much audio it has taken and how
 * many AI runs that has been metered as. Nothing here trusts the recording
 * device, which only names its recording with a key. Naming a new recording
 * for every part costs a full run each time, so it can never cost less.
 *
 * Counts only: no audio, transcript, or note text is ever written here.
 */

/** One metered AI run covers this much recorded audio, or any part of it. */
export const SCRIBE_METERED_SECONDS_PER_RUN = 10 * 60;
/** The longest recording, plus room for the last part and a retry or two. */
export const SCRIBE_RECORDING_MAX_AUDIO_SECONDS =
  SCRIBE_MAX_RECORDING_SECONDS + 5 * 60;
/** Another device counts as "recording now" if it sent audio this recently. */
export const SCRIBE_ACTIVE_RECORDING_WINDOW_MS = 90 * 1000;
/** Recording counts are kept this long for usage questions, then removed. */
export const SCRIBE_RECORDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ScribeRecordingSource = "browser" | "phone";

export interface ScribeRecordingRow {
  createdBy: string;
  appointmentId: string | null;
  source: string;
  audioSeconds: number;
  deviceKeyHash: string | null;
}

export function meteredRunsFor(audioSeconds: number): number {
  if (audioSeconds <= 0) return 0;
  return Math.ceil(audioSeconds / SCRIBE_METERED_SECONDS_PER_RUN);
}

export async function findRecording(
  db: Database,
  practiceId: string,
  recordingKey: string,
): Promise<ScribeRecordingRow | null> {
  const [row] = await db
    .select({
      createdBy: scribeRecordings.createdBy,
      appointmentId: scribeRecordings.appointmentId,
      source: scribeRecordings.source,
      audioSeconds: scribeRecordings.audioSeconds,
      deviceKeyHash: scribeRecordings.deviceKeyHash,
    })
    .from(scribeRecordings)
    .where(
      and(
        eq(scribeRecordings.practiceId, practiceId),
        eq(scribeRecordings.recordingKey, recordingKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Open a recording with no audio yet (a phone link, before the phone joins). */
export async function openRecording(
  db: Database,
  input: {
    practiceId: string;
    userId: string;
    appointmentId: string | null;
    recordingKey: string;
    source: ScribeRecordingSource;
  },
): Promise<void> {
  await db
    .insert(scribeRecordings)
    .values({
      practiceId: input.practiceId,
      createdBy: input.userId,
      appointmentId: input.appointmentId,
      recordingKey: input.recordingKey,
      source: input.source,
    })
    .onConflictDoNothing();
}

/**
 * Whether a recording key may be used by this person for this visit. A key
 * that already names someone else's recording, another visit's, or another
 * kind of device is refused rather than merged.
 */
export function recordingMatches(
  recording: ScribeRecordingRow,
  expected: {
    userId: string;
    appointmentId: string | null;
    source: ScribeRecordingSource;
  },
): boolean {
  return (
    recording.createdBy === expected.userId &&
    recording.appointmentId === expected.appointmentId &&
    recording.source === expected.source
  );
}

/**
 * Add transcribed audio to a recording and say how many AI runs are now due.
 * `first` is true when this is the recording's first audio.
 */
export async function addRecordingAudio(
  db: Database,
  input: {
    practiceId: string;
    userId: string;
    appointmentId: string | null;
    recordingKey: string;
    source: ScribeRecordingSource;
    seconds: number;
  },
): Promise<{ runsDue: number; first: boolean }> {
  const seconds = Math.max(1, Math.ceil(input.seconds));
  const [row] = await db
    .insert(scribeRecordings)
    .values({
      practiceId: input.practiceId,
      createdBy: input.userId,
      appointmentId: input.appointmentId,
      recordingKey: input.recordingKey,
      source: input.source,
      audioSeconds: seconds,
    })
    .onConflictDoUpdate({
      target: [scribeRecordings.practiceId, scribeRecordings.recordingKey],
      set: {
        audioSeconds: sql`${scribeRecordings.audioSeconds} + ${seconds}`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: scribeRecordings.id,
      audioSeconds: scribeRecordings.audioSeconds,
      meteredRuns: scribeRecordings.meteredRuns,
    });
  if (!row) return { runsDue: 0, first: false };

  const runsDue = meteredRunsFor(row.audioSeconds) - row.meteredRuns;
  if (runsDue > 0) {
    await db
      .update(scribeRecordings)
      .set({ meteredRuns: row.meteredRuns + runsDue })
      .where(
        and(
          eq(scribeRecordings.practiceId, input.practiceId),
          eq(scribeRecordings.id, row.id),
        ),
      );
  }
  return { runsDue: Math.max(0, runsDue), first: row.audioSeconds === seconds };
}

/** Is a different recording taking audio for this visit right now? */
export async function otherRecordingActive(
  db: Database,
  input: {
    practiceId: string;
    appointmentId: string;
    recordingKey: string;
    now?: Date;
  },
): Promise<boolean> {
  const since = new Date(
    (input.now ?? new Date()).getTime() - SCRIBE_ACTIVE_RECORDING_WINDOW_MS,
  );
  const [row] = await db
    .select({ id: scribeRecordings.id })
    .from(scribeRecordings)
    .where(
      and(
        eq(scribeRecordings.practiceId, input.practiceId),
        eq(scribeRecordings.appointmentId, input.appointmentId),
        ne(scribeRecordings.recordingKey, input.recordingKey),
        gt(scribeRecordings.audioSeconds, 0),
        gt(scribeRecordings.updatedAt, since),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Tie a phone link to the first phone that opens it. Returns false when the
 * link is already open on a different phone.
 */
export async function bindRecordingDevice(
  db: Database,
  input: { practiceId: string; recordingKey: string; deviceKeyHash: string },
): Promise<boolean> {
  await db
    .update(scribeRecordings)
    .set({ deviceKeyHash: input.deviceKeyHash })
    .where(
      and(
        eq(scribeRecordings.practiceId, input.practiceId),
        eq(scribeRecordings.recordingKey, input.recordingKey),
        sql`${scribeRecordings.deviceKeyHash} is null`,
      ),
    );
  const recording = await findRecording(
    db,
    input.practiceId,
    input.recordingKey,
  );
  return recording?.deviceKeyHash === input.deviceKeyHash;
}
