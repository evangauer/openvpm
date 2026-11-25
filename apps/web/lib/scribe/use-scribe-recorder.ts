"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  bytesToBase64,
  Downsampler,
  encodeWav,
  floatToPcm16,
  SCRIBE_MAX_RECORDING_SECONDS,
  pcmRms,
  SCRIBE_SAMPLE_RATE,
  SCRIBE_SOUND_RMS,
  SegmentCutter,
  type ScribeSegment,
} from "./audio";
import { SCRIBE_PREVIOUS_TAIL_LENGTH } from "./policy";

/**
 * Records the visit in the browser and feeds it to the server one short
 * segment at a time. Audio lives in memory only: a segment is dropped as soon
 * as its text comes back, and everything is dropped when the page is left.
 */

export type ScribeRecorderStatus =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  /** Reading an uploaded audio file into segments. */
  | "reading";

/**
 * The server will not take any more of this recording (the visit's note was
 * finalized, the link was closed, Scribe was turned off). Retrying cannot
 * help, so the recorder stops and shows the message.
 */
export class ScribeTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScribeTerminalError";
  }
}

/** The server asked the recorder to slow down. Wait, then send again. */
export class ScribeBusyError extends Error {
  constructor() {
    super("busy");
    this.name = "ScribeBusyError";
  }
}

/**
 * Turn a failed server call into what the recorder should do about it: slow
 * down, stop for good, or (anything else) try the part again.
 */
export function rethrowForRecorder(error: unknown): never {
  const status =
    error && typeof error === "object" && "data" in error
      ? (error as { data?: { httpStatus?: number } | null }).data?.httpStatus
      : undefined;
  if (status === 429) throw new ScribeBusyError();
  if (status !== undefined && status >= 400 && status < 500) {
    throw new ScribeTerminalError(
      error instanceof Error && error.message
        ? error.message
        : "Scribe has stopped recording.",
    );
  }
  throw error;
}

export type TranscribeSegment = (input: {
  audio: string;
  /** Stable across retries of the same segment, so it is stored once. */
  clientKey: string;
  /** Names the recording this segment belongs to. */
  recordingKey: string;
  previousTail?: string;
}) => Promise<{ text: string }>;

type QueuedSegment = {
  clientKey: string;
  recordingKey: string;
  wav: Uint8Array;
};

type WakeLock = { release: () => Promise<void> };

const WORKLET_URL = "/scribe-pcm-capture.js";
const RETRY_DELAYS_MS = [1500, 4000];
const BUSY_DELAY_MS = 6000;
const BUSY_MAX_WAITS = 20;
/** Uploaded files are held in memory while they are read. */
export const SCRIBE_SKIP_CONFIRM =
  "Leave this part out? Up to 30 seconds of the visit will be missing from the transcript.";

/** Seconds of silence while recording before the screen asks about the mic. */
export const SCRIBE_QUIET_WARNING_SECONDS = 15;

export const SCRIBE_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

function describeStartError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The microphone is blocked for this site. Allow it in your browser, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Connect one, then try again.";
  }
  if (name === "NotReadableError") {
    return "Another app is using the microphone. Close it, then try again.";
  }
  return "Recording could not start in this browser. Try Chrome, Edge or Safari, or use an audio file instead.";
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function requestWakeLock(): Promise<WakeLock | null> {
  try {
    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLock> };
      }
    ).wakeLock;
    return (await wakeLock?.request("screen")) ?? null;
  } catch {
    // A sleeping screen is an inconvenience, not a reason to fail.
    return null;
  }
}

export function useScribeRecorder(options: {
  transcribe: TranscribeSegment;
  /** Called once per segment, in order, with that segment's text. */
  onText: (text: string) => void;
}) {
  const [status, setStatus] = useState<ScribeRecorderStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [pendingSegments, setPendingSegments] = useState(0);
  const [failed, setFailed] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [hearingNothing, setHearingNothing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const statusRef = useRef(status);
  statusRef.current = status;

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const cutterRef = useRef<SegmentCutter | null>(null);
  const samplesRef = useRef(0);
  const lastTickRef = useRef(0);
  // Recording time (seconds) when speech-level sound was last heard.
  const lastSoundRef = useRef(0);
  // Whether this recording has sent any stretch with speech in it.
  const heardSpeechRef = useRef(false);
  const queueRef = useRef<QueuedSegment[]>([]);
  const drainingRef = useRef(false);
  const tailRef = useRef("");
  const recordingKeyRef = useRef("");
  // Bumped whenever everything in flight must be abandoned (reset, unmount, a
  // terminal answer from the server). Anything that awaits compares it after.
  const generationRef = useRef(0);
  const wakeLockRef = useRef<WakeLock | null>(null);
  const stopRef = useRef<() => void>(() => {});

  const releaseDevices = useCallback(() => {
    nodeRef.current?.port.close();
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    void wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setLevel(0);
    setInterrupted(false);
  }, []);

  /** Abandon everything: devices, audio waiting to be sent, and uploads. */
  const abandon = useCallback(() => {
    generationRef.current += 1;
    releaseDevices();
    cutterRef.current = null;
    queueRef.current = [];
    tailRef.current = "";
    drainingRef.current = false;
    setPendingSegments(0);
    setFailed(false);
    setElapsedSeconds(0);
    setStatus("idle");
  }, [releaseDevices]);

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    const generation = generationRef.current;
    try {
      while (queueRef.current.length > 0) {
        const segment = queueRef.current[0]!;
        let text: string | null = null;
        let attempts = 0;
        let busyWaits = 0;
        for (;;) {
          try {
            const result = await optionsRef.current.transcribe({
              audio: bytesToBase64(segment.wav),
              clientKey: segment.clientKey,
              recordingKey: segment.recordingKey,
              previousTail: tailRef.current || undefined,
            });
            text = result.text;
            break;
          } catch (caught) {
            if (generation !== generationRef.current) return;
            if (caught instanceof ScribeTerminalError) {
              abandon();
              setError(caught.message);
              return;
            }
            if (caught instanceof ScribeBusyError && busyWaits < BUSY_MAX_WAITS) {
              busyWaits += 1;
              await wait(BUSY_DELAY_MS);
            } else if (attempts < RETRY_DELAYS_MS.length) {
              await wait(RETRY_DELAYS_MS[attempts]!);
              attempts += 1;
            } else {
              break;
            }
            if (generation !== generationRef.current) return;
          }
        }
        if (generation !== generationRef.current) return;
        if (text === null) {
          // Keep the audio and everything behind it; the clinician can retry
          // or skip this part.
          setFailed(true);
          return;
        }
        setFailed(false);
        queueRef.current.shift();
        setPendingSegments(queueRef.current.length);
        if (text) {
          tailRef.current = `${tailRef.current} ${text}`
            .trim()
            .slice(-SCRIBE_PREVIOUS_TAIL_LENGTH);
          optionsRef.current.onText(text);
        }
      }
    } finally {
      // After a reset a newer drain may already be running; leave its flag be.
      if (generation === generationRef.current) drainingRef.current = false;
    }
  }, [abandon]);

  const enqueue = useCallback(
    (segment: ScribeSegment) => {
      // Near-silent stretches are not worth a provider call.
      if (!segment.hasSound) return;
      heardSpeechRef.current = true;
      queueRef.current.push({
        clientKey: crypto.randomUUID(),
        recordingKey: recordingKeyRef.current,
        wav: encodeWav(segment.pcm),
      });
      setPendingSegments(queueRef.current.length);
      void drain();
    },
    [drain],
  );

  const stop = useCallback(() => {
    if (!contextRef.current && !streamRef.current) return;
    releaseDevices();
    const last = cutterRef.current?.flush();
    const wasRecording = cutterRef.current !== null;
    cutterRef.current = null;
    if (last) enqueue(last);
    // Otherwise "Stop" on a muted microphone ends with nothing and no reason.
    if (wasRecording && !heardSpeechRef.current) {
      setError(
        "No speech was heard in that recording, so there is nothing to write up. Check the microphone and try again.",
      );
    }
    setStatus("idle");
  }, [enqueue, releaseDevices]);
  stopRef.current = stop;

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    const generation = generationRef.current;
    setError(null);
    setFailed(false);
    setStatus("starting");

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    // The page may be left, or the recorder reset, while the browser is still
    // asking for the microphone. Whatever was opened by then is closed again
    // here, so a microphone can never be left on with nothing on screen.
    const abandoned = () => {
      if (generation === generationRef.current) return false;
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
      return true;
    };

    try {
      if (
        typeof AudioWorkletNode === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        throw new Error("unsupported");
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (abandoned()) return;

      // Ask for 16 kHz directly; where the browser cannot join a microphone
      // to a context at another rate, fall back to its own rate and
      // downsample here.
      let source: MediaStreamAudioSourceNode;
      try {
        context = new AudioContext({ sampleRate: SCRIBE_SAMPLE_RATE });
        source = context.createMediaStreamSource(stream);
      } catch {
        void context?.close().catch(() => {});
        context = new AudioContext();
        source = context.createMediaStreamSource(stream);
      }
      await context.audioWorklet.addModule(WORKLET_URL);
      if (abandoned()) return;
      await context.resume();
      if (abandoned()) return;

      const liveContext = context;
      const liveStream = stream;
      streamRef.current = liveStream;
      contextRef.current = liveContext;

      const downsampler = new Downsampler(liveContext.sampleRate);
      const cutter = new SegmentCutter();
      cutterRef.current = cutter;
      recordingKeyRef.current = crypto.randomUUID();
      samplesRef.current = 0;
      lastSoundRef.current = 0;
      heardSpeechRef.current = false;
      lastTickRef.current = 0;
      setElapsedSeconds(0);

      const node = new AudioWorkletNode(liveContext, "scribe-pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (cutterRef.current !== cutter) return;
        const block = downsampler.push(event.data);
        if (block.length === 0) return;
        const pcm = floatToPcm16(block);
        samplesRef.current += pcm.length;
        for (const segment of cutter.push(pcm)) enqueue(segment);

        // Update the clock and meter about ten times a second.
        const now = samplesRef.current / SCRIBE_SAMPLE_RATE;
        if (pcmRms(pcm) >= SCRIBE_SOUND_RMS) lastSoundRef.current = now;
        if (now - lastTickRef.current >= 0.1) {
          lastTickRef.current = now;
          let peak = 0;
          for (let i = 0; i < block.length; i += 1) {
            const value = Math.abs(block[i]!);
            if (value > peak) peak = value;
          }
          setLevel(Math.min(1, peak * 1.6));
          setElapsedSeconds(Math.floor(now));
          // A muted or wrong microphone records silence; say so early
          // rather than at the end of the visit.
          setHearingNothing(now - lastSoundRef.current >= SCRIBE_QUIET_WARNING_SECONDS);
          if (now >= SCRIBE_MAX_RECORDING_SECONDS) stopRef.current();
        }
      };
      source.connect(node);
      nodeRef.current = node;

      // If the microphone is unplugged or its permission revoked, finish
      // cleanly with what was captured.
      liveStream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (streamRef.current === liveStream) stopRef.current();
      });

      // A phone call, another app, or a locked screen can suspend capture
      // behind our back. Say so instead of showing a clock that has stopped.
      liveContext.addEventListener("statechange", () => {
        if (contextRef.current !== liveContext) return;
        if (statusRef.current !== "recording") return;
        setInterrupted(liveContext.state !== "running");
      });

      wakeLockRef.current = await requestWakeLock();
      if (abandoned()) {
        void wakeLockRef.current?.release().catch(() => {});
        wakeLockRef.current = null;
        return;
      }

      setStatus("recording");
    } catch (startError) {
      if (generation !== generationRef.current) {
        abandoned();
        return;
      }
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
      releaseDevices();
      cutterRef.current = null;
      setError(describeStartError(startError));
      setStatus("idle");
    }
  }, [enqueue, releaseDevices]);

  const pause = useCallback(async () => {
    if (statusRef.current !== "recording") return;
    await contextRef.current?.suspend();
    setLevel(0);
    setInterrupted(false);
    setStatus("paused");
  }, []);

  /** Continue after a pause, or after the browser interrupted the recording. */
  const resume = useCallback(async () => {
    const current = statusRef.current;
    if (current !== "paused" && current !== "recording") return;
    try {
      await contextRef.current?.resume();
    } catch {
      // Still interrupted; the status line keeps saying so.
    }
    if (!wakeLockRef.current) wakeLockRef.current = await requestWakeLock();
    if (contextRef.current?.state === "running") setInterrupted(false);
    if (current === "paused") setStatus("recording");
  }, []);

  // Coming back to the page: pick the recording up again if the browser
  // suspended it, and take the screen lock back (browsers drop it when hidden).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (statusRef.current !== "recording") return;
      void (async () => {
        try {
          await contextRef.current?.resume();
        } catch {
          // Leave the interrupted notice up.
        }
        if (contextRef.current?.state === "running") setInterrupted(false);
        void wakeLockRef.current?.release().catch(() => {});
        wakeLockRef.current = await requestWakeLock();
      })();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /**
   * Transcribe an audio file recorded elsewhere. It is read in the browser,
   * cut into the same short segments as a live recording, and sent the same
   * way; the file itself is never uploaded or kept.
   */
  const addFile = useCallback(
    async (file: File) => {
      if (statusRef.current !== "idle" || queueRef.current.length > 0) return;
      const generation = generationRef.current;
      setError(null);
      setFailed(false);
      if (file.size > SCRIBE_UPLOAD_MAX_BYTES) {
        setError("That file is too large. Recordings up to 200 MB can be used.");
        return;
      }
      setStatus("reading");
      let context: AudioContext | null = null;
      try {
        const bytes = await file.arrayBuffer();
        if (generation !== generationRef.current) return;
        // Decoding into a 16 kHz context resamples as it goes, which keeps a
        // long recording's memory to a fraction of its full-rate size.
        try {
          context = new AudioContext({ sampleRate: SCRIBE_SAMPLE_RATE });
        } catch {
          context = new AudioContext();
        }
        const decoded = await context.decodeAudioData(bytes);
        if (generation !== generationRef.current) return;
        if (decoded.duration > SCRIBE_MAX_RECORDING_SECONDS) {
          setError(
            `That recording is too long. Recordings up to ${Math.round(
              SCRIBE_MAX_RECORDING_SECONDS / 60,
            )} minutes can be used.`,
          );
          return;
        }

        // Mix every channel down to one.
        const mono = new Float32Array(decoded.length);
        for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
          const data = decoded.getChannelData(channel);
          for (let i = 0; i < data.length; i += 1) mono[i]! += data[i]!;
        }
        if (decoded.numberOfChannels > 1) {
          for (let i = 0; i < mono.length; i += 1) {
            mono[i]! /= decoded.numberOfChannels;
          }
        }

        const downsampler = new Downsampler(decoded.sampleRate);
        const cutter = new SegmentCutter();
        recordingKeyRef.current = crypto.randomUUID();
        const BLOCK = 16_000;
        let heardSound = false;
        for (let offset = 0; offset < mono.length; offset += BLOCK) {
          const block = downsampler.push(mono.subarray(offset, offset + BLOCK));
          if (block.length === 0) continue;
          for (const segment of cutter.push(floatToPcm16(block))) {
            heardSound ||= segment.hasSound;
            enqueue(segment);
          }
        }
        const last = cutter.flush();
        if (last) {
          heardSound ||= last.hasSound;
          enqueue(last);
        }
        setElapsedSeconds(Math.floor(decoded.duration));
        if (!heardSound) setError("No speech was found in that file.");
      } catch {
        if (generation === generationRef.current) {
          setError(
            "That file could not be read as audio. Try an MP3, M4A, or WAV recording.",
          );
        }
      } finally {
        void context?.close().catch(() => {});
        if (generation === generationRef.current) setStatus("idle");
      }
    },
    [enqueue],
  );

  const retry = useCallback(() => {
    setFailed(false);
    void drain();
  }, [drain]);

  /** Give up on the part that keeps failing and carry on with the rest. */
  const skip = useCallback(() => {
    if (drainingRef.current) return;
    queueRef.current.shift();
    setPendingSegments(queueRef.current.length);
    setFailed(false);
    void drain();
  }, [drain]);

  /** Stop, and forget any audio still waiting to be transcribed. */
  const reset = useCallback(() => {
    abandon();
    setError(null);
  }, [abandon]);

  // Never leave the microphone open after the page is gone.
  useEffect(
    () => () => {
      generationRef.current += 1;
      releaseDevices();
    },
    [releaseDevices],
  );

  return {
    status,
    elapsedSeconds,
    level,
    pendingSegments,
    failed,
    /** The browser suspended the recording (a call, another app, a lock). */
    interrupted,
    /** Recording, but nothing at speech level for a while: check the mic. */
    hearingNothing: status === "recording" && hearingNothing,
    error,
    /** True while audio is being captured or is still waiting for its text. */
    busy: status !== "idle" || pendingSegments > 0,
    start,
    pause,
    resume,
    stop,
    addFile,
    retry,
    skip,
    reset,
  };
}
