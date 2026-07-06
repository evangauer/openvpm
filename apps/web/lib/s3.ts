import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";

function storageEnv(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

function bucketName(): string {
  return storageEnv("S3_BUCKET") ?? "openpims";
}

function storageEndpoint(): string | undefined {
  return storageEnv("S3_ENDPOINT");
}

function publicStorageEndpoint(): string {
  return storageEndpoint() ?? "https://s3.amazonaws.com";
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: storageEndpoint(),
    region: storageEnv("S3_REGION") ?? "us-east-1",
    credentials: {
      accessKeyId: storageEnv("S3_ACCESS_KEY") ?? "",
      secretAccessKey: storageEnv("S3_SECRET_KEY") ?? "",
    },
    forcePathStyle: true, // Required for MinIO / S3-compatible stores
  });
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
  const bucket = bucketName();
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  // Build the URL from the endpoint so it works for both AWS S3 and MinIO
  return `${publicStorageEndpoint()}/${bucket}/${key}`;
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
  try {
    const res = await s3Client().send(
      new GetObjectCommand({ Bucket: bucketName(), Key: key }),
    );
    if (
      typeof options.maxBytes === "number" &&
      typeof res.ContentLength === "number" &&
      res.ContentLength > options.maxBytes
    ) {
      return null;
    }

    const body = await res.Body?.transformToByteArray();
    if (!body) return null;
    if (
      typeof options.maxBytes === "number" &&
      body.byteLength > options.maxBytes
    ) {
      return null;
    }
    return { body, contentType: res.ContentType };
  } catch {
    return null;
  }
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
  const command = new GetObjectCommand({
    Bucket: bucketName(),
    Key: key,
  });

  return awsGetSignedUrl(s3Client(), command, { expiresIn });
}

/**
 * Delete an object from S3/MinIO.
 *
 * @param key Object key to delete
 */
export async function deleteFile(key: string): Promise<void> {
  await s3Client().send(
    new DeleteObjectCommand({
      Bucket: bucketName(),
      Key: key,
    }),
  );
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
    await s3Client().send(
      new HeadBucketCommand({
        Bucket: bucketName(),
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
