import { afterEach, describe, expect, it, vi } from "vitest";
import {
  demoFollowupConfig,
  demoFollowupDedupeKey,
  demoFollowupMaxEmails,
  demoFollowupStepDue,
  demoToolCopy,
} from "../demo-followup";
import {
  DEMO_DISCLOSURE_FEEDBACK_V1,
  DEMO_DISCLOSURE_FOLLOWUP_V2,
} from "../demo-disclosure";

const HOUR = 60 * 60 * 1000;
const firstSeenAt = new Date("2026-11-05T15:00:00Z");
const at = (hours: number) => new Date(firstSeenAt.getTime() + hours * HOUR);

afterEach(() => vi.unstubAllEnvs());

describe("demoFollowupConfig", () => {
  it("is off by default and needs a rollout time", () => {
    expect(demoFollowupConfig()).toEqual({
      enabled: false,
      reason: "disabled",
    });
    vi.stubEnv("DEMO_FOLLOWUP_ENABLED", "true");
    expect(demoFollowupConfig()).toEqual({
      enabled: false,
      reason: "rollout_at_invalid",
    });
    vi.stubEnv("DEMO_FOLLOWUP_ROLLOUT_AT", "2026-11-05T00:00:00Z");
    expect(demoFollowupConfig()).toMatchObject({ enabled: true });
  });
});

describe("demoFollowupMaxEmails", () => {
  it("never exceeds the one email the old disclosure promised", () => {
    expect(
      demoFollowupMaxEmails({
        disclosureVersion: DEMO_DISCLOSURE_FEEDBACK_V1,
        toolCount: 9,
      }),
    ).toBe(1);
  });

  it("sends the full series only to engaged visitors who saw the new disclosure", () => {
    expect(
      demoFollowupMaxEmails({
        disclosureVersion: DEMO_DISCLOSURE_FOLLOWUP_V2,
        toolCount: 1,
      }),
    ).toBe(2);
    expect(
      demoFollowupMaxEmails({
        disclosureVersion: DEMO_DISCLOSURE_FOLLOWUP_V2,
        toolCount: 2,
      }),
    ).toBe(4);
  });
});

describe("demoFollowupStepDue", () => {
  const base = {
    firstSeenAt,
    existingEmailCount: 0,
    lastEmailAt: null,
    maxEmails: 4,
  };

  it("waits three hours before the feedback email", () => {
    expect(demoFollowupStepDue({ ...base, now: at(2) })).toBeNull();
    expect(demoFollowupStepDue({ ...base, now: at(3) })).toBe(1);
  });

  it("follows the schedule up to the lead's cap", () => {
    expect(
      demoFollowupStepDue({
        ...base,
        now: at(48),
        existingEmailCount: 1,
        lastEmailAt: at(3),
      }),
    ).toBe(2);
    expect(
      demoFollowupStepDue({
        ...base,
        now: at(48),
        existingEmailCount: 1,
        lastEmailAt: at(3),
        maxEmails: 1,
      }),
    ).toBeNull();
    expect(
      demoFollowupStepDue({
        ...base,
        now: at(216),
        existingEmailCount: 3,
        lastEmailAt: at(120),
      }),
    ).toBe(4);
  });

  it("keeps a minimum gap and drops stale leads", () => {
    expect(
      demoFollowupStepDue({
        ...base,
        now: at(50),
        existingEmailCount: 1,
        lastEmailAt: at(40),
      }),
    ).toBeNull();
    expect(demoFollowupStepDue({ ...base, now: at(22 * 24) })).toBeNull();
  });
});

describe("helpers", () => {
  it("versions dedupe keys per lead and step", () => {
    expect(demoFollowupDedupeKey("lead-1", 2)).toBe(
      "lead:demo-followup:v1:lead-1:2",
    );
  });

  it("has copy for product tools only", () => {
    expect(demoToolCopy("day_board")?.name).toBe("the day board");
    expect(demoToolCopy("dashboard")).toBeNull();
    expect(demoToolCopy(null)).toBeNull();
  });
});
