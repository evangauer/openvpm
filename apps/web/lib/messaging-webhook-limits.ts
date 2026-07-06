export const MESSAGING_WEBHOOK_BODY_MAX_BYTES = 256 * 1024;

export function messagingWebhookContentLengthTooLarge(headers: Headers): boolean {
  const value = headers.get("content-length");
  if (!value) return false;

  const length = Number(value);
  return Number.isFinite(length) && length > MESSAGING_WEBHOOK_BODY_MAX_BYTES;
}

export function messagingWebhookBodyTooLarge(body: string): boolean {
  return Buffer.byteLength(body, "utf8") > MESSAGING_WEBHOOK_BODY_MAX_BYTES;
}
