"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  FileText,
  ChevronDown,
  ChevronRight,
  Send,
  CheckCircle,
  Loader2,
  Plus,
  DollarSign,
  ArrowRightLeft,
  Download,
  Mail,
  Ban,
  CreditCard,
  CalendarClock,
  Pill,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useCurrencyFormatter } from "@/lib/locale/useCurrency";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { ActionConfirmationDialog } from "@/components/common/action-confirmation-dialog";
import { TableSkeleton } from "@/components/common/loading";
import { TableScroll } from "@/components/common/table-scroll";
import {
  BILLING_ADJUSTMENT_REASON_MAX_LENGTH,
  BILLING_NOTES_MAX_LENGTH,
  BILLING_PAYMENT_AMOUNT_MIN,
  BILLING_UNIT_PRICE_MAX,
  isBillingAmountWithinBalance,
} from "@/lib/billing/policy";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";

const STATUS_TABS = [
  { label: "All", value: undefined, isEstimate: false as const },
  { label: "Draft", value: "draft", isEstimate: false as const },
  { label: "Sent", value: "sent", isEstimate: false as const },
  { label: "Paid", value: "paid", isEstimate: false as const },
  { label: "Overdue", value: "overdue", isEstimate: false as const },
  { label: "Void", value: "void", isEstimate: false as const },
  { label: "Estimates", value: undefined, isEstimate: true as const },
] as const;

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  void: "bg-gray-100 text-gray-500",
  partial: "bg-amber-100 text-amber-700",
  settled: "bg-teal-100 text-teal-700",
  estimate: "bg-purple-100 text-purple-700",
};

const PAYMENT_METHODS = [
  { label: "Cash", value: "cash" },
  { label: "Credit Card", value: "credit_card" },
  { label: "Debit Card", value: "debit_card" },
  { label: "Check", value: "check" },
  { label: "Online", value: "online" },
  { label: "Other", value: "other" },
] as const;

const BILLING_ACTION_REASON_MIN_LENGTH = 5;
const BILLING_ACTION_REASON_MAX_LENGTH = 500;

function canManageBillingRole(role?: string | null): boolean {
  return role === "admin" || role === "front_desk";
}

function formatBillingDateInput(
  value: Date | string,
  timeZone?: string | null
) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(
      "en-US",
      { timeZone: "UTC" }
    );
  }

  return formatBillingInstantDate(value, timeZone);
}

function formatBillingInstantDate(
  value: Date | string,
  timeZone?: string | null
) {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "short",
    timeZone: timeZone ?? undefined,
  };

  try {
    return new Date(value).toLocaleDateString("en-US", options);
  } catch {
    return new Date(value).toLocaleDateString("en-US", {
      ...options,
      timeZone: undefined,
    });
  }
}

function getDisplayStatus(invoice: {
  status: string;
  paidAmount: string | null;
  adjustedAmount?: string | null;
  total: string | null;
  isEstimate: boolean;
}): { label: string; style: string } {
  if (invoice.isEstimate) {
    return { label: "estimate", style: STATUS_STYLES.estimate };
  }
  const paid = Number(invoice.paidAmount ?? 0);
  const adjusted = Number(invoice.adjustedAmount ?? 0);
  const total = Number(invoice.total ?? 0);
  if (
    total > 0 &&
    adjusted > 0 &&
    paid + adjusted >= total &&
    invoice.status !== "paid" &&
    invoice.status !== "void"
  ) {
    return { label: "settled", style: STATUS_STYLES.settled };
  }
  if (paid + adjusted > 0 && paid + adjusted < total && invoice.status !== "paid") {
    return { label: "partial", style: STATUS_STYLES.partial };
  }
  return {
    label: invoice.status,
    style: STATUS_STYLES[invoice.status] ?? STATUS_STYLES.draft,
  };
}

export default function BillingPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const formatCurrency = useCurrencyFormatter();
  const canManageBilling = canManageBillingRole(session?.user?.role);
  const canWaiveDispenseCharges = session?.user?.role === "admin";
  const [activeTab, setActiveTab] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [pendingInvoiceVoidId, setPendingInvoiceVoidId] = useState<
    string | null
  >(null);
  const [invoiceVoidReason, setInvoiceVoidReason] = useState("");
  const limit = 25;

  // Deep link: /billing?expand=<invoiceId> opens that invoice's detail (the
  // welcome tour uses this to walk into a real invoice). After mount so the
  // server render stays stable.
  useEffect(() => {
    const expand = new URLSearchParams(window.location.search).get("expand");
    if (expand) setExpandedId(expand);
  }, []);

  const tab = STATUS_TABS[activeTab];
  const statusFilter = tab.isEstimate ? undefined : tab.value;
  const isEstimateFilter = tab.isEstimate ? true : false;

  const billingConfig = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const { data, isLoading, error } = trpc.billing.listInvoices.useQuery({
    status: statusFilter,
    isEstimate: isEstimateFilter,
    limit,
    offset,
  });
  const arSummary = trpc.billing.arSummary.useQuery(undefined, {
    staleTime: 60 * 1000,
  });
  const listError = billingConfig.error ?? error;
  const isListLoading = billingConfig.isLoading || isLoading;
  const billingConfigMissing =
    !billingConfig.isLoading && !billingConfig.error && !billingConfig.data;
  const verifiedBillingConfig =
    billingConfig.error || !billingConfig.data ? null : billingConfig.data;
  const billingSettingsReady = verifiedBillingConfig !== null;
  const billingTimeZone = verifiedBillingConfig
    ? verifiedBillingConfig.timezone
    : null;
  const invoiceListMissing = !isLoading && !error && !data;
  const billingListMissing = billingConfigMissing || invoiceListMissing;

  const utils = trpc.useUtils();

  const updateStatus = trpc.billing.updateInvoiceStatus.useMutation({
    onSuccess: () => {
      toast.success("Invoice status updated");
      utils.billing.listInvoices.invalidate();
      utils.billing.getInvoice.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const convertEstimate = trpc.billing.convertEstimateToInvoice.useMutation({
    onSuccess: () => {
      toast.success("Estimate converted to invoice");
      utils.billing.listInvoices.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const voidInvoice = trpc.billing.voidInvoice.useMutation({
    onSuccess: () => {
      toast.success("Invoice voided");
      utils.billing.listInvoices.invalidate();
      utils.billing.getInvoice.invalidate();
      utils.billing.listDispenseChargeQueue.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const handleStatusChange = (
    e: React.MouseEvent,
    id: string,
    status: "sent"
  ) => {
    e.stopPropagation();
    updateStatus.mutate({ id, status });
  };

  const handleConvertEstimate = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    convertEstimate.mutate({ id });
  };

  const handleVoidInvoice = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setInvoiceVoidReason("");
    setPendingInvoiceVoidId(id);
  };

  const closeInvoiceVoidDialog = () => {
    if (voidInvoice.isPending) return;
    setPendingInvoiceVoidId(null);
    setInvoiceVoidReason("");
  };

  const confirmInvoiceVoid = () => {
    const reason = invoiceVoidReason.trim();
    if (
      !pendingInvoiceVoidId ||
      reason.length < BILLING_ACTION_REASON_MIN_LENGTH
    ) {
      return;
    }
    voidInvoice.mutate(
      { id: pendingInvoiceVoidId, reason },
      {
        onSuccess: () => {
          setPendingInvoiceVoidId(null);
          setInvoiceVoidReason("");
        },
      },
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">Billing</h2>
          <p className="text-sm text-muted-foreground">
            Invoices and payments
          </p>
        </div>
        {canManageBilling && (
          <Button asChild>
            <Link href="/billing/new">
              <Plus className="mr-1 h-4 w-4" />
              New Invoice
            </Link>
          </Button>
        )}
      </div>

      <DispenseChargeQueuePanel
        canManage={canManageBilling}
        canWaive={canWaiveDispenseCharges}
        billingTimeZone={billingTimeZone}
        onInvoiceCreated={setExpandedId}
      />

      <WellnessBillingPanel
        billingTimeZone={billingTimeZone}
        settingsReady={billingSettingsReady}
        canManageBilling={canManageBilling}
      />

      {/* Accounts receivable at a glance */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Outstanding</p>
          <p className="mt-1 font-heading text-2xl font-semibold">
            {arSummary.isError
              ? "—"
              : arSummary.data
                ? formatCurrency(arSummary.data.outstanding)
                : "…"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Overdue</p>
          <p
            className={`mt-1 font-heading text-2xl font-semibold ${
              arSummary.data && Number(arSummary.data.overdue) > 0
                ? "text-destructive"
                : ""
            }`}
          >
            {arSummary.isError
              ? "—"
              : arSummary.data
                ? formatCurrency(arSummary.data.overdue)
                : "…"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Collected this month</p>
          <p className="mt-1 font-heading text-2xl font-semibold">
            {arSummary.isError
              ? "—"
              : arSummary.data
                ? formatCurrency(arSummary.data.collectedThisMonth)
                : "…"}
          </p>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="mt-6 flex items-center gap-1 border-b border-border">
        {STATUS_TABS.map((t, idx) => (
          <button
            key={t.label}
            onClick={() => {
              setActiveTab(idx);
              setOffset(0);
            }}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === idx
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {listError || billingListMissing ? (
        <div className="mt-6 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {listError?.message ?? "Unable to load invoices. Please retry."}
        </div>
      ) : isListLoading ? (
        <TableSkeleton rows={8} cols={7} />
      ) : data && verifiedBillingConfig && data.items.length > 0 ? (
        <>
          <TableScroll className="mt-6 rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="w-8 px-2 py-3" />
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Client
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Patient
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Total
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Paid
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Due Date
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Created
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((invoice) => (
                  <InvoiceRow
                    key={invoice.id}
                    invoice={invoice}
                    isExpanded={expandedId === invoice.id}
                    onToggle={() =>
                      setExpandedId(
                        expandedId === invoice.id ? null : invoice.id
                      )
                    }
                    onStatusChange={handleStatusChange}
                    onConvertEstimate={handleConvertEstimate}
                    onVoidInvoice={handleVoidInvoice}
                    practiceName={verifiedBillingConfig.practiceName}
                    billingTimeZone={billingTimeZone}
                    canManageBilling={canManageBilling}
                    isMutating={
                      updateStatus.isPending ||
                      convertEstimate.isPending ||
                      voidInvoice.isPending
                    }
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <p>
              Showing {offset + 1}--{Math.min(offset + limit, data.total)} of{" "}
              {data.total}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + limit >= data.total}
                onClick={() => setOffset(offset + limit)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : (
        <EmptyState
          className="mt-6"
          icon={FileText}
          title={
            tab.isEstimate
              ? "No estimates yet"
              : statusFilter
                ? "No invoices with this status"
                : "No invoices yet"
          }
          description={
            tab.isEstimate
              ? "Create an estimate when a client needs approval before services are performed."
              : statusFilter
                ? "Choose another status tab or create a new invoice."
                : "Create invoices from services, products, or treatment templates before recording payments."
          }
          action={
            canManageBilling
              ? {
                  label: tab.isEstimate ? "Create estimate" : "Create invoice",
                  onClick: () => router.push("/billing/new"),
                  icon: Plus,
                }
              : undefined
          }
        />
      )}

      <ActionConfirmationDialog
        open={pendingInvoiceVoidId !== null}
        title="Void invoice?"
        description="This cannot be undone. Any dispensed medication charges on this invoice will return to the billing work queue; inventory will not move again."
        confirmLabel="Void invoice"
        confirmVariant="destructive"
        isPending={voidInvoice.isPending}
        reason={{
          label: "Reason for voiding",
          value: invoiceVoidReason,
          onChange: setInvoiceVoidReason,
          placeholder: "Explain the correction for the audit trail",
          minLength: BILLING_ACTION_REASON_MIN_LENGTH,
          maxLength: BILLING_ACTION_REASON_MAX_LENGTH,
        }}
        onCancel={closeInvoiceVoidDialog}
        onConfirm={confirmInvoiceVoid}
      />
    </div>
  );
}

function DispenseChargeQueuePanel({
  canManage,
  canWaive,
  billingTimeZone,
  onInvoiceCreated,
}: {
  canManage: boolean;
  canWaive: boolean;
  billingTimeZone?: string | null;
  onInvoiceCreated: (invoiceId: string) => void;
}) {
  const router = useRouter();
  const formatCurrency = useCurrencyFormatter();
  const utils = trpc.useUtils();
  const [waiveTargetId, setWaiveTargetId] = useState<string | null>(null);
  const [waiveReason, setWaiveReason] = useState("");
  const [legacyReviewTargetId, setLegacyReviewTargetId] = useState<
    string | null
  >(null);
  const pending = trpc.billing.listDispenseChargeQueue.useQuery({
    status: "pending",
    limit: 50,
    offset: 0,
  });
  const waived = trpc.billing.listDispenseChargeQueue.useQuery(
    { status: "waived", limit: 25, offset: 0 },
    { enabled: canWaive },
  );
  const createInvoice = trpc.billing.createDispenseChargeInvoice.useMutation({
    onSuccess: async ({ invoiceId }) => {
      toast.success("Medication dispense added to a draft invoice");
      onInvoiceCreated(invoiceId);
      await Promise.all([
        utils.billing.listDispenseChargeQueue.invalidate(),
        utils.billing.listInvoices.invalidate(),
      ]);
      router.push(`/billing?expand=${invoiceId}`);
    },
    onError: (error) => toast.error(error.message),
  });
  const waiveCharge = trpc.billing.waiveDispenseCharge.useMutation({
    onSuccess: async () => {
      toast.success("Medication charge waived with an audit record");
      await utils.billing.listDispenseChargeQueue.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const reopenCharge = trpc.billing.reopenDispenseCharge.useMutation({
    onSuccess: async () => {
      toast.success("Medication charge returned to the work queue");
      await utils.billing.listDispenseChargeQueue.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const isMutating =
    createInvoice.isPending || waiveCharge.isPending || reopenCharge.isPending;

  function openWaiveDialog(id: string) {
    setWaiveReason("");
    setWaiveTargetId(id);
  }

  function closeWaiveDialog() {
    if (waiveCharge.isPending) return;
    setWaiveTargetId(null);
    setWaiveReason("");
  }

  function confirmWaive() {
    const reason = waiveReason.trim();
    if (!waiveTargetId || reason.length < BILLING_ACTION_REASON_MIN_LENGTH) {
      return;
    }
    waiveCharge.mutate(
      { id: waiveTargetId, reason },
      {
        onSuccess: () => {
          setWaiveTargetId(null);
          setWaiveReason("");
        },
      },
    );
  }

  function createDraftForDispense(item: { id: string; legacyReview: boolean }) {
    if (item.legacyReview) {
      setLegacyReviewTargetId(item.id);
      return;
    }
    createInvoice.mutate({
      id: item.id,
      acknowledgeLegacyReview: false,
    });
  }

  function closeLegacyReviewDialog() {
    if (createInvoice.isPending) return;
    setLegacyReviewTargetId(null);
  }

  function confirmLegacyReview() {
    if (!legacyReviewTargetId) return;
    createInvoice.mutate(
      {
        id: legacyReviewTargetId,
        acknowledgeLegacyReview: true,
      },
      { onSuccess: () => setLegacyReviewTargetId(null) },
    );
  }

  return (
    <section className="mt-6 rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div>
          <div className="flex items-center gap-2">
            <Pill className="h-4 w-4 text-primary" />
            <h3 className="font-heading font-semibold">
              Unbilled medication dispenses
            </h3>
            {pending.data ? (
              <Badge
                variant={pending.data.total > 0 ? "destructive" : "secondary"}
              >
                {pending.data.total}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Every clinic-stock fill stays here until billing creates a draft
            invoice or an admin records why it is no-charge. Inventory has
            already been deducted and will not move again.
          </p>
        </div>
      </div>
      {pending.isError ? (
        <div className="p-4 text-sm text-destructive">
          Unable to load medication billing work. {pending.error.message}
        </div>
      ) : pending.isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading medication billing work...
        </div>
      ) : pending.data && pending.data.items.length > 0 ? (
        <div className="divide-y divide-border">
          {pending.data.items.map((item) => (
            <div
              key={item.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{item.description}</p>
                  {item.legacyReview ? (
                    <Badge variant="outline">Legacy review</Badge>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {item.patientName} · {item.clientFirstName}{" "}
                  {item.clientLastName} · Qty {item.quantity} at{" "}
                  {formatCurrency(item.unitPrice)} · dispensed{" "}
                  {formatBillingInstantDate(item.createdAt, billingTimeZone)}
                  {item.appointmentId ? (
                    <>
                      {" "}·{" "}
                      <Link
                        href={`/encounters/${item.appointmentId}#charge-capture`}
                        className="underline underline-offset-2"
                      >
                        Open visit
                      </Link>
                    </>
                  ) : (
                    <> · Standalone refill</>
                  )}
                </p>
              </div>
              {canManage ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    disabled={isMutating}
                    onClick={() => createDraftForDispense(item)}
                  >
                    {item.legacyReview ? "Review & create" : "Create draft"}
                  </Button>
                  {canWaive ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isMutating}
                      onClick={() => openWaiveDialog(item.id)}
                    >
                      Waive
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <CheckCircle className="h-4 w-4 text-green-600" />
          No clinic-stock dispenses are waiting for billing.
        </div>
      )}
      {canWaive && waived.data && waived.data.items.length > 0 ? (
        <details className="border-t border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Recently waived ({waived.data.total})
          </summary>
          <div className="mt-3 space-y-3">
            {waived.data.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div>
                  <p className="font-medium">{item.description}</p>
                  <p className="text-muted-foreground">
                    {item.patientName} · {item.resolutionReason}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isMutating}
                  onClick={() => reopenCharge.mutate({ id: item.id })}
                >
                  <Undo2 className="mr-1 h-3.5 w-3.5" />
                  Reopen
                </Button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <ActionConfirmationDialog
        open={legacyReviewTargetId !== null}
        title="Review legacy dispense"
        description="This dispense predates the billing ledger. Verify it was not already billed before creating a draft invoice."
        confirmLabel="Verified — create draft"
        isPending={createInvoice.isPending}
        onCancel={closeLegacyReviewDialog}
        onConfirm={confirmLegacyReview}
      />

      <ActionConfirmationDialog
        open={waiveTargetId !== null}
        title="Waive medication charge?"
        description="No invoice will be created. Inventory remains deducted, and the reason is saved to the audit trail so an admin can review or reopen this charge later."
        confirmLabel="Waive charge"
        confirmVariant="destructive"
        isPending={waiveCharge.isPending}
        reason={{
          label: "Reason for no charge",
          value: waiveReason,
          onChange: setWaiveReason,
          placeholder: "Explain why this dispense should not be billed",
          minLength: BILLING_ACTION_REASON_MIN_LENGTH,
          maxLength: BILLING_ACTION_REASON_MAX_LENGTH,
        }}
        onCancel={closeWaiveDialog}
        onConfirm={confirmWaive}
      />

    </section>
  );
}

function WellnessBillingPanel({
  billingTimeZone,
  settingsReady,
  canManageBilling,
}: {
  billingTimeZone?: string | null;
  settingsReady: boolean;
  canManageBilling: boolean;
}) {
  const formatCurrency = useCurrencyFormatter();
  const utils = trpc.useUtils();
  const dueQuery = trpc.wellness.listDue.useQuery(undefined, {
    enabled: settingsReady,
    refetchOnWindowFocus: false,
  });
  const dueMembershipsMissing =
    settingsReady && !dueQuery.isLoading && !dueQuery.error && !dueQuery.data;
  const dueMembershipsUnavailable =
    !!dueQuery.error || dueMembershipsMissing;
  const verifiedDueMemberships =
    dueQuery.isLoading || dueMembershipsUnavailable || !dueQuery.data
      ? null
      : dueQuery.data;
  const dueMemberships = verifiedDueMemberships ?? [];
  const totalDue = verifiedDueMemberships
    ? verifiedDueMemberships.reduce(
        (sum, row) => sum + Number(row.price ?? 0),
        0
      )
    : 0;

  const generateInvoices = trpc.wellness.generateDueInvoices.useMutation({
    onSuccess: (result) => {
      const label = result.generated === 1 ? "invoice" : "invoices";
      toast.success(`${result.generated} wellness ${label} generated`);
      utils.wellness.listDue.invalidate();
      utils.billing.listInvoices.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  if (
    !settingsReady ||
    (!dueQuery.isLoading &&
      !dueQuery.error &&
      !dueMembershipsMissing &&
      dueMemberships.length === 0)
  ) {
    return null;
  }

  return (
    <div
      className={`mt-6 rounded-lg border ${
        dueMembershipsUnavailable
          ? "border-destructive bg-destructive/5"
          : "border-border bg-card"
      }`}
    >
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <CalendarClock className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">Wellness invoices due</h3>
              <Badge variant="secondary">Invoice schedule</Badge>
            </div>
            <p
              className={`text-sm ${
                dueMembershipsUnavailable
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {dueQuery.isLoading
                ? "Checking due memberships..."
                : dueQuery.error
                ? dueQuery.error.message
                : dueMembershipsMissing
                ? "Unable to load due wellness memberships. Please retry."
                : `${dueMemberships.length} scheduled invoice${
                    dueMemberships.length === 1 ? "" : "s"
                  } due, ${formatCurrency(totalDue)} before tax`}
            </p>
            {!dueMembershipsUnavailable && !dueQuery.isLoading && (
              <p className="mt-1 text-xs text-muted-foreground">
                OpenVPM generates invoices for each billing date; staff still
                collect payment on each invoice.
              </p>
            )}
          </div>
        </div>
        {canManageBilling && (
          <Button
            size="sm"
            disabled={
              dueQuery.isLoading ||
              dueMembershipsUnavailable ||
              dueMemberships.length === 0 ||
              generateInvoices.isPending
            }
            onClick={() =>
              generateInvoices.mutate({
                enrollmentIds: dueMemberships.map((row) => row.enrollmentId),
              })
            }
          >
            {generateInvoices.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileText className="mr-2 h-4 w-4" />
            )}
            Generate invoices
          </Button>
        )}
      </div>
      {dueMemberships.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Client
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Patient
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Plan
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Due
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {dueMemberships.map((row) => (
                <tr
                  key={row.enrollmentId}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3 font-medium">
                    {row.clientFirstName} {row.clientLastName}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.patientName || "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.planName}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatBillingDateInput(
                      row.nextBillingDate,
                      billingTimeZone
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCurrency(row.price)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function InvoiceRow({
  invoice,
  isExpanded,
  onToggle,
  onStatusChange,
  onConvertEstimate,
  onVoidInvoice,
  practiceName,
  billingTimeZone,
  canManageBilling,
  isMutating,
}: {
  invoice: {
    id: string;
    status: string;
    subtotal: string | null;
    tax: string | null;
    total: string | null;
    paidAmount: string | null;
    adjustedAmount?: string | null;
    dueDate: string | null;
    createdAt: Date | string | null;
    isEstimate: boolean;
    appointmentId: string | null;
    clientFirstName: string | null;
    clientLastName: string | null;
    patientName: string | null;
  };
  isExpanded: boolean;
  onToggle: () => void;
  onStatusChange: (
    e: React.MouseEvent,
    id: string,
    status: "sent"
  ) => void;
  onConvertEstimate: (e: React.MouseEvent, id: string) => void;
  onVoidInvoice: (e: React.MouseEvent, id: string) => void;
  practiceName: string;
  billingTimeZone?: string | null;
  canManageBilling: boolean;
  isMutating: boolean;
}) {
  const formatCurrency = useCurrencyFormatter();
  const detail = trpc.billing.getInvoice.useQuery(
    { id: invoice.id },
    { enabled: isExpanded }
  );

  const displayStatus = getDisplayStatus(invoice);
  const adjustedAmount = Number(invoice.adjustedAmount ?? 0);

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
      >
        <td className="px-2 py-3 text-muted-foreground">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </td>
        <td className="px-4 py-3 font-medium">
          {invoice.clientFirstName} {invoice.clientLastName}
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {invoice.patientName || "\u2014"}
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${displayStatus.style}`}
          >
            {displayStatus.label}
          </span>
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatCurrency(invoice.total)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          <span>{formatCurrency(invoice.paidAmount)}</span>
          {adjustedAmount > 0 && (
            <span className="block text-xs text-muted-foreground">
              Adj {formatCurrency(adjustedAmount)}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {invoice.dueDate
            ? formatBillingDateInput(invoice.dueDate, billingTimeZone)
            : "\u2014"}
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {invoice.createdAt
            ? formatBillingInstantDate(invoice.createdAt, billingTimeZone)
            : "\u2014"}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-1">
            {canManageBilling && invoice.isEstimate && (
              <Button
                variant="ghost"
                size="sm"
                disabled={isMutating}
                onClick={(e) => onConvertEstimate(e, invoice.id)}
                title="Convert to Invoice"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
              </Button>
            )}
            {canManageBilling &&
              !invoice.isEstimate &&
              invoice.status === "draft" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={isMutating}
                onClick={(e) => onStatusChange(e, invoice.id, "sent")}
                title="Mark as Sent"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            )}
            {canManageBilling &&
              !invoice.isEstimate &&
              (invoice.status === "sent" || invoice.status === "overdue") && (
                <>
                  {invoice.status === "sent" ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isMutating}
                      onClick={(e) => onStatusChange(e, invoice.id, "sent")}
                      title="Mark as Sent"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </>
              )}
            {canManageBilling &&
              invoice.status !== "paid" &&
              invoice.status !== "void" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isMutating}
                  onClick={(e) => onVoidInvoice(e, invoice.id)}
                  title="Void Invoice"
                >
                  <Ban className="h-3.5 w-3.5" />
                </Button>
              )}
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-border last:border-0">
          <td colSpan={9} className="bg-muted/20 px-8 py-4" data-tour="invoice-detail">
            {detail.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading invoice details...
              </div>
            ) : detail.data ? (
              <div className="space-y-4">
                {detail.data.appointmentId ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      href={`/encounters/${encodeURIComponent(detail.data.appointmentId)}#charge-capture`}
                    >
                      Back to visit
                    </Link>
                  </Button>
                ) : null}

                {/* Estimate Approval Card */}
                {invoice.isEstimate && (
                  <div className="flex items-center justify-between rounded-lg border border-purple-200 bg-purple-50 p-4 dark:border-purple-900 dark:bg-purple-950/30">
                    <div className="flex items-center gap-2">
                      <FileText className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                      <span className="text-sm font-medium text-purple-800 dark:text-purple-300">
                        This is an estimate
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const d = detail.data!;
                          const clientName = [d.clientFirstName, d.clientLastName]
                            .filter(Boolean)
                            .join(" ");
                          const { generateInvoicePdf } = await import("@/lib/pdf");
                          generateInvoicePdf({
                            practiceName,
                            clientName,
                            clientEmail: d.clientEmail ?? undefined,
                            patientName: d.patientName ?? undefined,
                            invoiceDate: d.createdAt
                              ? formatBillingInstantDate(
                                  d.createdAt,
                                  billingTimeZone
                                )
                              : formatBillingInstantDate(
                                  new Date(),
                                  billingTimeZone
                                ),
                            dueDate: d.dueDate
                              ? formatBillingDateInput(
                                  d.dueDate,
                                  billingTimeZone
                                )
                              : undefined,
                            status: "estimate",
                            items: d.items.map((item) => ({
                              description: item.description ?? "",
                              quantity: Number(item.quantity ?? 1),
                              unitPrice: formatCurrency(item.unitPrice),
                              total: formatCurrency(item.total),
                            })),
                            subtotal: formatCurrency(d.subtotal),
                            tax: formatCurrency(d.tax),
                            total: formatCurrency(d.total),
                            paidAmount: formatCurrency(d.paidAmount),
                            balanceDue: formatCurrency(d.balanceDue),
                          }).save(`estimate-${clientName || "unknown"}.pdf`);
                        }}
                      >
                        <Download className="mr-1 h-3.5 w-3.5" />
                        Present to Client
                      </Button>
                      {canManageBilling && (
                        <Button
                          size="sm"
                          disabled={isMutating}
                          onClick={(e) => onConvertEstimate(e, invoice.id)}
                        >
                          <CheckCircle className="mr-1 h-3.5 w-3.5" />
                          Approve &amp; Convert
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-6 text-sm">
                  <span className="text-muted-foreground">
                    Client:{" "}
                    <span className="text-foreground font-medium">
                      {detail.data.clientFirstName}{" "}
                      {detail.data.clientLastName}
                    </span>
                  </span>
                  {detail.data.clientEmail && (
                    <span className="text-muted-foreground">
                      {detail.data.clientEmail}
                    </span>
                  )}
                </div>
                {detail.data.items.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="py-2 text-left font-medium text-muted-foreground">
                          Description
                        </th>
                        <th className="py-2 text-left font-medium text-muted-foreground">
                          Type
                        </th>
                        <th className="py-2 text-right font-medium text-muted-foreground">
                          Qty
                        </th>
                        <th className="py-2 text-right font-medium text-muted-foreground">
                          Unit Price
                        </th>
                        <th className="py-2 text-right font-medium text-muted-foreground">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.items.map((item) => (
                        <tr
                          key={item.id}
                          className="border-b border-border/50 last:border-0"
                        >
                          <td className="py-2">{item.description}</td>
                          <td className="py-2 capitalize text-muted-foreground">
                            {item.itemType} · {item.taxable ? "taxable" : "not taxable"}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {item.quantity}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {formatCurrency(item.unitPrice)}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {formatCurrency(item.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border">
                        <td colSpan={4} className="py-2 text-right font-medium">
                          Subtotal
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatCurrency(detail.data.subtotal)}
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={4} className="py-1 text-right text-muted-foreground">
                          Tax
                        </td>
                        <td className="py-1 text-right tabular-nums text-muted-foreground">
                          {formatCurrency(detail.data.tax)}
                        </td>
                      </tr>
                      <tr className="font-semibold">
                        <td colSpan={4} className="py-2 text-right">
                          Total
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatCurrency(detail.data.total)}
                        </td>
                      </tr>
                    </tfoot>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No line items on this invoice.
                  </p>
                )}

                {/* Balance Summary */}
                {!invoice.isEstimate && (
                  <div className="flex items-center justify-between rounded-lg border border-border bg-background p-3 text-sm">
                    <div className="flex items-center gap-6">
                      <span>
                        Total:{" "}
                        <span className="font-semibold">
                          {formatCurrency(detail.data.total)}
                        </span>
                      </span>
                      <span>
                        Paid:{" "}
                        <span className="font-semibold text-green-600">
                          {formatCurrency(detail.data.paidAmount)}
                        </span>
                      </span>
                      {Number(detail.data.adjustedAmount ?? 0) > 0 && (
                        <span>
                          Adjusted:{" "}
                          <span className="font-semibold text-teal-600">
                            {formatCurrency(detail.data.adjustedAmount)}
                          </span>
                        </span>
                      )}
                      <span>
                        Balance:{" "}
                        <span className="font-semibold text-red-600">
                          {formatCurrency(detail.data.balanceDue)}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const d = detail.data!;
                          const clientName = [d.clientFirstName, d.clientLastName]
                            .filter(Boolean)
                            .join(" ");
                          const { generateInvoicePdf } = await import("@/lib/pdf");
                          generateInvoicePdf({
                            practiceName,
                            clientName,
                            clientEmail: d.clientEmail ?? undefined,
                            patientName: d.patientName ?? undefined,
                            invoiceDate: d.createdAt
                              ? formatBillingInstantDate(
                                  d.createdAt,
                                  billingTimeZone
                                )
                              : formatBillingInstantDate(
                                  new Date(),
                                  billingTimeZone
                                ),
                            dueDate: d.dueDate
                              ? formatBillingDateInput(
                                  d.dueDate,
                                  billingTimeZone
                                )
                              : undefined,
                            status: d.status,
                            items: d.items.map((item) => ({
                              description: item.description ?? "",
                              quantity: Number(item.quantity ?? 1),
                              unitPrice: formatCurrency(item.unitPrice),
                              total: formatCurrency(item.total),
                            })),
                            subtotal: formatCurrency(d.subtotal),
                            tax: formatCurrency(d.tax),
                            total: formatCurrency(d.total),
                            paidAmount: formatCurrency(d.paidAmount),
                            balanceDue: formatCurrency(d.balanceDue),
                          }).save(`invoice-${clientName || "unknown"}.pdf`);
                        }}
                      >
                        <Download className="mr-1 h-3.5 w-3.5" />
                        Download PDF
                      </Button>
                      {canManageBilling &&
                        (invoice.status === "sent" ||
                          invoice.status === "overdue") && (
                        <EmailInvoiceButton invoiceId={invoice.id} />
                      )}
                    </div>
                  </div>
                )}

                {/* Payment History & Record Payment */}
                {!invoice.isEstimate && (
                  <PaymentSection
                    invoiceId={invoice.id}
                    invoicePaidAmount={detail.data.paidAmount}
                    invoiceAdjustedAmount={detail.data.adjustedAmount}
                    invoiceBalanceDue={detail.data.balanceDue}
                    invoiceDueDate={detail.data.dueDate}
                    invoiceStatus={invoice.status}
                    billingTimeZone={billingTimeZone}
                    canManageBilling={canManageBilling}
                  />
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Failed to load invoice details.
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function EmailInvoiceButton({ invoiceId }: { invoiceId: string }) {
  const sendInvoiceEmail = trpc.notifications.sendInvoiceEmail.useMutation({
    onSuccess: () => {
      toast.success("Invoice emailed");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={sendInvoiceEmail.isPending}
      onClick={(e) => {
        e.stopPropagation();
        sendInvoiceEmail.mutate({ invoiceId });
      }}
    >
      {sendInvoiceEmail.isPending ? (
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Mail className="mr-1 h-3.5 w-3.5" />
      )}
      Email Invoice
    </Button>
  );
}

function PaymentSection({
  invoiceId,
  invoicePaidAmount,
  invoiceAdjustedAmount,
  invoiceBalanceDue,
  invoiceDueDate,
  invoiceStatus,
  billingTimeZone,
  canManageBilling,
}: {
  invoiceId: string;
  invoicePaidAmount: string | null;
  invoiceAdjustedAmount: string | null;
  invoiceBalanceDue: string | null;
  invoiceDueDate: string | null;
  invoiceStatus: string;
  billingTimeZone?: string | null;
  canManageBilling: boolean;
}) {
  const formatCurrency = useCurrencyFormatter();
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [showAdjustmentForm, setShowAdjustmentForm] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<string>("cash");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [adjustmentType, setAdjustmentType] = useState<"credit" | "write_off">(
    "credit"
  );
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [refundTarget, setRefundTarget] = useState<{
    paymentId: string;
    amount: string;
  } | null>(null);
  const [refundReason, setRefundReason] = useState("");
  const [refundDueDate, setRefundDueDate] = useState("");
  const paymentOperationId = useRef<string | null>(null);
  const adjustmentOperationId = useRef<string | null>(null);

  const utils = trpc.useUtils();

  const paymentsQuery = trpc.billing.listPayments.useQuery({ invoiceId });
  const adjustmentsQuery = trpc.billing.listAdjustments.useQuery({ invoiceId });
  const cardPaymentStatus = trpc.billing.cardPaymentStatus.useQuery(undefined, {
    enabled: canManageBilling,
    staleTime: 60_000,
  });

  const recordPayment = trpc.billing.recordPayment.useMutation({
    onSuccess: () => {
      toast.success("Payment recorded");
      utils.billing.listPayments.invalidate({ invoiceId });
      utils.billing.listInvoices.invalidate();
      utils.billing.getInvoice.invalidate({ id: invoiceId });
      setShowPaymentForm(false);
      setPaymentAmount("");
      setPaymentMethod("cash");
      setPaymentNotes("");
      paymentOperationId.current = null;
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const applyAdjustment = trpc.billing.applyInvoiceAdjustment.useMutation({
    onSuccess: () => {
      toast.success("Invoice adjustment applied");
      utils.billing.listAdjustments.invalidate({ invoiceId });
      utils.billing.listInvoices.invalidate();
      utils.billing.getInvoice.invalidate({ id: invoiceId });
      setShowAdjustmentForm(false);
      setAdjustmentType("credit");
      setAdjustmentAmount("");
      setAdjustmentReason("");
      adjustmentOperationId.current = null;
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const cardCheckout = trpc.billing.createCardPaymentCheckout.useMutation({
    onSuccess: ({ url }) => {
      if (!isSafeCheckoutRedirectUrl(url)) {
        toast.error("Card checkout is unavailable. Please try again.");
        return;
      }
      window.location.href = url;
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const refundPayment = trpc.billing.refundPayment.useMutation({
    onSuccess: () => {
      toast.success("Payment refunded");
      setRefundTarget(null);
      setRefundReason("");
      setRefundDueDate("");
      utils.billing.listPayments.invalidate({ invoiceId });
      utils.billing.listInvoices.invalidate();
      utils.billing.getInvoice.invalidate({ id: invoiceId });
      utils.billing.arSummary.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const { data: paymentSession } = useSession();
  const canRefund = paymentSession?.user?.role === "admin";

  const remaining = Math.max(0, Number(invoiceBalanceDue ?? 0));
  const amountInputMax = Math.min(remaining, BILLING_UNIT_PRICE_MAX);
  const canCollect =
    canManageBilling &&
    (invoiceStatus === "sent" || invoiceStatus === "overdue") &&
    remaining > 0;
  const cardPaymentStatusMissing =
    canManageBilling &&
    !cardPaymentStatus.isLoading &&
    !cardPaymentStatus.error &&
    !cardPaymentStatus.data;
  const verifiedCardPaymentStatus =
    cardPaymentStatus.isLoading ||
    cardPaymentStatus.error ||
    cardPaymentStatusMissing ||
    !cardPaymentStatus.data
      ? null
      : cardPaymentStatus.data;
  const cardPaymentsEnabled = verifiedCardPaymentStatus
    ? verifiedCardPaymentStatus.enabled === true
    : false;
  const cardPaymentsUnavailable =
    cardPaymentStatus.isError ||
    cardPaymentStatusMissing ||
    (verifiedCardPaymentStatus ? !verifiedCardPaymentStatus.enabled : false);
  const canRecordPayment =
    canManageBilling &&
    isBillingAmountWithinBalance(paymentAmount, invoiceBalanceDue) &&
    paymentNotes.trim().length <= BILLING_NOTES_MAX_LENGTH &&
    !recordPayment.isPending;
  const canApplyAdjustment =
    canManageBilling &&
    isBillingAmountWithinBalance(adjustmentAmount, invoiceBalanceDue) &&
    adjustmentReason.trim().length <= BILLING_ADJUSTMENT_REASON_MAX_LENGTH &&
    !applyAdjustment.isPending;

  const handleOpenForm = () => {
    paymentOperationId.current = null;
    setPaymentAmount(remaining.toFixed(2));
    setShowPaymentForm(true);
  };

  const handleOpenAdjustmentForm = () => {
    adjustmentOperationId.current = null;
    setAdjustmentAmount(remaining.toFixed(2));
    setShowAdjustmentForm(true);
  };

  const handleRecordPayment = () => {
    if (!canRecordPayment) return;
    paymentOperationId.current ??= crypto.randomUUID();
    recordPayment.mutate({
      invoiceId,
      operationId: paymentOperationId.current,
      amount: paymentAmount.trim(),
      method: paymentMethod as any,
      notes: paymentNotes.trim() || undefined,
    });
  };

  const handleApplyAdjustment = () => {
    if (!canApplyAdjustment) return;
    adjustmentOperationId.current ??= crypto.randomUUID();
    applyAdjustment.mutate({
      invoiceId,
      operationId: adjustmentOperationId.current,
      type: adjustmentType,
      amount: adjustmentAmount.trim(),
      reason: adjustmentReason.trim() || undefined,
    });
  };

  const closeRefundDialog = () => {
    if (refundPayment.isPending) return;
    setRefundTarget(null);
    setRefundReason("");
    setRefundDueDate("");
  };

  const confirmRefund = () => {
    if (
      !refundTarget ||
      refundReason.trim().length < BILLING_ACTION_REASON_MIN_LENGTH
    ) {
      return;
    }
    refundPayment.mutate({
      paymentId: refundTarget.paymentId,
      reason: refundReason.trim(),
      dueDate: refundDueDate || undefined,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h4 className="text-sm font-medium">Payments &amp; Adjustments</h4>
        {canCollect && (
          <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleOpenForm}
            >
              <DollarSign className="mr-1 h-3.5 w-3.5" />
              Record Payment
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              disabled={
                cardCheckout.isPending ||
                cardPaymentStatus.isLoading ||
                !cardPaymentsEnabled
              }
              onClick={() => cardCheckout.mutate({ invoiceId })}
              title={
                cardPaymentsUnavailable
                  ? "Card payments are not configured"
                  : "Take card payment"
              }
            >
              {cardCheckout.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CreditCard className="mr-1 h-3.5 w-3.5" />
              )}
              Take Card
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleOpenAdjustmentForm}
            >
              <DollarSign className="mr-1 h-3.5 w-3.5" />
              Credit / Write Off
            </Button>
          </div>
        )}
      </div>

      {canCollect && cardPaymentsUnavailable && (
        <p className="text-xs text-muted-foreground">
          Card payments are not configured.
        </p>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>Paid {formatCurrency(invoicePaidAmount)}</span>
        <span>Adjusted {formatCurrency(invoiceAdjustedAmount)}</span>
        <span>Balance {formatCurrency(invoiceBalanceDue)}</span>
      </div>

      {/* Payment form */}
      {showPaymentForm && (
        <div className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Amount
              </label>
              <Input
                type="number"
                step="0.01"
                min={BILLING_PAYMENT_AMOUNT_MIN}
                max={amountInputMax}
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Method
              </label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Notes (optional)
              </label>
              <Input
                value={paymentNotes}
                maxLength={BILLING_NOTES_MAX_LENGTH}
                onChange={(e) => setPaymentNotes(e.target.value)}
                placeholder="Reference, check #, etc."
              />
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleRecordPayment}
              disabled={!canRecordPayment}
            >
              {recordPayment.isPending ? "Recording..." : "Record Payment"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                paymentOperationId.current = null;
                setShowPaymentForm(false);
              }}
            >
              Cancel
            </Button>
          </div>
          {recordPayment.isError && (
            <p className="text-xs text-destructive">
              {recordPayment.error.message}
            </p>
          )}
        </div>
      )}

      {showAdjustmentForm && (
        <div className="space-y-3 rounded-lg border border-border bg-background p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Type
              </label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={adjustmentType}
                onChange={(e) =>
                  setAdjustmentType(e.target.value as "credit" | "write_off")
                }
              >
                <option value="credit">Credit</option>
                <option value="write_off">Write-off</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Amount
              </label>
              <Input
                type="number"
                step="0.01"
                min={BILLING_PAYMENT_AMOUNT_MIN}
                max={amountInputMax}
                value={adjustmentAmount}
                onChange={(e) => setAdjustmentAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Reason
              </label>
              <Input
                value={adjustmentReason}
                maxLength={BILLING_ADJUSTMENT_REASON_MAX_LENGTH}
                onChange={(e) => setAdjustmentReason(e.target.value)}
                placeholder="Discount, courtesy, bad debt"
              />
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleApplyAdjustment}
              disabled={!canApplyAdjustment}
            >
              {applyAdjustment.isPending ? "Applying..." : "Apply Adjustment"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                adjustmentOperationId.current = null;
                setShowAdjustmentForm(false);
              }}
            >
              Cancel
            </Button>
          </div>
          {applyAdjustment.isError && (
            <p className="text-xs text-destructive">
              {applyAdjustment.error.message}
            </p>
          )}
        </div>
      )}

      {/* Payment list */}
      {paymentsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading payments...</p>
      ) : paymentsQuery.data && paymentsQuery.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 text-left font-medium text-muted-foreground">
                Date
              </th>
              <th className="py-2 text-right font-medium text-muted-foreground">
                Amount
              </th>
              <th className="py-2 text-left font-medium text-muted-foreground">
                Method
              </th>
              <th className="py-2 text-left font-medium text-muted-foreground">
                Received By
              </th>
              <th className="py-2 text-left font-medium text-muted-foreground">
                Notes
              </th>
              {canRefund && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {paymentsQuery.data.map((payment) => (
              <tr
                key={payment.id}
                className="border-b border-border/50 last:border-0"
              >
                <td className="py-2 text-muted-foreground">
                  {payment.receivedAt
                    ? formatBillingInstantDate(
                        payment.receivedAt,
                        billingTimeZone
                      )
                    : "\u2014"}
                </td>
                <td
                  className={`py-2 text-right tabular-nums font-medium ${
                    Number(payment.amount) < 0
                      ? "text-destructive"
                      : "text-green-600"
                  }`}
                >
                  {formatCurrency(payment.amount)}
                </td>
                <td className="py-2 capitalize text-muted-foreground">
                  {payment.method?.replace(/_/g, " ") ?? "\u2014"}
                </td>
                <td className="py-2 text-muted-foreground">
                  {payment.receivedByName ?? "\u2014"}
                </td>
                <td className="py-2 text-muted-foreground">
                  {payment.notes || "\u2014"}
                </td>
                {canRefund && (
                  <td className="py-2 text-right">
                    {Number(payment.amount) > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={refundPayment.isPending}
                        onClick={() => {
                          setRefundReason("");
                          setRefundDueDate(invoiceDueDate ?? "");
                          setRefundTarget({
                            paymentId: payment.id,
                            amount: payment.amount,
                          });
                        }}
                      >
                        Refund
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No payments recorded.</p>
      )}

      {adjustmentsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading adjustments...</p>
      ) : adjustmentsQuery.data && adjustmentsQuery.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 text-left font-medium text-muted-foreground">
                Date
              </th>
              <th className="py-2 text-left font-medium text-muted-foreground">
                Type
              </th>
              <th className="py-2 text-right font-medium text-muted-foreground">
                Amount
              </th>
              <th className="py-2 text-left font-medium text-muted-foreground">
                Created By
              </th>
              <th className="py-2 text-left font-medium text-muted-foreground">
                Reason
              </th>
            </tr>
          </thead>
          <tbody>
            {adjustmentsQuery.data.map((adjustment) => (
              <tr
                key={adjustment.id}
                className="border-b border-border/50 last:border-0"
              >
                <td className="py-2 text-muted-foreground">
                  {adjustment.createdAt
                    ? formatBillingInstantDate(
                        adjustment.createdAt,
                        billingTimeZone
                      )
                    : "\u2014"}
                </td>
                <td className="py-2 capitalize text-muted-foreground">
                  {adjustment.type.replace(/_/g, " ")}
                </td>
                <td className="py-2 text-right tabular-nums font-medium text-teal-600">
                  {formatCurrency(adjustment.amount)}
                </td>
                <td className="py-2 text-muted-foreground">
                  {adjustment.createdByName ?? "\u2014"}
                </td>
                <td className="py-2 text-muted-foreground">
                  {adjustment.reason || "\u2014"}
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No credits or write-offs recorded.
        </p>
      )}
      <ActionConfirmationDialog
        open={refundTarget !== null}
        title="Refund payment?"
        description={`Refund ${formatCurrency(refundTarget?.amount ?? "0")}? Card payments are refunded through Stripe.`}
        confirmLabel="Refund payment"
        confirmVariant="destructive"
        isPending={refundPayment.isPending}
        reason={{
          label: "Reason for refund",
          value: refundReason,
          onChange: setRefundReason,
          placeholder: "Explain the refund for the audit trail",
          minLength: BILLING_ACTION_REASON_MIN_LENGTH,
          maxLength: BILLING_ACTION_REASON_MAX_LENGTH,
        }}
        onCancel={closeRefundDialog}
        onConfirm={confirmRefund}
      >
        <label
          htmlFor={`refund-due-date-${invoiceId}`}
          className="text-sm font-medium"
        >
          Due date if this refund reopens the visit balance
        </label>
        <Input
          id={`refund-due-date-${invoiceId}`}
          type="date"
          className="mt-2"
          value={refundDueDate}
          disabled={refundPayment.isPending || Boolean(invoiceDueDate)}
          onChange={(event) => setRefundDueDate(event.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Required when a completed, paid visit becomes accounts receivable.
        </p>
      </ActionConfirmationDialog>
    </div>
  );
}
