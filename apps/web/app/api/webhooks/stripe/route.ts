import { NextRequest, NextResponse } from "next/server";
import { eq, and, isNull, sum } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  invoiceAdjustments,
  invoices,
  payments,
  practices,
} from "@openpims/db";
import { constructWebhookEvent } from "@/lib/stripe";
import { withSystem } from "@/lib/tenant-db";
import { claimStripeEvent } from "@/lib/billing/stripe-events";
import {
  invoiceBalanceCents,
  moneyToCents,
} from "@/lib/billing/invoice-balance";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
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
      event = await constructWebhookEvent(body.text, signature);
    } catch (err) {
      console.error("[Stripe Webhook] signature verification failed:", err);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    if (!event) {
      return NextResponse.json(
        { error: "Webhook verification failed or Stripe not configured" },
        { status: 400 },
      );
    }

    // Webhook has no tenant session, so claim/process in system context. The
    // event claim lives in the same transaction as side effects; if processing
    // throws, the claim rolls back and Stripe can retry.
    const paidInvoiceEvents: {
      practiceId: string;
      payload: Record<string, any>;
    }[] = [];

    await withSystem(db, async (tx) => {
      const claimed = await claimStripeEvent(tx, {
        eventId: event.id,
        endpoint: "client-invoice",
        eventType: event.type,
      });
      if (!claimed) return;

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as {
          id?: string;
          metadata?: { invoiceId?: string };
          amount_total?: number | null;
        };

        const invoiceId = session.metadata?.invoiceId;
        if (!invoiceId) {
          console.error("[Stripe Webhook] No invoiceId in session metadata");
          return;
        }

        // Calculate payment amount from Stripe (convert cents to dollars)
        const amountCents = session.amount_total ?? 0;
        const amountDollars = (amountCents / 100).toFixed(2);
        const externalId = `stripe:checkout:${session.id ?? event.id}`;

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
          .innerJoin(
            practices,
            and(
              eq(practices.id, invoices.practiceId),
              isNull(practices.deletedAt),
            ),
          )
          .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
          .limit(1);

        if (!invoice) {
          console.error("[Stripe Webhook] Invoice not found for Checkout", {
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
          console.error("[Stripe Webhook] Checkout for non-payable invoice", {
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
            `Stripe Checkout payment external id belongs to another invoice: ${externalId}`,
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
              `Stripe Checkout amount no longer matches invoice balance: ${invoiceId}`,
            );
          }

          // Record the payment once per Checkout Session. The Stripe event ledger
          // handles normal redelivery; this protects money state if Stripe ever
          // emits or we receive multiple distinct events for the same session.
          await tx
            .insert(payments)
            .values({
              invoiceId,
              amount: amountDollars,
              method: "online",
              externalId,
              notes: session.id
                ? `Paid via Stripe Checkout (${session.id})`
                : "Paid via Stripe Checkout",
            })
            .onConflictDoNothing({ target: payments.externalId });
        }

        // Sum all payments for this invoice
        const [result] = await tx
          .select({ total: sum(payments.amount) })
          .from(payments)
          .where(
            and(
              eq(payments.invoiceId, invoiceId),
              isNull(payments.deletedAt),
            ),
          );

        const paidAmount = result?.total ?? "0";

        // Get invoice total to check if fully paid after adjustments.
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
            `Invoice changed while processing Stripe Checkout payment: ${invoiceId}`,
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
              source: "stripe",
            },
          });
        }
      }
    });

    for (const paidInvoiceEvent of paidInvoiceEvents) {
      await dispatchWebhookEvent(
        paidInvoiceEvent.practiceId,
        "invoice.paid",
        paidInvoiceEvent.payload,
      );
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[Stripe Webhook] Error:", err);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}
