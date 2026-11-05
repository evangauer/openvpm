import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptionGaps,
  customerLifecycleConfig,
  netPromoterScore,
  npsCategory,
  npsCycleDue,
  trialWinbackStepDue,
  usageSummaryPhrase,
} from "@/lib/growth/customer-lifecycle";

const NOW = new Date("2026-11-05T16:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

afterEach(() => vi.unstubAllEnvs());

describe("customerLifecycleConfig", () => {
  it("stays off without an explicit flag and a valid rollout time", () => {
    expect(customerLifecycleConfig()).toEqual({
      enabled: false,
      reason: "disabled",
    });
    vi.stubEnv("CUSTOMER_LIFECYCLE_ENABLED", "true");
    vi.stubEnv("CUSTOMER_LIFECYCLE_ROLLOUT_AT", "soon");
    expect(customerLifecycleConfig()).toEqual({
      enabled: false,
      reason: "rollout_at_invalid",
    });
    vi.stubEnv("CUSTOMER_LIFECYCLE_ROLLOUT_AT", "2026-11-01T00:00:00Z");
    expect(customerLifecycleConfig()).toMatchObject({ enabled: true });
  });
});

describe("trialWinbackStepDue", () => {
  const due = (endedAgo: number, count = 0, lastEmailAgo: number | null = null) =>
    trialWinbackStepDue({
      now: NOW,
      trialEndedAt: ago(endedAgo),
      existingEmailCount: count,
      lastEmailAt: lastEmailAgo === null ? null : ago(lastEmailAgo),
    });

  it("follows the day 1, 7, 21 schedule", () => {
    expect(due(12 * HOUR)).toBeNull();
    expect(due(25 * HOUR)).toBe(1);
    expect(due(6 * DAY, 1, 5 * DAY)).toBeNull();
    expect(due(7 * DAY + HOUR, 1, 6 * DAY)).toBe(2);
    expect(due(21 * DAY + HOUR, 2, 14 * DAY)).toBe(3);
    expect(due(22 * DAY, 3, DAY)).toBeNull();
  });

  it("keeps notes at least three days apart and stops after 30 days", () => {
    expect(due(8 * DAY, 1, 2 * DAY)).toBeNull();
    expect(due(31 * DAY)).toBeNull();
  });
});

describe("npsCycleDue", () => {
  const cycle = (payingAgo: number) =>
    npsCycleDue({ now: NOW, payingSince: ago(payingAgo) });

  it("asks at day 30 and every 90 days after, within a two-week window", () => {
    expect(cycle(29 * DAY)).toBeNull();
    expect(cycle(30 * DAY)).toBe(1);
    expect(cycle(43 * DAY)).toBe(1);
    expect(cycle(45 * DAY)).toBeNull();
    expect(cycle(120 * DAY)).toBe(2);
    expect(cycle(210 * DAY + 3 * DAY)).toBe(3);
  });
});

describe("adoptionGaps", () => {
  it("names what is not turned on, most valuable first", () => {
    expect(
      adoptionGaps({ remindersEnabled: false, staffCount: 1, portalSessions: 0 }),
    ).toEqual(["reminders", "team", "portal"]);
    expect(
      adoptionGaps({ remindersEnabled: true, staffCount: 3, portalSessions: 2 }),
    ).toEqual([]);
  });
});

describe("NPS scoring", () => {
  it("categorizes and scores answers", () => {
    expect([0, 6, 7, 8, 9, 10].map(npsCategory)).toEqual([
      "detractor",
      "detractor",
      "passive",
      "passive",
      "promoter",
      "promoter",
    ]);
    expect(netPromoterScore([])).toBeNull();
    expect(netPromoterScore([10, 9, 8, 3])).toBe(25);
  });
});

describe("usageSummaryPhrase", () => {
  it("reads naturally and skips empty counts", () => {
    expect(usageSummaryPhrase({ clients: 0, appointments: 0, invoices: 0 })).toBeNull();
    expect(usageSummaryPhrase({ clients: 1, appointments: 0, invoices: 0 })).toBe(
      "1 client",
    );
    expect(usageSummaryPhrase({ clients: 4, appointments: 9, invoices: 0 })).toBe(
      "4 clients and 9 appointments",
    );
  });
});
