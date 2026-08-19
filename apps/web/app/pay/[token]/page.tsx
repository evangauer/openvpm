"use client";

import { useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  LockKeyhole,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatCurrency } from "@/lib/locale/format";
import { formatPortalDate } from "@/lib/portal/date";
import {
  isSafePortalCheckoutRedirectUrl,
  portalPaymentBanner,
} from "@/lib/portal/payments";
import { fetchWithClientTimeout } from "@/lib/client-fetch";

function PaymentButton({ token }: { token: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePay() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithClientTimeout("/api/portal/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentToken: token }),
      });
      const body = await response.json();
      if (!response.ok || !isSafePortalCheckoutRedirectUrl(body.url)) {
        throw new Error(body.error ?? "Unable to start payment");
      }
      window.location.href = body.url;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to start payment",
      );
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handlePay}
        disabled={loading}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-5 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <CreditCard className="h-5 w-5" aria-hidden="true" />
        {loading ? "Opening secure checkout…" : "Pay securely online"}
      </button>
      <p className="mt-2 text-center text-xs text-slate-500">
        Secure checkout powered by Stripe
      </p>
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function InvoicePaymentPage() {
  const { token } = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const paymentBanner = portalPaymentBanner(searchParams.get("payment"));
  const invoice = trpc.portal.getInvoicePayment.useQuery(
    { token },
    { retry: false },
  );

  if (invoice.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="h-9 w-9 animate-spin rounded-full border-4 border-teal-600 border-t-transparent" />
        <span className="sr-only">Loading invoice</span>
      </main>
    );
  }

  if (invoice.error || !invoice.data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-sm">
          <AlertCircle className="mx-auto h-10 w-10 text-amber-500" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900">
            This payment link is unavailable
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            It may have expired or the invoice may have changed. Please ask the
            clinic to send a new payment link.
          </p>
        </section>
      </main>
    );
  }

  const data = invoice.data;
  const balance = Number(data.balanceDue ?? 0);
  const paid = data.status === "paid" || balance <= 0;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#e6fffb_0,#f8fafc_42%)] px-4 py-8 sm:py-14">
      <section className="mx-auto w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60">
        <header className="bg-teal-700 px-6 py-6 text-white sm:px-8">
          <p className="text-sm font-medium text-teal-100">Invoice from</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {data.practiceName}
          </h1>
        </header>

        <div className="space-y-6 px-6 py-7 sm:px-8">
          <div>
            <p className="text-base text-slate-700">
              Hi {data.clientFirstName}, here is the secure payment page your
              clinic sent you.
            </p>
            <div className="mt-5 rounded-xl border border-teal-100 bg-teal-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-teal-800">
                Amount due
              </p>
              <p className="mt-1 text-4xl font-bold tracking-tight text-slate-950">
                {formatCurrency(data.balanceDue, data.currency, data.country)}
              </p>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
                <span>
                  Invoice date:{" "}
                  {formatPortalDate(
                    data.createdAt,
                    data.country,
                    data.timezone,
                  )}
                </span>
                {data.dueDate ? (
                  <span>
                    Due:{" "}
                    {formatPortalDate(
                      data.dueDate,
                      data.country,
                      data.timezone,
                    )}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          {paymentBanner ? (
            <div
              role="status"
              className={`rounded-xl border p-4 text-sm ${
                paymentBanner.kind === "success"
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-blue-200 bg-blue-50 text-blue-800"
              }`}
            >
              {paymentBanner.message}
            </div>
          ) : null}

          {paid ? (
            <div className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-green-800">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-semibold">This invoice is paid</p>
                <p className="mt-1 text-sm">No further payment is needed.</p>
              </div>
            </div>
          ) : data.onlinePaymentsEnabled ? (
            <PaymentButton token={token} />
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              Online payment is temporarily unavailable. Please contact the
              clinic to pay.
            </div>
          )}

          <div className="flex items-start gap-3 border-t border-slate-100 pt-5 text-sm leading-6 text-slate-600">
            <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-teal-700" />
            <div>
              <p className="font-medium text-slate-800">
                No account or password required
              </p>
              <p>
                This private link is limited to this invoice and expires on{" "}
                {formatPortalDate(data.expiresAt, data.country, data.timezone)}.
              </p>
            </div>
          </div>

          <footer className="text-sm leading-6 text-slate-600">
            Questions? Contact {data.practiceName}
            {data.practicePhone ? ` at ${data.practicePhone}` : ""}
            {data.practiceEmail ? ` or ${data.practiceEmail}` : ""}.
          </footer>
        </div>
      </section>
    </main>
  );
}
