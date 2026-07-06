import { NextRequest, NextResponse } from "next/server";
import { eq, and, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openpims/db/client";
import {
  clients,
  invoiceAdjustments,
  invoices,
  patients,
  practices,
} from "@openpims/db";
import { createCheckoutSession } from "@/lib/stripe";
import { withSystem } from "@/lib/tenant-db";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import {
  invoiceBalanceCents,
  moneyToCents,
} from "@/lib/billing/invoice-balance";
import {
  buildPortalPaymentReturnUrl,
  isSafePortalCheckoutRedirectUrl,
} from "@/lib/portal/payments";
import {
  PORTAL_ACCESS_TOKEN_MAX_LENGTH,
  portalRateLimitKey,
} from "@/lib/portal/tokens";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { readJsonRequestBody } from "@/lib/request-json";

const portalCheckoutInput = z.object({
  token: z.string().trim().min(1).max(PORTAL_ACCESS_TOKEN_MAX_LENGTH),
  invoiceId: z.string().uuid(),
});
const PORTAL_CHECKOUT_RATE_LIMIT_MESSAGE =
  "Too many payment attempts. Please try again later or call the clinic.";

function portalCheckoutRateLimitResponse(
  limit: number,
  result: { remaining: number; resetAt: Date }
) {
  return NextResponse.json(
    {
      error: PORTAL_CHECKOUT_RATE_LIMIT_MESSAGE,
    },
    {
      status: 429,
      headers: rateLimitResponseHeaders(limit, result),
    },
  );
}

async function enforcePortalCheckoutRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
}) {
  try {
    const result = await rateLimit({
      key: input.key,
      limit: input.limit,
      windowMs: input.windowMs,
    });
    if (result.success) return null;
    return portalCheckoutRateLimitResponse(input.limit, result);
  } catch (err) {
    console.error("[portal-checkout] rate limit failed:", err);
    return portalCheckoutRateLimitResponse(input.limit, {
      remaining: 0,
      resetAt: new Date(Date.now() + input.windowMs),
    });
  }
}

export async function POST(req: NextRequest) {
  const body = await readJsonRequestBody(req);
  if (!body.ok) {
    return NextResponse.json(
      {
        error:
          body.reason === "too_large"
            ? "Request body too large"
            : "Invalid request body",
      },
      { status: body.reason === "too_large" ? 413 : 400 },
    );
  }

  const parsed = portalCheckoutInput.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid token or invoiceId" },
      { status: 400 },
    );
  }

  const { token, invoiceId } = parsed.data;

  try {
    const clientIp = clientIpFromRequest(req);
    const ipRateLimitResponse = await enforcePortalCheckoutRateLimit({
      key: `portal-checkout:ip:${clientIp}`,
      limit: 30,
      windowMs: 15 * 60 * 1000,
    });
    if (ipRateLimitResponse) {
      return ipRateLimitResponse;
    }

    const tokenRateLimitResponse = await enforcePortalCheckoutRateLimit({
      key: portalRateLimitKey("portal-checkout", token),
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (tokenRateLimitResponse) {
      return tokenRateLimitResponse;
    }

    // Public token flow → run cross-tenant lookups in system context (RLS bypass).
    return await withSystem(db, async (tx) => {
      // Validate client token (same pattern as portal router)
      const [client] = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.accessToken, token), isNull(clients.deletedAt)))
        .limit(1);

      if (!client) {
        return NextResponse.json(
          { error: "Invalid portal link" },
          { status: 404 },
        );
      }

      // Fetch invoice and verify it belongs to this client
      const [invoice] = await tx
        .select({
          id: invoices.id,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          status: invoices.status,
          isEstimate: invoices.isEstimate,
          clientId: invoices.clientId,
          patientId: invoices.patientId,
          practiceId: invoices.practiceId,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.clientId, client.id),
            eq(invoices.practiceId, client.practiceId),
            isNull(invoices.deletedAt),
          ),
        )
        .limit(1);

      if (!invoice) {
        return NextResponse.json(
          { error: "Invoice not found" },
          { status: 404 },
        );
      }

      if (invoice.status === "paid") {
        return NextResponse.json(
          { error: "Invoice is already paid" },
          { status: 400 },
        );
      }
      if (invoice.status === "draft") {
        return NextResponse.json(
          { error: "Invoice has not been sent yet" },
          { status: 400 },
        );
      }
      if (invoice.status === "void") {
        return NextResponse.json(
          { error: "Cannot pay a void invoice" },
          { status: 400 },
        );
      }
      if (invoice.isEstimate) {
        return NextResponse.json(
          { error: "Convert the estimate before accepting payment" },
          { status: 400 },
        );
      }
      if (invoice.status !== "sent" && invoice.status !== "overdue") {
        return NextResponse.json(
          { error: "Invoice is not ready for online payment" },
          { status: 400 },
        );
      }

      const adjustmentRows = await tx
        .select({ amount: invoiceAdjustments.amount })
        .from(invoiceAdjustments)
        .where(
          and(
            eq(invoiceAdjustments.invoiceId, invoice.id),
            sql`exists (
              select 1
              from ${invoices}
              where ${invoices.id} = ${invoiceAdjustments.invoiceId}
                and ${invoices.clientId} = ${client.id}
                and ${invoices.practiceId} = ${client.practiceId}
                and ${invoices.deletedAt} is null
            )`,
            isNull(invoiceAdjustments.deletedAt),
          ),
        );
      const adjustedCents = adjustmentRows.reduce(
        (sum, row) => sum + moneyToCents(row.amount),
        0,
      );
      const amountCents = invoiceBalanceCents(invoice, adjustedCents);

      if (amountCents <= 0) {
        return NextResponse.json(
          { error: "No balance remaining" },
          { status: 400 },
        );
      }

      // Build description
      let description = `Invoice payment`;
      if (invoice.patientId) {
        const [patient] = await tx
          .select({ name: patients.name })
          .from(patients)
          .where(
            and(
              eq(patients.id, invoice.patientId),
              eq(patients.clientId, invoice.clientId),
              eq(patients.practiceId, invoice.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .limit(1);
        if (patient) {
          description = `Invoice payment for ${patient.name}`;
        }
      }

      // Charge in the practice's configured currency (region-aware).
      const [practice] = await tx
        .select({
          currency: practices.currency,
          tier: practices.subscriptionTier,
          billingStatus: practices.billingStatus,
          trialEndsAt: practices.trialEndsAt,
        })
        .from(practices)
        .where(
          and(eq(practices.id, invoice.practiceId), isNull(practices.deletedAt)),
        )
        .limit(1);

      if (!practice) {
        return NextResponse.json(
          { error: "Invalid portal link" },
          { status: 404 },
        );
      }

      if (
        billingEnforced() &&
        !hasHostedFullAccess(
          practice.tier,
          practice.billingStatus,
          practice.trialEndsAt,
        )
      ) {
        return NextResponse.json(
          {
            error:
              "OpenVPM Cloud is read-only until the practice trial or subscription is active.",
          },
          { status: 403 },
        );
      }

      const origin = req.nextUrl.origin;
      const result = await createCheckoutSession({
        invoiceId: invoice.id,
        amount: amountCents,
        clientEmail: client.email ?? "",
        clientName: `${client.firstName} ${client.lastName}`,
        description,
        currency: practice.currency ?? "usd",
        successUrl: buildPortalPaymentReturnUrl({
          origin,
          token,
          status: "success",
          invoiceId: invoice.id,
        }),
        cancelUrl: buildPortalPaymentReturnUrl({
          origin,
          token,
          status: "cancelled",
          invoiceId: invoice.id,
        }),
      });

      if (!isSafePortalCheckoutRedirectUrl(result?.url)) {
        return NextResponse.json(
          { error: "Payment processing is not configured" },
          { status: 503 },
        );
      }

      return NextResponse.json({ url: result.url });
    });
  } catch (err) {
    console.error("[Portal Checkout] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
