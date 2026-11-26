import { TRPCError } from "@trpc/server";
import { AgentNotConfiguredError } from "@/lib/agent";
import { loadSoapChartContext } from "@/lib/ai/soap-chart-context";
import {
  SoapDraftUnavailableError,
  type SoapDraft,
} from "@/lib/ai/soap-draft";
import { recordUsage } from "@/lib/billing/usage";
import { draftScribeNote } from "./draft";
import { loadScribeVocabulary } from "./vocabulary";
import {
  assertMayCallProvider,
  recordScribeAudit,
  type ScribeContext,
} from "./guards";
import {
  SCRIBE_PREVIOUS_TAIL_LENGTH,
  SCRIBE_TRANSCRIPT_MAX_LENGTH,
} from "./policy";
import {
  ScribeAudioUnsupportedError,
  transcribeScribeSegment,
} from "./transcribe";
import {
  addRecordingAudio,
  findRecording,
  otherRecordingActive,
  recordingMatches,
  SCRIBE_RECORDING_MAX_AUDIO_SECONDS,
} from "./recordings";
import {
  findScribeVisit,
  findSegmentByClientKey,
  insertVisitSegment,
  joinSegments,
  listVisitSegments,
  phoneLinkLive,
  purgeStaleScribeTranscripts,
  ScribeStoreError,
  scribeVisitState,
  type ScribeSegmentSource,
  type ScribeVisit,
} from "./visit-store";

/**
 * Scribe inside a visit: recorded audio becomes the visit's working transcript,
 * and the transcript plus the chart becomes a SOAP draft. Used by the chart
 * (signed-in) and by the phone link (capability token) alike.
 */

/**
 * A live recording sends two or three parts a minute; an uploaded file sends
 * its parts as fast as they are transcribed. Cost is metered by the length of
 * the audio, so this only has to stop a runaway page.
 */
const TRANSCRIBE_RATE_LIMIT = 30;
const DRAFT_RATE_LIMIT = 10;

const NOT_IN_EXAM_MESSAGE =
  "Scribe works while the visit is in exam. Start the exam first.";
const FINALIZED_MESSAGE =
  "This visit's note is already finalized, so Scribe has stopped.";

/** The visit, provided it can still take a recording or a draft. */
export async function requireOpenVisit(
  ctx: ScribeContext,
  appointmentId: string,
): Promise<ScribeVisit> {
  const visit = await findScribeVisit(ctx.db, ctx.practiceId, appointmentId);
  if (!visit) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Visit not found." });
  }
  const state = await scribeVisitState(ctx.db, ctx.practiceId, visit.id);
  if (state === "not_in_exam") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: NOT_IN_EXAM_MESSAGE,
    });
  }
  if (state !== "open") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: FINALIZED_MESSAGE,
    });
  }
  return visit;
}

function providerError(error: unknown, fallback: string): TRPCError {
  if (
    error instanceof AgentNotConfiguredError ||
    error instanceof ScribeAudioUnsupportedError
  ) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: error.message,
    });
  }
  if (error instanceof SoapDraftUnavailableError) {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: fallback });
}

/**
 * Meter a stretch of transcribed audio against its recording, and write the
 * content-free audit entry when it is the recording's first. Shared by the
 * standalone page and visits so both are metered the same way.
 */
export async function meterRecordedAudio(
  ctx: ScribeContext,
  input: {
    appointmentId: string | null;
    recordingKey: string;
    source: ScribeSegmentSource;
    seconds: number;
  },
): Promise<void> {
  const { runsDue, first } = await addRecordingAudio(ctx.db, {
    practiceId: ctx.practiceId,
    userId: ctx.user.id,
    appointmentId: input.appointmentId,
    recordingKey: input.recordingKey,
    source: input.source,
    seconds: input.seconds,
  });
  if (runsDue > 0) {
    await recordUsage({
      practiceId: ctx.practiceId,
      kind: "ai_run",
      quantity: runsDue,
    });
  }
  if (first) {
    await recordScribeAudit(
      ctx,
      "recorded",
      { fromPhone: input.source === "phone" ? 1 : 0 },
      input.appointmentId,
    );
  }
}

/**
 * Refuse a recording key that names someone else's recording, and stop a
 * recording that has reached the longest length Scribe takes.
 */
export async function assertRecordingMayContinue(
  ctx: ScribeContext,
  input: {
    appointmentId: string | null;
    recordingKey: string;
    source: ScribeSegmentSource;
  },
): Promise<{ started: boolean }> {
  const recording = await findRecording(
    ctx.db,
    ctx.practiceId,
    input.recordingKey,
  );
  if (!recording) return { started: false };
  if (
    !recordingMatches(recording, {
      userId: ctx.user.id,
      appointmentId: input.appointmentId,
      source: input.source,
    })
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That recording could not be read. Record it again.",
    });
  }
  if (recording.audioSeconds >= SCRIBE_RECORDING_MAX_AUDIO_SECONDS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This recording has reached its longest length. Stop it and write the note.",
    });
  }
  return { started: recording.audioSeconds > 0 };
}

/**
 * Transcribe one short stretch of a visit recording and add it to the visit's
 * transcript. A retried upload (same clientKey) returns the stored text
 * without calling the provider again.
 */
export async function transcribeIntoVisit(
  ctx: ScribeContext,
  input: {
    appointmentId: string;
    clientKey: string;
    /** Names the recording this part belongs to. */
    recordingKey: string;
    wav: Uint8Array;
    durationSeconds: number;
    source: ScribeSegmentSource;
    /** The phone link this part arrived on, re-checked before it is stored. */
    phoneLinkId?: string;
  },
): Promise<{ text: string }> {
  const visit = await requireOpenVisit(ctx, input.appointmentId);

  const existing = await findSegmentByClientKey(
    ctx.db,
    ctx.practiceId,
    visit.id,
    input.clientKey,
  );
  if (existing) return { text: existing.text };

  // Self-hosted installs may run no scheduled jobs, so old transcripts for
  // this clinic are also swept whenever Scribe is used.
  await purgeStaleScribeTranscripts(ctx.db, { practiceId: ctx.practiceId });

  const transcript = joinSegments(
    await listVisitSegments(ctx.db, ctx.practiceId, visit.id),
  );
  if (transcript.length >= SCRIBE_TRANSCRIPT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This visit's transcript is full. Write the note, or clear the transcript to start again.",
    });
  }

  const recording = await assertRecordingMayContinue(ctx, input);
  if (
    !recording.started &&
    (await otherRecordingActive(ctx.db, {
      practiceId: ctx.practiceId,
      appointmentId: visit.id,
      recordingKey: input.recordingKey,
    }))
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This visit is already being recorded on another device. Stop that recording first.",
    });
  }

  await assertMayCallProvider(ctx, {
    name: "scribe-transcribe",
    perMinute: TRANSCRIBE_RATE_LIMIT,
    message: "Recording is ahead of transcription. It will catch up shortly.",
  });

  let text: string;
  try {
    text = await transcribeScribeSegment({
      wav: input.wav,
      previousTail: transcript.slice(-SCRIBE_PREVIOUS_TAIL_LENGTH) || undefined,
      patientName: visit.patientName,
      species: visit.species,
      vocabulary: await loadScribeVocabulary(ctx.db, ctx.practiceId),
    });
  } catch (error) {
    throw providerError(error, "Could not transcribe that part of the recording.");
  }

  // Transcribing took a few seconds. Check again, this time holding the same
  // row the note's finalization locks, so a part can never be stored after its
  // visit's note is finalized and the transcript was deleted.
  const state = await scribeVisitState(ctx.db, ctx.practiceId, visit.id, {
    lock: true,
  });
  const linkOpen =
    !input.phoneLinkId ||
    (await phoneLinkLive(ctx.db, ctx.practiceId, input.phoneLinkId));
  if (state !== "open" || !linkOpen) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: state === "not_in_exam" ? NOT_IN_EXAM_MESSAGE : FINALIZED_MESSAGE,
    });
  }

  if (text) {
    try {
      text = await insertVisitSegment(ctx.db, {
        practiceId: ctx.practiceId,
        appointmentId: visit.id,
        userId: ctx.user.id,
        clientKey: input.clientKey,
        source: input.source,
        text,
      });
    } catch (error) {
      if (error instanceof ScribeStoreError) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }
      throw error;
    }
  }

  await meterRecordedAudio(ctx, {
    appointmentId: visit.id,
    recordingKey: input.recordingKey,
    source: input.source,
    seconds: input.durationSeconds,
  });

  return { text };
}

/** Draft the visit's SOAP note from its transcript and chart. Saves nothing. */
export async function draftVisitNote(
  ctx: ScribeContext,
  appointmentId: string,
): Promise<SoapDraft> {
  const visit = await requireOpenVisit(ctx, appointmentId);
  // The whole transcript, never a cut: a transcript stops taking new parts
  // once it reaches the limit, so it is at most one part over it.
  const transcript = joinSegments(
    await listVisitSegments(ctx.db, ctx.practiceId, visit.id),
  );
  if (!transcript) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Nothing has been transcribed for this visit yet.",
    });
  }

  await assertMayCallProvider(ctx, {
    name: "scribe-draft",
    perMinute: DRAFT_RATE_LIMIT,
    message: "Too many drafts at once. Wait a minute and try again.",
  });

  const chart = await loadSoapChartContext(
    ctx.db,
    ctx.practiceId,
    visit.patientId,
  );
  if (!chart) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found." });
  }

  let draft: SoapDraft;
  try {
    draft = await draftScribeNote({ transcript, chart });
  } catch (error) {
    throw providerError(error, "Could not draft the note. Try again.");
  }

  await recordUsage({ practiceId: ctx.practiceId, kind: "ai_run" });
  await recordScribeAudit(
    ctx,
    "drafted",
    { transcriptCharacters: transcript.length },
    visit.id,
  );
  return draft;
}
