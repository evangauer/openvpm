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

export interface SendMessageResult {
  success: boolean;
  /** Provider message id (Telnyx message id / Twilio SID) on success. */
  id?: string;
  error?: string;
}

export interface MessagingProvider {
  readonly name: MessagingProviderName;
  /** True when the provider has the credentials it needs to send. */
  isConfigured(): boolean;
  send(input: SendMessageInput): Promise<SendMessageResult>;
}
