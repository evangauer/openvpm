"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  Check,
  ClipboardList,
  FileText,
  Loader2,
  Package,
  Plus,
  Receipt,
  Stethoscope,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { formatCurrency } from "@/lib/locale/format";
import {
  BILLING_INVOICE_MAX_ITEMS,
  isBillingInvoiceLineTotalValid,
  isBillingInvoiceSubtotalValid,
} from "@/lib/billing/policy";
import { ServicePicker } from "@/components/billing/service-picker";
import { CapturePhotos } from "@/components/records/capture-photos";
import { ConsentSign } from "@/components/records/consent-sign";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";

type ChargeItem = {
  key: string;
  description: string;
  quantity: number;
  unitPrice: string;
  itemType: "service" | "product";
  itemId?: string;
};

const APPOINTMENT_STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  in_exam: "In exam",
  checked_out: "Checked out",
  no_show: "No show",
  cancelled: "Cancelled",
};

function canManageVisit(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function canCreateSoap(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

function canManageBilling(role?: string | null): boolean {
  return role === "admin" || role === "front_desk";
}

function nextVisitAction(status: string): {
  label: string;
  status: "checked_in" | "in_exam" | "checked_out";
} | null {
  if (status === "scheduled" || status === "confirmed") {
    return { label: "Check in", status: "checked_in" };
  }
  if (status === "checked_in") {
    return { label: "Start exam", status: "in_exam" };
  }
  if (status === "in_exam") {
    return { label: "Check out", status: "checked_out" };
  }
  return null;
}

function formatAppointmentTime(
  value: Date | string,
  timeZone?: string | null
): string {
  try {
    return new Date(value).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return new Date(value).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
}

function EncounterLoading() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-12 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading visit workspace...
    </div>
  );
}

export default function EncounterWorkspacePage() {
  const params = useParams<{ appointmentId: string }>();
  const { data: session, status: sessionStatus } = useSession();
  const appointmentId = params.appointmentId;
  const utils = trpc.useUtils();

  const appointmentQuery = trpc.appointments.getById.useQuery(
    { id: appointmentId },
    { enabled: Boolean(appointmentId) }
  );
  const appointment = appointmentQuery.data;
  const patientQuery = trpc.patients.getById.useQuery(
    { id: appointment?.patientId ?? "" },
    { enabled: Boolean(appointment?.patientId) }
  );
  const taxConfigQuery = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const invoicesQuery = trpc.billing.listInvoices.useQuery(
    { appointmentId, limit: 25, offset: 0 },
    { enabled: Boolean(appointmentId) }
  );

  const updateStatus = trpc.appointments.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("Visit status updated");
      utils.appointments.getById.invalidate({ id: appointmentId });
      utils.appointments.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  if (sessionStatus === "loading" || appointmentQuery.isLoading) {
    return <EncounterLoading />;
  }

  if (appointmentQuery.error || !appointment) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Unable to load this visit"
        description={
          appointmentQuery.error?.message ??
          "The appointment may have been removed or belongs to another clinic."
        }
        action={{
          label: "Back to schedule",
          onClick: () => window.location.assign("/schedule"),
          icon: ArrowLeft,
        }}
      />
    );
  }

  const role = session?.user?.role;
  const patient = patientQuery.data;
  const clientName = [appointment.clientFirstName, appointment.clientLastName]
    .filter(Boolean)
    .join(" ");
  const nextAction = nextVisitAction(appointment.status);
  const activeInvoices =
    invoicesQuery.data?.items.filter(
      (invoice) => !invoice.isEstimate && invoice.status !== "void"
    ) ?? [];
  const visitInvoices = invoicesQuery.data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/schedule">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to schedule
          </Link>
        </Button>
      </div>

      <header className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Stethoscope className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-2xl font-semibold">
                {appointment.patientName ?? "Unassigned visit"}
              </h1>
              <Badge variant="outline">
                {APPOINTMENT_STATUS_LABELS[appointment.status] ??
                  appointment.status}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {appointment.typeName ?? "Appointment"} ·{" "}
              {clientName || "No client"}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4" />
                {formatAppointmentTime(
                  appointment.startTime,
                  taxConfigQuery.data?.timezone
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="h-4 w-4" />
                {appointment.doctorName
                  ? `Dr. ${appointment.doctorName}`
                  : "Unassigned provider"}
              </span>
              {appointment.roomName ? (
                <span>{appointment.roomName}</span>
              ) : null}
            </div>
          </div>
        </div>
        {nextAction && canManageVisit(role) ? (
          <Button
            disabled={updateStatus.isPending}
            onClick={() =>
              updateStatus.mutate({
                id: appointmentId,
                status: nextAction.status,
              })
            }
          >
            {updateStatus.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            {nextAction.label}
          </Button>
        ) : null}
      </header>

      {appointment.notes ? (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
          <span className="font-medium">Visit note:</span> {appointment.notes}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Clinical work</CardTitle>
              <CardDescription>
                Document and capture visit work without losing the appointment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!appointment.patientId ? (
                <EmptyState
                  icon={UserRound}
                  title="Attach a patient first"
                  description="Clinical documentation and billing need a patient and client on the appointment."
                  className="p-8"
                />
              ) : patientQuery.error ||
                (!patientQuery.isLoading && !patient) ? (
                <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
                  Unable to load the patient chart. Refresh before documenting.
                </div>
              ) : patientQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading patient context...
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="rounded-md border border-border bg-muted/20 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{patient?.name}</p>
                        <p className="text-sm capitalize text-muted-foreground">
                          {[patient?.species, patient?.breed]
                            .filter(Boolean)
                            .join(" · ") || "Patient details unavailable"}
                        </p>
                      </div>
                      {patient?.allergies.length ? (
                        <Badge variant="destructive">
                          {patient.allergies.length} allerg
                          {patient.allergies.length === 1 ? "y" : "ies"}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">No recorded allergies</Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {canCreateSoap(role) ? (
                      <Button size="sm" asChild>
                        <Link
                          href={`/records/new-soap/${appointment.patientId}?appointmentId=${appointmentId}`}
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Write SOAP note
                        </Link>
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/patients/${appointment.patientId}`}>
                        <ClipboardList className="mr-2 h-4 w-4" />
                        Open patient chart
                      </Link>
                    </Button>
                    {canManageVisit(role) ? (
                      <>
                        <CapturePhotos
                          patientId={appointment.patientId}
                          appointmentId={appointmentId}
                        />
                        <ConsentSign
                          patientId={appointment.patientId}
                          appointmentId={appointmentId}
                        />
                      </>
                    ) : null}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    SOAP notes created here are linked to this appointment.
                    Photos and signatures captured during an open visit attach
                    to the active visit automatically.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <EncounterInvoices
            appointmentId={appointmentId}
            invoicesQuery={invoicesQuery}
            visitInvoices={visitInvoices}
            canManage={canManageBilling(role)}
          />
        </div>

        <ChargeCapture
          appointmentId={appointmentId}
          clientId={appointment.clientId}
          patientId={appointment.patientId}
          canManage={canManageBilling(role)}
          activeInvoice={
            activeInvoices[0]
              ? {
                  id: activeInvoices[0].id,
                  status: activeInvoices[0].status,
                }
              : null
          }
          invoiceStateReady={
            Boolean(invoicesQuery.data) && !invoicesQuery.error
          }
          invoiceStateLoading={invoicesQuery.isLoading}
        />
      </div>
    </div>
  );
}

function EncounterInvoices({
  appointmentId,
  invoicesQuery,
  visitInvoices,
  canManage,
}: {
  appointmentId: string;
  invoicesQuery: ReturnType<typeof trpc.billing.listInvoices.useQuery>;
  visitInvoices: Array<{
    id: string;
    status: string;
    total: string;
    paidAmount: string;
    adjustedAmount: string;
    isEstimate: boolean;
  }>;
  canManage: boolean;
}) {
  const fmt = useCurrencyFormatterWithConfig();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice state</CardTitle>
        <CardDescription>
          Charges and payment status linked directly to this visit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {invoicesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading visit invoices...
          </div>
        ) : invoicesQuery.error || !invoicesQuery.data ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Unable to load invoice state. Do not create duplicate charges until
            this is resolved.
          </div>
        ) : visitInvoices.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No active invoice for this visit"
            description={
              canManage
                ? "Add all known services and products in Charge capture to create a visit-linked draft."
                : "An admin or front desk teammate can create this visit's charges."
            }
            className="p-8"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {visitInvoices.map((invoice) => {
              const paid = Number(invoice.paidAmount ?? 0);
              const adjusted = Number(invoice.adjustedAmount ?? 0);
              const balance = Math.max(
                0,
                Number(invoice.total ?? 0) - paid - adjusted
              );
              return (
                <div
                  key={invoice.id}
                  className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">
                        {invoice.isEstimate ? "Estimate" : "Invoice"}
                      </p>
                      <Badge
                        variant={
                          invoice.status === "paid" ? "success" : "outline"
                        }
                      >
                        {invoice.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Total {fmt(invoice.total)} · Balance {fmt(balance)}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/billing?expand=${invoice.id}`}>
                      Open invoice
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <span className="sr-only">Appointment {appointmentId}</span>
      </CardContent>
    </Card>
  );
}

function useCurrencyFormatterWithConfig() {
  const config = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  return (value: number | string | null | undefined) =>
    formatCurrency(
      value,
      config.data?.currency ?? "usd",
      config.data?.country ?? "US"
    );
}

function ChargeCapture({
  appointmentId,
  clientId,
  patientId,
  canManage,
  activeInvoice,
  invoiceStateReady,
  invoiceStateLoading,
}: {
  appointmentId: string;
  clientId: string | null;
  patientId: string | null;
  canManage: boolean;
  activeInvoice: { id: string; status: string } | null;
  invoiceStateReady: boolean;
  invoiceStateLoading: boolean;
}) {
  const utils = trpc.useUtils();
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [items, setItems] = useState<ChargeItem[]>([]);
  const [loadedInvoiceId, setLoadedInvoiceId] = useState<string | null>(null);
  const configQuery = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const configReady = Boolean(configQuery.data) && !configQuery.error;
  const activeInvoiceIsDraft = activeInvoice?.status === "draft";
  const invoiceDetailQuery = trpc.billing.getInvoice.useQuery(
    {
      id:
        activeInvoice?.id ?? "00000000-0000-0000-0000-000000000000",
    },
    { enabled: Boolean(canManage && activeInvoiceIsDraft) }
  );
  const invoiceDetailReady =
    !activeInvoice ||
    (activeInvoiceIsDraft && Boolean(invoiceDetailQuery.data));
  const servicesQuery = trpc.billing.listServices.useQuery(undefined, {
    enabled:
      canManage &&
      configReady &&
      invoiceStateReady &&
      (!activeInvoice || (activeInvoiceIsDraft && invoiceDetailReady)),
  });
  const productsQuery = trpc.billing.listProducts.useQuery(
    { limit: 100 },
    {
      enabled:
        canManage &&
        configReady &&
        invoiceStateReady &&
        (!activeInvoice || (activeInvoiceIsDraft && invoiceDetailReady)),
    }
  );

  useEffect(() => {
    if (!activeInvoice) {
      if (loadedInvoiceId) {
        setItems([]);
        setLoadedInvoiceId(null);
      }
      return;
    }
    if (
      activeInvoiceIsDraft &&
      invoiceDetailQuery.data?.id === activeInvoice.id &&
      loadedInvoiceId !== activeInvoice.id
    ) {
      setItems(
        invoiceDetailQuery.data.items.map((item) => ({
          key: item.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          itemType: item.itemType,
          itemId: item.itemId ?? undefined,
        }))
      );
      setLoadedInvoiceId(activeInvoice.id);
    }
  }, [
    activeInvoice,
    activeInvoiceIsDraft,
    invoiceDetailQuery.data,
    loadedInvoiceId,
  ]);

  const catalog = useMemo(() => {
    const services = (servicesQuery.data ?? []).map((service) => ({
      id: `service:${service.id}`,
      itemId: service.id,
      itemType: "service" as const,
      name: service.name,
      code: service.code,
      category: ["Service", service.category].filter(Boolean).join(" · "),
      defaultPrice: service.defaultPrice,
      stockQuantity: null as number | null,
    }));
    const products = (productsQuery.data ?? []).map((product) => ({
      id: `product:${product.id}`,
      itemId: product.id,
      itemType: "product" as const,
      name: product.name,
      category: `Product · ${product.stockQuantity} in stock`,
      defaultPrice: product.unitPrice,
      stockQuantity: product.stockQuantity,
    }));
    return [...services, ...products];
  }, [productsQuery.data, servicesQuery.data]);

  const selected = catalog.find((entry) => entry.id === selectedCatalogId);
  const subtotal = items.reduce(
    (sum, item) => sum + item.quantity * Number(item.unitPrice),
    0
  );
  const taxRate = Number(configQuery.data?.taxRatePercent ?? 0) / 100;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const total = subtotal + tax;
  const fmt = (value: number | string | null | undefined) =>
    formatCurrency(
      value,
      configQuery.data?.currency ?? "usd",
      configQuery.data?.country ?? "US"
    );
  const selectedHasStock =
    selected?.itemType !== "product" ||
    (selected.stockQuantity !== null && quantity <= selected.stockQuantity);
  const canAdd =
    Boolean(selected) &&
    Number.isInteger(quantity) &&
    quantity > 0 &&
    selectedHasStock &&
    items.length < BILLING_INVOICE_MAX_ITEMS;
  const canSubmit =
    Boolean(clientId && patientId) &&
    items.length > 0 &&
    items.every((item) =>
      isBillingInvoiceLineTotalValid(item.unitPrice, item.quantity)
    ) &&
    isBillingInvoiceSubtotalValid(items) &&
    configReady &&
    invoiceStateReady &&
    invoiceDetailReady &&
    (!activeInvoice || activeInvoiceIsDraft);

  const createInvoice = trpc.billing.createInvoice.useMutation({
    onSuccess: () => {
      toast.success("Visit charges saved as a draft invoice");
      setItems([]);
      setSelectedCatalogId("");
      setQuantity(1);
      utils.billing.listInvoices.invalidate({
        appointmentId,
        limit: 25,
        offset: 0,
      });
    },
    onError: (error) => toast.error(error.message),
  });
  const updateInvoiceItems = trpc.billing.updateInvoiceItems.useMutation({
    onSuccess: () => {
      toast.success("Visit invoice charges updated");
      utils.billing.listInvoices.invalidate({
        appointmentId,
        limit: 25,
        offset: 0,
      });
      if (activeInvoice) {
        utils.billing.getInvoice.invalidate({ id: activeInvoice.id });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const isSaving = createInvoice.isPending || updateInvoiceItems.isPending;

  function addSelectedItem() {
    if (!selected || !canAdd) return;
    setItems((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        description: selected.name,
        quantity,
        unitPrice: selected.defaultPrice,
        itemType: selected.itemType,
        itemId: selected.itemId,
      },
    ]);
    setSelectedCatalogId("");
    setQuantity(1);
  }

  function saveCharges() {
    if (!clientId || !patientId || !canSubmit) return;
    const lineItems = items.map(
      ({ description, quantity, unitPrice, itemType, itemId }) => ({
        description,
        quantity,
        unitPrice,
        itemType,
        itemId,
      })
    );
    if (activeInvoice) {
      updateInvoiceItems.mutate({ id: activeInvoice.id, items: lineItems });
      return;
    }
    createInvoice.mutate({
      appointmentId,
      clientId,
      patientId,
      items: lineItems,
      isEstimate: false,
    });
  }

  return (
    <Card className="h-fit lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle>Charge capture</CardTitle>
        <CardDescription>
          {activeInvoiceIsDraft
            ? "Correct or add services and products before this invoice is sent."
            : "Add the services and products performed or dispensed during this visit."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!canManage ? (
          <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            Charge capture is read-only for your role. An admin or front desk
            teammate can create the invoice.
          </div>
        ) : invoiceStateLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Confirming visit invoice state...
          </div>
        ) : !invoiceStateReady ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Charge capture is locked because invoice state could not be
            confirmed. Refresh before creating charges.
          </div>
        ) : activeInvoice && !activeInvoiceIsDraft ? (
          <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            This visit invoice is already {activeInvoice.status}. Open it from
            Invoice state to collect payment or review the balance. Only unpaid
            draft charges can be edited.
          </div>
        ) : activeInvoiceIsDraft && invoiceDetailQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading existing visit charges...
          </div>
        ) : activeInvoiceIsDraft &&
          (invoiceDetailQuery.error || !invoiceDetailQuery.data) ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Existing charges could not be loaded. Refresh before editing this
            draft invoice.
          </div>
        ) : configQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading practice tax and currency settings...
          </div>
        ) : !configReady ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Charge capture is locked because tax and currency settings could not
            be confirmed. Refresh before creating charges.
          </div>
        ) : !clientId || !patientId ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Add both a client and patient to the appointment before capturing
            charges.
          </div>
        ) : servicesQuery.error || productsQuery.error ? (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
            Unable to load the charge catalog. Refresh before creating an
            invoice.
          </div>
        ) : servicesQuery.isLoading || productsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading services and products...
          </div>
        ) : catalog.length === 0 && items.length === 0 ? (
          <EmptyState
            icon={Package}
            title="Charge catalog is empty"
            description="Add services or inventory products before building a visit invoice."
            className="p-8"
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_auto] lg:grid-cols-1 xl:grid-cols-[minmax(0,1fr)_80px_auto]">
              <ServicePicker
                services={catalog}
                value={selectedCatalogId}
                onSelect={setSelectedCatalogId}
                disabled={isSaving}
                formatPrice={fmt}
              />
              <Input
                type="number"
                min={1}
                max={selected?.stockQuantity ?? undefined}
                value={quantity}
                aria-label="Charge quantity"
                aria-invalid={!selectedHasStock}
                onChange={(event) =>
                  setQuantity(Math.max(1, Number(event.target.value) || 1))
                }
              />
              <Button
                type="button"
                variant="outline"
                disabled={!canAdd || isSaving}
                onClick={addSelectedItem}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </div>

            {!selectedHasStock ? (
              <p className="text-xs font-medium text-destructive">
                Quantity exceeds available inventory.
              </p>
            ) : null}

            {items.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                No charges added yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {items.map((item) => (
                  <div
                    key={item.key}
                    className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.description}
                      </p>
                      <p className="text-xs capitalize text-muted-foreground">
                        {item.itemType}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Qty
                        <Input
                          type="number"
                          min={1}
                          max={10000}
                          value={item.quantity}
                          aria-label={`${item.description} quantity`}
                          className="w-20 text-foreground"
                          disabled={isSaving}
                          onChange={(event) =>
                            setItems((current) =>
                              current.map((candidate) =>
                                candidate.key === item.key
                                  ? {
                                      ...candidate,
                                      quantity: Math.max(
                                        1,
                                        Number(event.target.value) || 1
                                      ),
                                    }
                                  : candidate
                              )
                            )
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Unit price
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={item.unitPrice}
                          aria-label={`${item.description} unit price`}
                          className="w-28 text-foreground"
                          disabled={isSaving}
                          onChange={(event) =>
                            setItems((current) =>
                              current.map((candidate) =>
                                candidate.key === item.key
                                  ? {
                                      ...candidate,
                                      unitPrice: event.target.value,
                                    }
                                  : candidate
                              )
                            )
                          }
                        />
                      </label>
                      <span className="flex w-24 flex-col gap-1 text-right text-xs text-muted-foreground">
                        Line total
                        <span className="text-sm font-medium text-foreground tabular-nums">
                          {fmt(item.quantity * Number(item.unitPrice || 0))}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="self-end"
                        aria-label={`Remove ${item.description}`}
                        disabled={isSaving}
                        onClick={() =>
                          setItems((current) =>
                            current.filter(
                              (candidate) => candidate.key !== item.key
                            )
                          )
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {items.length > 0 ? (
              <div className="flex flex-col gap-1 rounded-md bg-muted/30 p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{fmt(subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Tax ({configQuery.data?.taxRatePercent ?? "0.00"}%)
                  </span>
                  <span>{fmt(tax)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-border pt-2 font-semibold">
                  <span>Draft total</span>
                  <span>{fmt(total)}</span>
                </div>
              </div>
            ) : null}

            <Button
              disabled={!canSubmit || isSaving}
              onClick={saveCharges}
            >
              {isSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Receipt className="mr-2 h-4 w-4" />
              )}
              {activeInvoiceIsDraft
                ? "Update visit invoice"
                : "Create visit invoice"}
            </Button>
            <p className="text-xs text-muted-foreground">
              {activeInvoiceIsDraft
                ? "Product stock is restored and re-deducted atomically when draft charges change."
                : "This creates a draft linked to the appointment. Product stock is deducted atomically when the invoice is created."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
