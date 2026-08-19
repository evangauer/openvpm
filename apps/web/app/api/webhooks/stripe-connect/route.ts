import { NextRequest, NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, sum } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  invoiceAdjustments,
  invoices,
  payments,
  paymentDisputes,
  paymentProcessorPayouts,
  paymentProcessorRefunds,
  paymentProcessorSettlements,
  appointments,
  practicePaymentAccounts,
  practices,
} from "@openpims/db";
import {
  captureStripeCheckoutAuthorization,
  constructConnectWebhookEvent,
  INVOICE_CHECKOUT_CAPTURE_MODE,
  retrieveStripeCheckoutSettlement,
  retrieveStripePayoutReconciliation,
  retrieveStripeRefundEvidence,
} from "@/lib/stripe";
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
      STRIPE_WEBHOOK_BODY_MAX_BYTES,
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
      console.error(
        "[Stripe Connect Webhook] signature verification failed:",
        err,
      );
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
        metadata?: {
          source?: string;
          stripeConnectAccountId?: string;
          openvpmApplicationFeeAmount?: string;
        };
      };
      if (candidate.metadata?.source !== "client_invoice_connect") {
        return NextResponse.json({ received: true });
      }
      if (
        !event.account ||
        (candidate.metadata.stripeConnectAccountId &&
          candidate.metadata.stripeConnectAccountId !== event.account)
      ) {
        console.error(
          "[Stripe Connect Webhook] Invoice Checkout account identity is missing or inconsistent",
        );
        return NextResponse.json({ received: true });
      }
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
              isNull(practicePaymentAccounts.deletedAt),
            ),
          );
        return;
      }

      if (event.type.startsWith("charge.dispute.")) {
        const dispute = event.data.object as {
          id?: string;
          charge?: string | { id?: string } | null;
          status?: string;
          amount?: number;
          currency?: string;
          reason?: string | null;
          created?: number;
          evidence_details?: { due_by?: number | null } | null;
        };
        const chargeId =
          typeof dispute.charge === "string"
            ? dispute.charge
            : dispute.charge?.id;
        if (
          !event.account ||
          !dispute.id ||
          !chargeId ||
          !dispute.status ||
          !Number.isInteger(dispute.amount) ||
          (dispute.amount ?? 0) <= 0 ||
          !dispute.currency ||
          !Number.isInteger(dispute.created)
        ) {
          console.error(
            "[Stripe Connect Webhook] Dispute event is missing bounded settlement evidence",
          );
          return;
        }

        const [settlement] = await tx
          .select({
            id: paymentProcessorSettlements.id,
            practiceId: paymentProcessorSettlements.practiceId,
          })
          .from(paymentProcessorSettlements)
          .where(
            and(
              eq(
                paymentProcessorSettlements.connectedAccountId,
                event.account,
              ),
              eq(paymentProcessorSettlements.chargeId, chargeId),
              isNull(paymentProcessorSettlements.deletedAt),
            ),
          )
          .limit(1);
        // A clinic can use its Stripe account outside OpenVPM. Ignore disputes
        // for charges that do not belong to this application's settlement
        // ledger instead of creating an unscoped cross-system record.
        if (!settlement) return;

        const now = new Date();
        const terminal = new Set(["won", "lost", "warning_closed"]).has(
          dispute.status,
        );
        await tx
          .insert(paymentDisputes)
          .values({
            practiceId: settlement.practiceId,
            settlementId: settlement.id,
            provider: STRIPE_CONNECT_PROVIDER,
            externalDisputeId: dispute.id,
            chargeId,
            status: dispute.status,
            amountCents: dispute.amount!,
            currency: dispute.currency.toLowerCase(),
            reason: dispute.reason ?? null,
            evidenceDueBy: dispute.evidence_details?.due_by
              ? new Date(dispute.evidence_details.due_by * 1000)
              : null,
            providerCreatedAt: new Date(dispute.created! * 1000),
            closedAt: terminal ? now : null,
            lastSyncedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              paymentDisputes.provider,
              paymentDisputes.externalDisputeId,
            ],
            set: {
              status: dispute.status,
              amountCents: dispute.amount!,
              currency: dispute.currency.toLowerCase(),
              reason: dispute.reason ?? null,
              evidenceDueBy: dispute.evidence_details?.due_by
                ? new Date(dispute.evidence_details.due_by * 1000)
                : null,
              closedAt: terminal ? now : null,
              lastSyncedAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          });
        return;
      }

      if (event.type.startsWith("refund.")) {
        const eventRefund = event.data.object as { id?: string };
        if (!event.account || !eventRefund.id) {
          console.error(
            "[Stripe Connect Webhook] Refund event is missing connected account identity",
          );
          return;
        }
        const [localRefund] = await tx
          .select({ id: paymentProcessorRefunds.id })
          .from(paymentProcessorRefunds)
          .where(
            and(
              eq(
                paymentProcessorRefunds.connectedAccountId,
                event.account,
              ),
              eq(paymentProcessorRefunds.externalRefundId, eventRefund.id),
              isNull(paymentProcessorRefunds.deletedAt),
            ),
          )
          .limit(1);
        // A clinic can refund non-OpenVPM charges directly in Stripe. Those
        // events are intentionally ignored instead of creating unscoped rows.
        if (!localRefund) return;
        const refund = await retrieveStripeRefundEvidence({
          connectedAccountId: event.account,
          refundId: eventRefund.id,
        });
        const now = new Date();
        await tx
          .update(paymentProcessorRefunds)
          .set({
            balanceTransactionId: refund.balanceTransactionId,
            currency: refund.currency,
            amountCents: refund.amountCents,
            balanceAmountCents: refund.balanceAmountCents,
            balanceFeeCents: refund.balanceFeeCents,
            balanceNetCents: refund.balanceNetCents,
            status: refund.status,
            lastSyncedAt: now,
            updatedAt: now,
          })
          .where(eq(paymentProcessorRefunds.id, localRefund.id));
        return;
      }

      if (event.type.startsWith("payout.")) {
        const eventPayout = event.data.object as { id?: string };
        if (!event.account || !eventPayout.id) {
          console.error(
            "[Stripe Connect Webhook] Payout event is missing connected account identity",
          );
          return;
        }
        const [paymentAccount] = await tx
          .select({ practiceId: practicePaymentAccounts.practiceId })
          .from(practicePaymentAccounts)
          .where(
            and(
              eq(
                practicePaymentAccounts.stripeAccountId,
                event.account,
              ),
              eq(
                practicePaymentAccounts.provider,
                STRIPE_CONNECT_PROVIDER,
              ),
              isNull(practicePaymentAccounts.deletedAt),
            ),
          )
          .limit(1);
        if (!paymentAccount) return;

        const payout = await retrieveStripePayoutReconciliation({
          connectedAccountId: event.account,
          payoutId: eventPayout.id,
        });
        const now = new Date();
        await tx
          .insert(paymentProcessorPayouts)
          .values({
            practiceId: paymentAccount.practiceId,
            provider: STRIPE_CONNECT_PROVIDER,
            connectedAccountId: payout.connectedAccountId,
            externalPayoutId: payout.payoutId,
            currency: payout.currency,
            amountCents: payout.amountCents,
            status: payout.status,
            automatic: payout.automatic,
            reconciliationComplete: payout.reconciliationComplete,
            arrivalAt: payout.arrivalAt,
            providerCreatedAt: payout.providerCreatedAt,
            failureCode: payout.failureCode,
            failureMessage: payout.failureMessage,
            lastSyncedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              paymentProcessorPayouts.provider,
              paymentProcessorPayouts.connectedAccountId,
              paymentProcessorPayouts.externalPayoutId,
            ],
            set: {
              currency: payout.currency,
              amountCents: payout.amountCents,
              status: payout.status,
              automatic: payout.automatic,
              reconciliationComplete: payout.reconciliationComplete,
              arrivalAt: payout.arrivalAt,
              failureCode: payout.failureCode,
              failureMessage: payout.failureMessage,
              lastSyncedAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          });

        const payoutStatus =
          payout.status === "in_transit" ? "pending" : payout.status;
        if (
          payout.reconciliationComplete &&
          payout.balanceTransactionIds.length > 0
        ) {
          await tx
            .update(paymentProcessorSettlements)
            .set({
              payoutId: payout.payoutId,
              payoutStatus,
              lastSyncedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(
                  paymentProcessorSettlements.connectedAccountId,
                  payout.connectedAccountId,
                ),
                inArray(
                  paymentProcessorSettlements.balanceTransactionId,
                  payout.balanceTransactionIds,
                ),
                isNull(paymentProcessorSettlements.deletedAt),
              ),
            );
        } else {
          await tx
            .update(paymentProcessorSettlements)
            .set({ payoutStatus, lastSyncedAt: now, updatedAt: now })
            .where(
              and(
                eq(
                  paymentProcessorSettlements.connectedAccountId,
                  payout.connectedAccountId,
                ),
                eq(paymentProcessorSettlements.payoutId, payout.payoutId),
                isNull(paymentProcessorSettlements.deletedAt),
              ),
            );
        }
        return;
      }

      if (event.type !== "checkout.session.completed") return;

      const session = event.data.object as {
        id?: string;
        metadata?: {
          captureMode?: string;
          invoiceId?: string;
          source?: string;
          stripeConnectAccountId?: string;
          openvpmApplicationFeeAmount?: string;
        };
        amount_total?: number | null;
        payment_intent?: string | { id?: string } | null;
      };

      const connectedAccountId = event.account!;
      const invoiceId = session.metadata?.invoiceId;
      if (!connectedAccountId || !session.id) {
        console.error(
          "[Stripe Connect Webhook] Invoice Checkout is missing account or session identity",
        );
        return;
      }

      const amountCents = session.amount_total ?? 0;
      const checkoutSessionId = session.id;
      const externalId = `stripe:connect:${connectedAccountId}:checkout:${checkoutSessionId}`;
      const manualCapture =
        session.metadata?.captureMode === INVOICE_CHECKOUT_CAPTURE_MODE;
      const expectedApplicationFeeAmount = Number(
        session.metadata?.openvpmApplicationFeeAmount,
      );
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      let resolutionPracticeId: string | null = null;

      const resolveInvalidCheckout = async (reason: string) => {
        const resolution = await resolveInvalidInvoiceCheckout(tx, {
          eventId: event.id,
          endpoint: "client-invoice-connect",
          externalId,
          sessionId: checkoutSessionId,
          invoiceId,
          practiceId: resolutionPracticeId,
          connectedAccountId,
          amountCents,
          reason,
        });
        console.error(
          "[Stripe Connect Webhook] Checkout could not be attributed",
          {
            invoiceId,
            sessionId: session.id,
            reason,
            resolution: resolution.outcome,
          },
        );
      };

      if (!invoiceId) {
        await resolveInvalidCheckout("missing_invoice_metadata");
        return;
      }

      const [paymentAccount] = await tx
        .select({
          practiceId: practicePaymentAccounts.practiceId,
          stripeAccountId: practicePaymentAccounts.stripeAccountId,
          recoveryHold: practices.recoveryHold,
        })
        .from(practicePaymentAccounts)
        .innerJoin(
          practices,
          and(
            eq(practices.id, practicePaymentAccounts.practiceId),
            isNull(practices.deletedAt),
          ),
        )
        .where(
          and(
            eq(practicePaymentAccounts.stripeAccountId, connectedAccountId),
            eq(practicePaymentAccounts.provider, STRIPE_CONNECT_PROVIDER),
            isNull(practicePaymentAccounts.deletedAt),
          ),
        )
        .limit(1)
        // Serialize provider capture against the committed recovery-hold
        // update for this practice.
        .for("share", { of: practices });

      if (!paymentAccount) {
        await resolveInvalidCheckout("payment_account_not_found");
        return;
      }
      resolutionPracticeId = paymentAccount.practiceId;
      if (paymentAccount.recoveryHold) {
        throw new Error(
          `Stripe Connect Checkout processing paused for held practice ${paymentAccount.practiceId}`,
        );
      }

      const [invoiceIdentity] = await tx
        .select({
          id: invoices.id,
          practiceId: invoices.practiceId,
          appointmentId: invoices.appointmentId,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.practiceId, paymentAccount.practiceId),
            isNull(invoices.deletedAt),
          ),
        )
        .limit(1);

      if (!invoiceIdentity) {
        await resolveInvalidCheckout("invoice_not_found");
        return;
      }

      if (invoiceIdentity.appointmentId) {
        const [appointment] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.id, invoiceIdentity.appointmentId),
              eq(appointments.practiceId, paymentAccount.practiceId),
              isNull(appointments.deletedAt),
            ),
          )
          .for("update", { of: appointments });
        if (!appointment) {
          await resolveInvalidCheckout("appointment_not_found");
          return;
        }
        try {
          await assertVisitInvoiceReadyForFinancialAction(
            { db: tx, practiceId: paymentAccount.practiceId },
            invoiceIdentity.appointmentId,
          );
        } catch (err) {
          if (err instanceof TRPCError && err.code === "PRECONDITION_FAILED") {
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
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.practiceId, paymentAccount.practiceId),
            isNull(invoices.deletedAt),
          ),
        )
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
          and(eq(payments.externalId, externalId), isNull(payments.deletedAt)),
        )
        .limit(1);

      if (existingPayment && existingPayment.invoiceId !== invoiceId) {
        throw new Error(
          `Stripe Connect payment external id belongs to another invoice: ${externalId}`,
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
            invoice.isEstimate ? "estimate" : `invoice_${invoice.status}`,
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
      let recordedPaymentId: string | null = existingPayment?.id ?? null;
      if (!existingPayment) {
        const balanceCents = invoiceBalanceCents(invoice, adjustedCents);
        if (amountCents <= 0 || balanceCents <= 0) {
          await resolveInvalidCheckout("no_live_balance");
          return;
        }

        let paymentAmountCents = amountCents;
        let settlementApplicationFeeAmount = expectedApplicationFeeAmount;
        if (manualCapture) {
          if (!paymentIntentId) {
            throw new Error(
              `Manual Stripe Connect Checkout is missing its PaymentIntent: ${checkoutSessionId}`,
            );
          }
          const captured = await captureStripeCheckoutAuthorization({
            paymentIntentId,
            amountCents: Math.min(amountCents, balanceCents),
            checkoutSessionId,
            connectedAccountId,
            expectedApplicationFeeAmount,
          });
          paymentAmountCents = captured.amountCapturedCents;
          settlementApplicationFeeAmount =
            captured.applicationFeeAmountCents;
          if (paymentAmountCents <= 0 || paymentAmountCents > balanceCents) {
            await resolveInvalidCheckout("captured_amount_exceeds_balance");
            return;
          }
        } else if (amountCents > balanceCents) {
          await resolveInvalidCheckout("legacy_amount_exceeds_balance");
          return;
        }

        const amountDollars = (paymentAmountCents / 100).toFixed(2);
        recordedPaymentAmountCents = paymentAmountCents;

        if (
          !paymentIntentId ||
          !Number.isInteger(settlementApplicationFeeAmount)
        ) {
          throw new Error(
            `Stripe Connect Checkout is missing settlement policy evidence: ${checkoutSessionId}`,
          );
        }
        const settlement = await retrieveStripeCheckoutSettlement({
          connectedAccountId,
          checkoutSessionId,
          paymentIntentId,
          expectedGrossCents: paymentAmountCents,
          expectedApplicationFeeCents: settlementApplicationFeeAmount,
        });

        const [createdPayment] = await tx
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
          .onConflictDoNothing({ target: payments.externalId })
          .returning({ id: payments.id });
        if (!createdPayment) {
          throw new Error(
            `Stripe Connect payment identity raced another transaction: ${externalId}`,
          );
        }
        recordedPaymentId = createdPayment.id;
        const now = new Date();
        await tx.insert(paymentProcessorSettlements).values({
          practiceId: invoice.practiceId,
          invoiceId,
          paymentId: createdPayment.id,
          provider: STRIPE_CONNECT_PROVIDER,
          connectedAccountId: settlement.connectedAccountId,
          checkoutSessionId: settlement.checkoutSessionId,
          paymentIntentId: settlement.paymentIntentId,
          chargeId: settlement.chargeId,
          balanceTransactionId: settlement.balanceTransactionId,
          currency: settlement.currency,
          grossAmountCents: settlement.grossAmountCents,
          processorFeeCents: settlement.processorFeeCents,
          applicationFeeCents: settlement.applicationFeeCents,
          clinicNetCents: settlement.clinicNetCents,
          balanceStatus: settlement.balanceStatus,
          availableOn: settlement.availableOn,
          payoutStatus: "unassigned",
          reconciledAt: now,
          lastSyncedAt: now,
        });
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
        await markCompletedVisitCloseoutPaid(
          { db: tx, practiceId: invoice.practiceId },
          {
            appointmentId: invoice.appointmentId,
            invoiceId,
            source: "stripe_connect",
            paymentId: recordedPaymentId,
            paymentExternalId: externalId,
          },
        );
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
          amountPaidCents: recordedPaymentAmountCents!,
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
