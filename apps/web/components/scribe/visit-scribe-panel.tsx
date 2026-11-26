"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Laptop,
  Loader2,
  Mic,
  NotebookPen,
  Pause,
  Play,
  Smartphone,
  Square,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import type { SoapDraft } from "@/lib/ai/soap-draft";
import { SCRIBE_MAX_RECORDING_SECONDS } from "@/lib/scribe/audio";
import {
  canUseScribeRole,
  scribeRolloutEnabled,
} from "@/lib/scribe/availability";
import {
  rethrowForRecorder,
  SCRIBE_SKIP_CONFIRM,
  useScribeRecorder,
} from "@/lib/scribe/use-scribe-recorder";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  ConsentNotice,
  formatClock,
  RecordingStatus,
  ScribePlanNotice,
} from "@/components/scribe/recorder-parts";

const PHONE_POLL_MS = 3_000;
const AUDIO_FILE_TYPES = "audio/*,.mp3,.m4a,.wav,.aac,.ogg,.webm,.mp4";

/**
 * Whether Scribe can record in a visit for this person: the deployment switch,
 * the clinic's opt-in, a SOAP-writing role, and an AI model that takes audio.
 * With the switch off nothing is fetched at all.
 */
export function useVisitScribe(role?: string | null) {
  const rolloutOn = scribeRolloutEnabled();
  const allowed = rolloutOn && canUseScribeRole(role);
  const availability = trpc.scribe.availability.useQuery(undefined, {
    enabled: allowed,
    staleTime: 60_000,
  });
  const data = availability.data;
  return Boolean(
    allowed && data?.available && data.enabled && data.configured && data.canRecord,
  );
}

/** Why the clinic's plan holds Scribe back right now, if it does. */
function useScribePlanBlock() {
  const availability = trpc.scribe.availability.useQuery(undefined, {
    enabled: scribeRolloutEnabled(),
    staleTime: 60_000,
  });
  return {
    blocked: availability.data?.aiBlocked ?? null,
    canManage: availability.data?.canManage ?? false,
  };
}

type Mode = "idle" | "consent" | "phone-consent";

/** Bring the note into view once Scribe has filled it in: the payoff. */
function showNote() {
  window.requestAnimationFrame(() => {
    const note = document.getElementById("soap-note-sections");
    if (!note) return;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    note.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  });
}

function wordCount(text: string) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Scribe inside a visit's SOAP editor. Records on this computer or on a phone
 * (QR link), or takes an audio file; either way the transcript is kept with
 * the visit until its note is finalized, and "Write note" fills the editor
 * with a draft to review.
 */
export function VisitScribePanel({
  appointmentId,
  noteHasText,
  onDraft,
  disabled,
  startOpen,
}: {
  appointmentId: string;
  /** The editor already holds text that a draft would replace. */
  noteHasText: boolean;
  onDraft: (draft: SoapDraft) => void;
  disabled?: boolean;
  /** Opened from the visit page's "Record visit" button. */
  startOpen?: boolean;
}) {
  const utils = trpc.useUtils();
  const plan = useScribePlanBlock();
  const [mode, setMode] = useState<Mode>(startOpen ? "consent" : "idle");
  const [showTranscript, setShowTranscript] = useState(false);
  const [draftWhenReady, setDraftWhenReady] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // A draft that arrived after the clinician had started typing.
  const [heldDraft, setHeldDraft] = useState<SoapDraft | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const noteHasTextRef = useRef(noteHasText);
  noteHasTextRef.current = noteHasText;

  const transcriptQuery = trpc.scribe.visitTranscript.useQuery(
    { appointmentId },
    {
      refetchInterval: (query) =>
        query.state.data?.phoneRecording ? PHONE_POLL_MS : false,
    },
  );
  const segments = transcriptQuery.data?.segments ?? [];
  const phoneRecording = transcriptQuery.data?.phoneRecording ?? null;
  const visitState = transcriptQuery.data?.state ?? "open";

  const transcribeVisitSegment = trpc.scribe.transcribeVisitSegment.useMutation();
  const transcribeRef = useRef(transcribeVisitSegment.mutateAsync);
  transcribeRef.current = transcribeVisitSegment.mutateAsync;

  const invalidateTranscript = useCallback(
    () => utils.scribe.visitTranscript.invalidate({ appointmentId }),
    [appointmentId, utils],
  );

  const recorder = useScribeRecorder({
    transcribe: useCallback(
      // The server keeps the transcript and sends its own tail as context.
      async ({ previousTail: _previousTail, ...input }) => {
        try {
          return await transcribeRef.current({ appointmentId, ...input });
        } catch (error) {
          return rethrowForRecorder(error);
        }
      },
      [appointmentId],
    ),
    onText: useCallback(() => {
      void invalidateTranscript();
    }, [invalidateTranscript]),
  });

  // Leaving mid-recording would drop the part being recorded.
  useUnsavedChangesGuard(
    recorder.busy,
    "Scribe is still recording or writing down this visit. Leave and lose the part in progress?",
  );

  // Whether the note was empty when the draft was asked for. A draft that
  // comes back to find text there is held rather than typed over.
  const draftStartedEmptyRef = useRef(true);
  const draftVisitNote = trpc.scribe.draftVisitNote.useMutation({
    onSuccess: (draft) => {
      if (draftStartedEmptyRef.current && noteHasTextRef.current) {
        setHeldDraft(draft);
        return;
      }
      onDraft(draft);
      showNote();
      toast.success("Note drafted from the visit. Check every line before you finalize.");
    },
    onError: (error) => toast.error(error.message),
  });

  const startPhone = trpc.scribe.startPhoneRecording.useMutation({
    onSuccess: () => {
      setMode("idle");
      void invalidateTranscript();
    },
    onError: (error) => {
      toast.error(error.message);
      setMode("idle");
    },
  });
  const endPhone = trpc.scribe.endPhoneRecording.useMutation({
    onSuccess: () => void invalidateTranscript(),
    onError: (error) => toast.error(error.message),
  });
  const clearTranscript = trpc.scribe.clearVisitTranscript.useMutation({
    onSuccess: () => {
      setShowTranscript(false);
      void invalidateTranscript();
    },
    onError: (error) => toast.error(error.message),
  });

  // The code is only on screen until a phone has opened the link.
  const phoneUrl =
    phoneRecording && !phoneRecording.connected
      ? (startPhone.data?.url ?? null)
      : null;
  useEffect(() => {
    let cancelled = false;
    if (!phoneUrl) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(phoneUrl, { width: 220, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [phoneUrl]);

  const draftMutate = draftVisitNote.mutate;
  const draftPending = draftVisitNote.isPending;
  const writeNote = useCallback(
    (askFirst: boolean) => {
      if (draftPending) return;
      if (
        askFirst &&
        noteHasTextRef.current &&
        !window.confirm("Replace what is in the note with the Scribe draft?")
      ) {
        return;
      }
      draftStartedEmptyRef.current = !noteHasTextRef.current;
      setHeldDraft(null);
      draftMutate({ appointmentId });
    },
    [appointmentId, draftMutate, draftPending],
  );

  // After "Stop and write note" here: wait for the last of the transcript,
  // then draft, unless something failed or the note already has text.
  useEffect(() => {
    if (!draftWhenReady || recorder.busy) return;
    setDraftWhenReady(false);
    if (recorder.failed || recorder.error) return;
    void invalidateTranscript().then(() => {
      if (!noteHasTextRef.current) writeNote(false);
    });
  }, [
    draftWhenReady,
    invalidateTranscript,
    recorder.busy,
    recorder.error,
    recorder.failed,
    writeNote,
  ]);

  // When the phone finishes, its link closes; draft from what it sent.
  const phoneWasLiveRef = useRef(false);
  const phoneLive = phoneRecording !== null;
  const segmentCount = segments.length;
  useEffect(() => {
    if (phoneLive) {
      phoneWasLiveRef.current = true;
      return;
    }
    if (!phoneWasLiveRef.current) return;
    phoneWasLiveRef.current = false;
    if (segmentCount > 0 && !noteHasTextRef.current) writeNote(false);
  }, [phoneLive, segmentCount, writeNote]);

  // If the visit stops taking recordings while one is running here, let go of
  // the microphone straight away rather than at the next part.
  const recorderReset = recorder.reset;
  const recorderBusy = recorder.busy;
  useEffect(() => {
    if (transcriptQuery.data && transcriptQuery.data.state !== "open" && recorderBusy) {
      recorderReset();
    }
  }, [recorderBusy, recorderReset, transcriptQuery.data]);

  // The note was finalized, or the visit left the exam: nothing to offer.
  if (visitState === "finalized" || visitState === "not_found") return null;

  const recording = recorder.status === "recording";
  const paused = recorder.status === "paused";
  const capturing = recording || paused;
  const reading = recorder.status === "reading";
  const remainingSeconds = SCRIBE_MAX_RECORDING_SECONDS - recorder.elapsedSeconds;
  const transcriptWords = segments.reduce(
    (sum, segment) => sum + wordCount(segment.text),
    0,
  );
  const inExam = visitState === "open";
  const locked = disabled || !inExam;
  const working = recorder.busy || draftPending || startPhone.isPending;

  return (
    <section
      aria-label="Scribe"
      className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Mic className="h-4 w-4 text-primary" />
            Scribe
          </h3>
          <p className="text-xs text-muted-foreground">
            Record the visit and Scribe drafts this note for you to check. The
            transcript is kept with the visit until the note is finalized.
          </p>
        </div>
        {segments.length > 0 && !capturing && !phoneLive && !plan.blocked ? (
          <Button
            size="sm"
            onClick={() => writeNote(true)}
            disabled={locked || draftPending || recorder.busy}
          >
            {draftPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <NotebookPen className="mr-2 h-4 w-4" />
            )}
            {draftPending ? "Writing note..." : "Write note"}
          </Button>
        ) : null}
      </div>

      {!inExam ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Scribe works while the visit is in exam.
        </p>
      ) : plan.blocked && !capturing && !phoneLive ? (
        <ScribePlanNotice blocked={plan.blocked} canManage={plan.canManage} />
      ) : capturing ? (
        <div className="space-y-3">
          <RecordingStatus
            paused={paused}
            interrupted={recorder.interrupted}
            hearingNothing={recorder.hearingNothing}
            elapsedSeconds={recorder.elapsedSeconds}
            level={recorder.level}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                setDraftWhenReady(true);
                recorder.stop();
              }}
            >
              <Square className="mr-2 h-4 w-4" />
              Stop and write note
            </Button>
            {recording && !recorder.interrupted ? (
              <Button variant="outline" onClick={() => void recorder.pause()}>
                <Pause className="mr-2 h-4 w-4" />
                Pause
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void recorder.resume()}>
                <Play className="mr-2 h-4 w-4" />
                Resume
              </Button>
            )}
          </div>
          {remainingSeconds <= 300 ? (
            <p className="text-xs text-muted-foreground">
              Recording stops by itself in {formatClock(Math.max(0, remainingSeconds))}.
            </p>
          ) : null}
        </div>
      ) : mode === "consent" ? (
        <ConsentNotice
          onAgree={() => {
            setMode("idle");
            void recorder.start();
          }}
          onCancel={() => setMode("idle")}
        />
      ) : mode === "phone-consent" ? (
        <ConsentNotice
          agreeLabel="Everyone agrees, show the phone code"
          pending={startPhone.isPending}
          onAgree={() => startPhone.mutate({ appointmentId })}
          onCancel={() => setMode("idle")}
        />
      ) : phoneLive ? (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          {phoneUrl ? (
            <div className="flex h-[220px] w-[220px] shrink-0 items-center justify-center rounded-md border border-border bg-white">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrDataUrl}
                  alt="QR code that opens the visit recorder on a phone"
                  width={220}
                  height={220}
                />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              )}
            </div>
          ) : null}
          <div className="min-w-0 flex-1 space-y-3 text-sm">
            {phoneUrl ? (
              <>
                <p className="font-medium">Scan with the phone&apos;s camera</p>
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>Open the link and tap Record on the phone.</li>
                  <li>Leave the phone near the conversation.</li>
                  <li>Tap Finish on the phone. The note is written here.</li>
                </ol>
                <p
                  className="flex items-center gap-2 text-muted-foreground"
                  role="status"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Waiting for the phone. The code works on one phone only.
                </p>
              </>
            ) : phoneRecording.connected ? (
              <p className="flex items-center gap-2 font-medium" role="status">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                {segments.length > 0
                  ? "The phone is recording. The transcript is coming in below."
                  : "Phone connected. Tap Record on the phone."}
              </p>
            ) : (
              <p className="flex items-center gap-2 font-medium" role="status">
                <Smartphone className="h-4 w-4 text-primary" />
                A phone code is open for this visit. Stop it to show a new one.
              </p>
            )}
            {phoneRecording.connected ? (
              <p className="text-muted-foreground">
                Tap Finish on the phone when the visit is over and the note is
                written here.
              </p>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={endPhone.isPending}
              onClick={() => {
                endPhone.mutate({ appointmentId });
                startPhone.reset();
              }}
            >
              Stop phone recording
            </Button>
          </div>
        </div>
      ) : reading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading the audio file.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setMode("consent")} disabled={locked || working}>
            {recorder.status === "starting" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Laptop className="mr-2 h-4 w-4" />
            )}
            {segments.length > 0 ? "Record more" : "Record on this computer"}
          </Button>
          <Button
            variant="outline"
            onClick={() => setMode("phone-consent")}
            disabled={locked || working}
          >
            <Smartphone className="mr-2 h-4 w-4" />
            Record on a phone
          </Button>
          <Button
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={locked || working}
          >
            <Upload className="mr-2 h-4 w-4" />
            Use an audio file
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept={AUDIO_FILE_TYPES}
            className="sr-only"
            tabIndex={-1}
            aria-label="Audio file of the visit"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                setDraftWhenReady(true);
                void recorder.addFile(file);
              }
            }}
          />
        </div>
      )}

      {recorder.error ? (
        <p className="text-sm text-destructive" role="alert">
          {recorder.error}
        </p>
      ) : null}
      {recorder.pendingSegments > 0 && !recorder.failed ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {capturing
            ? "Writing down what was said as you go."
            : recorder.pendingSegments > 1
              ? `Finishing the transcript: ${recorder.pendingSegments} parts to go.`
              : "Finishing the transcript."}
        </p>
      ) : null}
      {recorder.failed ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert">
          <span>
            Part of the recording could not be transcribed. It is kept on this page.
          </span>
          <Button size="sm" variant="outline" onClick={() => recorder.retry()}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => {
              if (window.confirm(SCRIBE_SKIP_CONFIRM)) recorder.skip();
            }}>
            Skip this part
          </Button>
        </div>
      ) : null}
      {heldDraft ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3 text-sm"
          role="status"
        >
          <span className="min-w-0 flex-1">
            The Scribe draft is ready, but the note has text in it now.
          </span>
          <Button
            size="sm"
            onClick={() => {
              onDraft(heldDraft);
              showNote();
              setHeldDraft(null);
            }}
          >
            Replace with the draft
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setHeldDraft(null)}>
            Keep what I typed
          </Button>
        </div>
      ) : null}

      {segments.length > 0 ? (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="flex items-center gap-1 rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setShowTranscript((open) => !open)}
              aria-expanded={showTranscript}
            >
              {showTranscript ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
              Transcript
              <span className="font-normal text-muted-foreground">
                · {transcriptWords.toLocaleString()}{" "}
                {transcriptWords === 1 ? "word" : "words"}
              </span>
            </button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={capturing || phoneLive || recorder.busy || clearTranscript.isPending}
              onClick={() => {
                if (window.confirm("Delete this visit's transcript?")) {
                  clearTranscript.mutate({ appointmentId });
                }
              }}
            >
              Clear transcript
            </Button>
          </div>
          {showTranscript || capturing || phoneLive ? (
            <div
              className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border bg-card p-3 text-sm"
              aria-live="polite"
            >
              {(showTranscript ? segments : segments.slice(-3)).map((segment) => (
                <p key={segment.id} className="whitespace-pre-wrap break-words">
                  {segment.source === "phone" ? (
                    <Smartphone
                      className="mr-1.5 inline h-3 w-3 text-muted-foreground"
                      aria-label="From the phone"
                    />
                  ) : null}
                  {segment.text}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** "Record visit" on the visit page: opens the SOAP editor ready to record. */
export function RecordVisitButton({
  role,
  patientId,
  appointmentId,
  size = "sm",
}: {
  role?: string | null;
  patientId: string;
  appointmentId: string;
  size?: "sm" | "default";
}) {
  const usable = useVisitScribe(role);
  if (!usable) return null;
  return (
    <Button size={size} variant="outline" asChild>
      <a
        href={`/records/new-soap/${patientId}?appointmentId=${appointmentId}&scribe=1`}
      >
        <Mic className="mr-2 h-4 w-4" />
        Record visit
      </a>
    </Button>
  );
}
