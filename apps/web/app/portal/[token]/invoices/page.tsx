"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertCircle, CreditCard, Receipt } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/common/empty-state";
import { formatCurrency as formatCurrencyBase } from "@/lib/locale/format";
import { formatPortalDate } from "@/lib/portal/date";
import {
  isSafePortalCheckoutRedirectUrl,
  portalPaymentBanner,
} from "@/lib/portal/payments";
import { fetchWithClientTimeout } from "@/lib/client-fetch";

const statusStyles: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  void: "bg-gray-100 text-gray-400",
  estimate: "bg-purple-100 text-purple-700",
};

function formatDate(
  d: string | Date | null,
  country?: string | null,
  timeZone?: string | null,
): string {
  return formatPortalDate(d, country, timeZone);
}

function formatCurrency(
  amount: string | number | null,
  currency: string = "usd",
  country?: string | null,
): string {
  return formatCurrencyBase(amount, currency, country);
}

function PayButton({ invoiceId }: { invoiceId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithClientTimeout("/api/portal/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId }),
      });
      const data = await res.json();
      if (!res.ok || !isSafePortalCheckoutRedirectUrl(data.url)) {
        throw new Error(data.error ?? "Unable to start payment");
      }
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start payment");
      setLoading(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-start gap-1 sm:w-auto">
      <button
        onClick={handlePay}
        disabled={loading}
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 sm:w-auto"
      >
        <CreditCard className="h-4 w-4" aria-hidden="true" />
        {loading ? "Opening secure checkout..." : "Pay securely online"}
      </button>
      <span className="text-xs text-gray-500">Powered by Stripe</span>
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}

function PaymentUnavailable() {
  return (
    <p className="text-sm text-gray-600">
      Online payment is temporarily unavailable. Please contact the clinic to
      pay.
    </p>
  );
}

export default function InvoicesPage() {
  const searchParams = useSearchParams();
  const returnedInvoiceId = searchParams.get("invoice");
  const paymentBanner = portalPaymentBanner(
    searchParams.get("payment"),
    returnedInvoiceId,
  );

  const { data, isLoading, error } = trpc.portal.getInvoices.useQuery({});

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-xl">
        <EmptyState
          className="py-12"
          icon={AlertCircle}
          title="Unable to load invoices"
          description="Please refresh this page or contact your clinic if the portal link has expired."
        />
      </div>
    );
  }

  return (
    <div>
      <Link
        href="/portal"
        className="mb-6 inline-flex items-center gap-1 text-sm text-primary hover:text-primary/80"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 19.5L8.25 12l7.5-7.5"
          />
        </svg>
        Back to portal
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-8">Invoices</h1>

      {paymentBanner && (
        <div
          className={`mb-6 rounded-lg border p-4 text-sm ${
            paymentBanner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-blue-200 bg-blue-50 text-blue-800"
          }`}
        >
          {paymentBanner.message}
        </div>
      )}

      {data.length === 0 ? (
        <EmptyState
          className="py-12"
          icon={Receipt}
          title="No invoices yet"
          description="Invoices and estimates from your clinic will appear here."
        />
      ) : (
        <>
          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {data.map((inv) => {
              const balance = Number(inv.balanceDue ?? 0);
              const adjusted = Number(inv.adjustedAmount ?? 0);
              const status = inv.isEstimate ? "estimate" : inv.status;
              const isReturnedInvoice = returnedInvoiceId === inv.id;
              const isPayable =
                balance > 0 &&
                !inv.isEstimate &&
                (inv.status === "sent" || inv.status === "overdue");
              const canPay = isPayable && inv.onlinePaymentsEnabled;
              return (
                <div
                  key={inv.id}
                  className={`rounded-xl border p-4 ${
                    isReturnedInvoice
                      ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                      : "border-gray-200"
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="font-medium text-gray-900">
                        {formatCurrency(inv.total, inv.currency, inv.country)}
                      </p>
                      <p className="text-sm text-gray-500">
                        {formatDate(inv.createdAt, inv.country, inv.timezone)}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                        statusStyles[status] || "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {status}
                    </span>
                  </div>
                  {inv.patientName && (
                    <p className="text-sm text-gray-500">
                      Patient: {inv.patientName}
                    </p>
                  )}
                  <div className="flex justify-between mt-2 text-sm">
                    <span className="text-gray-400">
                      Paid:{" "}
                      {formatCurrency(
                        inv.paidAmount,
                        inv.currency,
                        inv.country,
                      )}
                    </span>
                    {adjusted > 0 && (
                      <span className="text-gray-400">
                        Adjusted:{" "}
                        {formatCurrency(
                          inv.adjustedAmount,
                          inv.currency,
                          inv.country,
                        )}
                      </span>
                    )}
                    {balance > 0 && (
                      <span className="font-medium text-red-600">
                        Balance:{" "}
                        {formatCurrency(balance, inv.currency, inv.country)}
                      </span>
                    )}
                  </div>
                  {inv.dueDate && (
                    <p className="text-xs text-gray-400 mt-1">
                      Due: {formatDate(inv.dueDate, inv.country, inv.timezone)}
                    </p>
                  )}
                  {canPay && (
                    <div className="mt-3">
                      <PayButton invoiceId={inv.id} />
                    </div>
                  )}
                  {isPayable && !inv.onlinePaymentsEnabled && (
                    <div className="mt-3">
                      <PaymentUnavailable />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="pb-2 pr-4 font-medium">Date</th>
                  <th className="pb-2 pr-4 font-medium">Patient</th>
                  <th className="pb-2 pr-4 font-medium text-right">Total</th>
                  <th className="pb-2 pr-4 font-medium text-right">Paid</th>
                  <th className="pb-2 font-medium text-right">Balance</th>
                  <th className="pb-2 pl-6 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Due Date</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.map((inv) => {
                  const balance = Number(inv.balanceDue ?? 0);
                  const adjusted = Number(inv.adjustedAmount ?? 0);
                  const status = inv.isEstimate ? "estimate" : inv.status;
                  const isReturnedInvoice = returnedInvoiceId === inv.id;
                  const isPayable =
                    balance > 0 &&
                    !inv.isEstimate &&
                    (inv.status === "sent" || inv.status === "overdue");
                  const canPay = isPayable && inv.onlinePaymentsEnabled;
                  return (
                    <tr
                      key={inv.id}
                      className={
                        isReturnedInvoice ? "bg-primary/5" : undefined
                      }
                    >
                      <td className="py-3 pr-4 text-gray-600">
                        {formatDate(inv.createdAt, inv.country, inv.timezone)}
                      </td>
                      <td className="py-3 pr-4 text-gray-900">
                        {inv.patientName || "-"}
                      </td>
                      <td className="py-3 pr-4 text-right font-medium text-gray-900">
                        {formatCurrency(inv.total, inv.currency, inv.country)}
                      </td>
                      <td className="py-3 pr-4 text-right text-gray-600">
                        {formatCurrency(
                          inv.paidAmount,
                          inv.currency,
                          inv.country,
                        )}
                        {adjusted > 0 && (
                          <span className="block text-xs text-gray-400">
                            Adj{" "}
                            {formatCurrency(
                              inv.adjustedAmount,
                              inv.currency,
                              inv.country,
                            )}
                          </span>
                        )}
                      </td>
                      <td
                        className={`py-3 text-right font-medium ${balance > 0 ? "text-red-600" : "text-green-600"}`}
                      >
                        {formatCurrency(balance, inv.currency, inv.country)}
                      </td>
                      <td className="py-3 pl-6 pr-4">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                            statusStyles[status] || "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-gray-500">
                        {formatDate(inv.dueDate, inv.country, inv.timezone)}
                      </td>
                      <td className="py-3">
                        {canPay && (
                          <PayButton invoiceId={inv.id} />
                        )}
                        {isPayable && !inv.onlinePaymentsEnabled && (
                          <PaymentUnavailable />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
