import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const executeResults: unknown[][] = [];
  const execute = vi.fn(async () => executeResults.shift() ?? []);
  const db = { execute };
  return {
    db,
    execute,
    executeResults,
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn(database),
    ),
  };
});

vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));

const {
  classifyRecoveryTrial,
  computeActivationRecovery,
  deriveRecoveryNextAction,
  deriveRecoveryStage,
  recoverySetupState,
} = await import("@/lib/admin/activation-recovery");

afterEach(() => {
  vi.clearAllMocks();
  mocks.executeResults.length = 0;
});

describe("activation recovery", () => {
  it("classifies trial boundaries at one injected, timezone-safe clock", () => {
    const now = new Date("2026-08-08T12:00:00.000Z");

    expect(
      classifyRecoveryTrial("trialing", "2026-08-12T12:00:00.000Z", now),
    ).toBe("active");
    expect(
      classifyRecoveryTrial("trialing", "2026-08-11T12:00:00.000Z", now),
    ).toBe("ending_soon");
    expect(
      classifyRecoveryTrial("trialing", "2026-08-08T12:00:00.000Z", now),
    ).toBe("expired");
    expect(classifyRecoveryTrial("none", null, now)).toBe("no_trial");

    // The same instant with an offset must classify identically.
    expect(
      classifyRecoveryTrial("trialing", "2026-08-11T08:00:00-04:00", now),
    ).toBe("ending_soon");
  });

  it("derives every authoritative progress stage from durable product data", () => {
    const base = {
      activated: false,
      paymentMethodCollected: false,
      firstPositivePayment: false,
      setupStarted: false,
      setupCompleted: false,
      realClientCount: 0,
      realAppointmentCount: 0,
    };

    expect(deriveRecoveryStage(base)).toBe("registered");
    expect(deriveRecoveryStage({ ...base, setupStarted: true })).toBe(
      "setup_started",
    );
    expect(
      deriveRecoveryStage({
        ...base,
        setupStarted: true,
        setupCompleted: true,
      }),
    ).toBe("setup_complete");
    expect(deriveRecoveryStage({ ...base, realClientCount: 1 })).toBe(
      "client_added",
    );
    expect(deriveRecoveryStage({ ...base, realAppointmentCount: 1 })).toBe(
      "appointment_booked",
    );
    expect(
      deriveRecoveryStage({
        ...base,
        realClientCount: 1,
        realAppointmentCount: 1,
        activated: true,
      }),
    ).toBe("activated");
    expect(deriveRecoveryStage({ ...base, paymentMethodCollected: true })).toBe(
      "payment_method_collected",
    );
    expect(deriveRecoveryStage({ ...base, firstPositivePayment: true })).toBe(
      "first_positive_payment",
    );
  });

  it("recognizes the first path choice and retains the latest saved progress", () => {
    const intentSelectedAt = "2026-08-07T10:00:00.000Z";
    const journeyLastProgressAt = "2026-08-08T11:00:00.000Z";

    expect(
      recoverySetupState({
        onboardingState: { onboardingIntentSelectedAt: intentSelectedAt },
      }),
    ).toMatchObject({
      started: true,
      completed: false,
      stage: "Starting path",
      lastProgressAt: new Date(intentSelectedAt),
    });
    expect(
      recoverySetupState({
        onboardingState: {
          onboardingIntentSelectedAt: intentSelectedAt,
          journeyStepId: "data",
          journeyLastProgressAt,
          journeyDismissed: false,
        },
      }),
    ).toMatchObject({
      started: true,
      stage: "Data import",
      lastProgressAt: new Date(journeyLastProgressAt),
    });
  });

  it("covers help, contact, access, setup, activation, card, and paid actions", () => {
    const base = {
      billingStatus: "trialing",
      trialState: "active" as const,
      stage: "registered" as const,
      setupStage: "Not started",
      setupHelpRequested: false,
      hasVerifiedAdmin: true,
      hasAnyAdmin: true,
    };

    const cases = [
      [{ ...base, setupHelpRequested: true }, "Respond to setup help request"],
      [{ ...base, hasVerifiedAdmin: false }, "Verify the primary admin email"],
      [
        { ...base, hasVerifiedAdmin: false, hasAnyAdmin: false },
        "Restore an admin contact",
      ],
      [
        { ...base, trialState: "expired" as const },
        "Review a qualified trial extension",
      ],
      [
        {
          ...base,
          billingStatus: "past_due",
          trialState: "no_trial" as const,
          stage: "first_positive_payment" as const,
        },
        "Resolve the past-due subscription",
      ],
      [
        {
          ...base,
          billingStatus: "canceled",
          trialState: "no_trial" as const,
          stage: "first_positive_payment" as const,
        },
        "Restore trial or billing access",
      ],
      [
        {
          ...base,
          billingStatus: "active",
          trialState: "no_trial" as const,
        },
        "Review unknown historical payment evidence",
      ],
      [
        { ...base, trialState: "ending_soon" as const },
        "Help add a payment method before trial end",
      ],
      [
        { ...base, stage: "setup_started" as const, setupStage: "Data import" },
        "Unblock Data import",
      ],
      [
        { ...base, stage: "setup_complete" as const },
        "Help import the first real client",
      ],
      [
        { ...base, stage: "client_added" as const },
        "Help book the first real appointment",
      ],
      [
        { ...base, stage: "appointment_booked" as const },
        "Help add the appointment's client",
      ],
      [
        { ...base, stage: "activated" as const },
        "Invite clinic to add a payment method",
      ],
      [
        { ...base, stage: "payment_method_collected" as const },
        "Support the first successful clinic week",
      ],
      [
        {
          ...base,
          billingStatus: "active",
          trialState: "no_trial" as const,
          stage: "first_positive_payment" as const,
        },
        "Support retention and expansion",
      ],
    ] as const;

    for (const [input, label] of cases) {
      expect(deriveRecoveryNextAction(input).label).toBe(label);
    }
  });

  it("runs one system aggregate and ranks help requests ahead of older stalls", async () => {
    const now = new Date("2026-08-08T12:00:00.000Z");
    mocks.executeResults.push([
      {
        practiceId: "00000000-0000-0000-0000-000000000001",
        practiceName: "Older Clinic",
        billingStatus: "trialing",
        trialEndsAt: "2026-08-20T12:00:00.000Z",
        timezone: "America/Los_Angeles",
        createdAt: "2026-07-01T12:00:00.000Z",
        settings: {},
        verifiedAdminName: "Owner",
        verifiedAdminEmail: "owner@example.com",
        verifiedAdminEmailAt: "2026-07-01T13:00:00.000Z",
        activeAdminCount: "1",
        realClientCount: "0",
        realAppointmentCount: "0",
        activated: false,
        paymentMethodCollected: false,
        firstPositivePayment: false,
        lastMeaningfulActivityAt: "2026-07-01T12:00:00.000Z",
      },
      {
        practiceId: "00000000-0000-0000-0000-000000000002",
        practiceName: "Help Clinic",
        billingStatus: "trialing",
        trialEndsAt: "2026-08-20T12:00:00.000Z",
        timezone: "Pacific/Auckland",
        createdAt: "2026-08-01T12:00:00.000Z",
        settings: {
          onboardingState: {
            journeyStepId: "data",
            setupHelpRequestedAt: "2026-08-07T12:00:00.000Z",
          },
        },
        verifiedAdminName: "Admin",
        verifiedAdminEmail: "admin@example.com",
        verifiedAdminEmailAt: "2026-08-01T13:00:00.000Z",
        activeAdminCount: 1,
        realClientCount: 2,
        realAppointmentCount: 0,
        activated: false,
        paymentMethodCollected: false,
        firstPositivePayment: false,
        lastMeaningfulActivityAt: "2026-08-07T12:00:00.000Z",
      },
    ]);

    const result = await computeActivationRecovery(mocks.db as never, now);

    expect(mocks.withSystem).toHaveBeenCalledWith(
      mocks.db,
      expect.any(Function),
    );
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      queueRank: 1,
      practiceName: "Help Clinic",
      setupStage: "Data import",
      realClientCount: 2,
      stallAgeDays: 1,
      authoritativeStage: "client_added",
      nextAction: "Respond to setup help request",
    });
    expect(result[1]).toMatchObject({
      queueRank: 2,
      practiceName: "Older Clinic",
      stallAgeDays: 38,
      authoritativeStage: "registered",
    });
  });

  it("excludes analytics, soft-deleted, and demo data in the aggregate SQL", () => {
    const source = readFileSync("lib/admin/activation-recovery.ts", "utf8");

    expect(source).toContain(
      "p.settings ->> 'analyticsExcluded' is distinct from 'true'",
    );
    expect(source).toContain("p.deleted_at is null");
    expect(source).toContain("u.deleted_at is null");
    expect(source).toContain("c.deleted_at is null");
    expect(source).toContain("a.deleted_at is null");
    expect(source).toContain("p.settings -> 'demoData' -> 'clientIds'");
    expect(source).toContain("p.settings -> 'demoData' -> 'appointmentIds'");
    expect(source).toContain(
      "not (pb.demo_client_ids @> to_jsonb(c.id::text))",
    );
    expect(source).toContain(
      "not (pb.demo_appointment_ids @> to_jsonb(a.id::text))",
    );
    expect(source).toContain("u.email_verified_at is not null");
    expect(source).toContain("order by u.practice_id, u.created_at, u.id");
    expect(source).not.toContain("join lateral");
    expect(source).toContain("max(greatest(c.created_at, c.updated_at))");
    expect(source).toContain("max(greatest(a.created_at, a.updated_at))");
    expect(source).toContain("from practice_conversion_milestones pcm");
    expect(source).toContain("pcm.milestone = 'payment_method_collected'");
    expect(source).toContain("pcm.milestone = 'first_positive_payment'");
    expect(source).toContain("journeyLastProgressAt");
    expect(source).not.toContain("from funnel_events fe");
  });
});
