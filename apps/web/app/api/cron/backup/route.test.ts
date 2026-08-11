import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PracticeExportFixture = {
  formatVersion: number;
  practiceId: string;
  exportedAt: string;
  counts: Record<string, number>;
  clients: unknown[];
  [key: string]: unknown;
};

const mocks = vi.hoisted(() => {
  const db = {};

  return {
    db,
    alertOps: vi.fn(async () => undefined),
    backupKey: vi.fn(
      (practiceId: string, dateYmd: string) =>
        `backups/${practiceId}/${dateYmd}.json`,
    ),
    cronAuthError: vi.fn((): Response | null => null),
    exportPracticeData: vi.fn(
      async (
        _tx: unknown,
        practiceId: string,
        exportedAt: string,
      ): Promise<PracticeExportFixture> => ({
        formatVersion: 6,
        practiceId,
        exportedAt,
        counts: {},
        clients: [],
      }),
    ),
    reportCronHeartbeat: vi.fn(async () => undefined),
    uploadManagedFile: vi.fn(
      async (
        _key: string,
        _body: Buffer,
        _contentType: string,
        _checksumSha256: string,
      ) => ({
        url: "s3://openpims/object",
        etag: "primary-etag",
        versionId: "primary-version",
      }),
    ),
    uploadReplicaFile: vi.fn(
      async (
        _key: string,
        _body: Buffer,
        _contentType: string,
        _checksumSha256: string,
      ) => ({
        url: "s3://replica/object",
        etag: "replica-etag",
        versionId: "replica-version",
      }),
    ),
    readPrimaryObject: vi.fn(),
    readReplicaObject: vi.fn(
      async (
        _key: string,
        _options?: { maxBytes?: number },
      ): Promise<
        | { status: "failed" }
        | {
            status: "available";
            body: Uint8Array;
            versionId: string;
          }
      > => ({ status: "failed" }),
    ),
    replicaStorageReadiness: vi.fn(() => ({
      intended: false,
      ready: false,
      detail: "Independent object replica is not configured",
    })),
    replicaStorageRolloutEnabled: vi.fn(() => false),
    replicaStorageIncludesPractice: vi.fn(() => true),
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
      }),
    ),
    withTenantReadOnlySnapshot: vi.fn(
      async (_db: unknown, practiceId: string, fn: (tx: unknown) => unknown) =>
        fn({ tenantPracticeId: practiceId }),
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
  normalizeS3VersionId: (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return normalized && normalized.toLowerCase() !== "null"
      ? normalized
      : undefined;
  },
  uploadManagedFile: mocks.uploadManagedFile,
  uploadReplicaFile: mocks.uploadReplicaFile,
  readPrimaryObject: mocks.readPrimaryObject,
  readReplicaObject: mocks.readReplicaObject,
  replicaStorageIncludesPractice: mocks.replicaStorageIncludesPractice,
  replicaStorageReadiness: mocks.replicaStorageReadiness,
  replicaStorageRolloutEnabled: mocks.replicaStorageRolloutEnabled,
}));

vi.mock("@/lib/file-replication", () => ({
  checksumSha256Hex: vi.fn(() => "a".repeat(64)),
}));

vi.mock("@/lib/backup/policy", () => ({
  PRACTICE_BACKUP_JSON_MAX_BYTES: 1_024,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenantReadOnlySnapshot: mocks.withTenantReadOnlySnapshot,
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-28T14:05:06.789Z"));
  mocks.replicaStorageReadiness.mockReturnValue({
    intended: false,
    ready: false,
    detail: "Independent object replica is not configured",
  });
  mocks.replicaStorageRolloutEnabled.mockReturnValue(false);
  mocks.replicaStorageIncludesPractice.mockReturnValue(true);
  mocks.readPrimaryObject.mockImplementation(async () => ({
    status: "available" as const,
    body: new Uint8Array(
      mocks.uploadManagedFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
    ),
    versionId: "primary-version",
  }));
  mocks.readReplicaObject.mockResolvedValue({ status: "failed" });
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
      }),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    expect(response.status).toBe(401);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenantReadOnlySnapshot).not.toHaveBeenCalled();
    expect(mocks.uploadManagedFile).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("exports each active practice in tenant context and uploads dated JSON", async () => {
    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toEqual({
      date: "2026-06-28",
      practices: 2,
      ok: 2,
      failed: 0,
      otherFailed: 0,
      oversized: 0,
      nearLimit: 0,
      maxExportBytes: expect.any(Number),
      replicaOk: 0,
      replicaFailed: 0,
    });

    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.withTenantReadOnlySnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.exportPracticeData).toHaveBeenNthCalledWith(
      1,
      { tenantPracticeId: "practice-1" },
      "practice-1",
      "2026-06-28T14:05:06.789Z",
    );
    expect(mocks.exportPracticeData).toHaveBeenNthCalledWith(
      2,
      { tenantPracticeId: "practice-2" },
      "practice-2",
      "2026-06-28T14:05:06.789Z",
    );
    expect(mocks.backupKey).toHaveBeenNthCalledWith(
      1,
      "practice-1",
      "2026-06-28",
    );
    expect(mocks.uploadManagedFile).toHaveBeenNthCalledWith(
      1,
      "backups/practice-1/2026-06-28.json",
      expect.any(Buffer),
      "application/json",
      "a".repeat(64),
    );
    const uploadedPayload = mocks.uploadManagedFile.mock.calls[0]?.[1];
    expect(uploadedPayload).toBeInstanceOf(Buffer);
    expect(
      JSON.parse((uploadedPayload as Buffer).toString("utf8")),
    ).toMatchObject({
      practiceId: "practice-1",
      exportedAt: "2026-06-28T14:05:06.789Z",
    });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "backup",
      status: "ok",
      detail:
        "2 primary backups succeeded, 0 independent copies verified, 0 failed",
      metrics: {
        practices: 2,
        ok: 2,
        failed: 0,
        otherFailed: 0,
        oversized: 0,
        nearLimit: 0,
        maxExportBytes: expect.any(Number),
        backupMaxBytes: 1_024,
        replicaOk: 0,
        replicaFailed: 0,
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
        }),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
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
      "2026-06-28T02:30:00.000Z",
    );
    expect(mocks.backupKey).toHaveBeenNthCalledWith(
      1,
      "practice-la",
      "2026-06-27",
    );
    expect(mocks.backupKey).toHaveBeenNthCalledWith(
      2,
      "practice-tokyo",
      "2026-06-28",
    );
    expect(mocks.uploadManagedFile).toHaveBeenNthCalledWith(
      1,
      "backups/practice-la/2026-06-27.json",
      expect.any(Buffer),
      "application/json",
      "a".repeat(64),
    );
    expect(mocks.uploadManagedFile).toHaveBeenNthCalledWith(
      2,
      "backups/practice-tokyo/2026-06-28.json",
      expect.any(Buffer),
      "application/json",
      "a".repeat(64),
    );
  });

  it("copies each database backup to the independent target and verifies its bytes", async () => {
    mocks.replicaStorageRolloutEnabled.mockReturnValue(true);
    mocks.replicaStorageReadiness.mockReturnValue({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.readReplicaObject.mockImplementation(async () => ({
      status: "available" as const,
      body: new Uint8Array(
        mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
      ),
      versionId: "replica-version",
    }));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: 2,
      failed: 0,
      replicaOk: 2,
      replicaFailed: 0,
    });
    expect(mocks.uploadReplicaFile).toHaveBeenNthCalledWith(
      1,
      `database-backups/v2/practice-1/2026-06-28/${"a".repeat(64)}.json`,
      expect.any(Buffer),
      "application/json",
      "a".repeat(64),
    );
    expect(mocks.readReplicaObject).toHaveBeenNthCalledWith(
      1,
      `database-backups/v2/practice-1/2026-06-28/${"a".repeat(64)}.json`,
      { maxBytes: expect.any(Number), versionId: "replica-version" },
    );
    expect(mocks.uploadReplicaFile).toHaveBeenNthCalledWith(
      2,
      `database-backup-catalog/v2/practice-1/2026-06-28/${"a".repeat(64)}.json`,
      expect.any(Buffer),
      "application/json",
      "a".repeat(64),
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "backup",
        status: "ok",
        metrics: expect.objectContaining({ replicaOk: 2, replicaFailed: 0 }),
      }),
    );
  });

  it("converges an ambiguous checksum-addressed replica backup PUT by read-back", async () => {
    mocks.replicaStorageRolloutEnabled.mockReturnValue(true);
    mocks.replicaStorageReadiness.mockReturnValue({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.uploadReplicaFile.mockRejectedValueOnce(
      new Error("replica PUT timed out"),
    );
    mocks.readReplicaObject.mockImplementation(async () => ({
      status: "available" as const,
      body: new Uint8Array(
        mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
      ),
      versionId: "replica-version",
    }));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: 2,
      replicaOk: 2,
      replicaFailed: 0,
    });
    expect(mocks.readReplicaObject).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^database-backups\/v2\//),
      { maxBytes: expect.any(Number) },
    );
  });

  it("converges an ambiguous checksum-addressed replica catalog PUT by read-back", async () => {
    mocks.replicaStorageRolloutEnabled.mockReturnValue(true);
    mocks.replicaStorageReadiness.mockReturnValue({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.uploadReplicaFile
      .mockResolvedValueOnce({
        url: "s3://replica/object",
        etag: "replica-etag",
        versionId: "replica-version",
      })
      .mockRejectedValueOnce(new Error("catalog PUT timed out"));
    mocks.readReplicaObject.mockImplementation(async () => ({
      status: "available" as const,
      body: new Uint8Array(
        mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
      ),
      versionId: "replica-version",
    }));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: 2,
      replicaOk: 2,
      replicaFailed: 0,
    });
    expect(mocks.readReplicaObject).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^database-backup-catalog\/v2\//),
      { maxBytes: expect.any(Number) },
    );
  });

  it("rejects provider-null replica version IDs as exact recovery evidence", async () => {
    mocks.replicaStorageRolloutEnabled.mockReturnValue(true);
    mocks.replicaStorageReadiness.mockReturnValue({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.uploadReplicaFile.mockResolvedValue({
      url: "s3://replica/object",
      etag: "replica-etag",
      versionId: "null",
    });
    mocks.readReplicaObject.mockImplementation(async () => ({
      status: "available" as const,
      body: new Uint8Array(
        mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
      ),
      versionId: "null",
    }));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: 2,
      replicaOk: 0,
      replicaFailed: 2,
    });
  });

  it("fails before upload when an export cannot be restored within the supported size cap", async () => {
    mocks.exportPracticeData.mockResolvedValueOnce({
      formatVersion: 6,
      practiceId: "practice-1",
      exportedAt: "2026-06-28T14:05:06.789Z",
      counts: {},
      clients: [],
      oversized: "x".repeat(1_100),
    });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: 1,
      failed: 1,
      otherFailed: 0,
      oversized: 1,
    });
    expect(mocks.uploadManagedFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadManagedFile).toHaveBeenCalledWith(
      "backups/practice-2/2026-06-28.json",
      expect.any(Buffer),
      "application/json",
      "a".repeat(64),
    );
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Practice backup failed",
      expect.stringContaining("restore safety limit"),
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          failed: 1,
          otherFailed: 0,
          oversized: 1,
          nearLimit: 0,
          maxExportBytes: expect.any(Number),
          backupMaxBytes: 1_024,
        }),
      }),
    );
  });

  it("reports exports approaching the restore cap separately from failures", async () => {
    mocks.exportPracticeData.mockResolvedValueOnce({
      formatVersion: 6,
      practiceId: "practice-1",
      exportedAt: "2026-06-28T14:05:06.789Z",
      counts: {},
      clients: [],
      capacityProbe: "x".repeat(700),
    });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: 2,
      failed: 0,
      otherFailed: 0,
      oversized: 0,
      nearLimit: 1,
    });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          failed: 0,
          otherFailed: 0,
          oversized: 0,
          nearLimit: 1,
          maxExportBytes: expect.any(Number),
          backupMaxBytes: 1_024,
        }),
      }),
    );
  });

  it("accepts an ambiguous primary PUT only when read-back proves the exact bytes", async () => {
    mocks.uploadManagedFile.mockRejectedValueOnce(
      new Error("request timed out"),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: 2,
      failed: 0,
      otherFailed: 0,
      oversized: 0,
    });
    expect(mocks.readPrimaryObject).toHaveBeenNthCalledWith(
      1,
      "backups/practice-1/2026-06-28.json",
      { maxBytes: expect.any(Number) },
    );
    expect(mocks.alertOps).not.toHaveBeenCalledWith(
      "Practice backup failed",
      expect.any(String),
    );
  });

  it("degrades without failing the primary backup when replica verification fails", async () => {
    mocks.replicaStorageRolloutEnabled.mockReturnValue(true);
    mocks.replicaStorageReadiness.mockReturnValue({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.readReplicaObject.mockResolvedValue({ status: "failed" });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: 2,
      failed: 0,
      replicaOk: 0,
      replicaFailed: 2,
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Independent practice backup failed",
      "practice practice-1: replica write or verification failed",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ job: "backup", status: "degraded" }),
    );
  });

  it("reports degraded heartbeat and ops alerts when one practice backup fails", async () => {
    mocks.uploadManagedFile
      .mockResolvedValueOnce({
        url: "s3://openpims/backups/practice-1/2026-06-28.json",
        etag: "primary-etag",
        versionId: "primary-version",
      })
      .mockRejectedValueOnce(new Error("object storage unavailable"));
    mocks.readPrimaryObject
      .mockImplementationOnce(async () => ({
        status: "available" as const,
        body: new Uint8Array(
          mocks.uploadManagedFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
        ),
        versionId: "primary-version",
      }))
      .mockResolvedValueOnce({ status: "failed" });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/backup"),
    );

    await expect(response.json()).resolves.toEqual({
      date: "2026-06-28",
      practices: 2,
      ok: 1,
      failed: 1,
      otherFailed: 1,
      oversized: 0,
      nearLimit: 0,
      maxExportBytes: expect.any(Number),
      replicaOk: 0,
      replicaFailed: 0,
    });

    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Practice backup failed",
      "practice practice-2: object storage unavailable",
    );
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Scheduled backup had failures",
      "1 primary and 0 independent backup copies failed for UTC run 2026-06-28.",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "backup",
      status: "degraded",
      detail:
        "1 primary backups succeeded, 0 independent copies verified, 1 failed",
      metrics: {
        practices: 2,
        ok: 1,
        failed: 1,
        otherFailed: 1,
        oversized: 0,
        nearLimit: 0,
        maxExportBytes: expect.any(Number),
        backupMaxBytes: 1_024,
        replicaOk: 0,
        replicaFailed: 0,
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
        new Request("https://openvpm.test/api/cron/backup"),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Internal server error",
      });
      expect(mocks.alertOps).toHaveBeenCalledWith(
        "Backup cron job crashed",
        "database unavailable",
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
