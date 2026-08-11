import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const practiceId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000002";
  const fileMetadata = (overrides: Record<string, unknown> = {}) => ({
    id: "file_123",
    fileName: "logo.png",
    mimeType: "image/png",
    checksumSha256: null,
    fileSizeBytes: null,
    storageStatus: "unverified",
    replicaObjectKey: null,
    replicaObjectVersionId: null,
    replicaChecksumSha256: null,
    replicaFileSizeBytes: null,
    replicaStatus: null,
    ...overrides,
  });
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [fileMetadata()];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const tx = { select };

  return {
    practiceId,
    userId,
    fileMetadata,
    selectResults,
    getServerSession: vi.fn(async () => ({
      user: { id: userId, practiceId },
    })),
    readPrimaryObject: vi.fn(),
    readReplicaObject: vi.fn(),
    schedulePrimaryRepair: vi.fn(async () => true),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    ),
  };
});

vi.mock("next-auth", () => ({
  getServerSession: mocks.getServerSession,
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@openpims/db/client", () => ({
  db: {},
}));

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
}));

vi.mock("@/lib/file-replication", () => ({
  checksumSha256Hex: vi.fn(() => "a".repeat(64)),
  schedulePrimaryRepair: mocks.schedulePrimaryRepair,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

const { GET } = await import("./route");
const { UPLOAD_FILE_MAX_BYTES } = await import("@/lib/upload-limits");

function fileRequest(path: string) {
  return new Request(`https://openvpm.test/api/files/${path}`) as never;
}

function routeContext(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.selectResults.length = 0;
  mocks.getServerSession.mockResolvedValue({
    user: { id: mocks.userId, practiceId: mocks.practiceId },
  });
});

describe("file proxy response headers", () => {
  it("serves public branding images inline without requiring a session", async () => {
    mocks.readPrimaryObject.mockResolvedValue({
      status: "available",
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo.png`),
      routeContext([mocks.practiceId, "branding", "logo.png"]),
    );

    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.readPrimaryObject).toHaveBeenCalledWith(
      `${mocks.practiceId}/branding/logo.png`,
      { maxBytes: UPLOAD_FILE_MAX_BYTES },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="logo.png"',
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("does not serve non-image objects from the public branding category", async () => {
    mocks.readPrimaryObject.mockResolvedValue({
      status: "available",
      body: new TextEncoder().encode("%PDF-1.7\n"),
      contentType: "application/pdf",
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo.pdf`),
      routeContext([mocks.practiceId, "branding", "logo.pdf"]),
    );

    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.readPrimaryObject).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("does not fetch public branding objects without active file metadata", async () => {
    mocks.selectResults.push([]);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo.png`),
      routeContext([mocks.practiceId, "branding", "logo.png"]),
    );

    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("does not fetch public branding objects with non-image file metadata", async () => {
    mocks.selectResults.push([
      mocks.fileMetadata({ mimeType: "application/pdf" }),
    ]);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo.png`),
      routeContext([mocks.practiceId, "branding", "logo.png"]),
    );

    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("rejects malformed encoded paths before auth or storage lookup", async () => {
    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/%`),
      routeContext([mocks.practiceId, "branding", "%"]),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("rejects encoded path separators before auth or storage lookup", async () => {
    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo%2Fsecret.png`),
      routeContext([mocks.practiceId, "branding", "logo%2Fsecret.png"]),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("rejects unsupported categories before auth or storage lookup", async () => {
    const response = await GET(
      fileRequest(`${mocks.practiceId}/exports/backup.json`),
      routeContext([mocks.practiceId, "exports", "backup.json"]),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("rejects deeper object paths before auth or storage lookup", async () => {
    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/nested/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "nested", "lab.pdf"]),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("rejects private objects without session lookup when NEXTAUTH_SECRET is blank", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "   ");

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"]),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("serves private document files as attachments with nosniff", async () => {
    mocks.selectResults.push(
      [{ id: mocks.userId }],
      [
        mocks.fileMetadata({
          fileName: "lab.pdf",
          mimeType: "application/pdf",
        }),
      ],
    );
    mocks.readPrimaryObject.mockResolvedValue({
      status: "available",
      body: new TextEncoder().encode("%PDF-1.7\n"),
      contentType: "application/pdf",
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"]),
    );

    expect(mocks.getServerSession).toHaveBeenCalledTimes(1);
    expect(mocks.withSystem).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="lab.pdf"',
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
  });

  it("serves a checksum-verified replica when the primary provider fails", async () => {
    const replicaBody = new Uint8Array([1, 2, 3]);
    mocks.selectResults.push(
      [{ id: mocks.userId }],
      [
        mocks.fileMetadata({
          fileName: "lab report.pdf",
          mimeType: "application/pdf",
          checksumSha256: "a".repeat(64),
          fileSizeBytes: replicaBody.byteLength,
          storageStatus: "missing",
          replicaObjectKey: "attachments/v1/practice/file/checksum",
          replicaObjectVersionId: "replica-version-1",
          replicaChecksumSha256: "a".repeat(64),
          replicaFileSizeBytes: replicaBody.byteLength,
          replicaStatus: "available",
        }),
      ],
    );
    mocks.readPrimaryObject.mockResolvedValue({ status: "failed" });
    mocks.readReplicaObject.mockResolvedValue({
      status: "available",
      body: replicaBody,
      contentType: "application/pdf",
      versionId: "replica-version-1",
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/opaque-key`),
      routeContext([mocks.practiceId, "documents", "opaque-key"]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="lab_report.pdf"',
    );
    expect(mocks.readReplicaObject).toHaveBeenCalledWith(
      "attachments/v1/practice/file/checksum",
      {
        maxBytes: UPLOAD_FILE_MAX_BYTES,
        versionId: "replica-version-1",
      },
    );
    expect(mocks.schedulePrimaryRepair).toHaveBeenCalledWith({
      practiceId: mocks.practiceId,
      fileId: "file_123",
      fileKey: `${mocks.practiceId}/documents/opaque-key`,
      checksumSha256: "a".repeat(64),
      fileSizeBytes: replicaBody.byteLength,
      storageStatus: "missing",
      observedState: "failed",
    });
  });

  it("does not serve a replica whose stored version is provider-null", async () => {
    mocks.selectResults.push(
      [{ id: mocks.userId }],
      [
        mocks.fileMetadata({
          fileName: "lab.pdf",
          mimeType: "application/pdf",
          checksumSha256: "a".repeat(64),
          fileSizeBytes: 3,
          storageStatus: "missing",
          replicaObjectKey: "attachments/v1/practice/file/checksum",
          replicaObjectVersionId: "null",
          replicaChecksumSha256: "a".repeat(64),
          replicaFileSizeBytes: 3,
          replicaStatus: "available",
        }),
      ],
    );
    mocks.readPrimaryObject.mockResolvedValue({ status: "missing" });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/opaque-key`),
      routeContext([mocks.practiceId, "documents", "opaque-key"]),
    );

    expect(response.status).toBe(404);
    expect(mocks.readReplicaObject).not.toHaveBeenCalled();
  });

  it("does not report a missing primary as definitive when replica verification fails", async () => {
    mocks.selectResults.push(
      [{ id: mocks.userId }],
      [
        mocks.fileMetadata({
          fileName: "lab.pdf",
          mimeType: "application/pdf",
          checksumSha256: "a".repeat(64),
          fileSizeBytes: 3,
          storageStatus: "missing",
          replicaObjectKey: "attachments/v1/practice/file/checksum",
          replicaObjectVersionId: "replica-version-1",
          replicaChecksumSha256: "a".repeat(64),
          replicaFileSizeBytes: 3,
          replicaStatus: "available",
        }),
      ],
    );
    mocks.readPrimaryObject.mockResolvedValue({ status: "missing" });
    mocks.readReplicaObject.mockResolvedValue({ status: "failed" });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/opaque-key`),
      routeContext([mocks.practiceId, "documents", "opaque-key"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "File temporarily unavailable",
    });
  });

  it("treats oversized storage objects as missing", async () => {
    mocks.selectResults.push(
      [{ id: mocks.userId }],
      [
        mocks.fileMetadata({
          fileName: "lab.pdf",
          mimeType: "application/pdf",
        }),
      ],
    );
    mocks.readPrimaryObject.mockResolvedValue({ status: "failed" });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "File temporarily unavailable",
    });
    expect(mocks.readPrimaryObject).toHaveBeenCalledWith(
      `${mocks.practiceId}/documents/lab.pdf`,
      { maxBytes: UPLOAD_FILE_MAX_BYTES },
    );
  });

  it("does not fetch private objects without active file metadata", async () => {
    mocks.selectResults.push([{ id: mocks.userId }], []);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"]),
    );

    expect(mocks.getServerSession).toHaveBeenCalledTimes(1);
    expect(mocks.withSystem).toHaveBeenCalledTimes(2);
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("does not fetch private objects for stale sessions", async () => {
    mocks.selectResults.push([]);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"]),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("does not fetch private objects for another practice", async () => {
    mocks.getServerSession.mockResolvedValue({
      user: {
        id: mocks.userId,
        practiceId: "00000000-0000-0000-0000-000000000099",
      },
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"]),
    );

    expect(response.status).toBe(403);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("revalidates private file sessions against active user and practice rows", () => {
    expect(ROUTE_SOURCE).toContain("innerJoin(");
    expect(ROUTE_SOURCE).toContain("getActiveFileMetadata");
    expect(ROUTE_SOURCE).toContain("eq(files.fileKey, key)");
    expect(ROUTE_SOURCE).toContain("eq(files.practiceId, practiceId)");
    expect(ROUTE_SOURCE).toContain("eq(files.category, category)");
    expect(ROUTE_SOURCE).toContain("isNull(files.deletedAt)");
    expect(ROUTE_SOURCE).toContain("isNull(practices.deletedAt)");
    expect(ROUTE_SOURCE).toContain("eq(users.id, session.user.id)");
    expect(ROUTE_SOURCE).toContain("eq(users.practiceId, practiceId)");
    expect(ROUTE_SOURCE).toContain("isNull(users.deletedAt)");
  });
});
