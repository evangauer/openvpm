"use client";

import { Loader2, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Small pieces shared by every place Scribe records: the chart, and the phone
 * page behind a QR link.
 */

export function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function RecordingStatus({
  paused,
  interrupted = false,
  hearingNothing = false,
  elapsedSeconds,
  level,
}: {
  paused: boolean;
  /** The browser suspended the recording behind our back. */
  interrupted?: boolean;
  /** Recording, but nothing at speech level for a while. */
  hearingNothing?: boolean;
  elapsedSeconds: number;
  level: number;
}) {
  const stopped = paused || interrupted;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm font-medium" role="status">
          <span
            aria-hidden="true"
            className={
              stopped
                ? "h-2.5 w-2.5 rounded-full bg-muted-foreground"
                : "h-2.5 w-2.5 animate-pulse rounded-full bg-destructive motion-reduce:animate-none"
            }
          />
          {interrupted ? "Recording interrupted" : paused ? "Paused" : "Recording"}
        </span>
        <span className="font-mono text-sm tabular-nums">
          {formatClock(elapsedSeconds)}
        </span>
        <MicLevel level={stopped ? 0 : level} />
      </div>
      {interrupted ? (
        <p className="text-sm text-amber-700 dark:text-amber-400" role="alert">
          Something else took over the microphone, so nothing is being recorded.
          Press Resume to carry on.
        </p>
      ) : hearingNothing ? (
        <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
          Scribe isn&apos;t hearing anything. If people are talking, check that
          the right microphone is chosen and not muted.
        </p>
      ) : null}
    </div>
  );
}

const LEVEL_BARS = 12;

/** A small input meter: bars that light up with how loud the room is. */
function MicLevel({ level }: { level: number }) {
  const lit = Math.round(Math.min(1, Math.max(0, level)) * LEVEL_BARS);
  return (
    <div
      className="flex h-4 items-end gap-0.5"
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
    >
      {Array.from({ length: LEVEL_BARS }, (_, bar) => (
        <span
          key={bar}
          className={
            bar < lit
              ? "h-full w-1 rounded-sm bg-primary"
              : "h-1.5 w-1 rounded-sm bg-muted-foreground/30"
          }
        />
      ))}
    </div>
  );
}

export function ConsentNotice({
  onAgree,
  onCancel,
  agreeLabel = "Everyone agrees, start recording",
  pending = false,
}: {
  onAgree: () => void;
  onCancel: () => void;
  agreeLabel?: string;
  pending?: boolean;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="font-medium">Before you record.</span> Make sure
        everyone in the room knows the visit is being recorded and agrees to
        it. The recording is sent to the clinic&apos;s AI provider to be written
        up and is not kept by OpenVPM.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onAgree} disabled={pending}>
          {pending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Mic className="mr-2 h-4 w-4" />
          )}
          {agreeLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
