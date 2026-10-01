import { createSubscriptionWebhookHandler } from "@/lib/billing/subscription-webhook";

/** Existing Get Talky subscriptions retain their original signing secret. */
export const POST = createSubscriptionWebhookHandler("legacy");
