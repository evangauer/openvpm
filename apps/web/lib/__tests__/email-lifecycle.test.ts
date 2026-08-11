import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const insertResults: unknown[][] = [];
  const selectResults: unknown[][] = [];
  const deleteResults: unknown[][] = [];

  const insertReturning = vi.fn(async () => insertResults.shift() ?? []);
  const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
  const insertValues = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const deleteReturning = vi.fn(async () => deleteResults.shift() ?? []);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));

  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db = { insert, select, delete: deleteFn, update };

  return {
    db,
    insertResults,
    selectResults,
    deleteResults,
    insertValues,
    onConflictDoNothing,
    select,
    deleteWhere,
    updateSet,
    alertOps: vi.fn(async () => undefined),
    marketingEmailEnabledForRecipient: vi.fn(async () => true),
    practiceAllowsExternalSideEffects: vi.fn(async () => true),
    lockPracticeForExternalSideEffects: vi.fn(async () => true),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/platform-email-preferences", () => ({
  marketingEmailEnabledForRecipient: mocks.marketingEmailEnabledForRecipient,
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  practiceAllowsExternalSideEffects: mocks.practiceAllowsExternalSideEffects,
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
}));

const { LIFECYCLE_EMAIL_PENDING_RECLAIM_MS, sendLifecycleEmail } =
  await import("../email-lifecycle");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const BASE_OPTS = {
  practiceId: PRACTICE_ID,
  to: "owner@example.com",
  emailType: "trial-ending",
  dedupeKey: "lc:trial-ending:practice:t-3",
  category: "transactional" as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-28T12:00:00Z"));
  mocks.marketingEmailEnabledForRecipient.mockResolvedValue(true);
  mocks.practiceAllowsExternalSideEffects.mockResolvedValue(true);
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.insertResults.length = 0;
  mocks.selectResults.length = 0;
  mocks.deleteResults.length = 0;
});

describe("sendLifecycleEmail", () => {
  it("does not claim or send while the practice is on recovery hold", async () => {
    mocks.practiceAllowsExternalSideEffects.mockResolvedValueOnce(false);
    const send = vi.fn(async () => ({ success: true, id: "email-1" }));

    await expect(sendLifecycleEmail({ ...BASE_OPTS, send })).resolves.toEqual({
      sent: false,
      deduped: false,
      suppressed: true,
    });

    expect(send).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("drops a safe claim if recovery wins immediately before provider send", async () => {
    mocks.insertResults.push([{ id: "comm-race" }]);
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);
    const send = vi.fn(async () => ({ success: true, id: "email-race" }));

    await expect(sendLifecycleEmail({ ...BASE_OPTS, send })).resolves.toEqual({
      sent: false,
      deduped: false,
      suppressed: true,
    });

    expect(send).not.toHaveBeenCalled();
    expect(mocks.deleteWhere).toHaveBeenCalled();
  });

  it("drops a safe claim when mutable campaign eligibility changes", async () => {
    mocks.insertResults.push([{ id: "comm-stale-campaign" }]);
    const stillEligible = vi.fn(async () => false);
    const send = vi.fn(async () => ({ success: true, id: "email-stale" }));

    await expect(
      sendLifecycleEmail({ ...BASE_OPTS, stillEligible, send }),
    ).resolves.toEqual({
      sent: false,
      deduped: false,
      suppressed: true,
    });

    expect(stillEligible).toHaveBeenCalledWith(mocks.db);
    expect(send).not.toHaveBeenCalled();
    expect(mocks.deleteWhere).toHaveBeenCalled();
  });

  it("claims, sends, and marks a lifecycle email sent", async () => {
    mocks.insertResults.push([{ id: "comm-1" }]);
    const send = vi.fn(async () => ({ success: true, id: "email-1" }));

    await expect(sendLifecycleEmail({ ...BASE_OPTS, send })).resolves.toEqual({
      sent: true,
      deduped: false,
    });

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        channel: "email",
        direction: "outbound",
        status: "pending",
        dedupeKey: BASE_OPTS.dedupeKey,
      }),
    );
    expect(mocks.onConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.any(Object) }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet).toHaveBeenCalledWith({
      status: "sent",
      providerMessageId: "email-1",
    });
  });

  it("suppresses optional email before creating a lifecycle claim", async () => {
    mocks.marketingEmailEnabledForRecipient.mockResolvedValueOnce(false);
    const send = vi.fn(async () => ({ success: true, id: "email-1" }));

    await expect(
      sendLifecycleEmail({ ...BASE_OPTS, category: "marketing", send }),
    ).resolves.toEqual({
      sent: false,
      deduped: false,
      suppressed: true,
    });

    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("defaults optional email on when the recipient has no preference", async () => {
    mocks.insertResults.push([{ id: "comm-1" }]);
    const send = vi.fn(async () => ({ success: true, id: "email-1" }));

    await expect(
      sendLifecycleEmail({ ...BASE_OPTS, category: "marketing", send }),
    ).resolves.toEqual({ sent: true, deduped: false });

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when optional-email preference lookup fails", async () => {
    mocks.marketingEmailEnabledForRecipient.mockRejectedValueOnce(
      new Error("preference unavailable"),
    );
    const send = vi.fn(async () => ({ success: true, id: "email-1" }));

    await expect(
      sendLifecycleEmail({ ...BASE_OPTS, category: "marketing", send }),
    ).resolves.toEqual({ sent: false, deduped: false });

    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Lifecycle email error",
      expect.stringContaining("preference unavailable"),
    );
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("marks a lifecycle email sent when the provider omits an id", async () => {
    mocks.insertResults.push([{ id: "comm-1" }]);
    const send = vi.fn(async () => ({ success: true }));

    await expect(sendLifecycleEmail({ ...BASE_OPTS, send })).resolves.toEqual({
      sent: true,
      deduped: false,
    });

    expect(mocks.updateSet).toHaveBeenCalledWith({ status: "sent" });
  });

  it("dedupes a fresh pending claim without sending or deleting it", async () => {
    mocks.insertResults.push([]);
    mocks.selectResults.push([
      {
        id: "comm-pending",
        status: "pending",
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    ]);
    const send = vi.fn(async () => ({ success: true, id: "email-1" }));

    await expect(sendLifecycleEmail({ ...BASE_OPTS, send })).resolves.toEqual({
      sent: false,
      deduped: true,
    });

    expect(send).not.toHaveBeenCalled();
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("reclaims a stale pending claim before retrying the send", async () => {
    mocks.insertResults.push([], [{ id: "comm-reclaimed" }]);
    mocks.selectResults.push([
      {
        id: "comm-stale",
        status: "pending",
        createdAt: new Date(
          Date.now() - LIFECYCLE_EMAIL_PENDING_RECLAIM_MS - 1,
        ),
      },
    ]);
    mocks.deleteResults.push([{ id: "comm-stale" }]);
    const send = vi.fn(async () => ({ success: true, id: "email-1" }));

    await expect(sendLifecycleEmail({ ...BASE_OPTS, send })).resolves.toEqual({
      sent: true,
      deduped: false,
    });

    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet).toHaveBeenCalledWith({
      status: "sent",
      providerMessageId: "email-1",
    });
  });

  it("keeps a failed non-retryable lifecycle email claimed and marked failed", async () => {
    mocks.insertResults.push([{ id: "comm-1" }]);
    const send = vi.fn(async () => ({
      success: false,
      error: "provider down",
    }));

    await expect(sendLifecycleEmail({ ...BASE_OPTS, send })).resolves.toEqual({
      sent: false,
      deduped: false,
    });

    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Lifecycle email failed",
      "trial-ending \u2192 owner@example.com: provider down",
    );
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledWith({ status: "failed" });
  });

  it("drops a failed retryable lifecycle email claim so cron can retry", async () => {
    mocks.insertResults.push([{ id: "comm-1" }]);
    const send = vi.fn(async () => ({
      success: false,
      error: "provider down",
    }));

    await expect(
      sendLifecycleEmail({ ...BASE_OPTS, send, retryOnFail: true }),
    ).resolves.toEqual({
      sent: false,
      deduped: false,
    });

    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet).not.toHaveBeenCalledWith({ status: "failed" });
  });
});
