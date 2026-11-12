import { describe, expect, it } from "vitest";
import { scoreLead, type LeadScoreInput } from "../lead-score";

const now = new Date("2026-11-05T12:00:00Z");

function input(overrides: Partial<LeadScoreInput> = {}): LeadScoreInput {
  return {
    now,
    clinicModel: null,
    firstGoal: null,
    onboardingIntent: null,
    setupStarted: false,
    setupCompleted: false,
    helpRequested: false,
    stopReason: null,
    realClientCount: 0,
    realAppointmentCount: 0,
    activated: false,
    paymentMethodCollected: false,
    firstPositivePayment: false,
    lastMeaningfulActivityAt: now,
    ...overrides,
  };
}

describe("scoreLead", () => {
  it("scores a fresh companion signup that stopped before trial as warm", () => {
    const lead = scoreLead(
      input({
        clinicModel: "companion",
        firstGoal: "run_visit",
        setupStarted: true,
      }),
    );
    expect(lead).toMatchObject({ fit: 50, intent: 13, total: 63, tier: "warm" });
    expect(lead.reasons).toContain("Companion clinic");
    expect(lead.reasons).toContain("Created an account");
  });

  it("treats any hand-raise as hot", () => {
    const lead = scoreLead(
      input({ clinicModel: "exploring", stopReason: "price" }),
    );
    expect(lead.tier).toBe("hot");
    expect(lead.reasons[0]).toBe(
      "Told us why they stopped: the price doesn't fit",
    );
  });

  it("caps each half at 50", () => {
    const lead = scoreLead(
      input({
        clinicModel: "companion",
        firstGoal: "import_records",
        helpRequested: true,
        activated: true,
        paymentMethodCollected: true,
        realClientCount: 12,
      }),
    );
    expect(lead.fit).toBe(50);
    expect(lead.intent).toBe(50);
    expect(lead.tier).toBe("hot");
  });

  it("halves intent after two quiet weeks", () => {
    const lead = scoreLead(
      input({
        realClientCount: 3,
        lastMeaningfulActivityAt: new Date(now.getTime() - 20 * 86_400_000),
      }),
    );
    expect(lead.intent).toBe(12);
    expect(lead.reasons.at(-1)).toBe("Quiet for 20 days");
  });

  it("routes self-hosters and paying clinics to their own tracks", () => {
    expect(scoreLead(input({ onboardingIntent: "self_host" })).tier).toBe(
      "self_host",
    );
    expect(scoreLead(input({ stopReason: "self_host" })).tier).toBe(
      "self_host",
    );
    expect(scoreLead(input({ firstPositivePayment: true })).tier).toBe(
      "customer",
    );
  });

  it("puts an anonymous account with no signals in nurture", () => {
    expect(scoreLead(input())).toMatchObject({
      fit: 0,
      intent: 10,
      tier: "nurture",
    });
  });
});
