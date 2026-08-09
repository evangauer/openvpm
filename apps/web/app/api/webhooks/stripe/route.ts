import { NextRequest, NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, sum } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  invoiceAdjustments,
  invoices,
  payments,
  practices,
  appointments,
} from "@openpims/db";
import {
  captureStripeCheckoutAuthorization,
  constructWebhookEvent,
  INVOICE_CHECKOUT_CAPTURE_MODE,
} from "@/lib/stripe";
import { withSystem } from "@/lib/tenant-db";
import { claimStripeEvent } from "@/lib/billing/stripe-events";
import {
  invoiceBalanceCents,
  moneyToCents,
} from "@/lib/billing/invoice-balance";
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
import {
  assertVisitInvoiceReadyForFinancialAction,
  markCompletedVisitCloseoutPaid,
} from "@/server/visit-billing-integrity";
import { resolveInvalidInvoiceCheckout } from "@/server/stripe-checkout-resolution";

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

    if (event.type === "checkout.session.completed") {
      const candidate = event.data.object as {
        metadata?: { invoiceId?: string; source?: string };
      };
      if (candidate.metadata?.source !== "client_invoice") {
        return NextResponse.json({ received: true });
      }
    }

    // Webhook has no tenant session, so claim/process in system context. The
    // event claim lives in the same transaction as side effects; if processing
    // throws, the claim rolls back and Stripe can retry.
    const paidInvoiceEvents: {
      practiceId: string;
      payload: Record<string, any>;
    }[] = [];
    const clientReceipts: ClientReceipt[] = [];

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
          metadata?: {
            invoiceId?: string;
            captureMode?: string;
            source?: string;
          };
          amount_total?: number | null;
          payment_intent?: string | { id?: string } | null;
        };

        const invoiceId = session.metadata?.invoiceId;
        if (!session.id) {
          console.error("[Stripe Webhook] Invoice Checkout is missing session id");
          return;
        }

        // Calculate payment amount from Stripe (convert cents to dollars)
        const amountCents = session.amount_total ?? 0;
        const checkoutSessionId = session.id;
        const externalId = `stripe:checkout:${checkoutSessionId}`;
        const manualCapture =
          session.metadata?.captureMode === INVOICE_CHECKOUT_CAPTURE_MODE;
        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id;
        let resolutionPracticeId: string | null = null;

        const resolveInvalidCheckout = async (reason: string) => {
          const resolution = await resolveInvalidInvoiceCheckout(tx, {
            eventId: event.id,
            endpoint: "client-invoice",
            externalId,
            sessionId: checkoutSessionId,
            invoiceId,
            practiceId: resolutionPracticeId,
            amountCents,
            reason,
          });
          console.error("[Stripe Webhook] Checkout could not be attributed", {
            invoiceId,
            sessionId: session.id,
            reason,
            resolution: resolution.outcome,
          });
        };

        if (!invoiceId) {
          await resolveInvalidCheckout("missing_invoice_metadata");
          return;
        }

        const [invoiceIdentity] = await tx
          .select({
            id: invoices.id,
            practiceId: invoices.practiceId,
            appointmentId: invoices.appointmentId,
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

        if (!invoiceIdentity) {
          await resolveInvalidCheckout("invoice_not_found");
          return;
        }
        resolutionPracticeId = invoiceIdentity.practiceId;

        if (invoiceIdentity.appointmentId) {
          const [appointment] = await tx
            .select({ id: appointments.id })
            .from(appointments)
            .where(
              and(
                eq(appointments.id, invoiceIdentity.appointmentId),
                eq(appointments.practiceId, invoiceIdentity.practiceId),
                isNull(appointments.deletedAt)
              )
            )
            .for("update", { of: appointments });
          if (!appointment) {
            await resolveInvalidCheckout("appointment_not_found");
            return;
          }
          try {
            await assertVisitInvoiceReadyForFinancialAction(
              { db: tx, practiceId: invoiceIdentity.practiceId },
              invoiceIdentity.appointmentId
            );
          } catch (err) {
            if (
              err instanceof TRPCError &&
              err.code === "PRECONDITION_FAILED"
            ) {
              await resolveInvalidCheckout("visit_not_ready");
              return;
            }
            throw err;
          }
        }

        const [invoice] = await tx
          .select({
            id: invoices.id,
            practiceId: invoices.practiceId,
            appointmentId: invoices.appointmentId,
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
          .limit(1)
          .for("update", { of: invoices });

        if (!invoice) {
          await resolveInvalidCheckout("invoice_not_found");
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

        if (
          invoice.isEstimate ||
          invoice.status === "draft" ||
          invoice.status === "paid" ||
          invoice.status === "void"
        ) {
          if (!existingPayment) {
            await resolveInvalidCheckout(
              invoice.isEstimate ? "estimate" : `invoice_${invoice.status}`
            );
          }
          return;
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

        let recordedPaymentAmountCents: number | null = null;
        if (!existingPayment) {
          const balanceCents = invoiceBalanceCents(invoice, adjustedCents);
          if (amountCents <= 0 || balanceCents <= 0) {
            await resolveInvalidCheckout("no_live_balance");
            return;
          }

          let paymentAmountCents = amountCents;
          if (manualCapture) {
            if (!paymentIntentId) {
              throw new Error(
                `Manual Stripe Checkout is missing its PaymentIntent: ${checkoutSessionId}`
              );
            }
            const captured = await captureStripeCheckoutAuthorization({
              paymentIntentId,
              amountCents: Math.min(amountCents, balanceCents),
              checkoutSessionId,
            });
            paymentAmountCents = captured.amountCapturedCents;
            // A previous webhook attempt may have captured successfully before
            // its DB transaction rolled back. Never attribute that capture over
            // a balance that changed before Stripe retried the event.
            if (
              paymentAmountCents <= 0 ||
              paymentAmountCents > balanceCents
            ) {
              await resolveInvalidCheckout("captured_amount_exceeds_balance");
              return;
            }
          } else if (amountCents > balanceCents) {
            // Sessions created before manual capture was deployed have already
            // moved money. Refund the full stale payment instead of orphaning it.
            await resolveInvalidCheckout("legacy_amount_exceeds_balance");
            return;
          }

          const amountDollars = (paymentAmountCents / 100).toFixed(2);
          recordedPaymentAmountCents = paymentAmountCents;

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
          await markCompletedVisitCloseoutPaid(
            { db: tx, practiceId: invoice.practiceId },
            {
              appointmentId: invoice.appointmentId,
              invoiceId,
              source: "stripe",
              paymentId: existingPayment?.id ?? null,
              paymentExternalId: externalId,
            }
          );
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

        // Receipt only for a newly recorded payment, never on redelivery.
        if (!existingPayment) {
          const receipt = await loadClientReceipt(tx, invoiceId, {
            amountPaidCents: recordedPaymentAmountCents!,
            balanceRemainingCents: totalCents - paidCents - adjustedCents,
          });
          if (receipt) clientReceipts.push(receipt);
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

    for (const receipt of clientReceipts) {
      await deliverClientReceipt(receipt);
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
