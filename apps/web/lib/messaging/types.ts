/**
 * Provider-agnostic messaging (SMS) layer. Mirrors the provider-agnostic AI
 * runner (lib/agent/runner.ts): the active provider is chosen by env
 * (MESSAGING_PROVIDER, defaulting to whichever is configured), so the same call
 * sites run on Telnyx or Twilio with only an env change.
 *
 * Phase 0 covers outbound send only. Per-clinic provisioning, A2P registration,
 * and inbound/STOP handling (hostNumber, registerBrand, registerCampaign,
 * handleInbound) arrive in later phases and will extend this interface.
 */

export type MessagingProviderName = "telnyx" | "twilio" | "console";

/**
 * Where a message is sent from. A messaging-service/profile id is preferred —
 * it lets the provider pick from a number pool and binds the A2P campaign — and
 * a bare E.164 `from` number is the fallback when no service is configured.
 */
export interface MessagingSender {
  /** Telnyx messaging profile id / Twilio Messaging Service SID, if configured. */
  messagingServiceId?: string;
  /** E.164 from-number, used when no messaging service is set. */
  from?: string;
}

export interface SendMessageInput {
  to: string;
  body: string;
  sender: MessagingSender;
}

export type SendMessageResult =
  | {
      status: "accepted";
      /** A provider acceptance without a durable, nonblank id is ambiguous. */
      id: string;
    }
  | { status: "definite_failure"; error: string }
  | { status: "outcome_unknown"; error: string };

export interface MessagingProvider {
  readonly name: MessagingProviderName;
  /** True when the provider has the credentials it needs to send. */
  isConfigured(): boolean;
  send(input: SendMessageInput): Promise<SendMessageResult>;
}

/**
 * The provider and sender that must be used together for one outbound message.
 * Location-scoped sends resolve this pair from the same `location_messaging`
 * row so a global provider setting cannot route a clinic's sender elsewhere.
 */
export interface ResolvedMessagingTransport {
  provider: MessagingProvider;
  sender: MessagingSender;
}
