import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANAGED_UPLOAD_SOURCE = readFileSync(
  fileURLToPath(new URL("../managed-file-upload.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => ({
  readPrimaryObject: vi.fn(),
  uploadManagedFile: vi.fn(),
  registerFileForReplication: vi.fn(async () => true),
}));

vi.mock("@/lib/s3", () => ({
  readPrimaryObject: mocks.readPrimaryObject,
  uploadManagedFile: mocks.uploadManagedFile,
}));
vi.mock("@/lib/file-replication", () => ({
  checksumSha256Hex: vi.fn(() => "a".repeat(64)),
  registerFileForReplication: mocks.registerFileForReplication,
}));

const {
  ManagedUploadConflictError,
  ManagedUploadStateError,
  finalizeManagedUploadManifest,
  markManagedUploadCorrupt,
  putAndVerifyManagedUpload,
  queueManagedUploadReplication,
  reserveManagedUpload,
} = await import("../managed-file-upload");

const practiceId = "00000000-0000-4000-8000-000000000001";
const uploadedBy = "00000000-0000-4000-8000-000000000002";
const idempotencyKey = "00000000-0000-4000-8000-000000000099";

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    practiceId,
    uploadedBy,
    idempotencyKey,
    fileName: "logo.png",
    fileKey: `${practiceId}/branding/00000000-0000-4000-8000-000000000004`,
    fileUrl: `/api/files/${practiceId}/branding/00000000-0000-4000-8000-000000000004`,
    mimeType: "image/png",
    fileSizeBytes: 8,
    checksumSha256: "a".repeat(64),
    storageStatus: "pending_upload",
    category: "branding" as const,
    source: "practice_logo",
    entityType: "practice",
    entityId: practiceId,
    patientId: null,
    appointmentId: null,
    created: true,
    ...overrides,
  };
}

function reservationInput() {
  return {
    practiceId,
    uploadedBy,
    idempotencyKey,
    fileName: "logo.png",
    mimeType: "image/png",
    fileSizeBytes: 8,
    checksumSha256: "a".repeat(64),
    category: "branding" as const,
    source: "practice_logo",
    entityType: "practice" as const,
    entityId: practiceId,
  };
}

function fakeReservationTx(input: {
  inserted?: Record<string, unknown>;
  existing?: Record<string, unknown>;
}) {
  const insertedValues: Record<string, unknown>[] = [];
  const updatedValues: Record<string, unknown>[] = [];
  const insert = vi.fn(() => {
    const builder = {
      values: vi.fn((value: Record<string, unknown>) => {
        insertedValues.push(value);
        return builder;
      }),
      onConflictDoNothing: vi.fn(() => builder),
      returning: vi.fn(async () => (input.inserted ? [input.inserted] : [])),
    };
    return builder;
  });
  const select = vi.fn(() => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn(async () => (input.existing ? [input.existing] : [])),
    };
    return builder;
  });
  const update = vi.fn(() => {
    const builder = {
      set: vi.fn((value: Record<string, unknown>) => {
        updatedValues.push(value);
        return builder;
      }),
      where: vi.fn(() => builder),
      returning: vi.fn(async () =>
        input.existing
          ? [{ ...input.existing, ...(updatedValues.at(-1) ?? {}) }]
          : [],
      ),
    };
    return builder;
  });
  return {
    tx: { insert, select, update } as never,
    insertedValues,
    updatedValues,
    select,
  };
}

function fakeTransitionTx(input: {
  updated?: Record<string, unknown>[];
  selected?: Record<string, unknown>[];
}) {
  const update = vi.fn(() => {
    const builder = {
      set: vi.fn(() => builder),
      where: vi.fn(() => builder),
      returning: vi.fn(async () => input.updated ?? []),
    };
    return builder;
  });
  const select = vi.fn(() => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => input.selected ?? []),
    };
    return builder;
  });
  return { tx: { update, select } as never, update, select };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("managed upload reservation", () => {
  it("persists a pending manifest with semantic ownership before provider I/O", async () => {
    const row = reservation({ created: undefined });
    delete (row as { created?: unknown }).created;
    const { tx, insertedValues } = fakeReservationTx({ inserted: row });

    const result = await reserveManagedUpload(tx, reservationInput());

    expect(result.created).toBe(true);
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        storageStatus: "pending_upload",
        idempotencyKey,
        category: "branding",
        source: "practice_logo",
        entityType: "practice",
        entityId: practiceId,
      }),
    );
    expect(mocks.uploadManagedFile).not.toHaveBeenCalled();
  });

  it("resumes a matching reservation and rejects key reuse with another payload", async () => {
    const existing = reservation({ created: undefined });
    delete (existing as { created?: unknown }).created;
    const matching = fakeReservationTx({ existing });
    await expect(
      reserveManagedUpload(matching.tx, reservationInput()),
    ).resolves.toMatchObject({ created: false, idempotencyKey });

    const mismatched = fakeReservationTx({
      existing: { ...existing, checksumSha256: "b".repeat(64) },
    });
    await expect(
      reserveManagedUpload(mismatched.tx, reservationInput()),
    ).rejects.toBeInstanceOf(ManagedUploadConflictError);
    expect(mismatched.updatedValues).toHaveLength(0);
  });

  it("fails closed on a tombstoned idempotency reservation without resurrecting it", async () => {
    expect(new ManagedUploadStateError("deleted")).toBeInstanceOf(
      ManagedUploadConflictError,
    );
    const tombstoned = reservation({
      created: undefined,
      deletedAt: new Date("2026-08-01T00:00:00.000Z"),
      storageStatus: "available",
    });
    delete (tombstoned as { created?: unknown }).created;
    const replay = fakeReservationTx({ existing: tombstoned });

    await expect(
      reserveManagedUpload(replay.tx, reservationInput()),
    ).rejects.toBeInstanceOf(ManagedUploadStateError);
    expect(replay.updatedValues).toHaveLength(0);
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
    expect(mocks.uploadManagedFile).not.toHaveBeenCalled();
  });

  it.each(["missing", "unverified"])(
    "atomically reopens an exact live %s reservation for safe read-before-write retry",
    async (storageStatus) => {
      const existing = reservation({
        created: undefined,
        deletedAt: null,
        storageStatus,
        storageVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        objectEtag: "stale-etag",
        objectVersionId: "stale-version",
      });
      delete (existing as { created?: unknown }).created;
      const replay = fakeReservationTx({ existing });

      await expect(
        reserveManagedUpload(replay.tx, reservationInput()),
      ).resolves.toMatchObject({
        id: existing.id,
        storageStatus: "pending_upload",
        storageVerifiedAt: null,
        objectEtag: null,
        objectVersionId: null,
        created: false,
      });
      expect(replay.updatedValues).toContainEqual(
        expect.objectContaining({
          storageStatus: "pending_upload",
          storageVerifiedAt: null,
          objectEtag: null,
          objectVersionId: null,
        }),
      );
    },
  );

  it("never reopens a cleanup-pending reservation", async () => {
    const existing = reservation({
      created: undefined,
      deletedAt: null,
      storageStatus: "cleanup_pending",
    });
    delete (existing as { created?: unknown }).created;
    const replay = fakeReservationTx({ existing });

    await expect(
      reserveManagedUpload(replay.tx, reservationInput()),
    ).rejects.toBeInstanceOf(ManagedUploadStateError);
    expect(replay.updatedValues).toHaveLength(0);
    expect(mocks.uploadManagedFile).not.toHaveBeenCalled();
  });

  it("rotates a matching corrupt reservation onto a fresh quarantined key", async () => {
    const existing = reservation({
      created: undefined,
      storageStatus: "corrupt",
      storageVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      objectEtag: "corrupt-etag",
      objectVersionId: "corrupt-version",
    });
    delete (existing as { created?: unknown }).created;
    const originalKey = existing.fileKey;
    const recovery = fakeReservationTx({ existing });

    const result = await reserveManagedUpload(recovery.tx, reservationInput());

    expect(result).toMatchObject({
      id: existing.id,
      idempotencyKey,
      storageStatus: "pending_upload",
      storageVerifiedAt: null,
      objectEtag: null,
      objectVersionId: null,
      created: false,
    });
    expect(result.fileKey).not.toBe(originalKey);
    expect(result.fileKey).toMatch(
      new RegExp(`^${practiceId}/branding/${existing.id}-[0-9a-f-]{36}$`),
    );
    expect(result.fileUrl).toBe(`/api/files/${result.fileKey}`);
    expect(recovery.updatedValues).toContainEqual(
      expect.objectContaining({
        fileKey: result.fileKey,
        fileUrl: result.fileUrl,
        storageStatus: "pending_upload",
        storageVerifiedAt: null,
        objectEtag: null,
        objectVersionId: null,
      }),
    );
    const selectBuilder = recovery.select.mock.results[0]?.value;
    expect(selectBuilder.for).toHaveBeenCalledWith("update");
  });
});

describe("managed upload provider convergence", () => {
  it("recovers a committed PUT even when the provider write returned an error", async () => {
    const body = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    mocks.uploadManagedFile.mockRejectedValueOnce(new Error("timeout"));
    mocks.readPrimaryObject.mockResolvedValueOnce({
      status: "available",
      body,
      etag: "etag-readback",
      versionId: "version-readback",
    });

    await expect(
      putAndVerifyManagedUpload({ reservation: reservation(), body }),
    ).resolves.toEqual({
      status: "verified",
      evidence: {
        url: `/api/files/${practiceId}/branding/00000000-0000-4000-8000-000000000004`,
        etag: "etag-readback",
        versionId: "version-readback",
      },
    });
  });

  it("does not overwrite a pending reservation while provider state is unknown", async () => {
    const body = Buffer.alloc(8);
    mocks.readPrimaryObject.mockResolvedValueOnce({ status: "failed" });

    await expect(
      putAndVerifyManagedUpload({
        reservation: reservation({ created: false }),
        body,
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(mocks.uploadManagedFile).not.toHaveBeenCalled();
  });

  it("classifies deterministic-key checksum mismatch as corrupt", async () => {
    mocks.readPrimaryObject.mockResolvedValueOnce({
      status: "available",
      body: new Uint8Array(7),
    });

    await expect(
      putAndVerifyManagedUpload({
        reservation: reservation({ created: false }),
        body: Buffer.alloc(8),
      }),
    ).resolves.toEqual({ status: "corrupt" });
  });

  it("reads a recovered replacement key before safely writing expected bytes", async () => {
    const body = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const recovered = reservation({
      created: false,
      storageStatus: "pending_upload",
      fileKey: `${practiceId}/branding/00000000-0000-4000-8000-000000000055`,
      fileUrl: `/api/files/${practiceId}/branding/00000000-0000-4000-8000-000000000055`,
    });
    mocks.readPrimaryObject
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({
        status: "available",
        body,
        etag: "replacement-etag",
        versionId: "replacement-version",
      });
    mocks.uploadManagedFile.mockResolvedValueOnce({
      url: recovered.fileUrl,
      etag: "replacement-etag",
      versionId: "replacement-version",
    });

    await expect(
      putAndVerifyManagedUpload({ reservation: recovered, body }),
    ).resolves.toEqual({
      status: "verified",
      evidence: {
        url: recovered.fileUrl,
        etag: "replacement-etag",
        versionId: "replacement-version",
      },
    });
    expect(mocks.readPrimaryObject).toHaveBeenNthCalledWith(
      1,
      recovered.fileKey,
      { maxBytes: 10 * 1024 * 1024 },
    );
    expect(mocks.uploadManagedFile).toHaveBeenCalledWith(
      recovered.fileKey,
      body,
      recovered.mimeType,
      recovered.checksumSha256,
    );
  });

  it("queues exact verified evidence for independent replication", async () => {
    await expect(
      queueManagedUploadReplication(reservation(), {
        url: "s3://primary/object",
        etag: "etag-1",
        versionId: "version-1",
      }),
    ).resolves.toBe(true);
    expect(mocks.registerFileForReplication).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "00000000-0000-4000-8000-000000000004",
        checksumSha256: "a".repeat(64),
        objectVersionId: "version-1",
      }),
    );
  });
});

describe("managed upload manifest transitions", () => {
  it("fails closed when finalization loses its exact reservation generation", async () => {
    const stale = fakeTransitionTx({ updated: [], selected: [] });

    await expect(
      finalizeManagedUploadManifest(stale.tx, reservation(), {
        url: reservation().fileUrl,
        etag: "etag-old",
        versionId: "version-old",
      }),
    ).resolves.toBe(false);
    expect(stale.select).toHaveBeenCalledTimes(1);
  });

  it("allows an exact concurrent generation that is already available", async () => {
    const converged = fakeTransitionTx({
      updated: [],
      selected: [{ id: reservation().id }],
    });

    await expect(
      finalizeManagedUploadManifest(converged.tx, reservation(), {
        url: reservation().fileUrl,
        etag: "etag-retry",
        versionId: "version-retry",
      }),
    ).resolves.toBe(true);
  });

  it("reports a lost corrupt-state compare-and-swap without downgrading newer state", async () => {
    const stale = fakeTransitionTx({ updated: [] });
    await expect(
      markManagedUploadCorrupt(stale.tx, reservation()),
    ).resolves.toBe(false);
  });

  it("converges when the exact object generation is already quarantined", async () => {
    const converged = fakeTransitionTx({
      updated: [],
      selected: [{ id: reservation().id }],
    });
    await expect(
      markManagedUploadCorrupt(converged.tx, reservation()),
    ).resolves.toBe(true);
  });

  it("binds every mutation to the exact object generation and prior state", () => {
    const finalizeSource = MANAGED_UPLOAD_SOURCE.slice(
      MANAGED_UPLOAD_SOURCE.indexOf(
        "export async function finalizeManagedUploadManifest",
      ),
      MANAGED_UPLOAD_SOURCE.indexOf(
        "export async function markManagedUploadCorrupt",
      ),
    );
    const corruptSource = MANAGED_UPLOAD_SOURCE.slice(
      MANAGED_UPLOAD_SOURCE.indexOf(
        "export async function markManagedUploadCorrupt",
      ),
      MANAGED_UPLOAD_SOURCE.indexOf(
        "export async function queueManagedUploadReplication",
      ),
    );
    for (const source of [finalizeSource, corruptSource]) {
      expect(source).toContain(
        "eq(files.idempotencyKey, reservation.idempotencyKey)",
      );
      expect(source).toContain("eq(files.fileKey, reservation.fileKey)");
      expect(source).toContain("eq(files.fileUrl, reservation.fileUrl)");
      expect(source).toContain(
        "eq(files.checksumSha256, reservation.checksumSha256)",
      );
      expect(source).toContain(
        "eq(files.fileSizeBytes, reservation.fileSizeBytes)",
      );
      expect(source).toContain("isNull(files.deletedAt)");
    }
    expect(finalizeSource).toContain(
      'eq(files.storageStatus, "pending_upload")',
    );
    expect(corruptSource).toContain(
      'eq(files.storageStatus, "pending_upload")',
    );
    const rotateSource = MANAGED_UPLOAD_SOURCE.slice(
      MANAGED_UPLOAD_SOURCE.indexOf("async function rotateCorruptReservation"),
      MANAGED_UPLOAD_SOURCE.indexOf(
        "async function reopenRetryableReservation",
      ),
    );
    const reopenSource = MANAGED_UPLOAD_SOURCE.slice(
      MANAGED_UPLOAD_SOURCE.indexOf(
        "async function reopenRetryableReservation",
      ),
      MANAGED_UPLOAD_SOURCE.indexOf(
        "export async function reserveManagedUpload",
      ),
    );
    expect(rotateSource).toContain("isNull(files.deletedAt)");
    expect(reopenSource).toContain("isNull(files.deletedAt)");
    expect(reopenSource).toContain(
      'inArray(files.storageStatus, ["missing", "unverified"])',
    );
  });
});
