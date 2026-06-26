import Twilio from "twilio";
import type {
  MessagingProvider,
  SendMessageInput,
  SendMessageResult,
} from "./types";

// Initialised lazily so the module imports cleanly without credentials (local
// dev / CI), mirroring the prior lib/sms.ts behaviour.
let twilioClient: Twilio.Twilio | null = null;

function getClient(): Twilio.Twilio | null {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  twilioClient = Twilio(sid, token);
  return twilioClient;
}

/**
 * Twilio adapter (fallback provider). Sends via a Messaging Service SID when set,
 * otherwise from a bare number.
 */
export const twilioProvider: MessagingProvider = {
  name: "twilio",

  isConfigured(): boolean {
    return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  },

  async send({ to, body, sender }: SendMessageInput): Promise<SendMessageResult> {
    const client = getClient();
    if (!client) {
      return { success: false, error: "Twilio is not configured." };
    }
    if (!sender.messagingServiceId && !sender.from) {
      return {
        success: false,
        error: "No Twilio sender (Messaging Service SID or from-number) configured.",
      };
    }
    try {
      const message = await client.messages.create({
        to,
        body,
        ...(sender.messagingServiceId
          ? { messagingServiceSid: sender.messagingServiceId }
          : { from: sender.from }),
      });
      return { success: true, id: message.sid };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown Twilio error",
      };
    }
  },
};
