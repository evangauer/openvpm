import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  BlobNotFoundError,
  del as deleteBlob,
  get as getBlob,
  list as listBlobs,
  put as putBlob,
} from "@vercel/blob";
import { createHash } from "node:crypto";

export const FILE_REPLICA_TARGET = "independent-v1";

const REPLICA_ENV_NAMES = [
  "FILE_REPLICA_ENABLED",
  "FILE_REPLICA_ALL_PRACTICES",
  "FILE_REPLICA_PRACTICE_IDS",
  "FILE_REPLICA_PROVIDER",
  "FILE_REPLICA_S3_ENDPOINT",
  "FILE_REPLICA_S3_REGION",
  "FILE_REPLICA_S3_ACCESS_KEY",
  "FILE_REPLICA_S3_SECRET_KEY",
  "FILE_REPLICA_S3_BUCKET",
  "FILE_REPLICA_BLOB_READ_WRITE_TOKEN",
] as const;

interface S3StorageConfig {
  provider: "s3";
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

interface BlobStorageConfig {
  provider: "vercel_blob";
  token: string;
}

type StorageConfig = S3StorageConfig | BlobStorageConfig;

export interface StoredObjectWrite {
  url: string;
  etag?: string;
  versionId?: string;
}

/**
 * S3-compatible providers use the literal `null` version ID when bucket
 * versioning is unavailable. That value (and blank provider output) cannot
 * identify an immutable object version and must never be accepted as exact
 * recovery evidence.
 */
export function normalizeS3VersionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.toLowerCase() !== "null"
    ? normalized
    : undefined;
}

export type ObjectReadResult =
  | {
      status: "available";
      body: Uint8Array;
      contentType?: string;
      etag?: string;
      versionId?: string;
    }
  | { status: "missing" }
  | { status: "failed" };

function storageEnv(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

function primaryStorageConfig(): StorageConfig {
  if (storageEnv("FILE_STORAGE_PROVIDER") === "vercel_blob") {
    return {
      provider: "vercel_blob",
      token: storageEnv("BLOB_READ_WRITE_TOKEN") ?? "",
    };
  }

  return {
    provider: "s3",
    endpoint: storageEnv("S3_ENDPOINT"),
    region: storageEnv("S3_REGION") ?? "us-east-1",
    accessKeyId: storageEnv("S3_ACCESS_KEY") ?? "",
    secretAccessKey: storageEnv("S3_SECRET_KEY") ?? "",
    bucket: storageEnv("S3_BUCKET") ?? "openpims",
  };
}

function replicaStorageConfig(): StorageConfig | null {
  const readiness = replicaStorageReadiness();
  if (!readiness.ready) return null;

  if (storageEnv("FILE_REPLICA_PROVIDER") === "vercel_blob") {
    return {
      provider: "vercel_blob",
      token: replicaBlobToken()!,
    };
  }

  return {
    provider: "s3",
    endpoint: storageEnv("FILE_REPLICA_S3_ENDPOINT"),
    region: storageEnv("FILE_REPLICA_S3_REGION") ?? "us-east-1",
    accessKeyId: storageEnv("FILE_REPLICA_S3_ACCESS_KEY")!,
    secretAccessKey: storageEnv("FILE_REPLICA_S3_SECRET_KEY")!,
    bucket: storageEnv("FILE_REPLICA_S3_BUCKET")!,
  };
}

function publicStorageEndpoint(config: StorageConfig): string {
  if (config.provider !== "s3") {
    throw new Error("Public S3 endpoint requested for non-S3 storage");
  }
  return config.endpoint ?? "https://s3.amazonaws.com";
}

function s3Client(config: StorageConfig): S3Client {
  if (config.provider !== "s3") {
    throw new Error("S3 client requested for non-S3 storage");
  }
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true, // Required for MinIO / S3-compatible stores
  });
}

function canonicalStorageIdentity(config: StorageConfig): string {
  if (config.provider === "vercel_blob") {
    return `vercel_blob/${createHash("sha256").update(config.token).digest("hex")}`;
  }
  const endpoint = (config.endpoint ?? "https://s3.amazonaws.com")
    .replace(/\/+$/, "")
    .toLowerCase();
  return `${endpoint}/${config.bucket.toLowerCase()}`;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

function replicaBlobToken(): string | undefined {
  const dedicated = storageEnv("FILE_REPLICA_BLOB_READ_WRITE_TOKEN");
  if (dedicated) return dedicated;
  // The Vercel CLI injects this standard name when a Blob store is connected.
  // It is safe for replica use only while the primary remains on S3.
  return storageEnv("FILE_STORAGE_PROVIDER") === "vercel_blob"
    ? undefined
    : storageEnv("BLOB_READ_WRITE_TOKEN");
}

export function replicaStorageRolloutIntended(): boolean {
  return (
    replicaStorageRequired() ||
    REPLICA_ENV_NAMES.some((name) => storageEnv(name) !== undefined)
  );
}

export function replicaStorageRequired(): boolean {
  return envFlag("FILE_REPLICA_REQUIRED");
}

export function replicaStorageRolloutEnabled(): boolean {
  return envFlag("FILE_REPLICA_ENABLED");
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredReplicaPracticeIds(): string[] {
  return [
    ...new Set(
      (process.env.FILE_REPLICA_PRACTICE_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/** Null means every active practice; an array is the exact controlled cohort. */
export function replicaStoragePracticeScope(): string[] | null {
  return envFlag("FILE_REPLICA_ALL_PRACTICES")
    ? null
    : configuredReplicaPracticeIds();
}

export function replicaStorageIncludesPractice(practiceId: string): boolean {
  if (!replicaStorageRolloutEnabled()) return false;
  const scope = replicaStoragePracticeScope();
  return scope === null || scope.includes(practiceId);
}

export function replicaStorageReadiness(): {
  intended: boolean;
  ready: boolean;
  detail: string;
} {
  const intended = replicaStorageRolloutIntended();
  const provider = storageEnv("FILE_REPLICA_PROVIDER") ?? "s3";
  if (provider !== "s3" && provider !== "vercel_blob") {
    return {
      intended,
      ready: false,
      detail: "Replica storage provider is unsupported",
    };
  }

  const accessKeyId = storageEnv("FILE_REPLICA_S3_ACCESS_KEY");
  const secretAccessKey = storageEnv("FILE_REPLICA_S3_SECRET_KEY");
  const bucket = storageEnv("FILE_REPLICA_S3_BUCKET");
  const blobToken = replicaBlobToken();
  const missing =
    provider === "vercel_blob"
      ? Number(!blobToken)
      : [accessKeyId, secretAccessKey, bucket].filter((value) => !value).length;

  if (missing > 0) {
    return {
      intended,
      ready: false,
      detail: intended
        ? `${missing} required replica storage value${missing === 1 ? " is" : "s are"} missing`
        : "Independent object replica is not configured",
    };
  }

  const replica: StorageConfig =
    provider === "vercel_blob"
      ? { provider, token: blobToken! }
      : {
          provider,
          endpoint: storageEnv("FILE_REPLICA_S3_ENDPOINT"),
          region: storageEnv("FILE_REPLICA_S3_REGION") ?? "us-east-1",
          accessKeyId: accessKeyId!,
          secretAccessKey: secretAccessKey!,
          bucket: bucket!,
        };
  if (
    canonicalStorageIdentity(replica) ===
    canonicalStorageIdentity(primaryStorageConfig())
  ) {
    return {
      intended,
      ready: false,
      detail: "Replica storage must use a different storage target",
    };
  }

  if (replicaStorageRolloutEnabled()) {
    const allPractices = envFlag("FILE_REPLICA_ALL_PRACTICES");
    const practiceIds = configuredReplicaPracticeIds();
    if (allPractices && practiceIds.length > 0) {
      return {
        intended,
        ready: false,
        detail:
          "Replica rollout must choose either all practices or an exact cohort",
      };
    }
    if (!allPractices && practiceIds.length === 0) {
      return {
        intended,
        ready: false,
        detail: "Replica rollout needs an exact practice cohort",
      };
    }
    if (practiceIds.some((id) => !UUID_PATTERN.test(id))) {
      return {
        intended,
        ready: false,
        detail: "Replica rollout practice cohort is invalid",
      };
    }
  }

  return { intended, ready: true, detail: "Replica storage envs present" };
}

function objectUrl(config: StorageConfig, key: string): string {
  if (config.provider !== "s3") {
    throw new Error("S3 object URL requested for non-S3 storage");
  }
  return `${publicStorageEndpoint(config)}/${config.bucket}/${key}`;
}

export const OBJECT_STORAGE_IO_TIMEOUT_MS = 15_000;

async function putObject(
  config: StorageConfig,
  key: string,
  body: Buffer,
  contentType: string,
  checksumSha256?: string,
): Promise<StoredObjectWrite> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OBJECT_STORAGE_IO_TIMEOUT_MS,
  );

  try {
    if (config.provider === "vercel_blob") {
      const result = await putBlob(key, body, {
        access: "private",
        token: config.token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: false,
        maximumSizeInBytes: body.byteLength,
        abortSignal: controller.signal,
      });
      return {
        url: result.url,
        etag: result.etag,
        // Private Blob pathnames are immutable because overwrite is disabled.
        // The provider ETag is therefore the exact immutable version evidence.
        versionId: result.etag,
      };
    }

    const result = await s3Client(config).send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(checksumSha256
          ? { Metadata: { "openvpm-sha256": checksumSha256 } }
          : {}),
      }),
      { abortSignal: controller.signal },
    );

    const versionId = normalizeS3VersionId(result.VersionId);
    return {
      url: objectUrl(config, key),
      ...(result.ETag ? { etag: result.ETag } : {}),
      ...(versionId ? { versionId } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const OBJECT_STORAGE_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Upload a file to S3/MinIO.
 *
 * @param key   Object key, e.g. `{practiceId}/{category}/{uuid}-{filename}`
 * @param body  File contents as a Buffer
 * @param contentType  MIME type of the file
 * @returns The public URL of the uploaded object
 */
export async function uploadFile(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  return (await putObject(primaryStorageConfig(), key, body, contentType)).url;
}

/** Upload a primary file object and retain provider integrity evidence. */
export async function uploadManagedFile(
  key: string,
  body: Buffer,
  contentType: string,
  checksumSha256: string,
): Promise<StoredObjectWrite> {
  return putObject(
    primaryStorageConfig(),
    key,
    body,
    contentType,
    checksumSha256,
  );
}

/** Write the independently configured replica target. */
export async function uploadReplicaFile(
  key: string,
  body: Buffer,
  contentType: string,
  checksumSha256: string,
): Promise<StoredObjectWrite> {
  const config = replicaStorageConfig();
  if (!config) throw new Error("Replica storage is not ready");
  return putObject(config, key, body, contentType, checksumSha256);
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound"
  );
}

async function readObject(
  config: StorageConfig,
  key: string,
  options: { maxBytes?: number; versionId?: string } = {},
): Promise<ObjectReadResult> {
  const requestedVersionId = normalizeS3VersionId(options.versionId);
  if (options.versionId !== undefined && !requestedVersionId) {
    return { status: "failed" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OBJECT_STORAGE_IO_TIMEOUT_MS,
  );

  try {
    if (config.provider === "vercel_blob") {
      const res = await getBlob(key, {
        access: "private",
        token: config.token,
        useCache: false,
        abortSignal: controller.signal,
      });
      if (!res) return { status: "missing" };
      if (res.statusCode !== 200 || !res.stream) return { status: "failed" };
      if (requestedVersionId && res.blob.etag !== requestedVersionId) {
        return { status: "failed" };
      }
      if (
        typeof options.maxBytes === "number" &&
        res.blob.size > options.maxBytes
      ) {
        await res.stream.cancel().catch(() => undefined);
        return { status: "failed" };
      }
      const body = new Uint8Array(await new Response(res.stream).arrayBuffer());
      if (
        typeof options.maxBytes === "number" &&
        body.byteLength > options.maxBytes
      ) {
        return { status: "failed" };
      }
      return {
        status: "available",
        body,
        contentType: res.blob.contentType,
        etag: res.blob.etag,
        versionId: res.blob.etag,
      };
    }

    const res = await s3Client(config).send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ...(requestedVersionId ? { VersionId: requestedVersionId } : {}),
      }),
      { abortSignal: controller.signal },
    );
    const responseVersionId = normalizeS3VersionId(res.VersionId);
    if (requestedVersionId && responseVersionId !== requestedVersionId) {
      return { status: "failed" };
    }
    if (
      typeof options.maxBytes === "number" &&
      typeof res.ContentLength === "number" &&
      res.ContentLength > options.maxBytes
    ) {
      return { status: "failed" };
    }

    const body = await res.Body?.transformToByteArray();
    if (!body) return { status: "failed" };
    if (
      typeof options.maxBytes === "number" &&
      body.byteLength > options.maxBytes
    ) {
      return { status: "failed" };
    }
    return {
      status: "available",
      body,
      ...(res.ContentType ? { contentType: res.ContentType } : {}),
      ...(res.ETag ? { etag: res.ETag } : {}),
      ...(responseVersionId ? { versionId: responseVersionId } : {}),
    };
  } catch (error) {
    return {
      status:
        error instanceof BlobNotFoundError || isMissingObjectError(error)
          ? "missing"
          : "failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function readPrimaryObject(
  key: string,
  options: { maxBytes?: number; versionId?: string } = {},
): Promise<ObjectReadResult> {
  return readObject(primaryStorageConfig(), key, options);
}

export async function readReplicaObject(
  key: string,
  options: { maxBytes?: number; versionId?: string } = {},
): Promise<ObjectReadResult> {
  const config = replicaStorageConfig();
  if (!config) return { status: "failed" };
  return readObject(config, key, options);
}

/**
 * Read an object's bytes + content type. Used by the same-origin file proxy
 * (`/api/files/...`) so uploaded images serve through the app instead of the
 * private R2/S3 API endpoint (which rejects unauthenticated <img> requests).
 *
 * @param key Object key in S3
 * @param options.maxBytes Optional byte cap for callers that proxy object bytes
 * @returns The object bytes + content type, or null if it does not exist.
 */
export async function getObject(
  key: string,
  options: { maxBytes?: number } = {},
): Promise<{ body: Uint8Array; contentType?: string } | null> {
  const result = await readPrimaryObject(key, options);
  return result.status === "available"
    ? { body: result.body, contentType: result.contentType }
    : null;
}

/**
 * Generate a pre-signed URL for reading a private object.
 *
 * @param key       Object key in S3
 * @param expiresIn Seconds until the URL expires (default 1 hour)
 * @returns A pre-signed GET URL
 */
export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const config = primaryStorageConfig();
  if (config.provider !== "s3") {
    throw new Error(
      "Direct signed URLs are unavailable for private Blob storage; use the authenticated file proxy.",
    );
  }
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
  });

  return awsGetSignedUrl(s3Client(config), command, {
    expiresIn,
  });
}

/**
 * Delete an object from S3/MinIO.
 *
 * @param key Object key to delete
 */
export async function deleteFile(key: string): Promise<void> {
  const config = primaryStorageConfig();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OBJECT_STORAGE_IO_TIMEOUT_MS,
  );

  try {
    if (config.provider === "vercel_blob") {
      await deleteBlob(key, {
        token: config.token,
        abortSignal: controller.signal,
      });
      return;
    }
    await s3Client(config).send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
      { abortSignal: controller.signal },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkObjectStorageHealth(
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? OBJECT_STORAGE_HEALTH_TIMEOUT_MS,
  );

  try {
    const config = primaryStorageConfig();
    if (config.provider === "vercel_blob") {
      await listBlobs({
        token: config.token,
        limit: 1,
        abortSignal: controller.signal,
      });
      return { ok: true, detail: "Object storage bucket reachable" };
    }
    await s3Client(config).send(
      new HeadBucketCommand({
        Bucket: config.bucket,
      }),
      { abortSignal: controller.signal },
    );
    return { ok: true, detail: "Object storage bucket reachable" };
  } catch (err) {
    void err;
    return { ok: false, detail: "Object storage check failed" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkReplicaStorageHealth(
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; detail: string }> {
  const readiness = replicaStorageReadiness();
  if (!readiness.ready) return { ok: false, detail: readiness.detail };

  const config = replicaStorageConfig()!;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? OBJECT_STORAGE_HEALTH_TIMEOUT_MS,
  );

  try {
    if (config.provider === "vercel_blob") {
      await listBlobs({
        token: config.token,
        limit: 1,
        abortSignal: controller.signal,
      });
      return { ok: true, detail: "Replica object storage reachable" };
    }
    await s3Client(config).send(
      new HeadBucketCommand({ Bucket: config.bucket }),
      { abortSignal: controller.signal },
    );
    return { ok: true, detail: "Replica object storage reachable" };
  } catch {
    return { ok: false, detail: "Replica object storage check failed" };
  } finally {
    clearTimeout(timeout);
  }
}
