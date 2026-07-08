import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, sum } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  invoiceAdjustments,
  invoices,
  payments,
  practicePaymentAccounts,
  practices,
} from "@openpims/db";
import { constructConnectWebhookEvent } from "@/lib/stripe";
import { withSystem } from "@/lib/tenant-db";
import { claimStripeEvent } from "@/lib/billing/stripe-events";
import {
  invoiceBalanceCents,
  moneyToCents,
} from "@/lib/billing/invoice-balance";
import {
  STRIPE_CONNECT_PROVIDER,
  stripeConnectAccountState,
} from "@/lib/billing/payment-accounts";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import {
  deliverClientReceipt,
  loadClientReceipt,
  type ClientReceipt,
} from "@/lib/billing/client-receipts";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  STRIPE_WEBHOOK_BODY_MAX_BYTES,
  stripeWebhookContentLengthTooLarge,
} from "@/lib/stripe-webhook-limits";

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
      STRIPE_WEBHOOK_BODY_MAX_BYTES
    );
    if (!body.ok) {
      return payloadTooLargeResponse();
    }

    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return NextResponse.json(
        { error: "Missing stripe-signature header" },
        { status: 400 },
      );
    }

    let event;
    try {
      event = await constructConnectWebhookEvent(body.text, signature);
    } catch (err) {
      console.error("[Stripe Connect Webhook] signature verification failed:", err);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    if (!event) {
      return NextResponse.json(
        { error: "Webhook verification failed or Stripe not configured" },
        { status: 400 },
      );
    }

    const paidInvoiceEvents: {
      practiceId: string;
      payload: Record<string, any>;
    }[] = [];
    const clientReceipts: ClientReceipt[] = [];

    await withSystem(db, async (tx) => {
      const claimed = await claimStripeEvent(tx, {
        eventId: event.id,
        endpoint: "client-invoice-connect",
        eventType: event.type,
      });
      if (!claimed) return;

      if (event.type === "account.updated") {
        const account = event.data.object as {
          id?: string;
          charges_enabled?: boolean;
          payouts_enabled?: boolean;
          details_submitted?: boolean;
          requirements?: {
            currently_due?: string[];
            disabled_reason?: string | null;
          } | null;
        };
        if (!account.id) return;

        const state = stripeConnectAccountState({
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
          details_submitted: account.details_submitted,
          requirements: account.requirements ?? null,
        });
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
              isNull(practicePaymentAccounts.deletedAt)
            )
          );
        return;
      }

      if (event.type !== "checkout.session.completed") return;

      const session = event.data.object as {
        id?: string;
        metadata?: {
          invoiceId?: string;
          stripeConnectAccountId?: string;
        };
        amount_total?: number | null;
      };

      const connectedAccountId =
        event.account ?? session.metadata?.stripeConnectAccountId;
      const invoiceId = session.metadata?.invoiceId;
      if (!connectedAccountId || !invoiceId) {
        console.error("[Stripe Connect Webhook] Missing account or invoice metadata");
        return;
      }

      const [paymentAccount] = await tx
        .select({
          practiceId: practicePaymentAccounts.practiceId,
          stripeAccountId: practicePaymentAccounts.stripeAccountId,
        })
        .from(practicePaymentAccounts)
        .innerJoin(
          practices,
          and(
            eq(practices.id, practicePaymentAccounts.practiceId),
            isNull(practices.deletedAt)
          )
        )
        .where(
          and(
            eq(practicePaymentAccounts.stripeAccountId, connectedAccountId),
            eq(practicePaymentAccounts.provider, STRIPE_CONNECT_PROVIDER),
            isNull(practicePaymentAccounts.deletedAt)
          )
        )
        .limit(1);

      if (!paymentAccount) {
        console.error("[Stripe Connect Webhook] Account not found", {
          connectedAccountId,
          sessionId: session.id,
        });
        return;
      }

      const amountCents = session.amount_total ?? 0;
      const amountDollars = (amountCents / 100).toFixed(2);
      const externalId = `stripe:connect:${connectedAccountId}:checkout:${
        session.id ?? event.id
      }`;

      const [invoice] = await tx
        .select({
          id: invoices.id,
          practiceId: invoices.practiceId,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          status: invoices.status,
          isEstimate: invoices.isEstimate,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.practiceId, paymentAccount.practiceId),
            isNull(invoices.deletedAt)
          )
        )
        .limit(1);

      if (!invoice) {
        console.error("[Stripe Connect Webhook] Invoice not found for Checkout", {
          invoiceId,
          sessionId: session.id,
        });
        return;
      }

      if (
        invoice.isEstimate ||
        invoice.status === "draft" ||
        invoice.status === "paid" ||
        invoice.status === "void"
      ) {
        console.error("[Stripe Connect Webhook] Checkout for non-payable invoice", {
          invoiceId,
          status: invoice.status,
          isEstimate: invoice.isEstimate,
          sessionId: session.id,
        });
        return;
      }

      const [existingPayment] = await tx
        .select({ id: payments.id, invoiceId: payments.invoiceId })
        .from(payments)
        .where(
          and(eq(payments.externalId, externalId), isNull(payments.deletedAt))
        )
        .limit(1);

      if (existingPayment && existingPayment.invoiceId !== invoiceId) {
        throw new Error(
          `Stripe Connect payment external id belongs to another invoice: ${externalId}`,
        );
      }

      const adjustmentRows = await tx
        .select({ amount: invoiceAdjustments.amount })
        .from(invoiceAdjustments)
        .where(
          and(
            eq(invoiceAdjustments.invoiceId, invoiceId),
            isNull(invoiceAdjustments.deletedAt),
          ),
        );
      const adjustedCents = adjustmentRows.reduce(
        (acc, row) => acc + moneyToCents(row.amount),
        0,
      );

      if (!existingPayment) {
        const balanceCents = invoiceBalanceCents(invoice, adjustedCents);
        if (amountCents <= 0 || amountCents > balanceCents) {
          throw new Error(
            `Stripe Connect Checkout amount no longer matches invoice balance: ${invoiceId}`,
          );
        }

        await tx
          .insert(payments)
          .values({
            invoiceId,
            amount: amountDollars,
            method: "online",
            externalId,
            notes: session.id
              ? `Paid via Stripe Connect Checkout (${session.id})`
              : "Paid via Stripe Connect Checkout",
          })
          .onConflictDoNothing({ target: payments.externalId });
      }

      const [result] = await tx
        .select({ total: sum(payments.amount) })
        .from(payments)
        .where(
          and(eq(payments.invoiceId, invoiceId), isNull(payments.deletedAt)),
        );

      const paidAmount = result?.total ?? "0";
      const paidCents = moneyToCents(paidAmount);
      const totalCents = moneyToCents(invoice.total);
      const updates: Record<string, any> = { paidAmount };
      if (paidCents + adjustedCents >= totalCents) {
        updates.status = "paid";
      }

      const [updatedInvoice] = await tx
        .update(invoices)
        .set(updates)
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.practiceId, invoice.practiceId),
            eq(invoices.status, invoice.status),
            eq(invoices.isEstimate, false),
            eq(invoices.paidAmount, invoice.paidAmount),
            isNull(invoices.deletedAt),
          ),
        )
        .returning({ id: invoices.id });

      if (!updatedInvoice) {
        throw new Error(
          `Invoice changed while processing Stripe Connect Checkout payment: ${invoiceId}`,
        );
      }

      if (updates.status === "paid") {
        paidInvoiceEvents.push({
          practiceId: invoice.practiceId,
          payload: {
            id: invoiceId,
            paymentExternalId: externalId,
            paidAmount,
            total: invoice.total,
            source: "stripe_connect",
          },
        });
      }

      // Receipt only for a newly recorded payment, never on redelivery.
      if (!existingPayment) {
        const receipt = await loadClientReceipt(tx, invoiceId, {
          amountPaidCents: amountCents,
          balanceRemainingCents: totalCents - paidCents - adjustedCents,
        });
        if (receipt) clientReceipts.push(receipt);
      }
    });

    for (const paidInvoiceEvent of paidInvoiceEvents) {
      await dispatchWebhookEvent(
        paidInvoiceEvent.practiceId,
        "invoice.paid",
        paidInvoiceEvent.payload,
      );
    }

    for (const receipt of clientReceipts) {
      await deliverClientReceipt(receipt);
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[Stripe Connect Webhook] Error:", err);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}
