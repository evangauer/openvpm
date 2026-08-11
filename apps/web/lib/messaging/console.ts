import type {
  MessagingProvider,
  SendMessageInput,
  SendMessageResult,
} from "./types";
import { randomUUID } from "node:crypto";

/**
 * Dev/CI fallback: logs the message instead of sending when no real provider is
 * configured. Sends are never metered for this provider (see lib/sms.ts).
 */
export const consoleProvider: MessagingProvider = {
  name: "console",

  isConfigured(): boolean {
    return true;
  },

  async send({ body }: SendMessageInput): Promise<SendMessageResult> {
    console.log("[SMS] console_provider_accept", {
      bodyLength: body.length,
    });
    // The immutable send ledger enforces provider-message uniqueness within a
    // practice, so local sends need the same one-message/one-id property as a
    // real carrier response.
    return { status: "accepted", id: `dev-console:${randomUUID()}` };
  },
};
