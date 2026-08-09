import type { SmsDeliveryClassification } from "./sms-delivery-ledger";

function token(value: string | null | undefined): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || null;
}

export function twilioProviderStatus(
  value: string | null | undefined,
): string | null {
  return token(value);
}

export function twilioDeliveryClassification(
  value: string | null | undefined,
): SmsDeliveryClassification {
  switch (token(value)) {
    case "queued":
    case "sending":
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "failed":
    case "undelivered":
    case "canceled":
      return "failed";
    default:
      return "unknown";
  }
}
