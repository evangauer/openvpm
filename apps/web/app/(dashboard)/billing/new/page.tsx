"use client";

import { useEffect, useState, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Plus, Trash2, ArrowLeft, Loader2, FileText } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { toast } from "sonner";
import { ServicePicker } from "@/components/billing/service-picker";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { formatCurrency } from "@/lib/locale/format";
import {
  CLIENT_SEARCH_MAX_LENGTH,
  isClientSearchInputValid,
} from "@/lib/clients/policy";
import {
  BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH,
  BILLING_INVOICE_LINE_QUANTITY_MAX,
  BILLING_INVOICE_LINE_QUANTITY_MIN,
  BILLING_INVOICE_MAX_ITEMS,
  BILLING_UNIT_PRICE_MAX,
  isBillingCurrencyAmountInputValid,
  isBillingInvoiceLineQuantityValid,
  isBillingInvoiceLineTotalValid,
  isBillingInvoiceSubtotalValid,
} from "@/lib/billing/policy";
import { centsToMoney, moneyToCents } from "@/lib/billing/invoice-balance";
import { tryCalculateInvoiceTaxTotals } from "@/lib/billing/invoice-tax";

interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: string;
  itemType: "service" | "product";
  itemId?: string;
  taxable: boolean;
}

function canManageBillingRole(role?: string | null): boolean {
  return role === "admin" || role === "front_desk";
}

function InlineQueryMessage({
  kind,
  children,
}: {
  kind: "error" | "loading" | "muted";
  children: ReactNode;
}) {
  return (
    <div
      className={
        kind === "error"
          ? "rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
          : "flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
      }
    >
      {kind === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </div>
  );
}

function addDateInputDays(dateInput: string, days: number): string {
  const [year, month, day] = dateInput.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function defaultDueDate(timeZone?: string | null): string {
  const today = formatDateInputForTimeZone(new Date(), timeZone);
  return addDateInputDays(today, 30);
}

export default function NewInvoicePage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-3xl">
        <InlineQueryMessage kind="loading">
          Checking billing access...
        </InlineQueryMessage>
      </div>
    );
  }

  if (!canManageBillingRole(session?.user?.role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4"
          onClick={() => router.push("/billing")}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to Billing
        </Button>
        <EmptyState
          icon={FileText}
          title="Billing actions are read-only"
          description="Only admins and front desk staff can create invoices or estimates."
          action={{
            label: "Back to Billing",
            onClick: () => router.push("/billing"),
          }}
        />
      </div>
    );
  }

  return <NewInvoiceForm />;
}

function NewInvoiceForm() {
  const router = useRouter();

  // Client search
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState<{
    id: string;
    firstName: string;
    lastName: string;
  } | null>(null);

  // Patient
  const [selectedPatientId, setSelectedPatientId] = useState<string>("");

  // Line items
  const [items, setItems] = useState<LineItem[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [itemQuantity, setItemQuantity] = useState(1);
  const [itemUnitPrice, setItemUnitPrice] = useState("");

  // Estimate toggle
  const [isEstimate, setIsEstimate] = useState(false);

  // Due date
  const [dueDate, setDueDate] = useState("");
  const [dueDateTouched, setDueDateTouched] = useState(false);
  const trimmedClientSearch = clientSearch.trim();
  const canSearchClients = isClientSearchInputValid(clientSearch);

  // Queries
  const clientResults = trpc.clients.search.useQuery(
    { query: trimmedClientSearch },
    { enabled: canSearchClients }
  );
  const clientResultsMissing =
    canSearchClients &&
    !selectedClient &&
    !clientResults.isLoading &&
    !clientResults.error &&
    !clientResults.data;
  const clientOptions =
    clientResults.data && !clientResults.error && !clientResultsMissing
      ? clientResults.data
      : [];

  const patientResults = trpc.billing.patientsByClient.useQuery(
    { clientId: selectedClient?.id ?? "" },
    { enabled: !!selectedClient }
  );
  const patientResultsMissing =
    Boolean(selectedClient) &&
    !patientResults.isLoading &&
    !patientResults.error &&
    !patientResults.data;
  const patientOptions =
    patientResults.data && !patientResults.error && !patientResultsMissing
      ? patientResults.data
      : [];

  const servicesQuery = trpc.billing.listServices.useQuery();
  const servicesMissing =
    !servicesQuery.isLoading && !servicesQuery.error && !servicesQuery.data;
  const serviceOptions =
    servicesQuery.data && !servicesQuery.error && !servicesMissing
      ? servicesQuery.data
      : [];
  const taxConfigQuery = trpc.billing.getTaxConfig.useQuery();
  const taxConfig = taxConfigQuery.data;
  const taxConfigMissing =
    !taxConfigQuery.isLoading && !taxConfigQuery.error && !taxConfig;
  const taxConfigReady = taxConfig !== undefined && !taxConfigQuery.error;

  useEffect(() => {
    if (!dueDateTouched && taxConfigReady && taxConfig) {
      setDueDate(defaultDueDate(taxConfig.timezone));
    }
  }, [dueDateTouched, taxConfig, taxConfigReady]);

  // Mutation
  const utils = trpc.useUtils();
  const createInvoice = trpc.billing.createInvoice.useMutation({
    onSuccess: () => {
      toast.success("Invoice created");
      utils.billing.listInvoices.invalidate();
      router.push("/billing");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // Calculations — preview only; the server recomputes tax authoritatively
  // from the practice's configured (region-aware) rate.
  const taxPercent =
    taxConfigReady && taxConfig ? taxConfig.taxRatePercent : "0.00";
  const currency = taxConfigReady && taxConfig ? taxConfig.currency : "usd";
  const country = taxConfigReady && taxConfig ? taxConfig.country : "US";
  const fmt = (v: number | string | null | undefined) =>
    formatCurrency(v, currency, country);
  const previewTotals = useMemo(
    () =>
      tryCalculateInvoiceTaxTotals(
      items.map((item) => ({
        lineTotalCents: item.quantity * moneyToCents(item.unitPrice || "0"),
        taxable: item.taxable,
      })),
      taxPercent,
      ),
    [items, taxPercent],
  );
  const subtotal = centsToMoney(previewTotals?.subtotalCents ?? 0);
  const tax = centsToMoney(previewTotals?.taxCents ?? 0);
  const total = centsToMoney(previewTotals?.totalCents ?? 0);
  const trimmedItemDescription = itemDescription.trim();
  const isDraftLineItemValid =
    trimmedItemDescription.length > 0 &&
    trimmedItemDescription.length <=
      BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH &&
    isBillingInvoiceLineQuantityValid(itemQuantity) &&
    isBillingCurrencyAmountInputValid(itemUnitPrice) &&
    isBillingInvoiceLineTotalValid(itemUnitPrice, itemQuantity);
  const canAddItem =
    isDraftLineItemValid &&
    items.length < BILLING_INVOICE_MAX_ITEMS &&
    !servicesQuery.isLoading &&
    !servicesQuery.error &&
    !servicesMissing;
  const canSubmitInvoice =
    Boolean(selectedClient) &&
    dueDate.trim().length > 0 &&
    items.length > 0 &&
    items.length <= BILLING_INVOICE_MAX_ITEMS &&
    isBillingInvoiceSubtotalValid(items) &&
    Boolean(previewTotals) &&
    !createInvoice.isPending;

  function handleServiceSelect(serviceId: string) {
    setSelectedServiceId(serviceId);
    const service = serviceOptions.find((s) => s.id === serviceId);
    if (service) {
      setItemDescription(service.name);
      setItemUnitPrice(service.defaultPrice);
    }
  }

  function handleAddItem() {
    if (!canAddItem) return;
    const service = serviceOptions.find((s) => s.id === selectedServiceId);
    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        description: trimmedItemDescription,
        quantity: itemQuantity,
        unitPrice: itemUnitPrice.trim(),
        itemType: "service",
        itemId: service?.id,
        taxable: service?.taxable ?? true,
      },
    ]);
    setSelectedServiceId("");
    setItemDescription("");
    setItemQuantity(1);
    setItemUnitPrice("");
  }

  function handleRemoveItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function handleSubmit() {
    if (!selectedClient || items.length === 0) return;
    createInvoice.mutate({
      clientId: selectedClient.id,
      patientId: selectedPatientId || undefined,
      items: items.map((item) => ({
        description: item.description.trim(),
        quantity: item.quantity,
        unitPrice: item.unitPrice.trim(),
        itemType: item.itemType,
        itemId: item.itemId,
      })),
      dueDate: dueDate || undefined,
      isEstimate,
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Button
        variant="ghost"
        size="sm"
        className="mb-4"
        onClick={() => router.push("/billing")}
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        Back to Billing
      </Button>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">
            {isEstimate ? "New Estimate" : "New Invoice"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isEstimate
              ? "Create an estimate that can be converted to an invoice later."
              : "Create a new invoice for a client."}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={isEstimate}
            onChange={(e) => setIsEstimate(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span className="font-medium">Estimate</span>
        </label>
      </div>

      {/* Client Search */}
      <div className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Client *</label>
          {selectedClient ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {selectedClient.firstName} {selectedClient.lastName}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedClient(null);
                  setSelectedPatientId("");
                  setClientSearch("");
                }}
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="relative">
              <Input
                placeholder="Search clients..."
                value={clientSearch}
                maxLength={CLIENT_SEARCH_MAX_LENGTH}
                onChange={(e) => setClientSearch(e.target.value)}
              />
              {canSearchClients &&
                (clientResults.isLoading ||
                  clientResults.error ||
                  clientResultsMissing ||
                  clientResults.data) && (
                <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-background shadow-lg">
                  {clientResults.error || clientResultsMissing ? (
                    <div className="px-4 py-3 text-sm text-destructive">
                      {clientResults.error?.message ??
                        "Unable to search clients. Please retry."}
                    </div>
                  ) : clientResults.isLoading ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Searching clients...
                    </div>
                  ) : clientOptions.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-muted-foreground">
                      No clients found
                    </div>
                  ) : (
                    clientOptions.map((client) => (
                      <button
                        key={client.id}
                        type="button"
                        className="w-full px-4 py-2 text-left text-sm hover:bg-muted/50 transition-colors"
                        onClick={() => {
                          setSelectedClient({
                            id: client.id,
                            firstName: client.firstName,
                            lastName: client.lastName,
                          });
                          setClientSearch("");
                        }}
                      >
                        <span className="font-medium">
                          {client.firstName} {client.lastName}
                        </span>
                        {client.email && (
                          <span className="ml-2 text-muted-foreground">
                            {client.email}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Patient Select */}
        {selectedClient && (
          <div>
            <label className="block text-sm font-medium mb-1">
              Patient (optional)
            </label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedPatientId}
              onChange={(e) => setSelectedPatientId(e.target.value)}
            >
              <option value="">-- No patient --</option>
              {patientOptions.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name} ({patient.species})
                </option>
              ))}
            </select>
            {patientResults.error || patientResultsMissing ? (
              <InlineQueryMessage kind="error">
                {patientResults.error
                  ? `Unable to load client patients. ${patientResults.error.message}`
                  : "Unable to load client patients. Please retry."}
              </InlineQueryMessage>
            ) : patientResults.isLoading ? (
              <div className="mt-2">
                <InlineQueryMessage kind="loading">
                  Loading client patients...
                </InlineQueryMessage>
              </div>
            ) : null}
          </div>
        )}

        {/* Add Line Item */}
        <div>
          <label className="block text-sm font-medium mb-1">Line Items</label>
          <div className="rounded-lg border border-border p-4 space-y-3">
            {servicesQuery.error || servicesMissing ? (
              <InlineQueryMessage kind="error">
                {servicesQuery.error
                  ? `Unable to load billing services. ${servicesQuery.error.message}`
                  : "Unable to load billing services. Please retry."}
              </InlineQueryMessage>
            ) : servicesQuery.isLoading ? (
              <InlineQueryMessage kind="loading">
                Loading billing services...
              </InlineQueryMessage>
            ) : null}
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-4">
                <ServicePicker
                  services={serviceOptions}
                  value={selectedServiceId}
                  onSelect={handleServiceSelect}
                  disabled={
                    servicesQuery.isLoading ||
                    !!servicesQuery.error ||
                    servicesMissing
                  }
                />
              </div>
              <div className="col-span-3">
                <Input
                  placeholder="Description"
                  value={itemDescription}
                  maxLength={BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH}
                  onChange={(e) => setItemDescription(e.target.value)}
                />
              </div>
              <div className="col-span-1">
                <Input
                  type="number"
                  min={BILLING_INVOICE_LINE_QUANTITY_MIN}
                  max={BILLING_INVOICE_LINE_QUANTITY_MAX}
                  step={1}
                  placeholder="Qty"
                  value={itemQuantity}
                  onChange={(e) =>
                    setItemQuantity(Math.max(1, parseInt(e.target.value) || 1))
                  }
                />
              </div>
              <div className="col-span-2">
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  max={BILLING_UNIT_PRICE_MAX}
                  placeholder="Unit Price"
                  value={itemUnitPrice}
                  onChange={(e) => setItemUnitPrice(e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={handleAddItem}
                  disabled={!canAddItem}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Add
                </Button>
              </div>
            </div>

            {/* Item list */}
            {items.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="py-2 text-left font-medium text-muted-foreground">
                        Description
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
                      <th className="py-2 w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.id}
                        className="border-b border-border/50 last:border-0"
                      >
                        <td className="py-2">
                          {item.description}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {item.taxable ? "Taxable" : "Not taxable"}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {item.quantity}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {fmt(item.unitPrice)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {fmt(item.quantity * parseFloat(item.unitPrice))}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive transition-colors"
                            onClick={() => handleRemoveItem(item.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Totals */}
        {items.length > 0 && (
          <div className="rounded-lg border border-border p-4 space-y-1 text-sm">
            {!previewTotals && taxConfigReady ? (
              <div className="mb-3">
                <InlineQueryMessage kind="error">
                  Set the practice tax rate between 0 and 100% and keep the
                  invoice total within the supported currency range before
                  creating this invoice.
                </InlineQueryMessage>
              </div>
            ) : taxConfigQuery.error || taxConfigMissing ? (
              <div className="mb-3">
                <InlineQueryMessage kind="error">
                  Unable to load practice tax settings. Preview totals omit tax
                  until settings load.
                </InlineQueryMessage>
              </div>
            ) : taxConfigQuery.isLoading ? (
              <div className="mb-3">
                <InlineQueryMessage kind="loading">
                  Loading practice tax settings...
                </InlineQueryMessage>
              </div>
            ) : null}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">{fmt(subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tax ({taxPercent}%)</span>
              <span className="tabular-nums">{fmt(tax)}</span>
            </div>
            <div className="flex justify-between font-semibold border-t border-border pt-1">
              <span>Total</span>
              <span className="tabular-nums">{fmt(total)}</span>
            </div>
          </div>
        )}

        {/* Due Date */}
        <div>
          <label className="block text-sm font-medium mb-1">Due Date</label>
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => {
              setDueDateTouched(true);
              setDueDate(e.target.value);
            }}
          />
          {!dueDate && taxConfigQuery.isLoading ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Loading practice date settings...
            </p>
          ) : null}
          {!dueDate && (taxConfigQuery.error || taxConfigMissing) ? (
            <p className="mt-1 text-xs text-destructive">
              Choose a due date manually. Practice settings could not load.
            </p>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <Button
            onClick={handleSubmit}
            disabled={
              !canSubmitInvoice
            }
          >
            {createInvoice.isPending
              ? "Creating..."
              : isEstimate
              ? "Create Estimate"
              : "Create Invoice"}
          </Button>
          <Button variant="outline" onClick={() => router.push("/billing")}>
            Cancel
          </Button>
        </div>

        {createInvoice.isError && (
          <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            {createInvoice.error.message}
          </div>
        )}
      </div>
    </div>
  );
}
