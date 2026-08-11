import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const send = vi.fn();

  return {
    send,
    S3Client: vi.fn(() => ({ send })),
    PutObjectCommand: vi.fn((input: unknown) => ({ input })),
    GetObjectCommand: vi.fn((input: unknown) => ({ input })),
    DeleteObjectCommand: vi.fn((input: unknown) => ({ input })),
    HeadBucketCommand: vi.fn((input: unknown) => ({ input })),
    getSignedUrl: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: mocks.S3Client,
  PutObjectCommand: mocks.PutObjectCommand,
  GetObjectCommand: mocks.GetObjectCommand,
  DeleteObjectCommand: mocks.DeleteObjectCommand,
  HeadBucketCommand: mocks.HeadBucketCommand,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mocks.getSignedUrl,
}));

const {
  OBJECT_STORAGE_HEALTH_TIMEOUT_MS,
  checkObjectStorageHealth,
  checkReplicaStorageHealth,
  deleteFile,
  getObject,
  normalizeS3VersionId,
  readPrimaryObject,
  replicaStorageIncludesPractice,
  replicaStoragePracticeScope,
  replicaStorageReadiness,
  replicaStorageRequired,
  replicaStorageRolloutEnabled,
  uploadFile,
  uploadManagedFile,
} = await import("../s3");

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("S3 uploads", () => {
  it("stores a SHA-256 marker and returns provider write evidence", async () => {
    mocks.send.mockResolvedValueOnce({
      ETag: "etag-1",
      VersionId: "version-1",
    });

    await expect(
      uploadManagedFile(
        "practice-1/documents/file-1",
        Buffer.from("pdf"),
        "application/pdf",
        "a".repeat(64),
      ),
    ).resolves.toEqual({
      url: "https://s3.amazonaws.com/openpims/practice-1/documents/file-1",
      etag: "etag-1",
      versionId: "version-1",
    });
    expect(mocks.PutObjectCommand).toHaveBeenCalledWith({
      Bucket: "openpims",
      Key: "practice-1/documents/file-1",
      Body: Buffer.from("pdf"),
      ContentType: "application/pdf",
      Metadata: { "openvpm-sha256": "a".repeat(64) },
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: "practice-1/documents/file-1",
        }),
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("does not expose blank or provider-null version IDs as recovery evidence", async () => {
    mocks.send
      .mockResolvedValueOnce({ VersionId: " null " })
      .mockResolvedValueOnce({ VersionId: "   " });

    await expect(
      uploadManagedFile(
        "practice-1/documents/file-1",
        Buffer.from("pdf"),
        "application/pdf",
        "a".repeat(64),
      ),
    ).resolves.not.toHaveProperty("versionId");
    await expect(
      uploadManagedFile(
        "practice-1/documents/file-2",
        Buffer.from("pdf"),
        "application/pdf",
        "a".repeat(64),
      ),
    ).resolves.not.toHaveProperty("versionId");
    expect(normalizeS3VersionId(" version-1 ")).toBe("version-1");
  });

  it("bounds object deletion with the provider I/O timeout signal", async () => {
    mocks.send.mockResolvedValueOnce({});

    await expect(
      deleteFile("practice-1/documents/opaque-key"),
    ).resolves.toBeUndefined();
    expect(mocks.DeleteObjectCommand).toHaveBeenCalledWith({
      Bucket: "openpims",
      Key: "practice-1/documents/opaque-key",
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("trims configured storage env values before creating objects and URLs", async () => {
    vi.stubEnv("S3_ENDPOINT", " https://storage.example ");
    vi.stubEnv("S3_REGION", " us-east-1 ");
    vi.stubEnv("S3_ACCESS_KEY", " access ");
    vi.stubEnv("S3_SECRET_KEY", "\tsecret\n");
    vi.stubEnv("S3_BUCKET", " clinic-private-bucket ");
    mocks.send.mockResolvedValueOnce({});

    await expect(
      uploadFile(
        "practice-1/branding/logo.png",
        Buffer.from("logo"),
        "image/png",
      ),
    ).resolves.toBe(
      "https://storage.example/clinic-private-bucket/practice-1/branding/logo.png",
    );

    expect(mocks.S3Client).toHaveBeenCalledWith({
      endpoint: "https://storage.example",
      region: "us-east-1",
      credentials: {
        accessKeyId: "access",
        secretAccessKey: "secret",
      },
      forcePathStyle: true,
    });
    expect(mocks.PutObjectCommand).toHaveBeenCalledWith({
      Bucket: "clinic-private-bucket",
      Key: "practice-1/branding/logo.png",
      Body: Buffer.from("logo"),
      ContentType: "image/png",
    });
  });

  it("falls back from blank storage env values instead of passing whitespace to S3", async () => {
    vi.stubEnv("S3_ENDPOINT", "   ");
    vi.stubEnv("S3_REGION", "\t");
    vi.stubEnv("S3_ACCESS_KEY", " ");
    vi.stubEnv("S3_SECRET_KEY", "\n");
    vi.stubEnv("S3_BUCKET", "   ");
    mocks.send.mockResolvedValueOnce({});

    await expect(
      uploadFile(
        "practice-1/files/lab.pdf",
        Buffer.from("pdf"),
        "application/pdf",
      ),
    ).resolves.toBe(
      "https://s3.amazonaws.com/openpims/practice-1/files/lab.pdf",
    );

    expect(mocks.S3Client).toHaveBeenCalledWith({
      endpoint: undefined,
      region: "us-east-1",
      credentials: {
        accessKeyId: "",
        secretAccessKey: "",
      },
      forcePathStyle: true,
    });
    expect(mocks.PutObjectCommand).toHaveBeenCalledWith({
      Bucket: "openpims",
      Key: "practice-1/files/lab.pdf",
      Body: Buffer.from("pdf"),
      ContentType: "application/pdf",
    });
  });
});

describe("S3 object reads", () => {
  it("rejects unusable exact-version requests before provider I/O", async () => {
    await expect(
      readPrimaryObject("practice/documents/file", { versionId: "null" }),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      readPrimaryObject("practice/documents/file", { versionId: "  " }),
    ).resolves.toEqual({ status: "failed" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("requires the provider to return the requested usable version ID", async () => {
    mocks.send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: vi.fn(async () => new Uint8Array([1, 2, 3])),
      },
      VersionId: "null",
    });

    await expect(
      readPrimaryObject("practice/documents/file", {
        versionId: "version-1",
      }),
    ).resolves.toEqual({ status: "failed" });
  });

  it("distinguishes a definitive missing object from a provider outage", async () => {
    mocks.send.mockRejectedValueOnce({
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    await expect(
      readPrimaryObject("practice/documents/missing"),
    ).resolves.toEqual({ status: "missing" });

    mocks.send.mockRejectedValueOnce(new Error("provider timeout secret=abc"));
    await expect(
      readPrimaryObject("practice/documents/unavailable"),
    ).resolves.toEqual({ status: "failed" });
  });

  it("rejects oversized objects from provider metadata before buffering", async () => {
    const transformToByteArray = vi.fn(async () => new Uint8Array([1, 2, 3]));
    mocks.send.mockResolvedValueOnce({
      Body: { transformToByteArray },
      ContentLength: 11,
      ContentType: "image/png",
    });

    await expect(
      getObject("practice/documents/lab.pdf", { maxBytes: 10 }),
    ).resolves.toBeNull();
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("rejects oversized objects after buffering when metadata is unavailable", async () => {
    mocks.send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: vi.fn(async () => new Uint8Array(11)),
      },
      ContentType: "application/pdf",
    });

    await expect(
      getObject("practice/documents/lab.pdf", { maxBytes: 10 }),
    ).resolves.toBeNull();
  });

  it("returns object bytes within the caller byte cap", async () => {
    const body = new Uint8Array([1, 2, 3]);
    mocks.send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: vi.fn(async () => body),
      },
      ContentLength: body.byteLength,
      ContentType: "image/png",
    });

    await expect(
      getObject("practice/branding/logo.png", { maxBytes: 10 }),
    ).resolves.toEqual({ body, contentType: "image/png" });
  });
});

describe("S3 health checks", () => {
  it("requires an explicit all-practice flag or valid UUID cohort before rollout", () => {
    vi.stubEnv("S3_ENDPOINT", "https://primary.example");
    vi.stubEnv("S3_BUCKET", "primary");
    vi.stubEnv("FILE_REPLICA_S3_ENDPOINT", "https://replica.example");
    vi.stubEnv("FILE_REPLICA_S3_BUCKET", "replica");
    vi.stubEnv("FILE_REPLICA_S3_ACCESS_KEY", "replica-access");
    vi.stubEnv("FILE_REPLICA_S3_SECRET_KEY", "replica-secret");

    expect(replicaStorageRolloutEnabled()).toBe(false);
    expect(replicaStorageReadiness()).toMatchObject({ ready: true });
    expect(replicaStorageIncludesPractice("practice-1")).toBe(false);

    vi.stubEnv("FILE_REPLICA_ENABLED", "true");
    expect(replicaStorageReadiness()).toMatchObject({
      ready: false,
      detail: "Replica rollout needs an exact practice cohort",
    });

    vi.stubEnv("FILE_REPLICA_PRACTICE_IDS", "not-a-uuid");
    expect(replicaStorageReadiness()).toMatchObject({
      ready: false,
      detail: "Replica rollout practice cohort is invalid",
    });

    const practiceId = "00000000-0000-4000-8000-000000000001";
    vi.stubEnv("FILE_REPLICA_PRACTICE_IDS", ` ${practiceId},${practiceId} `);
    expect(replicaStorageReadiness()).toMatchObject({ ready: true });
    expect(replicaStoragePracticeScope()).toEqual([practiceId]);
    expect(replicaStorageIncludesPractice(practiceId)).toBe(true);
    expect(
      replicaStorageIncludesPractice("00000000-0000-4000-8000-000000000099"),
    ).toBe(false);

    vi.stubEnv("FILE_REPLICA_ALL_PRACTICES", "true");
    expect(replicaStorageReadiness()).toMatchObject({
      ready: false,
      detail:
        "Replica rollout must choose either all practices or an exact cohort",
    });
  });

  it("keeps an absent replica advisory but fails closed on partial or identical config", () => {
    expect(replicaStorageReadiness()).toEqual({
      intended: false,
      ready: false,
      detail: "Independent object replica is not configured",
    });

    vi.stubEnv("FILE_REPLICA_REQUIRED", "true");
    expect(replicaStorageRequired()).toBe(true);
    expect(replicaStorageReadiness()).toMatchObject({
      intended: true,
      ready: false,
      detail: "3 required replica storage values are missing",
    });

    vi.stubEnv("S3_ENDPOINT", "https://storage.example");
    vi.stubEnv("S3_BUCKET", "primary");
    vi.stubEnv("FILE_REPLICA_S3_ENDPOINT", "https://storage.example/");
    vi.stubEnv("FILE_REPLICA_S3_BUCKET", "primary");
    vi.stubEnv("FILE_REPLICA_S3_ACCESS_KEY", "replica-access");
    vi.stubEnv("FILE_REPLICA_S3_SECRET_KEY", "replica-secret");
    expect(replicaStorageReadiness()).toEqual({
      intended: true,
      ready: false,
      detail: "Replica storage must use a different endpoint or bucket",
    });
  });

  it("health-checks a complete independent replica without exposing its identity", async () => {
    vi.stubEnv("S3_ENDPOINT", "https://primary.example");
    vi.stubEnv("S3_BUCKET", "primary");
    vi.stubEnv("FILE_REPLICA_S3_ENDPOINT", " https://replica.example ");
    vi.stubEnv("FILE_REPLICA_S3_REGION", " us-west-2 ");
    vi.stubEnv("FILE_REPLICA_S3_ACCESS_KEY", " replica-access ");
    vi.stubEnv("FILE_REPLICA_S3_SECRET_KEY", " replica-secret ");
    vi.stubEnv("FILE_REPLICA_S3_BUCKET", " replica-private ");
    mocks.send.mockResolvedValueOnce({});

    await expect(
      checkReplicaStorageHealth({ timeoutMs: 1234 }),
    ).resolves.toEqual({
      ok: true,
      detail: "Replica object storage reachable",
    });
    expect(mocks.S3Client).toHaveBeenCalledWith({
      endpoint: "https://replica.example",
      region: "us-west-2",
      credentials: {
        accessKeyId: "replica-access",
        secretAccessKey: "replica-secret",
      },
      forcePathStyle: true,
    });
    expect(mocks.HeadBucketCommand).toHaveBeenCalledWith({
      Bucket: "replica-private",
    });
  });

  it("checks bucket reachability with a bounded HeadBucket request", async () => {
    mocks.send.mockResolvedValueOnce({});

    await expect(
      checkObjectStorageHealth({ timeoutMs: 1234 }),
    ).resolves.toEqual({
      ok: true,
      detail: "Object storage bucket reachable",
    });

    expect(mocks.HeadBucketCommand).toHaveBeenCalledWith({
      Bucket: "openpims",
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: "openpims" },
      }),
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(OBJECT_STORAGE_HEALTH_TIMEOUT_MS).toBe(5_000);
  });

  it("returns a sanitized storage health failure", async () => {
    mocks.send.mockRejectedValueOnce(
      new Error("AccessDenied bucket=openpims secret=abc123"),
    );

    await expect(checkObjectStorageHealth()).resolves.toEqual({
      ok: false,
      detail: "Object storage check failed",
    });
  });
});
