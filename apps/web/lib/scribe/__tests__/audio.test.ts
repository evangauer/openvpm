import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  Downsampler,
  encodeWav,
  floatToPcm16,
  inspectScribeWav,
  pcmRms,
  SCRIBE_SAMPLE_RATE,
  SCRIBE_SEGMENT_HARD_MAX_SECONDS,
  SCRIBE_SEGMENT_MAX_BASE64_LENGTH,
  SCRIBE_SEGMENT_MAX_BYTES,
  SegmentCutter,
} from "../audio";

function tone(seconds: number, amplitude = 8000): Int16Array {
  const out = new Int16Array(Math.round(seconds * SCRIBE_SAMPLE_RATE));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.round(
      amplitude * Math.sin((2 * Math.PI * 220 * i) / SCRIBE_SAMPLE_RATE),
    );
  }
  return out;
}

function silence(seconds: number): Int16Array {
  return new Int16Array(Math.round(seconds * SCRIBE_SAMPLE_RATE));
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Feed audio in uneven blocks, the way the audio thread delivers it. */
function feed(cutter: SegmentCutter, pcm: Int16Array, block = 4096) {
  const segments = [];
  for (let i = 0; i < pcm.length; i += block) {
    segments.push(...cutter.push(pcm.subarray(i, i + block)));
  }
  return segments;
}

describe("scribe audio conversion", () => {
  it("converts float samples to 16-bit and clamps overloads", () => {
    expect(Array.from(floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5])))).toEqual([
      0, 32767, -32768, 32767, -32768, 16384,
    ]);
  });

  it("measures level", () => {
    expect(pcmRms(silence(1))).toBe(0);
    expect(pcmRms(new Int16Array([1000, -1000, 1000, -1000]))).toBe(1000);
    expect(pcmRms(new Int16Array(0))).toBe(0);
  });

  it("downsamples a stream to 16 kHz across uneven blocks", () => {
    for (const inputRate of [48_000, 44_100]) {
      const downsampler = new Downsampler(inputRate);
      const input = new Float32Array(inputRate * 2).fill(0.25);
      let produced = 0;
      for (let i = 0; i < input.length; i += 1000) {
        const out = downsampler.push(input.subarray(i, i + 1000));
        produced += out.length;
        for (const sample of out) expect(sample).toBeCloseTo(0.25, 6);
      }
      expect(Math.abs(produced - SCRIBE_SAMPLE_RATE * 2)).toBeLessThanOrEqual(1);
    }
    const passthrough = new Float32Array([0.1, 0.2]);
    expect(new Downsampler(SCRIBE_SAMPLE_RATE).push(passthrough)).toBe(passthrough);
    expect(() => new Downsampler(8000)).toThrow();
  });
});

describe("scribe segment cutting", () => {
  it("cuts in a pause once the minimum length is reached", () => {
    const cutter = new SegmentCutter();
    const audio = concat(tone(22), silence(1), tone(5));
    const segments = feed(cutter, audio);
    expect(segments).toHaveLength(1);
    // Cut 300 ms into the pause that follows 22 seconds of speech.
    expect(segments[0]!.durationSeconds).toBeCloseTo(22.3, 1);
    expect(segments[0]!.hasSound).toBe(true);
    expect(segments[0]!.index).toBe(0);
  });

  it("cuts at the maximum length when nobody pauses", () => {
    const segments = feed(new SegmentCutter(), tone(65));
    expect(segments.map((segment) => segment.durationSeconds)).toEqual([30, 30]);
    expect(segments.map((segment) => segment.index)).toEqual([0, 1]);
  });

  it("loses no audio between segments or at the end", () => {
    const cutter = new SegmentCutter();
    const audio = concat(tone(31), silence(0.5), tone(24.03));
    const segments = feed(cutter, audio, 1234);
    const last = cutter.flush();
    expect(last).not.toBeNull();
    const all = concat(...segments.map((s) => s.pcm), last!.pcm);
    expect(all.length).toBe(audio.length);
    expect(Array.from(all.subarray(0, 4000))).toEqual(
      Array.from(audio.subarray(0, 4000)),
    );
    expect(Array.from(all.subarray(all.length - 4000))).toEqual(
      Array.from(audio.subarray(audio.length - 4000)),
    );
    expect(cutter.flush()).toBeNull();
  });

  it("marks near-silent segments so they are not sent", () => {
    const cutter = new SegmentCutter();
    expect(feed(cutter, silence(31))[0]!.hasSound).toBe(false);
    cutter.push(tone(1));
    expect(cutter.flush()!.hasSound).toBe(true);
  });
});

describe("scribe WAV files", () => {
  it("round-trips what the page records", () => {
    const pcm = tone(2);
    const wav = encodeWav(pcm);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(inspectScribeWav(wav)).toEqual({ ok: true, durationSeconds: 2 });
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44 + 2 * 100, true)).toBe(pcm[100]);
  });

  it("refuses anything that is not the exact format the page produces", () => {
    const wav = encodeWav(tone(1));
    expect(inspectScribeWav(new Uint8Array(10))).toEqual({
      ok: false,
      problem: "not_wav",
    });
    expect(inspectScribeWav(new TextEncoder().encode("x".repeat(100)))).toEqual({
      ok: false,
      problem: "not_wav",
    });
    expect(inspectScribeWav(encodeWav(tone(1), 44_100))).toEqual({
      ok: false,
      problem: "unsupported_format",
    });
    const stereo = wav.slice();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(inspectScribeWav(stereo)).toEqual({
      ok: false,
      problem: "unsupported_format",
    });
    // A declared length that does not match the file.
    expect(inspectScribeWav(wav.slice(0, wav.length - 2))).toEqual({
      ok: false,
      problem: "not_wav",
    });
    expect(inspectScribeWav(encodeWav(new Int16Array(0)))).toEqual({
      ok: false,
      problem: "empty",
    });
    expect(
      inspectScribeWav(encodeWav(silence(SCRIBE_SEGMENT_HARD_MAX_SECONDS + 1))),
    ).toEqual({ ok: false, problem: "too_long" });
  });

  it("keeps the longest accepted segment inside the upload limit", () => {
    const longest = encodeWav(silence(SCRIBE_SEGMENT_HARD_MAX_SECONDS));
    expect(longest.length).toBe(SCRIBE_SEGMENT_MAX_BYTES);
    expect(bytesToBase64(longest).length).toBeLessThanOrEqual(
      SCRIBE_SEGMENT_MAX_BASE64_LENGTH,
    );
    // Well under the 4.5 MB request limit of the hosted platform.
    expect(SCRIBE_SEGMENT_MAX_BASE64_LENGTH).toBeLessThan(2_500_000);
  });
});

describe("scribe base64", () => {
  it("matches the platform encoder for every remainder length", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255, 8191, 8192, 8193, 70_001]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + 7) & 255;
      const encoded = bytesToBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(Array.from(base64ToBytes(encoded)!)).toEqual(Array.from(bytes));
    }
  });

  it("rejects text that is not base64", () => {
    for (const text of ["abc", "ab=c", "a b=", "!!!!", "YQ===", "=YQ="]) {
      expect(base64ToBytes(text)).toBeNull();
    }
  });
});
