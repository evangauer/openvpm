import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const insertResults: unknown[][] = [];
  const returning = vi.fn(async () => insertResults.shift() ?? [{ id: "event" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: { select, insert },
    selectResults,
    insertResults,
    select,
    insert,
    values,
    onConflictDoNothing,
    returning,
    upsertPracticeConversionMilestone: vi.fn(async () => true),
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn(database),
    ),
  };
});

vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/conversion-milestones", () => ({
  upsertPracticeConversionMilestone: mocks.upsertPracticeConversionMilestone,
  projectActivationMilestone: vi.fn(),
  recordActivationAfterAppointmentCreated: vi.fn(),
  recordActivationAfterClientCreated: vi.fn(),
}));

const {
  ensureRegistrationFirstTouch,
  recordRegistration,
} = await import("../funnel-events-server");

const VISITOR_ID = "123e4567-e89b-42d3-a456-426614174000";
const PRACTICE_ID = "323e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = new Date("2026-08-07T15:00:00.000Z");

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.insertResults.length = 0;
});

describe("registration funnel attribution", () => {
  it("does not duplicate an existing first-party touch", async () => {
    mocks.selectResults.push([{ id: "touch" }]);

    await expect(
      ensureRegistrationFirstTouch(mocks.db as never, {
        anonymousId: VISITOR_ID,
        source: "marketing",
        createdAt: CREATED_AT,
      })
    ).resolves.toBe(false);

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("treats the durable demo-gate submission as first-party touch evidence", () => {
    const source = readFileSync(
      new URL("../funnel-events-server.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /FIRST_TOUCH_EVENT_NAMES[\s\S]*"demo_gate_submitted"/,
    );
  });

  it("creates a privacy-bounded signup touch when browser telemetry is absent", async () => {
    mocks.selectResults.push([]);

    await expect(
      ensureRegistrationFirstTouch(mocks.db as never, {
        anonymousId: VISITOR_ID,
        source: "direct",
        createdAt: CREATED_AT,
      })
    ).resolves.toBe(true);

    expect(mocks.values).toHaveBeenCalledWith({
      eventName: "signup_land",
      anonymousId: VISITOR_ID,
      practiceId: null,
      source: "direct",
      path: "/register",
      origin: null,
      metadata: { serverFallback: true },
      createdAt: CREATED_AT,
    });
  });

  it("normalizes the UUID and links registration to the fallback touch", async () => {
    mocks.selectResults.push(
      [
        {
          id: PRACTICE_ID,
          settings: {
            acquisition: {
              funnelId: VISITOR_ID.toUpperCase(),
              source: "homepage",
            },
          },
          createdAt: CREATED_AT,
        },
      ],
      []
    );

    await expect(
      recordRegistration(mocks.db as never, PRACTICE_ID)
    ).resolves.toBe(true);

    expect(mocks.values).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventName: "signup_land",
        anonymousId: VISITOR_ID,
        metadata: { serverFallback: true },
      })
    );
    expect(mocks.upsertPracticeConversionMilestone).toHaveBeenCalledWith(
      mocks.db,
      {
        practiceId: PRACTICE_ID,
        milestone: "registered",
        occurredAt: CREATED_AT,
        evidenceSource: "practice_created",
        evidenceKey: `practice:${PRACTICE_ID}`,
      },
    );
  });

  it("does not invent an anonymous identity for historical registrations", async () => {
    mocks.selectResults.push([
      { id: PRACTICE_ID, settings: {}, createdAt: CREATED_AT },
    ]);

    await expect(
      recordRegistration(mocks.db as never, PRACTICE_ID)
    ).resolves.toBe(true);

    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.upsertPracticeConversionMilestone).toHaveBeenCalledOnce();
  });
});

describe("appointment activation telemetry", () => {
  it("delegates activation to the canonical projection module", () => {
    const source = readFileSync(
      new URL("../funnel-events-server.ts", import.meta.url),
      "utf8"
    );

    expect(source).toContain('from "@/lib/conversion-milestones"');
    expect(source).not.toContain('eventName: "activation"');
  });
});
