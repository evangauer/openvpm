import type {
  MessagingProvider,
  SendMessageInput,
  SendMessageResult,
} from "./types";
import { cleanSender, envValue } from "./env";
import { fetchTelnyx } from "./telnyx-http";
import { providerHttpErrorDiagnostic } from "./provider-diagnostics";

// Telnyx v2 REST — used directly (no SDK dependency) so the adapter stays a thin
// wrapper. https://developers.telnyx.com/api/messaging/send-message
const TELNYX_MESSAGES_URL = "https://api.telnyx.com/v2/messages";

function apiKey(): string | undefined {
  return envValue("TELNYX_API_KEY");
}

/**
 * Telnyx adapter (recommended provider — supports text-enabling a clinic's
 * existing number). Sends via a messaging profile when one is set (lets Telnyx
 * pick from the number pool / sticky sender and binds the A2P campaign), and
 * otherwise from a bare number.
 */
export const telnyxProvider: MessagingProvider = {
  name: "telnyx",

  isConfigured(): boolean {
    return Boolean(apiKey());
  },

  async send({
    to,
    body,
    sender,
  }: SendMessageInput): Promise<SendMessageResult> {
    const key = apiKey();
    if (!key) {
      return {
        status: "definite_failure",
        error: "Telnyx is not configured (TELNYX_API_KEY missing).",
      };
    }

    const configuredSender = cleanSender(sender);
    const payload: Record<string, string> = { to, text: body };
    if (configuredSender.messagingServiceId) {
      payload.messaging_profile_id = configuredSender.messagingServiceId;
    } else if (configuredSender.from) {
      payload.from = configuredSender.from;
    } else {
      return {
        status: "definite_failure",
        error:
          "No Telnyx sender (messaging profile or from-number) configured.",
      };
    }

    try {
      const res = await fetchTelnyx(TELNYX_MESSAGES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const responseText = await res.text().catch(() => "");
        let responsePayload: unknown;
        try {
          responsePayload = responseText ? JSON.parse(responseText) : null;
        } catch {
          responsePayload = null;
        }
        const status =
          res.status === 408 || res.status === 429 || res.status >= 500
            ? "outcome_unknown"
            : "definite_failure";
        return {
          status,
          error: providerHttpErrorDiagnostic(
            "Telnyx send",
            res.status,
            responsePayload,
          ),
        };
      }
      const json = (await res.json()) as { data?: { id?: string } };
      const id = json.data?.id?.trim();
      return id
        ? { status: "accepted", id }
        : {
            status: "outcome_unknown",
            error:
              "Telnyx accepted the request but returned no provider message id.",
          };
    } catch {
      return {
        status: "outcome_unknown",
        error: "Telnyx send outcome is unknown after a network error.",
      };
    }
  },
};
