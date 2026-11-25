import { describe, expect, it } from "vitest";
import { SCRIBE_MAX_RECORDING_SECONDS } from "../audio";
import {
  meteredRunsFor,
  recordingMatches,
  SCRIBE_METERED_SECONDS_PER_RUN,
  SCRIBE_RECORDING_MAX_AUDIO_SECONDS,
} from "../recordings";

describe("scribe recording metering", () => {
  it("meters one run for each ten minutes of audio, or any part of it", () => {
    expect(SCRIBE_METERED_SECONDS_PER_RUN).toBe(600);
    expect(meteredRunsFor(0)).toBe(0);
    expect(meteredRunsFor(1)).toBe(1);
    expect(meteredRunsFor(600)).toBe(1);
    expect(meteredRunsFor(601)).toBe(2);
    expect(meteredRunsFor(20 * 60)).toBe(2);
    expect(meteredRunsFor(45 * 60)).toBe(5);
  });

  it("lets the longest recording finish, with room for its last part", () => {
    expect(SCRIBE_RECORDING_MAX_AUDIO_SECONDS).toBeGreaterThan(
      SCRIBE_MAX_RECORDING_SECONDS,
    );
    expect(SCRIBE_RECORDING_MAX_AUDIO_SECONDS).toBeLessThanOrEqual(
      SCRIBE_MAX_RECORDING_SECONDS + 10 * 60,
    );
  });

  it("only matches a recording for the same person, visit and kind of device", () => {
    const recording = {
      createdBy: "user-1",
      appointmentId: "visit-1",
      source: "browser",
      audioSeconds: 30,
      deviceKeyHash: null,
    };
    const expected = {
      userId: "user-1",
      appointmentId: "visit-1",
      source: "browser" as const,
    };
    expect(recordingMatches(recording, expected)).toBe(true);
    expect(recordingMatches(recording, { ...expected, userId: "user-2" })).toBe(false);
    expect(recordingMatches(recording, { ...expected, appointmentId: null })).toBe(false);
    expect(recordingMatches(recording, { ...expected, source: "phone" })).toBe(false);
  });
});
