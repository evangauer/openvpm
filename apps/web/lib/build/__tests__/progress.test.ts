import { describe, expect, it } from "vitest";
import {
  createBuildResumeToken,
  parseBuildProgress,
  verifyBuildResumeToken,
} from "@/lib/build/progress";
import { createStopReasonToken } from "@/lib/growth/stop-reason-token";

const SECRET = "s".repeat(48);
const LEAD = "00000000-0000-4000-8000-0000000000aa";
const state = {
  practiceType: "equine",
  currentSystem: "daysmart",
  clinicName: "Farmstead Equine",
  brandColor: "#16a34a",
  services: [{ name: "Farm Call", price: 95, on: true }],
};

describe("saved build progress", () => {
  it("parses what was saved and rejects anything else", () => {
    const saved = {
      state,
      scene: "visit",
      savedAt: "2026-11-05T18:00:00.000Z",
      disclosureVersion: "build-v1",
    };
    expect(parseBuildProgress(saved)).toEqual(saved);
    expect(parseBuildProgress({ ...saved, scene: "nowhere" })).toBeNull();
    expect(parseBuildProgress({ ...saved, disclosureVersion: "demo-v2" })).toBeNull();
    expect(parseBuildProgress({ ...saved, state: { ...state, brandColor: "green" } })).toBeNull();
    expect(parseBuildProgress(null)).toBeNull();
  });

  it("signs resume links that only open a saved build", () => {
    const token = createBuildResumeToken(LEAD, { secret: SECRET });
    expect(verifyBuildResumeToken(token, { secret: SECRET })).toEqual({ leadId: LEAD });
    const stop = createStopReasonToken(LEAD, { secret: SECRET });
    expect(verifyBuildResumeToken(stop, { secret: SECRET })).toBeNull();
    expect(verifyBuildResumeToken(`${token}x`, { secret: SECRET })).toBeNull();
  });
});
