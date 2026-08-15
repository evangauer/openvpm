import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

const { assertOutboundEmailAllowed, OUTBOUND_EMAIL_LIMITS } = await import(
  "../outbound-email-security"
);

const NOW = new Date("2026-08-14T18:00:00Z");
const BASE = {
  practiceId: "practice-1",
  practiceCreatedAt: new Date("2025-08-14T18:00:00Z"),
  userId: "user-1",
  userEmailVerifiedAt: new Date("2026-08-14T17:00:00Z"),
  ip: "203.0.113.8",
  operation: "staff_invite" as const,
  now: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 10,
    resetAt: new Date(NOW.getTime() + 60_000),
  });
});

describe("outbound email abuse boundary", () => {
  it("permanently blocks the free-form inbox relay before consuming quota", async () => {
    await expect(
      assertOutboundEmailAllowed({ ...BASE, operation: "inbox" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Free-form email sending from the inbox is disabled for account safety.",
    });

    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("requires a verified staff identity before consuming quota", async () => {
    await expect(
      assertOutboundEmailAllowed({ ...BASE, userEmailVerifiedAt: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("enforces shared hourly and daily quotas for established practices", async () => {
    await expect(assertOutboundEmailAllowed(BASE)).resolves.toBeUndefined();

    expect(mocks.rateLimit).toHaveBeenCalledTimes(4);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "outbound-email:user-hour:user-1",
        limit: OUTBOUND_EMAIL_LIMITS.userPerHour,
      }),
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "outbound-email:practice-day:practice-1",
        limit: OUTBOUND_EMAIL_LIMITS.practicePerDay,
      }),
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "outbound-email:ip-hour:203.0.113.8",
        limit: OUTBOUND_EMAIL_LIMITS.ipPerHour,
      }),
    );
  });

  it("caps a practice at five external emails during its first day", async () => {
    mocks.rateLimit.mockImplementation(async ({ key }: { key: string }) => ({
      success: !key.startsWith("outbound-email:new-practice:"),
      remaining: 0,
      resetAt: new Date(NOW.getTime() + 60_000),
    }));

    await expect(
      assertOutboundEmailAllowed({
        ...BASE,
        practiceCreatedAt: new Date(NOW.getTime() - 60_000),
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "outbound-email:new-practice:practice-1",
        limit: 5,
      }),
    );
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Outbound email abuse limit reached",
      expect.stringContaining("quota=new_practice_first_day"),
    );
  });

  it("fails closed when the durable quota service is unavailable", async () => {
    mocks.rateLimit.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(assertOutboundEmailAllowed(BASE)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Outbound email blocked: quota service unavailable",
      expect.not.stringContaining("database unavailable"),
    );
  });
});
