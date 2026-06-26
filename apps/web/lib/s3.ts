import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "",
  },
  forcePathStyle: true, // Required for MinIO / S3-compatible stores
});

const bucket = process.env.S3_BUCKET ?? "openpims";

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
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  // Build the URL from the endpoint so it works for both AWS S3 and MinIO
  const endpoint = process.env.S3_ENDPOINT ?? "https://s3.amazonaws.com";
  return `${endpoint}/${bucket}/${key}`;
}

/**
 * Read an object's bytes + content type. Used by the same-origin file proxy
 * (`/api/files/...`) so uploaded images serve through the app instead of the
 * private R2/S3 API endpoint (which rejects unauthenticated <img> requests).
 *
 * @param key Object key in S3
 * @returns The object bytes + content type, or null if it does not exist.
 */
export async function getObject(
  key: string,
): Promise<{ body: Uint8Array; contentType?: string } | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await res.Body?.transformToByteArray();
    if (!body) return null;
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
    Bucket: bucket,
    Key: key,
  });

  return awsGetSignedUrl(s3, command, { expiresIn });
}

/**
 * Delete an object from S3/MinIO.
 *
 * @param key Object key to delete
 */
export async function deleteFile(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
}
