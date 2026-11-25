"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Mic,
  NotebookPen,
  Pause,
  Play,
  Square,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/form-field";
import { EmptyState } from "@/components/common/empty-state";
import type { SoapDraft } from "@/lib/ai/soap-draft";
import { SCRIBE_MAX_RECORDING_SECONDS } from "@/lib/scribe/audio";
import {
  canUseScribeRole,
  scribeRolloutEnabled,
} from "@/lib/scribe/availability";
import {
  formatScribeNote,
  SCRIBE_PATIENT_NAME_MAX_LENGTH,
  SCRIBE_SECTIONS,
  SCRIBE_SPECIES_MAX_LENGTH,
  SCRIBE_TRANSCRIPT_MAX_LENGTH,
} from "@/lib/scribe/policy";
import {
  rethrowForRecorder,
  SCRIBE_SKIP_CONFIRM,
  useScribeRecorder,
} from "@/lib/scribe/use-scribe-recorder";
import {
  ConsentNotice,
  RecordingStatus,
} from "@/components/scribe/recorder-parts";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

export default function ScribePage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking Scribe access...
        </div>
      </div>
    );
  }

  if (!scribeRolloutEnabled() || !canUseScribeRole(session?.user?.role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={NotebookPen}
          title="Scribe is not available"
          description="Scribe is open to administrators and veterinarians where it has been switched on."
          action={{
            label: "Back to dashboard",
            onClick: () => router.push("/"),
          }}
        />
      </div>
    );
  }

  return <ScribeWorkspace />;
}

function ScribeWorkspace() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const availability = trpc.scribe.availability.useQuery(undefined, {
    retry: false,
  });
  const setEnabled = trpc.scribe.setEnabled.useMutation({
    onSuccess: async () => {
      await utils.scribe.availability.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  if (availability.isLoading) {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Scribe...
        </div>
      </div>
    );
  }

  if (!availability.data?.available) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={NotebookPen}
          title="Scribe is not available"
          description={
            availability.error
              ? "We could not check Scribe for this clinic. Reload the page to try again."
              : "Scribe is open to administrators and veterinarians where it has been switched on."
          }
          action={{
            label: "Back to dashboard",
            onClick: () => router.push("/"),
          }}
        />
      </div>
    );
  }

  const { enabled, canManage, configured, canRecord } = availability.data;

  if (!enabled) {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card p-6">
        <div className="flex items-start gap-3">
          <NotebookPen className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="space-y-3">
            <div>
              <h1 className="font-heading text-lg font-semibold">
                Scribe is off for this clinic
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Scribe listens to a visit and drafts a SOAP note from what was
                said. The recording and its transcript are sent to the
                clinic&apos;s AI provider to write the draft. OpenVPM does not
                keep the recording, nothing is saved to a chart, and the
                clinician reviews every note before using it.
              </p>
            </div>
            {canManage ? (
              <Button
                onClick={() => setEnabled.mutate({ enabled: true })}
                disabled={setEnabled.isPending}
              >
                {setEnabled.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Turn on Scribe for this clinic
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ask a clinic administrator to turn it on.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <ScribeTool configured={configured} canRecord={canRecord} />
      {canManage ? (
        <p className="text-xs text-muted-foreground">
          Scribe is on for this clinic.{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
            onClick={() => setEnabled.mutate({ enabled: false })}
            disabled={setEnabled.isPending}
          >
            Turn it off
          </button>
        </p>
      ) : null}
    </div>
  );
}

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ScribeTool({
  configured,
  canRecord,
}: {
  configured: boolean;
  canRecord: boolean;
}) {
  const [patientName, setPatientName] = useState("");
  const [species, setSpecies] = useState("");
  const [transcript, setTranscript] = useState("");
  const [draft, setDraft] = useState<SoapDraft | null>(null);
  const [edited, setEdited] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Set when a recording is stopped: write the note once its text is all in.
  const [draftWhenReady, setDraftWhenReady] = useState(false);

  const draftNote = trpc.scribe.draftFromTranscript.useMutation({
    onSuccess: (result) => {
      setDraft(result);
      setEdited(false);
    },
  });
  const transcribeSegment = trpc.scribe.transcribeSegment.useMutation();

  // The recorder needs the latest patient details without restarting.
  const patientRef = useRef({ patientName, species });
  patientRef.current = { patientName, species };

  const transcribeRef = useRef(transcribeSegment.mutateAsync);
  transcribeRef.current = transcribeSegment.mutateAsync;

  const recorder = useScribeRecorder({
    transcribe: useCallback(
      // The standalone page keeps its transcript in the browser, so it has no
      // stored segment to deduplicate and does not send the key.
      async ({ clientKey: _clientKey, ...input }) => {
        try {
          return await transcribeRef.current({
            ...input,
            patientName: patientRef.current.patientName.trim() || undefined,
            species: patientRef.current.species.trim() || undefined,
          });
        } catch (error) {
          return rethrowForRecorder(error);
        }
      },
      [],
    ),
    onText: useCallback(
      (text: string) =>
        setTranscript((current) =>
          current.trim() ? `${current.trimEnd()}\n${text}` : text,
        ),
      [],
    ),
  });

  const transcriptLength = transcript.trim().length;
  const transcriptTooLong = transcriptLength > SCRIBE_TRANSCRIPT_MAX_LENGTH;
  const canDraft =
    configured &&
    transcriptLength > 0 &&
    !transcriptTooLong &&
    !draftNote.isPending &&
    !recorder.busy;

  // The page keeps nothing once you leave, so warn before work is lost.
  useUnsavedChangesGuard(
    transcriptLength > 0 || draft !== null || recorder.busy,
    "This recording, transcript and note are not saved anywhere. Leave without copying them?",
  );

  const draftMutate = draftNote.mutate;
  const sendDraft = useCallback(() => {
    draftMutate({
      transcript: transcript.trim(),
      patientName: patientName.trim() || undefined,
      species: species.trim() || undefined,
    });
  }, [draftMutate, patientName, species, transcript]);

  // After "Stop and write note": wait for the last of the transcript, then
  // draft. If part of the recording failed, leave it to the clinician.
  useEffect(() => {
    if (!draftWhenReady || recorder.busy) return;
    if (recorder.failed) return;
    setDraftWhenReady(false);
    if (recorder.error) return;
    if (
      configured &&
      transcript.trim().length > 0 &&
      transcript.trim().length <= SCRIBE_TRANSCRIPT_MAX_LENGTH
    ) {
      sendDraft();
    }
  }, [
    configured,
    draftWhenReady,
    recorder.busy,
    recorder.error,
    recorder.failed,
    sendDraft,
    transcript,
  ]);

  function requestDraft() {
    // A new draft replaces the note on screen, including the clinician's edits.
    if (
      edited &&
      !window.confirm("Drafting again replaces the edits you made. Continue?")
    ) {
      return;
    }
    sendDraft();
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(
        () => setCopied((current) => (current === key ? null : current)),
        2000,
      );
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }

  function startOver() {
    recorder.reset();
    setDraftWhenReady(false);
    setConsentOpen(false);
    setPatientName("");
    setSpecies("");
    setTranscript("");
    setDraft(null);
    setEdited(false);
    setCopied(null);
    draftNote.reset();
  }

  const recording = recorder.status === "recording";
  const paused = recorder.status === "paused";
  const capturing = recording || paused;
  const reading = recorder.status === "reading";
  const remainingSeconds =
    SCRIBE_MAX_RECORDING_SECONDS - recorder.elapsedSeconds;

  return (
    <>
      <div>
        <h1 className="font-heading text-xl font-semibold">Scribe</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Record the visit, or paste or type what was said. Scribe drafts a
          SOAP note for you to check and copy into your records. Nothing here
          is saved to a chart.
        </p>
      </div>

      {!configured ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          AI is not set up for this workspace yet, so Scribe cannot draft notes.
        </div>
      ) : null}

      <section className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Patient name"
            htmlFor="scribe-patient"
            description="Optional"
          >
            <Input
              id="scribe-patient"
              value={patientName}
              maxLength={SCRIBE_PATIENT_NAME_MAX_LENGTH}
              onChange={(event) => setPatientName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label="Species"
            htmlFor="scribe-species"
            description="Optional"
          >
            <Input
              id="scribe-species"
              value={species}
              maxLength={SCRIBE_SPECIES_MAX_LENGTH}
              onChange={(event) => setSpecies(event.target.value)}
              autoComplete="off"
            />
          </FormField>
        </div>

        {configured && canRecord ? (
          <div
            className="space-y-3 rounded-md border border-border p-4"
            aria-label="Visit recording"
          >
            {capturing ? (
              <>
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
                    <Button variant="outline" onClick={() => recorder.pause()}>
                      <Pause className="mr-2 h-4 w-4" />
                      Pause
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => recorder.resume()}>
                      <Play className="mr-2 h-4 w-4" />
                      Resume
                    </Button>
                  )}
                </div>
                {remainingSeconds <= 300 ? (
                  <p className="text-xs text-muted-foreground">
                    Recording stops by itself in{" "}
                    {formatClock(Math.max(0, remainingSeconds))}.
                  </p>
                ) : null}
              </>
            ) : consentOpen ? (
              <ConsentNotice
                onAgree={() => {
                  setConsentOpen(false);
                  void recorder.start();
                }}
                onCancel={() => setConsentOpen(false)}
              />
            ) : reading ? (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Reading the audio file.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => setConsentOpen(true)}
                  disabled={recorder.busy || draftNote.isPending}
                >
                  {recorder.status === "starting" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Mic className="mr-2 h-4 w-4" />
                  )}
                  {transcriptLength > 0 ? "Record more" : "Record the visit"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={recorder.busy || draftNote.isPending}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Use an audio file
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.webm,.mp4"
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
                <p className="text-sm text-muted-foreground">
                  Keep this tab open while you record.
                </p>
              </div>
            )}

            {recorder.pendingSegments > 0 && !recorder.failed ? (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {capturing
                  ? "Writing down what was said as you go."
                  : recorder.pendingSegments > 1
                    ? `Finishing the transcript: ${recorder.pendingSegments} parts to go.`
                    : "Finishing the transcript."}
              </p>
            ) : null}
            {recorder.failed ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 text-sm text-destructive"
              >
                <span>
                  Part of the recording could not be transcribed. It is kept on
                  this page.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => recorder.retry()}
                >
                  Try again
                </Button>
                <Button variant="ghost" size="sm" onClick={() => {
              if (window.confirm(SCRIBE_SKIP_CONFIRM)) recorder.skip();
            }}>
                  Skip this part
                </Button>
              </div>
            ) : null}
            {recorder.error ? (
              <p role="alert" className="text-sm text-destructive">
                {recorder.error}
              </p>
            ) : null}
          </div>
        ) : configured ? (
          <p className="text-sm text-muted-foreground">
            Recording is not set up for this workspace. You can still paste or
            type the visit below.
          </p>
        ) : null}

        <FormField
          label="Visit transcript"
          htmlFor="scribe-transcript"
          error={
            transcriptTooLong
              ? `Shorten the transcript to ${SCRIBE_TRANSCRIPT_MAX_LENGTH.toLocaleString()} characters or fewer.`
              : null
          }
          description={
            recorder.busy
              ? "You can edit this once the recording has been written down."
              : `${transcriptLength.toLocaleString()} of ${SCRIBE_TRANSCRIPT_MAX_LENGTH.toLocaleString()} characters`
          }
        >
          <Textarea
            id="scribe-transcript"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            readOnly={recorder.busy}
            aria-invalid={transcriptTooLong}
            className="min-h-48"
            placeholder="What the owner reported, what you found, and what you decided."
          />
        </FormField>
        {draftNote.error ? (
          <p role="alert" className="text-sm text-destructive">
            {draftNote.error.message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={requestDraft} disabled={!canDraft}>
            {draftNote.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {draft ? "Draft again" : "Draft note"}
          </Button>
          {transcriptLength > 0 || draft || recorder.busy ? (
            <Button
              variant="ghost"
              onClick={startOver}
              disabled={draftNote.isPending}
            >
              Start over
            </Button>
          ) : null}
        </div>
      </section>

      {draft ? (
        <section
          aria-label="Draft note"
          className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-lg font-semibold">Draft note</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Check every line before you use it. Scribe can miss or
                misread what was said.
              </p>
            </div>
            <Button
              onClick={() => copy("all", formatScribeNote(draft))}
              disabled={formatScribeNote(draft).length === 0}
            >
              {copied === "all" ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              {copied === "all" ? "Copied" : "Copy full note"}
            </Button>
          </div>
          {SCRIBE_SECTIONS.map(({ key, label }) => (
            <div key={key} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={`scribe-${key}`}
                  className="text-sm font-medium"
                >
                  {label}
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copy(key, draft[key].trim())}
                  disabled={draft[key].trim().length === 0}
                  aria-label={`Copy ${label}`}
                >
                  {copied === key ? (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {copied === key ? "Copied" : "Copy"}
                </Button>
              </div>
              <Textarea
                id={`scribe-${key}`}
                value={draft[key]}
                onChange={(event) => {
                  setDraft({ ...draft, [key]: event.target.value });
                  setEdited(true);
                }}
                className="min-h-28"
              />
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
