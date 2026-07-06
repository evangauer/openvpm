export const EMAIL_WEBHOOK_BODY_MAX_BYTES = 256 * 1024;

export function emailWebhookContentLengthTooLarge(headers: Headers): boolean {
  const value = headers.get("content-length");
  if (!value) return false;

  const length = Number(value);
  return Number.isFinite(length) && length > EMAIL_WEBHOOK_BODY_MAX_BYTES;
}

export function emailWebhookBodyTooLarge(body: string): boolean {
  return Buffer.byteLength(body, "utf8") > EMAIL_WEBHOOK_BODY_MAX_BYTES;
}
