"use client";

import React from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatCurrency } from "@/lib/locale/format";
import { cn } from "@/lib/utils";

type BalanceSummary = {
  outstandingCents: number;
  overdueCents: number;
  openInvoiceCount: number;
  currency: string;
  country: string;
};

export function ClientAccountBalanceContent({
  data,
  loading,
  unavailable,
  refreshing = false,
  onRefresh,
}: {
  data?: BalanceSummary;
  loading: boolean;
  unavailable: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const verifiedBalance = !loading && !unavailable ? data : undefined;
  const hasBalance = Boolean(verifiedBalance?.outstandingCents);
  const hasOverdue = Boolean(verifiedBalance?.overdueCents);

  return (
    <div
      className={cn(
        "inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-sm",
        hasOverdue
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-muted/30",
      )}
      aria-live="polite"
      title="Issued invoices across this client's patients, after recorded payments and credits. Drafts, estimates, and historical archive balances are excluded."
    >
      {loading ? (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading client balance...
        </span>
      ) : !verifiedBalance ? (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          Client balance unavailable
        </span>
      ) : (
        <>
          <span className="font-medium">
            Client balance:{" "}
            {formatCurrency(
              verifiedBalance.outstandingCents / 100,
              verifiedBalance.currency,
              verifiedBalance.country,
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {hasOverdue
              ? `${formatCurrency(verifiedBalance.overdueCents / 100, verifiedBalance.currency, verifiedBalance.country)} overdue`
              : hasBalance
                ? `${verifiedBalance.openInvoiceCount} open invoice${verifiedBalance.openInvoiceCount === 1 ? "" : "s"}`
                : "No issued balance due"}
          </span>
        </>
      )}
      {onRefresh && !loading ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          aria-label="Refresh client balance"
          title="Refresh client balance"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </div>
  );
}

/** Staff-only summary; currency and balance arrive together from tenant scope. */
export function ClientAccountBalance({ clientId }: { clientId: string }) {
  const balance = trpc.clients.getAccountBalance.useQuery(
    { clientId },
    {
      enabled: Boolean(clientId),
      staleTime: 0,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchInterval: 60_000,
    },
  );

  return (
    <ClientAccountBalanceContent
      data={balance.data}
      loading={balance.isLoading}
      unavailable={Boolean(balance.error) || !balance.data}
      refreshing={balance.isFetching}
      onRefresh={() => void balance.refetch()}
    />
  );
}
