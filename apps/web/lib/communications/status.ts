export type CommunicationStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export type CommunicationStatusInput = {
  status: string | null | undefined;
  channel?: string | null;
  direction?: string | null;
  readAt?: Date | string | null;
};

const communicationStatusLabels: Record<CommunicationStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
};
const unreadInboundStatuses = new Set(["pending", "sent", "delivered"]);

export function communicationStatusLabel(
  input: CommunicationStatusInput
): string {
  const status = input.status?.trim();
  if (!status) return "";

  if (input.direction === "inbound") {
    if (input.readAt || status === "read") return "Read by clinic";
    if (unreadInboundStatuses.has(status)) return "Unread";
  }

  if (
    input.direction === "outbound" &&
    input.channel === "portal" &&
    status === "read"
  ) {
    return "Read by client";
  }

  if (
    input.direction === "outbound" &&
    input.channel === "portal" &&
    status === "delivered"
  ) {
    return "Delivered to portal";
  }

  return communicationStatusLabels[status as CommunicationStatus] ?? status;
}
