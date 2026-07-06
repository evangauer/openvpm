export const STRIPE_WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;

export function stripeWebhookContentLengthTooLarge(headers: Headers): boolean {
  const value = headers.get("content-length");
  if (!value) return false;

  const length = Number(value);
  return Number.isFinite(length) && length > STRIPE_WEBHOOK_BODY_MAX_BYTES;
}

export function stripeWebhookBodyTooLarge(body: string): boolean {
  return Buffer.byteLength(body, "utf8") > STRIPE_WEBHOOK_BODY_MAX_BYTES;
}
