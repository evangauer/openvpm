import { createSubscriptionWebhookHandler } from "@/lib/billing/subscription-webhook";

/** Dedicated OpenVPM account; never accepts events signed with the legacy secret. */
export const POST = createSubscriptionWebhookHandler("openvpm");
