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
  getObject,
  uploadFile,
} = await import("../s3");

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("S3 uploads", () => {
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
        "image/png"
      )
    ).resolves.toBe(
      "https://storage.example/clinic-private-bucket/practice-1/branding/logo.png"
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
      uploadFile("practice-1/files/lab.pdf", Buffer.from("pdf"), "application/pdf")
    ).resolves.toBe("https://s3.amazonaws.com/openpims/practice-1/files/lab.pdf");

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
  it("rejects oversized objects from provider metadata before buffering", async () => {
    const transformToByteArray = vi.fn(async () => new Uint8Array([1, 2, 3]));
    mocks.send.mockResolvedValueOnce({
      Body: { transformToByteArray },
      ContentLength: 11,
      ContentType: "image/png",
    });

    await expect(getObject("practice/documents/lab.pdf", { maxBytes: 10 }))
      .resolves.toBeNull();
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("rejects oversized objects after buffering when metadata is unavailable", async () => {
    mocks.send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: vi.fn(async () => new Uint8Array(11)),
      },
      ContentType: "application/pdf",
    });

    await expect(getObject("practice/documents/lab.pdf", { maxBytes: 10 }))
      .resolves.toBeNull();
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

    await expect(getObject("practice/branding/logo.png", { maxBytes: 10 }))
      .resolves.toEqual({ body, contentType: "image/png" });
  });
});

describe("S3 health checks", () => {
  it("checks bucket reachability with a bounded HeadBucket request", async () => {
    mocks.send.mockResolvedValueOnce({});

    await expect(checkObjectStorageHealth({ timeoutMs: 1234 })).resolves.toEqual(
      {
        ok: true,
        detail: "Object storage bucket reachable",
      }
    );

    expect(mocks.HeadBucketCommand).toHaveBeenCalledWith({
      Bucket: "openpims",
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: "openpims" },
      }),
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      })
    );
    expect(OBJECT_STORAGE_HEALTH_TIMEOUT_MS).toBe(5_000);
  });

  it("returns a sanitized storage health failure", async () => {
    mocks.send.mockRejectedValueOnce(
      new Error("AccessDenied bucket=openpims secret=abc123")
    );

    await expect(checkObjectStorageHealth()).resolves.toEqual({
      ok: false,
      detail: "Object storage check failed",
    });
  });
});
