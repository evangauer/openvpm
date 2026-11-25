"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Mic, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SCRIBE_MAX_RECORDING_SECONDS } from "@/lib/scribe/audio";
import {
  ScribeBusyError,
  ScribeTerminalError,
  SCRIBE_SKIP_CONFIRM,
  useScribeRecorder,
} from "@/lib/scribe/use-scribe-recorder";
import { formatClock, RecordingStatus } from "@/components/scribe/recorder-parts";

type LinkState = "checking" | "open" | "closed" | "in-use" | "finished";

class LinkClosedError extends Error {}
class LinkInUseError extends Error {}

const DEVICE_STORAGE_KEY = "openvpm-scribe-device";
let memoryDeviceKey: string | null = null;

/**
 * A random secret that stays on this phone. The server ties a recording link
 * to the first phone that opens it, so a copy of the link is no use on another
 * device. It names nothing about the person or the phone.
 */
function deviceKey(): string {
  try {
    const stored = window.localStorage.getItem(DEVICE_STORAGE_KEY);
    if (stored && /^[a-f0-9]{32,64}$/.test(stored)) return stored;
  } catch {
    // Private browsing or blocked storage: keep it for this page only.
  }
  if (!memoryDeviceKey) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    memoryDeviceKey = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  try {
    window.localStorage.setItem(DEVICE_STORAGE_KEY, memoryDeviceKey);
  } catch {
    // Kept in memory instead.
  }
  return memoryDeviceKey;
}

async function post(token: string, body: unknown) {
  const response = await fetch(`/api/scribe-capture/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scribe-Device": deviceKey(),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await response.json().catch(() => ({}))) as {
    heardSpeech?: boolean;
    error?: string;
  };
  if (response.status === 404) throw new LinkClosedError();
  if (response.status === 409 && !("audio" in (body as object))) {
    throw new LinkInUseError();
  }
  if (response.status === 429) throw new ScribeBusyError();
  if (response.status >= 400 && response.status < 500) {
    throw new ScribeTerminalError(json.error ?? "Recording has stopped.");
  }
  if (!response.ok) throw new Error(json.error ?? "Something went wrong.");
  return json;
}

/**
 * The phone side of Scribe. Records in short stretches and sends each one to
 * the visit; the transcript and the note appear in the chart, not here.
 */
export function ScribeCaptureClient({ token }: { token: string }) {
  const [link, setLink] = useState<LinkState>("checking");
  const [sentParts, setSentParts] = useState(0);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    post(token, { action: "check" })
      .then(() => !cancelled && setLink("open"))
      .catch((error) => {
        if (cancelled) return;
        setLink(error instanceof LinkInUseError ? "in-use" : "closed");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const recorder = useScribeRecorder({
    transcribe: useCallback(
      async ({ audio, clientKey }) => {
        try {
          const result = await post(token, { audio, clientKey });
          return { text: result.heardSpeech ? "speech" : "" };
        } catch (error) {
          if (error instanceof LinkClosedError) {
            setLink("closed");
            // The chart stopped this recording; let go of the microphone.
            throw new ScribeTerminalError(
              "Recording was stopped in the chart.",
            );
          }
          throw error;
        }
      },
      [token],
    ),
    onText: useCallback(() => setSentParts((count) => count + 1), []),
  });

  // "Finish": stop, wait for every part to arrive, then close the link so the
  // chart knows to write the note.
  const finishRequested = useRef(false);
  useEffect(() => {
    if (!finishing || recorder.busy || finishRequested.current) return;
    if (link !== "open") return;
    if (recorder.failed) {
      // Something is still on this phone; Try again or Skip decides.
      return;
    }
    if (recorder.error && sentParts === 0) {
      // Nothing was heard at all: keep the link open so they can try again.
      setFinishing(false);
      return;
    }
    finishRequested.current = true;
    post(token, { action: "finish" })
      .catch(() => {})
      .finally(() => setLink("finished"));
  }, [finishing, link, recorder.busy, recorder.error, recorder.failed, sentParts, token]);

  const recording = recorder.status === "recording";
  const paused = recorder.status === "paused";
  const capturing = recording || paused;
  const remainingSeconds = SCRIBE_MAX_RECORDING_SECONDS - recorder.elapsedSeconds;

  if (link === "checking") {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening the recorder...
      </p>
    );
  }

  if (link === "in-use") {
    return (
      <div className="space-y-2">
        <h1 className="text-lg font-semibold text-gray-900">
          This code is already in use
        </h1>
        <p className="text-sm text-gray-600">
          Each code works on one phone. To record on this phone, stop phone
          recording in the visit&apos;s note and show a new code.
        </p>
      </div>
    );
  }

  if (link === "closed") {
    return (
      <div className="space-y-2">
        <h1 className="text-lg font-semibold text-gray-900">This link is closed</h1>
        <p className="text-sm text-gray-600">
          It has expired or recording was stopped in the chart.
          {sentParts > 0
            ? " What this phone already sent is in the visit's note."
            : ""}{" "}
          Show a new code from the visit&apos;s note to keep recording.
        </p>
      </div>
    );
  }

  if (link === "finished") {
    return (
      <div className="space-y-2">
        <CheckCircle2 className="h-8 w-8 text-teal-600" />
        <h1 className="text-lg font-semibold text-gray-900">Recording sent</h1>
        <p className="text-sm text-gray-600">
          The note is being written in the chart. You can close this page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-gray-900">Record the visit</h1>
        <p className="text-sm text-gray-600">
          Keep this page open and the phone near the conversation. Audio is sent
          to be written up and is not kept.
        </p>
      </div>

      {capturing ? (
        <div className="space-y-4">
          <RecordingStatus
            paused={paused}
            interrupted={recorder.interrupted}
            hearingNothing={recorder.hearingNothing}
            elapsedSeconds={recorder.elapsedSeconds}
            level={recorder.level}
          />
          <div className="grid grid-cols-2 gap-3">
            {recording && !recorder.interrupted ? (
              <Button
                variant="outline"
                size="lg"
                className="h-14"
                onClick={() => void recorder.pause()}
              >
                <Pause className="mr-2 h-5 w-5" /> Pause
              </Button>
            ) : (
              <Button
                variant="outline"
                size="lg"
                className="h-14"
                onClick={() => void recorder.resume()}
              >
                <Play className="mr-2 h-5 w-5" /> Resume
              </Button>
            )}
            <Button
              size="lg"
              className="h-14"
              onClick={() => {
                setFinishing(true);
                recorder.stop();
              }}
            >
              <Square className="mr-2 h-5 w-5" /> Finish
            </Button>
          </div>
          {remainingSeconds <= 300 ? (
            <p className="text-xs text-gray-500">
              Recording stops by itself in {formatClock(Math.max(0, remainingSeconds))}.
            </p>
          ) : null}
        </div>
      ) : finishing && !recorder.failed ? (
        <p className="flex items-center gap-2 text-sm text-gray-600" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Sending the last of the recording...
        </p>
      ) : (
        <div className="space-y-3">
          <Button
            size="lg"
            className="h-16 w-full text-base"
            onClick={() => {
              setFinishing(false);
              void recorder.start();
            }}
            disabled={recorder.status === "starting" || recorder.failed}
          >
            {recorder.status === "starting" ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <Mic className="mr-2 h-5 w-5" />
            )}
            {sentParts > 0 ? "Record more" : "Record"}
          </Button>
          {sentParts > 0 && !recorder.busy && !recorder.failed ? (
            <Button
              size="lg"
              variant="outline"
              className="h-14 w-full"
              onClick={() => setFinishing(true)}
            >
              Finish and write the note
            </Button>
          ) : null}
        </div>
      )}

      {sentParts > 0 || recorder.pendingSegments > 0 ? (
        <p className="text-sm text-gray-600" role="status">
          {sentParts} {sentParts === 1 ? "part" : "parts"} sent to the chart
          {recorder.pendingSegments > 0 ? `, ${recorder.pendingSegments} on the way` : ""}.
        </p>
      ) : null}
      {recorder.error ? (
        <p className="text-sm text-red-600" role="alert">
          {recorder.error}
        </p>
      ) : null}
      {recorder.failed ? (
        <div className="space-y-2 text-sm text-red-600" role="alert">
          <p>
            Part of the recording could not be sent. It is kept on this phone
            while this page stays open.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" onClick={() => recorder.retry()}>
              Try again
            </Button>
            <Button variant="ghost" onClick={() => {
              if (window.confirm(SCRIBE_SKIP_CONFIRM)) recorder.skip();
            }}>
              Skip this part
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
