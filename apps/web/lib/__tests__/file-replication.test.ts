import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const FILE_REPLICATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../file-replication.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const executeResults: unknown[] = [];
  const returningResults: unknown[][] = [];
  const insertedValues: unknown[] = [];
  const onConflictUpdateSets: Record<string, unknown>[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const execute = vi.fn(async () => executeResults.shift() ?? []);
  const insert = vi.fn(() => {
    const builder = {
      values: vi.fn((value: unknown) => {
        insertedValues.push(value);
        return builder;
      }),
      onConflictDoNothing: vi.fn(async () => undefined),
      onConflictDoUpdate: vi.fn(
        async (config: { set: Record<string, unknown> }) => {
          onConflictUpdateSets.push(config.set);
        },
      ),
    };
    return builder;
  });
  const update = vi.fn(() => {
    const builder = {
      set: vi.fn((value: Record<string, unknown>) => {
        updateSets.push(value);
        return builder;
      }),
      where: vi.fn(() => builder),
      returning: vi.fn(async () =>
        returningResults.length > 0
          ? returningResults.shift()!
          : [{ id: "replica-1" }],
      ),
    };
    return builder;
  });
  const tx = { execute, insert, update };

  return {
    executeResults,
    returningResults,
    insertedValues,
    onConflictUpdateSets,
    updateSets,
    execute,
    insert,
    update,
    tx,
    alertOps: vi.fn(async () => undefined),
    readPrimaryObject: vi.fn(),
    readReplicaObject: vi.fn(),
    replicaStorageReadiness: vi.fn(() => ({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    })),
    replicaStorageRequired: vi.fn(() => false),
    replicaStorageRolloutEnabled: vi.fn(() => true),
    replicaStoragePracticeScope: vi.fn(() => null as string[] | null),
    uploadManagedFile: vi.fn(
      async (
        _key: string,
        _body: Buffer,
        _contentType: string,
        _checksumSha256: string,
      ) => ({
        url: "s3://primary/object",
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
    withSystem: vi.fn(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/s3", () => ({
  FILE_REPLICA_TARGET: "independent-v1",
  normalizeS3VersionId: (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return normalized && normalized.toLowerCase() !== "null"
      ? normalized
      : undefined;
  },
  readPrimaryObject: mocks.readPrimaryObject,
  readReplicaObject: mocks.readReplicaObject,
  replicaStoragePracticeScope: mocks.replicaStoragePracticeScope,
  replicaStorageReadiness: mocks.replicaStorageReadiness,
  replicaStorageRequired: mocks.replicaStorageRequired,
  replicaStorageRolloutEnabled: mocks.replicaStorageRolloutEnabled,
  uploadManagedFile: mocks.uploadManagedFile,
  uploadReplicaFile: mocks.uploadReplicaFile,
}));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));

const {
  checksumSha256Hex,
  recoveryCatalogKey,
  registerFileForReplication,
  reconcileFileReplicas,
  replicaObjectKey,
  schedulePrimaryRepair,
} = await import("../file-replication");

const checksum = checksumSha256Hex(new TextEncoder().encode("abc"));

function claimedReplica(overrides: Record<string, unknown> = {}) {
  const practiceId = "00000000-0000-0000-0000-000000000001";
  const fileId = "00000000-0000-0000-0000-000000000002";
  return {
    replicaId: "00000000-0000-0000-0000-000000000010",
    practiceId,
    fileId,
    fileKey: `${practiceId}/documents/opaque`,
    mimeType: "application/pdf",
    fileChecksum: checksum,
    fileSize: 3,
    fileStorageStatus: "available",
    replicaObjectKey:
      "attachments/v1/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/pending",
    replicaChecksum: checksum,
    replicaSize: 3,
    replicaStatus: "pending",
    replicaObjectEtag: null,
    replicaObjectVersionId: null,
    replicaReplicatedAt: null,
    replicaVerifiedAt: null,
    attemptCount: 1,
    leaseToken: "00000000-0000-0000-0000-000000000011",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.executeResults.length = 0;
  mocks.returningResults.length = 0;
  mocks.insertedValues.length = 0;
  mocks.onConflictUpdateSets.length = 0;
  mocks.updateSets.length = 0;
  mocks.replicaStorageReadiness.mockReturnValue({
    intended: true,
    ready: true,
    detail: "Replica storage envs present",
  });
  mocks.replicaStorageRolloutEnabled.mockReturnValue(true);
  mocks.replicaStorageRequired.mockReturnValue(false);
  mocks.replicaStoragePracticeScope.mockReturnValue(null);
});

describe("file replica identity", () => {
  it("uses content-addressed object keys and deterministic recovery catalogs", () => {
    expect(checksum).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      replicaObjectKey({
        practiceId: "practice-1",
        fileId: "file-1",
        checksumSha256: checksum,
      }),
    ).toBe(`attachments/v1/practice-1/file-1/${checksum}`);
    expect(recoveryCatalogKey("practice-1", "file-1", checksum)).toBe(
      `recovery-catalog/v2/practice-1/file-1/${checksum}.json`,
    );
  });

  it("CAS-binds finalization and lease renewal to both claimed generations", () => {
    const primaryGuard = FILE_REPLICATION_SOURCE.match(
      /function claimedPrimaryGeneration\([\s\S]*?\n}/,
    )?.[0];
    const replicaGuard = FILE_REPLICATION_SOURCE.match(
      /function claimedReplicaGeneration\([\s\S]*?\n}/,
    )?.[0];
    const finalizer = FILE_REPLICATION_SOURCE.match(
      /async function finalizeReplica\([\s\S]*?\n}\n\nasync function writeRecoveryCatalog/,
    )?.[0];
    const renewer = FILE_REPLICATION_SOURCE.match(
      /async function renewReplicaLease\([\s\S]*?\n}\n\nasync function processClaimedReplica/,
    )?.[0];

    expect(primaryGuard).toContain("eq(files.fileKey, item.fileKey)");
    expect(primaryGuard).toContain("item.fileChecksum");
    expect(primaryGuard).toContain("item.fileSize");
    expect(primaryGuard).toContain(
      "eq(files.storageStatus, item.fileStorageStatus)",
    );
    expect(primaryGuard).toContain("isNull(files.deletedAt)");
    expect(replicaGuard).toContain(
      "eq(fileObjectReplicas.objectKey, item.replicaObjectKey)",
    );
    expect(replicaGuard).toContain("item.replicaChecksum");
    expect(replicaGuard).toContain("item.replicaSize");
    expect(replicaGuard).toContain("isNull(fileObjectReplicas.deletedAt)");
    expect(finalizer).toContain("claimedReplicaGeneration(item)");
    expect(finalizer).toContain("claimedPrimaryGenerationExists(item)");
    expect(finalizer).toContain(".where(claimedPrimaryGeneration(item))");
    expect(renewer).toContain("claimedReplicaGeneration(item)");
    expect(renewer).toContain("claimedPrimaryGenerationExists(item)");
  });
});

describe("file replica queue", () => {
  it("records primary evidence and durably queues an idempotent replica", async () => {
    await expect(
      registerFileForReplication({
        practiceId: "practice-1",
        fileId: "file-1",
        fileKey: "practice-1/documents/opaque",
        checksumSha256: checksum,
        fileSizeBytes: 3,
        objectEtag: "etag-1",
        objectVersionId: "version-1",
      }),
    ).resolves.toBe(true);

    expect(mocks.insertedValues).toHaveLength(3);
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        fileId: "file-1",
        storageTarget: "primary",
        eventKind: "primary_verified",
        observedChecksumSha256: checksum,
      }),
    );
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        fileId: "file-1",
        replicaTarget: "independent-v1",
        checksumSha256: checksum,
        status: "pending",
      }),
    );
    expect(mocks.alertOps).not.toHaveBeenCalled();
    expect(mocks.onConflictUpdateSets).toContainEqual(
      expect.objectContaining({
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    );
  });

  it("invalidates an active worker lease when registration refreshes generation", async () => {
    await registerFileForReplication({
      practiceId: "practice-1",
      fileId: "file-1",
      fileKey: "practice-1/documents/rotated",
      checksumSha256: checksum,
      fileSizeBytes: 3,
    });

    expect(mocks.onConflictUpdateSets).toHaveLength(1);
    expect(mocks.onConflictUpdateSets[0]).toMatchObject({
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it("does not make a completed clinic upload fail when queue persistence fails", async () => {
    mocks.withSystem.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      registerFileForReplication({
        practiceId: "practice-1",
        fileId: "file-1",
        fileKey: "practice-1/documents/opaque",
        checksumSha256: checksum,
        fileSizeBytes: 3,
      }),
    ).resolves.toBe(false);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "File replica queue write failed",
      expect.stringContaining("reconciliation must recover"),
    );
  });

  it("durably wakes reconciliation after a verified replica fallback", async () => {
    await expect(
      schedulePrimaryRepair({
        practiceId: "practice-1",
        fileId: "file-1",
        fileKey: "practice-1/documents/opaque",
        checksumSha256: checksum,
        fileSizeBytes: 3,
        storageStatus: "available",
        observedState: "failed",
      }),
    ).resolves.toBe(true);

    expect(mocks.updateSets).toEqual([
      expect.objectContaining({
        storageStatus: "unverified",
        storageVerifiedAt: null,
      }),
      expect.objectContaining({ nextAttemptAt: expect.any(Date) }),
    ]);
  });

  it("returns false without waking repair after an old proxy read loses generation CAS", async () => {
    mocks.returningResults.push([]);

    await expect(
      schedulePrimaryRepair({
        practiceId: "practice-1",
        fileId: "file-1",
        fileKey: "practice-1/documents/old-generation",
        checksumSha256: checksum,
        fileSizeBytes: 3,
        storageStatus: "available",
        observedState: "missing",
      }),
    ).resolves.toBe(false);

    expect(mocks.updateSets).toHaveLength(1);
    expect(mocks.updateSets[0]).toMatchObject({ storageStatus: "missing" });
  });

  it("does not make a fallback file read fail when repair scheduling is unavailable", async () => {
    mocks.withSystem.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      schedulePrimaryRepair({
        practiceId: "practice-1",
        fileId: "file-1",
        fileKey: "practice-1/documents/opaque",
        checksumSha256: checksum,
        fileSizeBytes: 3,
        storageStatus: "available",
        observedState: "missing",
      }),
    ).resolves.toBe(false);
  });
});

describe("file replica reconciliation", () => {
  it("skips all database and provider work until the independent target is complete", async () => {
    mocks.replicaStorageReadiness.mockReturnValueOnce({
      intended: false,
      ready: false,
      detail: "Independent object replica is not configured",
    });

    await expect(reconcileFileReplicas()).resolves.toMatchObject({
      intended: false,
      configured: false,
      claimed: 0,
      copied: 0,
    });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("copies, verifies, catalogs, and records a pending primary object", async () => {
    const body = new TextEncoder().encode("abc");
    mocks.executeResults.push(
      [{ id: "materialized-1" }],
      [claimedReplica()],
      [{ backlog: "0", available: "1", activeFiles: "1" }],
    );
    mocks.readPrimaryObject.mockResolvedValue({
      status: "available",
      body,
      contentType: "application/pdf",
      etag: "primary-etag",
    });
    mocks.readReplicaObject.mockImplementation(async (key: string) => {
      if (key.startsWith("recovery-catalog/")) {
        return {
          status: "available" as const,
          body: new Uint8Array(
            mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
          ),
          contentType: "application/json",
          versionId: "replica-version",
        };
      }
      if (mocks.uploadReplicaFile.mock.calls.length === 0) {
        return { status: "missing" as const };
      }
      return {
        status: "available" as const,
        body,
        contentType: "application/pdf",
        etag: "replica-etag",
        versionId: "replica-version",
      };
    });

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      configured: true,
      candidates: 1,
      claimed: 1,
      copied: 1,
      failed: 0,
      bytesCopied: 3,
      backlog: 0,
      available: 1,
      activeFiles: 1,
      coveragePct: 100,
    });
    const desiredKey = replicaObjectKey({
      practiceId: "00000000-0000-0000-0000-000000000001",
      fileId: "00000000-0000-0000-0000-000000000002",
      checksumSha256: checksum,
    });
    expect(mocks.uploadReplicaFile).toHaveBeenNthCalledWith(
      1,
      desiredKey,
      expect.any(Buffer),
      "application/pdf",
      checksum,
    );
    expect(mocks.uploadReplicaFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(
        /^recovery-catalog\/v2\/00000000-0000-0000-0000-000000000001\/00000000-0000-0000-0000-000000000002\/[0-9a-f]{64}\.json$/,
      ),
      expect.any(Buffer),
      "application/json",
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        status: "available",
        objectKey: desiredKey,
        checksumSha256: checksum,
        verifiedAt: expect.any(Date),
        leaseToken: null,
      }),
    );
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        storageTarget: "primary",
        eventKind: "primary_verified",
        observedChecksumSha256: checksum,
        observedFileSizeBytes: 3,
      }),
    );
  });

  it("preserves prior verified evidence across transient provider failures", async () => {
    const verifiedAt = new Date("2026-08-01T00:00:00.000Z");
    mocks.executeResults.push(
      [],
      [
        claimedReplica({
          replicaObjectKey: `attachments/v1/practice/file/${checksum}`,
          replicaStatus: "available",
          replicaObjectEtag: "old-etag",
          replicaObjectVersionId: "old-version",
          replicaReplicatedAt: verifiedAt,
          replicaVerifiedAt: verifiedAt,
        }),
      ],
      [{ backlog: 1, available: 0, activeFiles: 1 }],
    );
    mocks.readReplicaObject.mockResolvedValue({ status: "failed" });
    mocks.readPrimaryObject.mockResolvedValue({ status: "failed" });

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      claimed: 1,
      failed: 1,
    });
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        status: "available",
        objectEtag: "old-etag",
        objectVersionId: "old-version",
        replicatedAt: verifiedAt,
        verifiedAt,
        failureCode: "primary_unavailable",
      }),
    );
  });

  it("downgrades stale evidence when replica and primary bytes are definitively corrupt", async () => {
    const verifiedAt = new Date("2026-08-01T00:00:00.000Z");
    mocks.executeResults.push(
      [],
      [
        claimedReplica({
          replicaObjectKey: `attachments/v1/practice/file/${checksum}`,
          replicaStatus: "available",
          replicaObjectEtag: "old-etag",
          replicaObjectVersionId: "old-version",
          replicaReplicatedAt: verifiedAt,
          replicaVerifiedAt: verifiedAt,
        }),
      ],
      [{ backlog: 1, available: 0, activeFiles: 1 }],
    );
    mocks.readReplicaObject.mockResolvedValue({
      status: "available",
      body: new TextEncoder().encode("bad"),
    });
    mocks.readPrimaryObject.mockResolvedValue({
      status: "available",
      body: new TextEncoder().encode("bad"),
    });

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      sourceCorrupt: 1,
    });
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        status: "corrupt",
        objectEtag: null,
        objectVersionId: null,
        replicatedAt: null,
        verifiedAt: null,
        failureCode: "checksum_or_size_mismatch",
      }),
    );
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Primary file integrity mismatch",
      expect.stringContaining("expected manifest does not match stored bytes"),
    );
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        storageTarget: "primary",
        eventKind: "primary_integrity_mismatch",
        expectedChecksumSha256: checksum,
        observedChecksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("derives the content-addressed key and repairs a missing primary after database loss", async () => {
    const body = new TextEncoder().encode("abc");
    const item = claimedReplica({ fileStorageStatus: "unverified" });
    const desiredKey = replicaObjectKey({
      practiceId: item.practiceId,
      fileId: item.fileId,
      checksumSha256: checksum,
    });
    mocks.executeResults.push(
      [{ id: "materialized-1" }],
      [item],
      [{ backlog: 0, available: 1, activeFiles: 1 }],
    );
    mocks.readReplicaObject.mockImplementation(async (key: string) => {
      if (key.startsWith("recovery-catalog/")) {
        return {
          status: "available" as const,
          body: new Uint8Array(
            mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
          ),
          versionId: "replica-version",
        };
      }
      return {
        status: "available" as const,
        body,
        contentType: "application/pdf",
        etag: "replica-etag",
        versionId: "replica-version",
      };
    });
    mocks.readPrimaryObject
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({
        status: "available",
        body,
        contentType: "application/pdf",
        etag: "restored-etag",
        versionId: "restored-version",
      });

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      repairedPrimary: 1,
      failed: 0,
      bytesCopied: 3,
    });
    expect(mocks.readReplicaObject).toHaveBeenNthCalledWith(1, desiredKey, {
      maxBytes: expect.any(Number),
    });
    expect(mocks.readReplicaObject).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/pending$/),
      expect.anything(),
    );
    expect(mocks.uploadManagedFile).toHaveBeenCalledWith(
      item.fileKey,
      Buffer.from(body),
      "application/pdf",
      checksum,
    );
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        storageStatus: "available",
        checksumSha256: checksum,
        objectEtag: "restored-etag",
      }),
    );
  });

  it("repairs a corrupt primary from a verified replica", async () => {
    const body = new TextEncoder().encode("abc");
    const corrupt = new TextEncoder().encode("bad");
    const item = claimedReplica({
      replicaStatus: "available",
      replicaVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    mocks.executeResults.push(
      [],
      [item],
      [{ backlog: 0, available: 1, activeFiles: 1 }],
    );
    mocks.readReplicaObject.mockImplementation(async (key: string) => {
      if (key.startsWith("recovery-catalog/")) {
        return {
          status: "available" as const,
          body: new Uint8Array(
            mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
          ),
          versionId: "replica-version",
        };
      }
      return {
        status: "available" as const,
        body,
        versionId: "replica-version",
      };
    });
    mocks.readPrimaryObject
      .mockResolvedValueOnce({ status: "available", body: corrupt })
      .mockResolvedValueOnce({ status: "available", body });

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      repairedPrimary: 1,
      sourceCorrupt: 0,
      failed: 0,
    });
    expect(mocks.uploadManagedFile).toHaveBeenCalledTimes(1);
    expect(mocks.insertedValues).toContainEqual(
      expect.objectContaining({
        storageTarget: "primary",
        eventKind: "primary_restored_from_replica",
        nextStatus: "available",
      }),
    );
  });

  it("converges an ambiguous recovery-catalog PUT before marking an existing replica available", async () => {
    const body = new TextEncoder().encode("abc");
    const objectKey = replicaObjectKey({
      practiceId: claimedReplica().practiceId,
      fileId: claimedReplica().fileId,
      checksumSha256: checksum,
    });
    const first = claimedReplica({ replicaObjectKey: objectKey });
    mocks.executeResults.push(
      [],
      [first],
      [{ backlog: 0, available: 1, activeFiles: 1 }],
    );
    mocks.readPrimaryObject.mockResolvedValue({ status: "available", body });
    mocks.readReplicaObject.mockImplementation(async (key: string) => {
      if (key.startsWith("recovery-catalog/")) {
        return {
          status: "available" as const,
          body: new Uint8Array(
            mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
          ),
          versionId: "replica-version",
        };
      }
      return {
        status: "available" as const,
        body,
        versionId: "replica-version",
      };
    });
    mocks.uploadReplicaFile.mockRejectedValueOnce(
      new Error("catalog provider timeout"),
    );

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      failed: 0,
      alreadyPresent: 1,
    });
    expect(mocks.uploadReplicaFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadReplicaFile).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        new RegExp(
          `^recovery-catalog/v2/${first.practiceId}/${first.fileId}/[0-9a-f]{64}\\.json$`,
        ),
      ),
      expect.any(Buffer),
      "application/json",
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    expect(mocks.readReplicaObject).toHaveBeenLastCalledWith(
      expect.stringMatching(/^recovery-catalog\/v2\//),
      { maxBytes: expect.any(Number) },
    );
  });

  it("rejects provider-null replica versions as immutable recovery evidence", async () => {
    const body = new TextEncoder().encode("abc");
    mocks.executeResults.push(
      [],
      [claimedReplica()],
      [{ backlog: 1, available: 0, activeFiles: 1 }],
    );
    mocks.readPrimaryObject.mockResolvedValue({ status: "available", body });
    mocks.readReplicaObject.mockResolvedValue({
      status: "available",
      body,
      versionId: "null",
    });

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      failed: 1,
      copied: 0,
      available: 0,
    });
    expect(mocks.uploadReplicaFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadReplicaFile).not.toHaveBeenCalledWith(
      expect.stringMatching(/^recovery-catalog\/v2\//),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        status: "pending",
        objectVersionId: null,
      }),
    );
  });

  it("does not commit primary state or events when replica lease CAS is lost", async () => {
    const body = new TextEncoder().encode("abc");
    const item = claimedReplica({ replicaStatus: "available" });
    mocks.executeResults.push(
      [],
      [item],
      [{ backlog: 1, available: 0, activeFiles: 1 }],
    );
    mocks.readPrimaryObject.mockResolvedValue({ status: "available", body });
    mocks.readReplicaObject.mockImplementation(async (key: string) => {
      if (key.startsWith("recovery-catalog/")) {
        return {
          status: "available" as const,
          body: new Uint8Array(
            mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
          ),
        };
      }
      return {
        status: "available" as const,
        body,
        versionId: "replica-version",
      };
    });
    mocks.returningResults.push([]);

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      failed: 1,
      alreadyPresent: 0,
    });
    expect(mocks.updateSets).toHaveLength(1);
    expect(mocks.updateSets[0]).toMatchObject({ leaseToken: null });
    expect(mocks.insertedValues).toHaveLength(0);
  });

  it("rolls back stale finalization when a claimed primary rotates before its CAS", async () => {
    const body = new TextEncoder().encode("abc");
    mocks.executeResults.push(
      [],
      [claimedReplica()],
      [{ backlog: 1, available: 0, activeFiles: 1 }],
    );
    mocks.readPrimaryObject.mockResolvedValue({ status: "available", body });
    mocks.readReplicaObject.mockImplementation(async (key: string) => {
      if (key.startsWith("recovery-catalog/")) {
        return {
          status: "available" as const,
          body: new Uint8Array(
            mocks.uploadReplicaFile.mock.calls.at(-1)?.[1] ?? Buffer.alloc(0),
          ),
          versionId: "replica-version",
        };
      }
      return mocks.uploadReplicaFile.mock.calls.length === 0
        ? { status: "missing" as const }
        : {
            status: "available" as const,
            body,
            versionId: "replica-version",
          };
    });
    mocks.returningResults.push([{ id: "replica-1" }], []);

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      copied: 0,
      failed: 1,
    });
    expect(mocks.updateSets).toHaveLength(2);
    expect(mocks.insertedValues).toHaveLength(0);
  });

  it("stops stale primary repair when generation CAS prevents lease renewal", async () => {
    const body = new TextEncoder().encode("abc");
    const item = claimedReplica({
      replicaStatus: "available",
      replicaObjectKey: replicaObjectKey({
        practiceId: claimedReplica().practiceId,
        fileId: claimedReplica().fileId,
        checksumSha256: checksum,
      }),
      replicaVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    mocks.executeResults.push(
      [],
      [item],
      [{ backlog: 1, available: 0, activeFiles: 1 }],
    );
    mocks.readReplicaObject.mockResolvedValue({
      status: "available",
      body,
      versionId: "replica-version",
    });
    mocks.readPrimaryObject.mockResolvedValue({ status: "missing" });
    mocks.returningResults.push([]);

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      repairedPrimary: 0,
      failed: 1,
    });
    expect(mocks.uploadManagedFile).not.toHaveBeenCalled();
    expect(mocks.insertedValues).toHaveLength(0);
  });

  it("quarantines malformed tenant object namespaces before provider I/O", async () => {
    mocks.executeResults.push(
      [],
      [claimedReplica({ fileKey: "other-practice/documents/opaque" })],
      [{ backlog: 1, available: 0, activeFiles: 1 }],
    );

    await expect(reconcileFileReplicas({ limit: 1 })).resolves.toMatchObject({
      failed: 1,
    });
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
    expect(mocks.readReplicaObject).not.toHaveBeenCalled();
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        status: "failed",
        failureCode: "invalid_primary_object_namespace",
      }),
    );
  });
});
