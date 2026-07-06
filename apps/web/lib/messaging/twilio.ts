import Twilio from "twilio";
import type {
  MessagingProvider,
  SendMessageInput,
  SendMessageResult,
} from "./types";
import { cleanSender, envValue } from "./env";

// Initialised lazily so the module imports cleanly without credentials (local
// dev / CI), mirroring the prior lib/sms.ts behaviour.
let twilioClient: Twilio.Twilio | null = null;

function getClient(): Twilio.Twilio | null {
  if (twilioClient) return twilioClient;
  const sid = envValue("TWILIO_ACCOUNT_SID");
  const token = envValue("TWILIO_AUTH_TOKEN");
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
    return Boolean(envValue("TWILIO_ACCOUNT_SID") && envValue("TWILIO_AUTH_TOKEN"));
  },

  async send({ to, body, sender }: SendMessageInput): Promise<SendMessageResult> {
    const client = getClient();
    if (!client) {
      return { success: false, error: "Twilio is not configured." };
    }
    const configuredSender = cleanSender(sender);
    if (!configuredSender.messagingServiceId && !configuredSender.from) {
      return {
        success: false,
        error: "No Twilio sender (Messaging Service SID or from-number) configured.",
      };
    }
    try {
      const message = await client.messages.create({
        to,
        body,
        ...(configuredSender.messagingServiceId
          ? { messagingServiceSid: configuredSender.messagingServiceId }
          : { from: configuredSender.from }),
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
