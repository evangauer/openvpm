import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { practicePaymentAccounts } from "@openpims/db";
import { db } from "@openpims/db/client";
import {
  constructConnectV2EventNotification,
  retrieveConnectAccount,
} from "@/lib/stripe";
import { withSystem } from "@/lib/tenant-db";
import { claimStripeEvent } from "@/lib/billing/stripe-events";
import {
  STRIPE_CONNECT_PROVIDER,
  stripeConnectAccountState,
} from "@/lib/billing/payment-accounts";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  STRIPE_WEBHOOK_BODY_MAX_BYTES,
  stripeWebhookContentLengthTooLarge,
} from "@/lib/stripe-webhook-limits";

const ACCOUNT_STATE_EVENTS = new Set([
  "v2.core.account.updated",
  "v2.core.account.closed",
  "v2.core.account[requirements].updated",
  "v2.core.account[configuration.merchant].capability_status_updated",
]);

function payloadTooLargeResponse() {
  return NextResponse.json(
    { error: "Stripe webhook payload too large" },
    { status: 413 },
  );
}

export async function POST(req: NextRequest) {
  try {
    if (stripeWebhookContentLengthTooLarge(req.headers)) {
      return payloadTooLargeResponse();
    }
    const body = await readRequestTextWithLimit(
      req,
      STRIPE_WEBHOOK_BODY_MAX_BYTES,
    );
    if (!body.ok) return payloadTooLargeResponse();

    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return NextResponse.json(
        { error: "Missing stripe-signature header" },
        { status: 400 },
      );
    }

    let event;
    try {
      event = await constructConnectV2EventNotification(body.text, signature);
    } catch (error) {
      console.error(
        "[Stripe Connect v2 Webhook] signature verification failed",
        error,
      );
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
    if (!event) {
      return NextResponse.json(
        { error: "Webhook verification failed or Stripe not configured" },
        { status: 400 },
      );
    }
    if (!ACCOUNT_STATE_EVENTS.has(event.type)) {
      return NextResponse.json({ received: true });
    }

    const related = (event as {
      related_object?: { id?: string; type?: string } | null;
    }).related_object;
    if (!related?.id || related.type !== "v2.core.account") {
      console.error(
        "[Stripe Connect v2 Webhook] account event is missing its related account",
      );
      return NextResponse.json({ received: true });
    }

    // Thin notifications are deliberately unversioned. Fetch the current,
    // include-expanded Account rather than trusting event payload fields.
    const account = await retrieveConnectAccount(related.id);
    if (!account || account.id !== related.id) {
      throw new Error("Stripe Connect v2 account could not be retrieved");
    }
    const state = stripeConnectAccountState(account);

    await withSystem(db, async (tx) => {
      const claimed = await claimStripeEvent(tx, {
        eventId: event.id,
        endpoint: "connect-account-v2",
        eventType: event.type,
      });
      if (!claimed) return;

      await tx
        .update(practicePaymentAccounts)
        .set({
          onboardingStatus: state.onboardingStatus,
          chargesEnabled: state.chargesEnabled,
          payoutsEnabled: state.payoutsEnabled,
          detailsSubmitted: state.detailsSubmitted,
          requirementsCurrentlyDue: state.requirementsCurrentlyDue,
          requirementsDisabledReason: state.requirementsDisabledReason,
          lastSyncedAt: state.lastSyncedAt,
        })
        .where(
          and(
            eq(practicePaymentAccounts.stripeAccountId, account.id),
            eq(practicePaymentAccounts.provider, STRIPE_CONNECT_PROVIDER),
            isNull(practicePaymentAccounts.deletedAt),
          ),
        );
    });

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("[Stripe Connect v2 Webhook] processing failed", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 },
    );
  }
}
