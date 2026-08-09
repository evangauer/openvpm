import Twilio from "twilio";
import type {
  MessagingProvider,
  SendMessageInput,
  SendMessageResult,
} from "./types";
import { cleanSender, envValue } from "./env";
import { appBaseUrl } from "@/lib/app-url";

// Initialised lazily so the module imports cleanly without credentials (local
// dev / CI), mirroring the prior lib/sms.ts behaviour.
let twilioClient: Twilio.Twilio | null = null;

function twilioFailure(err: unknown): SendMessageResult {
  const status =
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof err.status === "number"
      ? err.status
      : undefined;
  const error = err instanceof Error ? err.message : "Unknown Twilio error";
  return status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
    ? { status: "definite_failure", error }
    : { status: "outcome_unknown", error };
}

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
    return Boolean(
      envValue("TWILIO_ACCOUNT_SID") && envValue("TWILIO_AUTH_TOKEN"),
    );
  },

  async send({
    to,
    body,
    sender,
  }: SendMessageInput): Promise<SendMessageResult> {
    const client = getClient();
    if (!client) {
      return { status: "definite_failure", error: "Twilio is not configured." };
    }
    const configuredSender = cleanSender(sender);
    if (!configuredSender.messagingServiceId && !configuredSender.from) {
      return {
        status: "definite_failure",
        error:
          "No Twilio sender (Messaging Service SID or from-number) configured.",
      };
    }
    try {
      const message = await client.messages.create({
        to,
        body,
        statusCallback: new URL(
          "/api/webhooks/twilio#rc=5&rp=all",
          appBaseUrl(),
        ).toString(),
        ...(configuredSender.messagingServiceId
          ? { messagingServiceSid: configuredSender.messagingServiceId }
          : { from: configuredSender.from }),
      });
      const id = message.sid?.trim();
      return id
        ? { status: "accepted", id }
        : {
            status: "outcome_unknown",
            error:
              "Twilio accepted the request but returned no provider message id.",
          };
    } catch (err) {
      return twilioFailure(err);
    }
  },
};
