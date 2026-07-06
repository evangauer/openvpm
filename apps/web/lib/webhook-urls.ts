export const WEBHOOK_URL_MAX_LENGTH = 2048;

const WEBHOOK_URL_PROTOCOLS = new Set(["http:", "https:"]);

export function isWebhookDeliveryUrl(value: string): boolean {
  if (value.length === 0 || value.length > WEBHOOK_URL_MAX_LENGTH) return false;

  try {
    const url = new URL(value);
    return WEBHOOK_URL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}
