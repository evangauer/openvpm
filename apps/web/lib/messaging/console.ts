import type { MessagingProvider, SendMessageInput, SendMessageResult } from "./types";

/**
 * Dev/CI fallback: logs the message instead of sending when no real provider is
 * configured. Sends are never metered for this provider (see lib/sms.ts).
 */
export const consoleProvider: MessagingProvider = {
  name: "console",

  isConfigured(): boolean {
    return true;
  },

  async send({ to, body, sender }: SendMessageInput): Promise<SendMessageResult> {
    console.log("──────────────────────────────────────────");
    console.log("[SMS] No messaging provider configured – logging to console");
    console.log(`  From: ${sender.messagingServiceId ?? sender.from ?? "(unset)"}`);
    console.log(`  To:   ${to}`);
    console.log(`  Body: ${body}`);
    console.log("──────────────────────────────────────────");
    return { success: true, id: "dev-console" };
  },
};
