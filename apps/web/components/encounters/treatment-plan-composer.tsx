"use client";

import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  ClipboardList,
  Copy,
  FileCheck2,
  Link2,
  Loader2,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

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
import { formatCurrency } from "@/lib/locale/format";
import { TEMPLATE_CATALOG_SEARCH_MAX_LENGTH } from "@/lib/templates/catalog-search";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type CatalogItem = {
  id: string;
  itemType: "service" | "product";
  name: string;
  code: string | null;
  category: string | null;
  unitPrice: string;
};

type DraftLine = CatalogItem & { quantity: string };

const VALID_QUANTITY = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/;

function validQuantity(value: string): boolean {
  return VALID_QUANTITY.test(value.trim()) && Number(value) > 0;
}

function lineFingerprint(lines: DraftLine[]): string {
  return JSON.stringify(
    lines.map((line) => [line.itemType, line.id, line.quantity.trim()]),
  );
}

function TreatmentPlanCatalogPicker({
  excluded,
  enabled,
  currency,
  onSelect,
}: {
  excluded: Set<string>;
  enabled: boolean;
  currency: string;
  onSelect: (item: CatalogItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const deferredSearch = useDeferredValue(search);
  const queryIsStale = search !== deferredSearch;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const catalogQuery = trpc.visitTreatmentPlans.searchCatalog.useQuery(
    { search: deferredSearch },
    { enabled: enabled && open, retry: false },
  );
  const results = useMemo(
    () =>
      (catalogQuery.data ?? []).filter(
        (item) => !excluded.has(`${item.itemType}:${item.id}`),
      ),
    [catalogQuery.data, excluded],
  );
  const active =
    !queryIsStale && !catalogQuery.isFetching && !catalogQuery.error
      ? results[highlight]
      : undefined;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => setHighlight(0), [deferredSearch, open]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const choose = (item: CatalogItem) => {
    onSelect(item);
    setOpen(false);
    setSearch("");
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      setHighlight((current) =>
        Math.min(current + 1, Math.max(results.length - 1, 0)),
      );
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      setHighlight((current) => Math.max(current - 1, 0));
      event.preventDefault();
    } else if (event.key === "Enter") {
      if (active) choose(active);
      event.preventDefault();
    } else if (event.key === "Escape") {
      setOpen(false);
      setSearch("");
      event.preventDefault();
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="outline"
        className="w-full justify-between"
        disabled={!enabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <span className="inline-flex items-center gap-2">
          <Search className="h-4 w-4" /> Add a service or product
        </span>
        <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
      </Button>

      {open ? (
        <div className="absolute z-40 mt-1 w-full min-w-[18rem] rounded-md border border-border bg-popover shadow-lg">
          <div className="flex min-h-11 items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              role="combobox"
              aria-label="Search treatment plan catalog"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={
                active
                  ? `${listboxId}-option-${active.itemType}-${active.id}`
                  : undefined
              }
              maxLength={TEMPLATE_CATALOG_SEARCH_MAX_LENGTH}
              value={search}
              placeholder="Search name, code, or category"
              className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={handleKeyDown}
            />
            {search ? (
              <button
                type="button"
                aria-label="Clear search"
                className="rounded p-2 text-muted-foreground hover:bg-accent"
                onClick={() => {
                  setSearch("");
                  inputRef.current?.focus();
                }}
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Available services and products"
            aria-busy={queryIsStale || catalogQuery.isFetching}
            className="max-h-72 overflow-y-auto p-1"
          >
            {queryIsStale || catalogQuery.isFetching ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching...
              </div>
            ) : catalogQuery.error ? (
              <div role="alert" className="px-3 py-6 text-sm text-destructive">
                Catalog search failed. Edit the search to retry.
              </div>
            ) : results.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No active catalog items match.
              </p>
            ) : (
              results.map((item, index) => (
                <button
                  key={`${item.itemType}:${item.id}`}
                  id={`${listboxId}-option-${item.itemType}-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  data-index={index}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-sm",
                    index === highlight && "bg-accent",
                  )}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => choose(item)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {item.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.itemType === "service" ? "Service" : "Product"}
                      {[item.code, item.category].filter(Boolean).length
                        ? ` · ${[item.code, item.category].filter(Boolean).join(" · ")}`
                        : ""}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCurrency(item.unitPrice, currency)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TreatmentPlanComposer({
  appointmentId,
  clientId,
  patientId,
  patientName,
}: {
  appointmentId: string;
  clientId: string;
  patientId: string;
  patientName: string;
}) {
  const utils = trpc.useUtils();
  const [lines, setLines] = useState<DraftLine[]>([]);
  const hydratedRevision = useRef<string | null>(null);
  const savedFingerprint = useRef("");
  const operation = useRef<{ fingerprint: string; id: string } | null>(null);
  const context = { appointmentId, clientId, patientId };
  const planQuery = trpc.visitTreatmentPlans.getForAppointment.useQuery(
    context,
    {
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const plan = planQuery.data;

  useEffect(() => {
    if (!plan) {
      if (planQuery.isSuccess && hydratedRevision.current === null) {
        savedFingerprint.current = lineFingerprint([]);
      }
      return;
    }
    if (hydratedRevision.current === plan.revision.id) return;
    const hydrated = plan.lines.map((line) => ({
      id: line.serviceId ?? line.productId!,
      itemType: line.itemType,
      name: line.description,
      code: null,
      category: null,
      unitPrice: line.unitPrice,
      quantity: line.offeredQuantity,
    }));
    setLines(hydrated);
    savedFingerprint.current = lineFingerprint(hydrated);
    hydratedRevision.current = plan.revision.id;
    operation.current = null;
  }, [plan, planQuery.isSuccess]);

  const deferredLines = useDeferredValue(lines);
  const quantitiesValid = lines.every((line) => validQuantity(line.quantity));
  const quoteQuery = trpc.visitTreatmentPlans.quote.useQuery(
    {
      ...context,
      items: deferredLines.map((line) => ({
        itemType: line.itemType,
        itemId: line.id,
        quantity: line.quantity,
      })),
    },
    {
      enabled:
        planQuery.isSuccess && deferredLines.length > 0 && quantitiesValid,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const quote =
    quantitiesValid && deferredLines === lines && !quoteQuery.isFetching
      ? quoteQuery.data
      : undefined;
  const currency = quote?.currency ?? plan?.revision.currency ?? "USD";
  const fingerprint = lineFingerprint(lines);
  const hasChanges = fingerprint !== savedFingerprint.current;
  const excluded = useMemo(
    () => new Set(lines.map((line) => `${line.itemType}:${line.id}`)),
    [lines],
  );

  const createPlan = trpc.visitTreatmentPlans.create.useMutation();
  const revisePlan = trpc.visitTreatmentPlans.revise.useMutation();
  const createPresentation =
    trpc.visitTreatmentPlans.createPresentation.useMutation();
  const [presentationLink, setPresentationLink] = useState<{
    url: string;
    expiresAt: Date;
  } | null>(null);
  const saving = createPlan.isPending || revisePlan.isPending;
  const completed = plan?.plan.status === "completed";

  const operationIdFor = (payloadFingerprint: string): string => {
    if (operation.current?.fingerprint === payloadFingerprint) {
      return operation.current.id;
    }
    const next = { fingerprint: payloadFingerprint, id: crypto.randomUUID() };
    operation.current = next;
    return next.id;
  };

  const save = async () => {
    const items = lines.map((line) => ({
      itemType: line.itemType,
      itemId: line.id,
      quantity: line.quantity.trim(),
    }));
    const payloadFingerprint = `${plan?.plan.id ?? "new"}:${fingerprint}`;
    try {
      if (plan) {
        await revisePlan.mutateAsync({
          operationId: operationIdFor(payloadFingerprint),
          planId: plan.plan.id,
          expectedRevisionNumber: plan.revision.revisionNumber,
          items,
        });
      } else {
        await createPlan.mutateAsync({
          operationId: operationIdFor(payloadFingerprint),
          ...context,
          title: `${patientName} treatment plan`,
          items,
        });
      }
      operation.current = null;
      await utils.visitTreatmentPlans.getForAppointment.invalidate(context);
      toast.success(plan ? "Treatment plan updated" : "Treatment plan saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed";
      toast.error(message);
      if (/changed in another session/i.test(message)) {
        await planQuery.refetch();
      }
    }
  };

  const makePresentationLink = async () => {
    if (!plan) return;
    try {
      const result = await createPresentation.mutateAsync({
        planId: plan.plan.id,
        revisionId: plan.revision.id,
      });
      setPresentationLink({
        url: result.url,
        expiresAt: new Date(result.expiresAt),
      });
      await navigator.clipboard.writeText(result.url).catch(() => undefined);
      await utils.visitTreatmentPlans.getForAppointment.invalidate(context);
      toast.success("Client link created and copied");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not create client link",
      );
    }
  };

  if (planQuery.error?.data?.code === "NOT_FOUND") return null;
  if (planQuery.isLoading) return null;

  if (planQuery.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Treatment plan</CardTitle>
          <CardDescription>
            Treatment plans are temporarily unavailable. Refresh before adding
            one.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card id="treatment-plan" className="scroll-mt-4">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" /> Treatment plan
            </CardTitle>
            <CardDescription className="mt-1.5">
              Build the plan you’ll review with the client.
            </CardDescription>
          </div>
          {plan ? (
            <Badge variant="secondary">
              Revision {plan.revision.revisionNumber}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <TreatmentPlanCatalogPicker
          excluded={excluded}
          enabled={planQuery.isSuccess && !completed}
          currency={currency}
          onSelect={(item) =>
            setLines((current) => [...current, { ...item, quantity: "1" }])
          }
        />

        {lines.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm font-medium">No items yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Search your existing catalog to start this treatment plan.
            </p>
          </div>
        ) : (
          <div className="divide-y rounded-md border border-border">
            {lines.map((line, index) => {
              const quotedLine = quote?.lines[index];
              return (
                <div
                  key={`${line.itemType}:${line.id}`}
                  className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_5.5rem_6rem_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{line.name}</p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {line.itemType}
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor={`treatment-plan-quantity-${line.itemType}-${line.id}`}
                      className="mb-1 block text-xs text-muted-foreground sm:sr-only"
                    >
                      Quantity
                    </label>
                    <Input
                      id={`treatment-plan-quantity-${line.itemType}-${line.id}`}
                      aria-label={`Quantity for ${line.name}`}
                      inputMode="decimal"
                      value={line.quantity}
                      aria-invalid={!validQuantity(line.quantity)}
                      disabled={completed}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? { ...candidate, quantity: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                    />
                  </div>
                  <p className="text-right text-sm font-medium tabular-nums sm:text-left">
                    {quotedLine
                      ? formatCurrency(quotedLine.lineTotal, currency)
                      : quoteQuery.isFetching
                        ? "…"
                        : "—"}
                  </p>
                  <div className="flex justify-end gap-1">
                    {lines.length > 1 ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9"
                          aria-label={`Move ${line.name} up`}
                          disabled={completed || index === 0}
                          onClick={() =>
                            setLines((current) => {
                              if (index === 0) return current;
                              const next = [...current];
                              [next[index - 1], next[index]] = [
                                next[index]!,
                                next[index - 1]!,
                              ];
                              return next;
                            })
                          }
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9"
                          aria-label={`Move ${line.name} down`}
                          disabled={completed || index === lines.length - 1}
                          onClick={() =>
                            setLines((current) => {
                              if (index === current.length - 1) return current;
                              const next = [...current];
                              [next[index], next[index + 1]] = [
                                next[index + 1]!,
                                next[index]!,
                              ];
                              return next;
                            })
                          }
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                      </>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-muted-foreground hover:text-destructive"
                      disabled={completed}
                      aria-label={`Remove ${line.name}`}
                      onClick={() =>
                        setLines((current) =>
                          current.filter((_, row) => row !== index),
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {lines.some((line) => !validQuantity(line.quantity)) ? (
          <p role="alert" className="text-sm text-destructive">
            Quantities must be greater than zero with up to three decimal
            places.
          </p>
        ) : null}

        {quoteQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            {quoteQuery.error.message}
          </p>
        ) : null}

        <div className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="grid grid-cols-3 gap-x-5 gap-y-1 text-sm">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="text-muted-foreground">Tax</span>
            <span className="font-medium">Total</span>
            <span className="tabular-nums">
              {quote ? formatCurrency(quote.subtotal, currency) : "—"}
            </span>
            <span className="tabular-nums">
              {quote ? formatCurrency(quote.tax, currency) : "—"}
            </span>
            <span className="font-semibold tabular-nums">
              {quote ? formatCurrency(quote.total, currency) : "—"}
            </span>
          </div>
          <Button
            type="button"
            disabled={
              saving ||
              lines.length === 0 ||
              !quantitiesValid ||
              quoteQuery.isFetching ||
              !quote ||
              !hasChanges ||
              completed
            }
            onClick={save}
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            {plan ? "Save new revision" : "Save treatment plan"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Saving this plan does not charge the client, adjust inventory, or
          schedule care.
        </p>

        {plan?.clientDecisionsEnabled && !plan.response ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  Client review and signature
                </p>
                <p className="text-xs text-muted-foreground">
                  The link expires in one hour and is locked to revision{" "}
                  {plan.revision.revisionNumber}.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  completed ||
                  hasChanges ||
                  createPresentation.isPending ||
                  plan.activePresentation?.status === "awaiting_signature"
                }
                onClick={() => void makePresentationLink()}
              >
                {createPresentation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="mr-2 h-4 w-4" />
                )}
                {plan.activePresentation?.status === "pending"
                  ? "Replace client link"
                  : plan.activePresentation?.status === "awaiting_signature"
                    ? "Awaiting signature"
                    : "Create client link"}
              </Button>
            </div>
            {presentationLink ? (
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={presentationLink.url}
                  aria-label="Client treatment plan link"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Copy client treatment plan link"
                  onClick={() => {
                    void navigator.clipboard.writeText(presentationLink.url);
                    toast.success("Link copied");
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {plan?.response ? (
          <div className="space-y-3 rounded-md border border-teal-200 bg-teal-50/50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold text-teal-950">
                  <FileCheck2 className="h-4 w-4" /> Client response signed
                </p>
                <p className="mt-1 text-xs text-teal-900/70">
                  {plan.response.signerName} ·{" "}
                  {new Date(plan.response.decidedAt).toLocaleString()}
                </p>
              </div>
              <Button asChild type="button" variant="outline" size="sm">
                <a
                  href={plan.response.signedFileUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Signed document
                </a>
              </Button>
            </div>
            <div className="divide-y divide-teal-100 rounded-md border border-teal-100 bg-white">
              {plan.lines.map((line) => {
                const decision = plan.response!.lines.find(
                  (row) => row.revisionLineId === line.id,
                );
                return (
                  <div
                    key={line.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{line.description}</span>
                    <span className="shrink-0 font-medium capitalize">
                      {decision?.decision}
                      {decision?.decision === "accepted"
                        ? ` · ${decision.acceptedQuantity}`
                        : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
