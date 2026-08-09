"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  Save,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BILLING_SERVICE_CATEGORY_MAX_LENGTH,
  BILLING_SERVICE_CODE_MAX_LENGTH,
  BILLING_SERVICE_NAME_MAX_LENGTH,
  BILLING_UNIT_PRICE_MAX,
  isBillingServicePriceInputValid,
} from "@/lib/billing/policy";
import { useCurrencyFormatter } from "@/lib/locale/useCurrency";
import { trpc } from "@/lib/trpc";

type ServiceForm = {
  name: string;
  code: string;
  category: string;
  defaultPrice: string;
  taxable: boolean;
};

type ServiceRow = {
  id: string;
  name: string;
  code: string | null;
  category: string | null;
  defaultPrice: string;
  taxable: boolean;
};

const EMPTY_FORM: ServiceForm = {
  name: "",
  code: "",
  category: "",
  defaultPrice: "",
  taxable: true,
};

function formIsValid(form: ServiceForm): boolean {
  return (
    form.name.trim().length > 0 &&
    form.name.trim().length <= BILLING_SERVICE_NAME_MAX_LENGTH &&
    form.code.trim().length <= BILLING_SERVICE_CODE_MAX_LENGTH &&
    form.category.trim().length <= BILLING_SERVICE_CATEGORY_MAX_LENGTH &&
    isBillingServicePriceInputValid(form.defaultPrice)
  );
}

function mutationInput(form: ServiceForm) {
  return {
    name: form.name.trim(),
    code: form.code.trim() || undefined,
    category: form.category.trim() || undefined,
    defaultPrice: form.defaultPrice.trim(),
    taxable: form.taxable,
  };
}

function formFromService(service: ServiceRow): ServiceForm {
  return {
    name: service.name,
    code: service.code ?? "",
    category: service.category ?? "",
    defaultPrice: service.defaultPrice,
    taxable: service.taxable,
  };
}

function expectedServiceSnapshot(service: ServiceRow) {
  return mutationInput(formFromService(service));
}

type ServiceSnapshot = ReturnType<typeof expectedServiceSnapshot>;

export function ServicesTab() {
  const formatCurrency = useCurrencyFormatter();
  const utils = trpc.useUtils();
  const activeQuery = trpc.billing.listServices.useQuery();
  const archivedQuery = trpc.billing.listArchivedServices.useQuery();
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<ServiceForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ServiceForm>(EMPTY_FORM);
  const [editExpected, setEditExpected] = useState<ServiceSnapshot | null>(
    null
  );
  const [search, setSearch] = useState("");

  const resetEditState = () => {
    setEditingId(null);
    setEditForm(EMPTY_FORM);
    setEditExpected(null);
  };

  const refreshCatalog = async () => {
    await Promise.all([
      utils.billing.listServices.invalidate(),
      utils.billing.listArchivedServices.invalidate(),
    ]);
  };

  const handleMutationError = (error: { message: string }) => {
    void refreshCatalog();
    toast.error(error.message);
  };

  const createMutation = trpc.billing.createService.useMutation({
    onSuccess: () => {
      void refreshCatalog();
      setCreateForm(EMPTY_FORM);
      setShowCreate(false);
      toast.success("Service created");
    },
    onError: handleMutationError,
  });
  const updateMutation = trpc.billing.updateService.useMutation({
    onSuccess: () => {
      void refreshCatalog();
      resetEditState();
      toast.success("Service updated");
    },
    onError: (error) => {
      if (error.data?.code === "CONFLICT") {
        resetEditState();
      }
      handleMutationError(error);
    },
  });
  const archiveMutation = trpc.billing.archiveService.useMutation({
    onSuccess: () => {
      void refreshCatalog();
      resetEditState();
      toast.success("Service archived");
    },
    onError: handleMutationError,
  });
  const restoreMutation = trpc.billing.restoreService.useMutation({
    onSuccess: () => {
      void refreshCatalog();
      toast.success("Service restored");
    },
    onError: handleMutationError,
  });

  const services = activeQuery.data as ServiceRow[] | undefined;
  const archivedServices = archivedQuery.data as ServiceRow[] | undefined;
  const availableServices = services ?? [];
  const availableArchivedServices = archivedServices ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredServices = useMemo(() => {
    if (!normalizedSearch) return availableServices;
    return availableServices.filter((service) =>
      [service.name, service.code, service.category].some((value) =>
        value?.toLocaleLowerCase().includes(normalizedSearch)
      )
    );
  }, [availableServices, normalizedSearch]);

  const isLoading = activeQuery.isLoading || archivedQuery.isLoading;
  const loadError = activeQuery.error ?? archivedQuery.error;
  const dataMissing =
    !isLoading && !loadError && (!services || !archivedServices);
  const mutationPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    archiveMutation.isPending ||
    restoreMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || dataMissing) {
    return (
      <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Unable to load services</p>
            <p className="mt-1">
              {loadError?.message ??
                "The service catalog request finished without returning data."}
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => {
                void activeQuery.refetch();
                void archivedQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ReceiptText className="h-5 w-5" /> Services &amp; Pricing
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage the services available in encounter and invoice charge
            pickers. Mark each service taxable according to your local rules;
            invoices preserve that choice as a historical snapshot.
          </p>
        </div>
        <Button
          size="sm"
          disabled={mutationPending}
          onClick={() => setShowCreate((visible) => !visible)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add service
        </Button>
      </div>

      {showCreate && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">New service</h3>
          <ServiceFields form={createForm} onChange={setCreateForm} />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!formIsValid(createForm) || mutationPending}
              onClick={() => createMutation.mutate(mutationInput(createForm))}
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create service
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={mutationPending}
              onClick={() => {
                setCreateForm(EMPTY_FORM);
                setShowCreate(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          aria-label="Search services"
          className="pl-9"
          placeholder="Search name, code, or category"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Service</th>
              <th className="px-4 py-3 text-left font-medium">Code</th>
              <th className="px-4 py-3 text-left font-medium">Category</th>
              <th className="px-4 py-3 text-right font-medium">Price</th>
              <th className="px-4 py-3 text-left font-medium">Tax</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredServices.map((service) => {
              const isEditing = editingId === service.id;
              if (isEditing) {
                return (
                  <tr
                    key={service.id}
                    className="border-b border-border last:border-0"
                  >
                    <td colSpan={6} className="space-y-3 p-4">
                      <ServiceFields form={editForm} onChange={setEditForm} />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={
                            !editExpected ||
                            !formIsValid(editForm) ||
                            mutationPending
                          }
                          onClick={() => {
                            if (!editExpected) return;
                            updateMutation.mutate({
                              id: service.id,
                              expected: editExpected,
                              ...mutationInput(editForm),
                            });
                          }}
                        >
                          {updateMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Save className="mr-2 h-4 w-4" />
                          )}
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={mutationPending}
                          onClick={resetEditState}
                        >
                          <X className="mr-2 h-4 w-4" /> Cancel
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr
                  key={service.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3 font-medium">{service.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {service.code || "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {service.category || "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCurrency(service.defaultPrice)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {service.taxable ? "Taxable" : "Not taxable"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        aria-label={`Edit ${service.name}`}
                        size="icon"
                        variant="ghost"
                        disabled={mutationPending}
                        onClick={() => {
                          setEditingId(service.id);
                          setEditForm(formFromService(service));
                          setEditExpected(expectedServiceSnapshot(service));
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        aria-label={`Archive ${service.name}`}
                        size="icon"
                        variant="ghost"
                        disabled={mutationPending}
                        onClick={() => {
                          const confirmed = window.confirm(
                            `Archive ${service.name}? It will be removed from future charge pickers. Existing invoices stay unchanged, and treatment templates that reference it must be updated before use.`
                          );
                          if (!confirmed) return;
                          archiveMutation.mutate({
                            id: service.id,
                            expected: expectedServiceSnapshot(service),
                          });
                        }}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {availableServices.length === 0 && (
              <tr>
                <td colSpan={6} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent p-8"
                    icon={ReceiptText}
                    title="No services configured"
                    description="Add your first service so the clinic can capture charges during encounters and invoicing."
                  />
                </td>
              </tr>
            )}
            {availableServices.length > 0 && filteredServices.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No services match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Archived services ({availableArchivedServices.length})
        </summary>
        <div className="border-t border-border">
          {availableArchivedServices.length === 0 ? (
            <p className="px-4 py-5 text-sm text-muted-foreground">
              No archived services.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {availableArchivedServices.map((service) => (
                <div
                  key={service.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">{service.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[service.code, service.category]
                        .filter(Boolean)
                        .join(" · ") || "No code or category"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={mutationPending}
                    onClick={() =>
                      restoreMutation.mutate({
                        id: service.id,
                        expected: expectedServiceSnapshot(service),
                      })
                    }
                  >
                    {restoreMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ArchiveRestore className="mr-2 h-4 w-4" />
                    )}
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function ServiceFields({
  form,
  onChange,
}: {
  form: ServiceForm;
  onChange: (form: ServiceForm) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(12rem,2fr)_minmax(8rem,1fr)_minmax(10rem,1fr)_9rem_auto] md:items-center">
      <Input
        aria-label="Service name"
        maxLength={BILLING_SERVICE_NAME_MAX_LENGTH}
        placeholder="Service name"
        value={form.name}
        onChange={(event) => onChange({ ...form, name: event.target.value })}
      />
      <Input
        aria-label="Service code"
        maxLength={BILLING_SERVICE_CODE_MAX_LENGTH}
        placeholder="Code (optional)"
        value={form.code}
        onChange={(event) => onChange({ ...form, code: event.target.value })}
      />
      <Input
        aria-label="Service category"
        maxLength={BILLING_SERVICE_CATEGORY_MAX_LENGTH}
        placeholder="Category (optional)"
        value={form.category}
        onChange={(event) =>
          onChange({ ...form, category: event.target.value })
        }
      />
      <Input
        aria-label="Default price"
        type="number"
        min={0}
        max={BILLING_UNIT_PRICE_MAX}
        step="0.01"
        placeholder="Price"
        value={form.defaultPrice}
        onChange={(event) =>
          onChange({ ...form, defaultPrice: event.target.value })
        }
      />
      <label className="flex min-h-10 items-center gap-2 rounded-md border border-input px-3 text-sm">
        <input
          type="checkbox"
          checked={form.taxable}
          onChange={(event) =>
            onChange({ ...form, taxable: event.target.checked })
          }
        />
        Taxable
      </label>
    </div>
  );
}
