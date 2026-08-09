export type CommunicationDeliveryStatus = "sent" | "delivered" | "failed";

type TelnyxRecipientStatus = {
  status?: unknown;
};

export type TelnyxMessagePayload = {
  id?: unknown;
  message_id?: unknown;
  status?: unknown;
  delivery_status?: unknown;
  to?: TelnyxRecipientStatus[] | TelnyxRecipientStatus;
  errors?: Array<{ code?: unknown }>;
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function telnyxProviderMessageId(
  payload: TelnyxMessagePayload | undefined
): string | null {
  if (!payload) return null;
  return stringValue(payload.id) ?? stringValue(payload.message_id);
}

export function telnyxDeliveryStatus(
  eventType: string | undefined,
  payload: TelnyxMessagePayload | undefined
): CommunicationDeliveryStatus | null {
  if (!eventType || !payload) return null;

  if (eventType === "message.sent") return "sent";
  if (eventType === "message.delivered") return "delivered";
  if (
    eventType === "message.delivery_failed" ||
    eventType === "message.failed"
  ) {
    return "failed";
  }

  if (eventType !== "message.finalized") return null;

  const status = telnyxProviderStatus(payload);

  if (!status) return null;
  if (
    status === "sending_failed" ||
    status === "delivery_failed" ||
    status === "failed" ||
    status === "gw_timeout" ||
    status === "dlr_timeout" ||
    status === "undelivered" ||
    status === "rejected"
  ) {
    return "failed";
  }
  if (status === "delivered" || status === "delivery_success") {
    return "delivered";
  }
  if (
    status === "queued" ||
    status === "sending" ||
    status === "sent" ||
    status === "delivery_unconfirmed"
  ) {
    return "sent";
  }

  return null;
}

export function telnyxProviderStatus(
  payload: TelnyxMessagePayload | undefined,
): string | null {
  if (!payload) return null;
  const recipientStatus = Array.isArray(payload.to)
    ? stringValue(payload.to[0]?.status)
    : stringValue(payload.to?.status);
  const rawStatus =
    stringValue(payload.delivery_status) ??
    stringValue(payload.status) ??
    recipientStatus;
  return rawStatus?.toLowerCase().replace(/[\s-]+/g, "_") ?? null;
}

export function telnyxProviderErrorCode(
  payload: TelnyxMessagePayload | undefined,
): string | null {
  return stringValue(payload?.errors?.[0]?.code);
}
