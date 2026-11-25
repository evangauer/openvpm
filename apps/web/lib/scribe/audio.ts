/**
 * Audio handling shared by the Scribe page and its server route. Pure
 * functions only: no browser or Node APIs, so both sides and the tests can use
 * them.
 *
 * A recording is captured as 16 kHz mono 16-bit PCM and cut into short WAV
 * segments. Short segments keep every upload small, let the transcript appear
 * while the visit is still going, and mean a dropped connection costs seconds
 * of audio instead of the whole visit.
 */

export const SCRIBE_SAMPLE_RATE = 16_000;
/** A segment is cut at the first pause after this many seconds... */
export const SCRIBE_SEGMENT_MIN_SECONDS = 20;
/** ...or here, pause or not. */
export const SCRIBE_SEGMENT_MAX_SECONDS = 30;
/** The server refuses anything longer than this. */
export const SCRIBE_SEGMENT_HARD_MAX_SECONDS = 45;
/** Recording stops by itself after this long. */
export const SCRIBE_MAX_RECORDING_SECONDS = 45 * 60;
export const SCRIBE_MAX_SEGMENTS = Math.ceil(
  SCRIBE_MAX_RECORDING_SECONDS / SCRIBE_SEGMENT_MIN_SECONDS,
);

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
/** Largest accepted WAV file, and its size once base64-encoded. */
export const SCRIBE_SEGMENT_MAX_BYTES =
  WAV_HEADER_BYTES +
  SCRIBE_SEGMENT_HARD_MAX_SECONDS * SCRIBE_SAMPLE_RATE * BYTES_PER_SAMPLE;
export const SCRIBE_SEGMENT_MAX_BASE64_LENGTH =
  Math.ceil(SCRIBE_SEGMENT_MAX_BYTES / 3) * 4;

const FRAME_SAMPLES = SCRIBE_SAMPLE_RATE / 10; // 100 ms
/** Below this a frame counts as a pause between phrases (0..32767 scale). */
const PAUSE_RMS = 260;
/** Above this a frame counts as sound worth transcribing. */
const SOUND_RMS = 130;
/** The same threshold, for telling a live recording that it hears nothing. */
export const SCRIBE_SOUND_RMS = SOUND_RMS;
const PAUSE_FRAMES_TO_CUT = 3;
const SOUND_FRAMES_FOR_SPEECH = 3;

/** Root mean square of 16-bit samples, on the 0..32767 scale. */
export function pcmRms(samples: Int16Array, start = 0, end = samples.length) {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (end - start));
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]!));
    out[i] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
  }
  return out;
}

/**
 * Streaming downsampler for browsers that will not open a 16 kHz audio
 * context. Averages the input samples that fall inside each output sample,
 * which is enough of a low-pass filter for speech.
 */
export class Downsampler {
  private sum = 0;
  private count = 0;
  private phase = 0;

  constructor(
    private readonly inputRate: number,
    private readonly outputRate = SCRIBE_SAMPLE_RATE,
  ) {
    if (!(inputRate >= outputRate)) {
      throw new Error("Input sample rate must be at least the output rate.");
    }
  }

  push(input: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) return input;
    const out = new Float32Array(
      Math.ceil((input.length * this.outputRate) / this.inputRate) + 1,
    );
    let written = 0;
    for (let i = 0; i < input.length; i += 1) {
      this.sum += input[i]!;
      this.count += 1;
      this.phase += this.outputRate;
      if (this.phase >= this.inputRate) {
        this.phase -= this.inputRate;
        out[written] = this.sum / this.count;
        written += 1;
        this.sum = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, written);
  }
}

export interface ScribeSegment {
  index: number;
  pcm: Int16Array;
  durationSeconds: number;
  /** False when the segment is near-silent and not worth sending. */
  hasSound: boolean;
}

/**
 * Cuts a stream of PCM into segments, preferring to cut in a pause so words
 * are not split across two uploads.
 */
export class SegmentCutter {
  private chunks: Int16Array[] = [];
  private samples = 0;
  private frame = new Int16Array(FRAME_SAMPLES);
  private frameFilled = 0;
  private pauseRun = 0;
  private soundFrames = 0;
  private nextIndex = 0;

  constructor(
    private readonly minSeconds = SCRIBE_SEGMENT_MIN_SECONDS,
    private readonly maxSeconds = SCRIBE_SEGMENT_MAX_SECONDS,
  ) {}

  /** Seconds of audio waiting in the segment being built. */
  get pendingSeconds() {
    return this.samples / SCRIBE_SAMPLE_RATE;
  }

  push(pcm: Int16Array): ScribeSegment[] {
    const out: ScribeSegment[] = [];
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(FRAME_SAMPLES - this.frameFilled, pcm.length - offset);
      this.frame.set(pcm.subarray(offset, offset + take), this.frameFilled);
      this.frameFilled += take;
      offset += take;
      if (this.frameFilled < FRAME_SAMPLES) break;

      const level = pcmRms(this.frame);
      this.pauseRun = level < PAUSE_RMS ? this.pauseRun + 1 : 0;
      if (level >= SOUND_RMS) this.soundFrames += 1;
      this.chunks.push(this.frame);
      this.samples += FRAME_SAMPLES;
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.frameFilled = 0;

      const seconds = this.samples / SCRIBE_SAMPLE_RATE;
      if (
        seconds >= this.maxSeconds ||
        (seconds >= this.minSeconds && this.pauseRun >= PAUSE_FRAMES_TO_CUT)
      ) {
        out.push(this.cut());
      }
    }
    return out;
  }

  /** Emit whatever is left, including a partly filled last frame. */
  flush(): ScribeSegment | null {
    if (this.frameFilled > 0) {
      const tail = this.frame.slice(0, this.frameFilled);
      if (pcmRms(tail) >= SOUND_RMS) this.soundFrames += 1;
      this.chunks.push(tail);
      this.samples += tail.length;
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.frameFilled = 0;
    }
    return this.samples > 0 ? this.cut() : null;
  }

  private cut(): ScribeSegment {
    const pcm = new Int16Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    const segment: ScribeSegment = {
      index: this.nextIndex,
      pcm,
      durationSeconds: pcm.length / SCRIBE_SAMPLE_RATE,
      hasSound: this.soundFrames >= SOUND_FRAMES_FOR_SPEECH,
    };
    this.nextIndex += 1;
    this.chunks = [];
    this.samples = 0;
    this.pauseRun = 0;
    this.soundFrames = 0;
    return segment;
  }
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function readAscii(view: DataView, offset: number, length: number) {
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

/** 16-bit mono PCM WAV file. */
export function encodeWav(
  pcm: Int16Array,
  sampleRate = SCRIBE_SAMPLE_RATE,
): Uint8Array {
  const dataBytes = pcm.length * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE, pcm[i]!, true);
  }
  return bytes;
}

export type ScribeWavProblem =
  | "not_wav"
  | "unsupported_format"
  | "empty"
  | "too_long";

/**
 * Accept only the exact file the Scribe page produces: a canonical 44-byte
 * header, 16 kHz mono 16-bit PCM, and no longer than the hard limit. Anything
 * else is refused before it reaches the AI provider.
 */
export function inspectScribeWav(
  bytes: Uint8Array,
): { ok: true; durationSeconds: number } | { ok: false; problem: ScribeWavProblem } {
  if (bytes.length < WAV_HEADER_BYTES) return { ok: false, problem: "not_wav" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    readAscii(view, 0, 4) !== "RIFF" ||
    readAscii(view, 8, 4) !== "WAVE" ||
    readAscii(view, 12, 4) !== "fmt " ||
    readAscii(view, 36, 4) !== "data"
  ) {
    return { ok: false, problem: "not_wav" };
  }
  if (
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== SCRIBE_SAMPLE_RATE ||
    view.getUint16(34, true) !== 16
  ) {
    return { ok: false, problem: "unsupported_format" };
  }
  const dataBytes = view.getUint32(40, true);
  if (dataBytes !== bytes.length - WAV_HEADER_BYTES || dataBytes % 2 !== 0) {
    return { ok: false, problem: "not_wav" };
  }
  if (dataBytes === 0) return { ok: false, problem: "empty" };
  const durationSeconds = dataBytes / BYTES_PER_SAMPLE / SCRIBE_SAMPLE_RATE;
  if (durationSeconds > SCRIBE_SEGMENT_HARD_MAX_SECONDS) {
    return { ok: false, problem: "too_long" };
  }
  return { ok: true, durationSeconds };
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    chunk +=
      BASE64[a >> 2]! +
      BASE64[((a & 3) << 4) | (b >> 4)]! +
      (i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)]! : "=") +
      (i + 2 < bytes.length ? BASE64[c & 63]! : "=");
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

/** Strict base64 decode. Returns null for anything that is not valid base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = BASE64.indexOf(text[i]!);
    const b = BASE64.indexOf(text[i + 1]!);
    const c = text[i + 2] === "=" ? 0 : BASE64.indexOf(text[i + 2]!);
    const d = text[i + 3] === "=" ? 0 : BASE64.indexOf(text[i + 3]!);
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (written < bytes.length) bytes[written++] = (triple >> 16) & 255;
    if (written < bytes.length) bytes[written++] = (triple >> 8) & 255;
    if (written < bytes.length) bytes[written++] = triple & 255;
  }
  return bytes;
}
