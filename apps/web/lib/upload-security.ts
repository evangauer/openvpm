export const ALLOWED_UPLOAD_MIME_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
} as const;

export type AllowedUploadMimeType = keyof typeof ALLOWED_UPLOAD_MIME_TYPES;
export const ALLOWED_IMAGE_UPLOAD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AllowedImageUploadMimeType =
  (typeof ALLOWED_IMAGE_UPLOAD_MIME_TYPES)[number];

export const ALLOWED_UPLOAD_CATEGORIES = [
  "patient-photos",
  "documents",
  "lab-results",
  "branding",
] as const;

export type AllowedUploadCategory = (typeof ALLOWED_UPLOAD_CATEGORIES)[number];

export function isAllowedUploadMimeType(
  mimeType: string
): mimeType is AllowedUploadMimeType {
  return Object.prototype.hasOwnProperty.call(
    ALLOWED_UPLOAD_MIME_TYPES,
    mimeType
  );
}

export function isAllowedImageUploadMimeType(
  mimeType: string
): mimeType is AllowedImageUploadMimeType {
  return (ALLOWED_IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(
    mimeType
  );
}

export function isAllowedUploadCategory(
  category: string
): category is AllowedUploadCategory {
  return (ALLOWED_UPLOAD_CATEGORIES as readonly string[]).includes(category);
}

export function detectUploadMimeType(
  bytes: Uint8Array
): AllowedUploadMimeType | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }

  return null;
}

export function uploadBytesMatchMimeType(
  declaredMimeType: string,
  bytes: Uint8Array
): declaredMimeType is AllowedUploadMimeType {
  return (
    isAllowedUploadMimeType(declaredMimeType) &&
    detectUploadMimeType(bytes) === declaredMimeType
  );
}

export function filenameFromObjectKey(key: string): string {
  return key.split("/").filter(Boolean).at(-1) ?? "download";
}

export function safeHeaderFilename(filename: string): string {
  const cleaned = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return cleaned || "download";
}

export function contentDispositionForFile({
  filename,
  contentType,
  isPublic,
}: {
  filename: string;
  contentType?: string;
  isPublic: boolean;
}): string {
  const disposition =
    isPublic || contentType?.toLowerCase().startsWith("image/")
      ? "inline"
      : "attachment";
  return `${disposition}; filename="${safeHeaderFilename(filename)}"`;
}
