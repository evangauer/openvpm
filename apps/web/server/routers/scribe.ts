import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { captureSessions, practices } from "@openpims/db";
import {
  createRouter,
  protectedProcedure,
  requireFeature,
  requireRole,
} from "../trpc";
import { AgentNotConfiguredError, isAgentConfigured } from "@/lib/agent";
import { SoapDraftUnavailableError } from "@/lib/ai/soap-draft";
import { recordUsage } from "@/lib/billing/usage";
import {
  clinicalTextInput,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import {
  base64ToBytes,
  inspectScribeWav,
  SCRIBE_SEGMENT_MAX_BASE64_LENGTH,
} from "@/lib/scribe/audio";
import {
  canUseScribeRole,
  scribePracticeEnabled,
  scribeRolloutEnabled,
} from "@/lib/scribe/availability";
import { draftScribeNote } from "@/lib/scribe/draft";
import { loadScribeVocabulary } from "@/lib/scribe/vocabulary";
import {
  activePracticeWhere,
  assertMayCallProvider,
  practiceNotFound,
  recordScribeAudit,
  scribeClinicAllowed,
  scribeNotAvailable,
  type ScribeContext,
} from "@/lib/scribe/guards";
import {
  assertRecordingMayContinue,
  draftVisitNote,
  meterRecordedAudio,
  requireOpenVisit,
  transcribeIntoVisit,
} from "@/lib/scribe/visit";
import { findRecording, openRecording } from "@/lib/scribe/recordings";
import {
  activePhoneLink,
  clearVisitTranscript,
  endPhoneLinks,
  findScribeVisit,
  listVisitSegments,
  purgePracticeScribeData,
  SCRIBE_PHONE_LINK_TTL_MS,
  scribeVisitState,
} from "@/lib/scribe/visit-store";
import { generateCaptureToken } from "@/lib/consult/tokens";
import { appBaseUrl } from "@/lib/app-url";
import {
  SCRIBE_PATIENT_NAME_MAX_LENGTH,
  SCRIBE_SPECIES_MAX_LENGTH,
  SCRIBE_TRANSCRIPT_MAX_LENGTH,
} from "@/lib/scribe/policy";
import {
  isScribeAudioConfigured,
  SCRIBE_PREVIOUS_TAIL_MAX_LENGTH,
  ScribeAudioUnsupportedError,
  transcribeScribeSegment,
} from "@/lib/scribe/transcribe";

const UNAVAILABLE = {
  available: false,
  enabled: false,
  canManage: false,
  configured: false,
  canRecord: false,
} as const;

/**
 * A live recording sends two or three parts a minute; an uploaded file sends
 * its parts as fast as they are transcribed. Cost is metered by the length of
 * the audio, so this only has to stop a runaway page.
 */
const TRANSCRIBE_RATE_LIMIT = 30;
const DRAFT_RATE_LIMIT = 10;

/** Both gates (deployment switch and the clinic's opt-in), no provider call. */
async function assertScribeOpen(ctx: ScribeContext) {
  if (!scribeRolloutEnabled() || !scribeClinicAllowed(ctx.practiceId)) {
    throw scribeNotAvailable();
  }
  const [practice] = await ctx.db
    .select({ settings: practices.settings })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);
  if (!practice) throw practiceNotFound();
  if (!scribePracticeEnabled(practice.settings)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Scribe is not turned on for this clinic.",
    });
  }
}

function readSegmentAudio(audio: string): {
  wav: Uint8Array;
  durationSeconds: number;
} {
  const wav = base64ToBytes(audio);
  const inspection = wav ? inspectScribeWav(wav) : null;
  if (!wav || !inspection?.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That recording could not be read. Record it again.",
    });
  }
  return { wav, durationSeconds: inspection.durationSeconds };
}

export const scribeRouter = createRouter({
  /**
   * What the sidebar and the Scribe page may show. `available` is the
   * deployment switch plus role; `enabled` is the clinic's own opt-in;
   * `canRecord` says whether an audio-capable model is configured.
   */
  availability: protectedProcedure.query(async ({ ctx }) => {
    if (
      !scribeRolloutEnabled() ||
      !scribeClinicAllowed(ctx.practiceId) ||
      !canUseScribeRole(ctx.user.role)
    ) {
      return UNAVAILABLE;
    }
    const [practice] = await ctx.db
      .select({ settings: practices.settings })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) throw practiceNotFound();
    return {
      available: true,
      enabled: scribePracticeEnabled(practice.settings),
      canManage: ctx.user.role === "admin",
      configured: isAgentConfigured(),
      canRecord: isAgentConfigured() && isScribeAudioConfigured(),
    };
  }),

  /** A clinic administrator turns Scribe on or off for their own clinic. */
  setEnabled: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ enabled: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      if (!scribeRolloutEnabled() || !scribeClinicAllowed(ctx.practiceId)) {
        throw scribeNotAvailable();
      }
      const patch = JSON.stringify({ scribe: { enabled: input.enabled } });
      const [updated] = await ctx.db
        .update(practices)
        .set({
          // Merge in the database so a concurrent settings write is not lost.
          settings: sql`coalesce(${practices.settings}, '{}'::jsonb) || ${patch}::jsonb`,
        })
        .where(activePracticeWhere(ctx.practiceId))
        .returning({ settings: practices.settings });
      if (!updated) throw practiceNotFound();
      const enabled = scribePracticeEnabled(updated.settings);
      // Turning Scribe off deletes what it was holding for this clinic.
      if (!enabled) await purgePracticeScribeData(ctx.db, ctx.practiceId);
      return { enabled };
    }),

  /**
   * Turn one short segment of a visit recording into text. The audio is held
   * in memory for this call only and is never stored.
   *
   * Like `draftFromTranscript`, this path is excluded from the generic
   * mutation audit in `../trpc`: the input is the recording itself.
   */
  transcribeSegment: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .use(requireFeature("agent"))
    .input(
      z
        .object({
          audio: z.string().min(1).max(SCRIBE_SEGMENT_MAX_BASE64_LENGTH),
          /** Names the recording this part belongs to (chosen by the page). */
          recordingKey: z.string().uuid(),
          previousTail: z
            .string()
            .max(SCRIBE_PREVIOUS_TAIL_MAX_LENGTH)
            .optional(),
          patientName: optionalClinicalTextInput(
            "Patient name",
            SCRIBE_PATIENT_NAME_MAX_LENGTH,
          ),
          species: optionalClinicalTextInput(
            "Species",
            SCRIBE_SPECIES_MAX_LENGTH,
          ),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const { wav, durationSeconds } = readSegmentAudio(input.audio);
      const recording = {
        appointmentId: null,
        recordingKey: input.recordingKey,
        source: "browser" as const,
      };
      await assertRecordingMayContinue(ctx, recording);

      await assertMayCallProvider(ctx, {
        name: "scribe-transcribe",
        perMinute: TRANSCRIBE_RATE_LIMIT,
        message: "Recording is ahead of transcription. It will catch up shortly.",
      });

      let text: string;
      try {
        text = await transcribeScribeSegment({
          wav,
          previousTail: input.previousTail,
          patientName: input.patientName,
          species: input.species,
          vocabulary: await loadScribeVocabulary(ctx.db, ctx.practiceId),
        });
      } catch (e) {
        if (
          e instanceof AgentNotConfiguredError ||
          e instanceof ScribeAudioUnsupportedError
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: e.message,
          });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not transcribe that part of the recording.",
        });
      }

      // Metered by how much audio the server itself measured.
      await meterRecordedAudio(ctx, { ...recording, seconds: durationSeconds });

      return { text };
    }),

  /**
   * Draft a SOAP note from a visit transcript. Nothing is saved to a chart:
   * the clinician reviews the draft and copies it where it belongs.
   *
   * This path is excluded from the generic mutation audit in `../trpc` so the
   * transcript never lands in the audit trail; a content-free entry is written
   * here instead.
   */
  draftFromTranscript: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .use(requireFeature("agent"))
    .input(
      z
        .object({
          transcript: clinicalTextInput(
            "Visit transcript",
            SCRIBE_TRANSCRIPT_MAX_LENGTH,
          ),
          patientName: optionalClinicalTextInput(
            "Patient name",
            SCRIBE_PATIENT_NAME_MAX_LENGTH,
          ),
          species: optionalClinicalTextInput(
            "Species",
            SCRIBE_SPECIES_MAX_LENGTH,
          ),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await assertMayCallProvider(ctx, {
        name: "scribe-draft",
        perMinute: DRAFT_RATE_LIMIT,
        message: "Too many drafts at once. Wait a minute and try again.",
      });

      let draft;
      try {
        draft = await draftScribeNote(input);
      } catch (e) {
        if (e instanceof AgentNotConfiguredError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: e.message,
          });
        }
        if (e instanceof SoapDraftUnavailableError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not draft the note. Try again.",
        });
      }

      // Meter successful drafts like other AI runs (no-op on self-host).
      await recordUsage({ practiceId: ctx.practiceId, kind: "ai_run" });
      await recordScribeAudit(ctx, "drafted", {
        transcriptCharacters: input.transcript.length,
      });

      return draft;
    }),
  // ---------------------------------------------------------------------------
  // Scribe inside a visit. The transcript belongs to the visit (appointment),
  // is drafted into that visit's SOAP note, and is deleted when the note is
  // finalized.
  // ---------------------------------------------------------------------------

  /** The visit's transcript so far, and whether a phone is recording it. */
  visitTranscript: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(z.object({ appointmentId: z.string().guid() }).strict())
    .query(async ({ ctx, input }) => {
      await assertScribeOpen(ctx);
      const visit = await findScribeVisit(
        ctx.db,
        ctx.practiceId,
        input.appointmentId,
      );
      if (!visit) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Visit not found." });
      }
      const [segments, phone, state] = await Promise.all([
        listVisitSegments(ctx.db, ctx.practiceId, visit.id),
        activePhoneLink(ctx.db, ctx.practiceId, visit.id),
        scribeVisitState(ctx.db, ctx.practiceId, visit.id),
      ]);
      const phoneDevice = phone
        ? await findRecording(ctx.db, ctx.practiceId, phone.id)
        : null;
      return {
        /** "open", or why Scribe cannot record this visit right now. */
        state,
        segments: segments.map((segment) => ({
          id: segment.id,
          text: segment.text,
          source: segment.source,
        })),
        phoneRecording: phone
          ? {
              expiresAt: phone.expiresAt,
              /** A phone has opened the link; the code is no longer needed. */
              connected: Boolean(phoneDevice?.deviceKeyHash),
            }
          : null,
      };
    }),

  /** One part of a recording made in the chart on this computer. */
  transcribeVisitSegment: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .use(requireFeature("agent"))
    .input(
      z
        .object({
          appointmentId: z.string().guid(),
          clientKey: z.string().uuid(),
          recordingKey: z.string().uuid(),
          audio: z.string().min(1).max(SCRIBE_SEGMENT_MAX_BASE64_LENGTH),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const { wav, durationSeconds } = readSegmentAudio(input.audio);
      return transcribeIntoVisit(ctx, {
        appointmentId: input.appointmentId,
        clientKey: input.clientKey,
        recordingKey: input.recordingKey,
        wav,
        durationSeconds,
        source: "browser",
      });
    }),

  /** Draft the visit's SOAP note from its transcript and chart. */
  draftVisitNote: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .use(requireFeature("agent"))
    .input(z.object({ appointmentId: z.string().guid() }).strict())
    .mutation(async ({ ctx, input }) => draftVisitNote(ctx, input.appointmentId)),

  /** Throw away the visit's transcript and stop any phone recording. */
  clearVisitTranscript: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(z.object({ appointmentId: z.string().guid() }).strict())
    .mutation(async ({ ctx, input }) => {
      const visit = await findScribeVisit(
        ctx.db,
        ctx.practiceId,
        input.appointmentId,
      );
      if (!visit) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Visit not found." });
      }
      await clearVisitTranscript(ctx.db, ctx.practiceId, visit.id);
      return { cleared: true };
    }),

  /**
   * A link for recording this visit on a phone. Opening a new one closes any
   * earlier link for the visit, so only one phone records at a time.
   */
  startPhoneRecording: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .use(requireFeature("agent"))
    .input(z.object({ appointmentId: z.string().guid() }).strict())
    .mutation(async ({ ctx, input }) => {
      await assertScribeOpen(ctx);
      if (!isScribeAudioConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Recording needs an AI model that accepts audio.",
        });
      }
      const visit = await requireOpenVisit(ctx, input.appointmentId);
      await endPhoneLinks(ctx.db, ctx.practiceId, visit.id);
      const token = generateCaptureToken();
      const expiresAt = new Date(Date.now() + SCRIBE_PHONE_LINK_TTL_MS);
      const [link] = await ctx.db
        .insert(captureSessions)
        .values({
          practiceId: ctx.practiceId,
          patientId: visit.patientId,
          appointmentId: visit.id,
          createdBy: ctx.user.id,
          token,
          expiresAt,
          purpose: "scribe",
        })
        .returning({ id: captureSessions.id });
      // The link is its own recording: one phone, one running audio total.
      await openRecording(ctx.db, {
        practiceId: ctx.practiceId,
        userId: ctx.user.id,
        appointmentId: visit.id,
        recordingKey: link!.id,
        source: "phone",
      });
      return { url: `${appBaseUrl()}/scribe-capture/${token}`, expiresAt };
    }),

  /** Stop accepting recordings from the visit's phone link. */
  endPhoneRecording: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(z.object({ appointmentId: z.string().guid() }).strict())
    .mutation(async ({ ctx, input }) => {
      await endPhoneLinks(ctx.db, ctx.practiceId, input.appointmentId);
      return { ended: true };
    }),
});
