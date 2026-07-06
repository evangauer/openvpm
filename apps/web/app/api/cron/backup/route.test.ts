import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = {};

  return {
    db,
    alertOps: vi.fn(async () => undefined),
    backupKey: vi.fn((practiceId: string, dateYmd: string) =>
      `backups/${practiceId}/${dateYmd}.json`
    ),
    cronAuthError: vi.fn((): Response | null => null),
    exportPracticeData: vi.fn(
      async (_tx: unknown, practiceId: string, exportedAt: string) => ({
        practiceId,
        exportedAt,
        counts: {},
        clients: [],
      })
    ),
    reportCronHeartbeat: vi.fn(async () => undefined),
    uploadFile: vi.fn(async (key: string, _body: Buffer, _contentType: string) =>
      `s3://openpims/${key}`
    ),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn({
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(async () => [
              { id: "practice-1", timezone: "America/New_York" },
              { id: "practice-2", timezone: "America/New_York" },
            ]),
          })),
        })),
      })
    ),
    withTenant: vi.fn(
      async (_db: unknown, practiceId: string, fn: (tx: unknown) => unknown) =>
        fn({ tenantPracticeId: practiceId })
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/backup/export", () => ({
  backupKey: mocks.backupKey,
  exportPracticeData: mocks.exportPracticeData,
}));

vi.mock("@/lib/cron-auth", () => ({
  cronAuthError: mocks.cronAuthError,
}));

vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));

vi.mock("@/lib/s3", () => ({
  uploadFile: mocks.uploadFile,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-28T14:05:06.789Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("backup cron", () => {
  it("requires cron authorization before touching backup state", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup")
    );

    expect(response.status).toBe(401);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("exports each active practice in tenant context and uploads dated JSON", async () => {
    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup")
    );

    await expect(response.json()).resolves.toEqual({
      date: "2026-06-28",
      practices: 2,
      ok: 2,
      failed: 0,
    });

    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.withTenant).toHaveBeenCalledTimes(2);
    expect(mocks.exportPracticeData).toHaveBeenNthCalledWith(
      1,
      { tenantPracticeId: "practice-1" },
      "practice-1",
      "2026-06-28T14:05:06.789Z"
    );
    expect(mocks.exportPracticeData).toHaveBeenNthCalledWith(
      2,
      { tenantPracticeId: "practice-2" },
      "practice-2",
      "2026-06-28T14:05:06.789Z"
    );
    expect(mocks.backupKey).toHaveBeenNthCalledWith(
      1,
      "practice-1",
      "2026-06-28"
    );
    expect(mocks.uploadFile).toHaveBeenNthCalledWith(
      1,
      "backups/practice-1/2026-06-28.json",
      expect.any(Buffer),
      "application/json"
    );
    const uploadedPayload = mocks.uploadFile.mock.calls[0]?.[1];
    expect(uploadedPayload).toBeInstanceOf(Buffer);
    expect(JSON.parse((uploadedPayload as Buffer).toString("utf8"))).toMatchObject({
      practiceId: "practice-1",
      exportedAt: "2026-06-28T14:05:06.789Z",
    });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "backup",
      status: "ok",
      detail: "2 practice backups succeeded, 0 failed",
      metrics: {
        practices: 2,
        ok: 2,
        failed: 0,
      },
    });
  });

  it("uses each practice timezone for its backup object date", async () => {
    vi.setSystemTime(new Date("2026-06-28T02:30:00.000Z"));
    mocks.withSystem.mockImplementationOnce(
      async (_db: unknown, fn: (tx: unknown) => unknown) =>
        fn({
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(async () => [
                { id: "practice-la", timezone: "America/Los_Angeles" },
                { id: "practice-tokyo", timezone: "Asia/Tokyo" },
              ]),
            })),
          })),
        })
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup")
    );

    await expect(response.json()).resolves.toMatchObject({
      date: "2026-06-28",
      practices: 2,
      failed: 0,
    });
    expect(mocks.exportPracticeData).toHaveBeenNthCalledWith(
      1,
      { tenantPracticeId: "practice-la" },
      "practice-la",
      "2026-06-28T02:30:00.000Z"
    );
    expect(mocks.backupKey).toHaveBeenNthCalledWith(
      1,
      "practice-la",
      "2026-06-27"
    );
    expect(mocks.backupKey).toHaveBeenNthCalledWith(
      2,
      "practice-tokyo",
      "2026-06-28"
    );
    expect(mocks.uploadFile).toHaveBeenNthCalledWith(
      1,
      "backups/practice-la/2026-06-27.json",
      expect.any(Buffer),
      "application/json"
    );
    expect(mocks.uploadFile).toHaveBeenNthCalledWith(
      2,
      "backups/practice-tokyo/2026-06-28.json",
      expect.any(Buffer),
      "application/json"
    );
  });

  it("reports degraded heartbeat and ops alerts when one practice backup fails", async () => {
    mocks.uploadFile
      .mockResolvedValueOnce("s3://openpims/backups/practice-1/2026-06-28.json")
      .mockRejectedValueOnce(new Error("object storage unavailable"));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup")
    );

    await expect(response.json()).resolves.toEqual({
      date: "2026-06-28",
      practices: 2,
      ok: 1,
      failed: 1,
    });

    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Practice backup failed",
      "practice practice-2: object storage unavailable"
    );
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Scheduled backup had failures",
      "1 of 2 practice backups failed for UTC run 2026-06-28."
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "backup",
      status: "degraded",
      detail: "1 practice backups succeeded, 1 failed",
      metrics: {
        practices: 2,
        ok: 1,
        failed: 1,
      },
    });
  });

  it("reports failed heartbeat when the practice sweep crashes", async () => {
    mocks.withSystem.mockRejectedValueOnce(new Error("database unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const response = await GET(
        new Request("https://openvpm.test/api/cron/backup")
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Internal server error",
      });
      expect(mocks.alertOps).toHaveBeenCalledWith(
        "Backup cron job crashed",
        "database unavailable"
      );
      expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
        job: "backup",
        status: "failed",
        detail: "database unavailable",
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
