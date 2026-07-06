export const UPLOAD_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_REQUEST_MAX_BYTES = UPLOAD_FILE_MAX_BYTES + 512 * 1024;

export function uploadRequestContentLengthTooLarge(headers: Headers): boolean {
  const value = headers.get("content-length");
  if (!value) return false;

  const length = Number(value);
  return Number.isFinite(length) && length > UPLOAD_REQUEST_MAX_BYTES;
}
