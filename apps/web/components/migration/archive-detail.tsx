"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { Loader2 } from "lucide-react";
import type { AppRouter } from "@/server/routers/_app";

type ArchiveDetailData =
  inferRouterOutputs<AppRouter>["migrationArchive"]["detail"];
export function formatImportedDate(
  value: string | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return date.toLocaleDateString("en-US", {
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : (timeZone ?? "UTC"),
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function ArchiveDetail({
  data,
  isLoading,
  errorMessage,
  formatCurrency = (value) => String(value ?? "—"),
  timeZone,
}: {
  data: ArchiveDetailData | undefined;
  isLoading: boolean;
  errorMessage?: string;
  timeZone?: string | null;
  formatCurrency?: (value: string | number | null | undefined) => string;
}) {
  if (isLoading) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading detail…
      </div>
    );
  }
  if (errorMessage || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage ?? "Detail is unavailable."}
      </p>
    );
  }
  if (data.kind === "medications") {
    return (
      <div className="space-y-4 break-words text-sm">
        <div>
          <p className="font-medium">{data.record.medicationName}</p>
          <p className="text-muted-foreground">{data.record.patientName}</p>
        </div>
        {data.record.directions ? (
          <p className="rounded-md bg-muted p-3 leading-6">
            {data.record.directions}
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs text-muted-foreground">Quantity</dt>
            <dd>{data.record.quantity ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Refills written</dt>
            <dd>{data.record.refillCount ?? "—"}</dd>
          </div>
        </dl>
        <div>
          <p className="font-medium">Fill history</p>
          {data.entries.length ? (
            <ul className="mt-2 divide-y divide-border rounded-md border border-border">
              {data.entries.map((entry) => (
                <li key={entry.id} className="p-3">
                  <p>
                    {entry.occurredAt
                      ? formatImportedDate(
                          entry.occurredAt.toISOString(),
                          timeZone,
                        )
                      : "Date unavailable"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {entry.quantity
                      ? `Quantity ${entry.quantity}`
                      : "Quantity unavailable"}
                    {entry.status ? ` · ${entry.status}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-muted-foreground">
              No fills in the source export.
            </p>
          )}
        </div>
      </div>
    );
  }
  if (data.kind === "labs") {
    return (
      <div className="space-y-4 break-words text-sm">
        <div>
          <p className="font-medium">
            {data.record.title?.trim() ||
              data.record.labName?.trim() ||
              "Imported lab report"}
          </p>
          <p className="text-muted-foreground">
            {data.record.patientName ?? "Patient match needs review"}
          </p>
        </div>
        {data.record.summary ? (
          <p className="leading-6">{data.record.summary}</p>
        ) : null}
        {data.entries.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.entries.map((entry) => (
              <li key={entry.id} className="flex justify-between gap-3 p-3">
                <span className="min-w-0 flex-1 break-words">{entry.name}</span>
                <span className="min-w-0 flex-1 break-words text-right font-medium">
                  {[entry.value, entry.unit].filter(Boolean).join(" ") || "—"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-border p-3 text-muted-foreground">
            No structured observations were included in the source export. Check
            imported documents for any accompanying report.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4 break-words text-sm">
      <div>
        <p className="font-medium">
          {data.record.documentNumber ?? titleCase(data.record.documentType)}
        </p>
        <p className="text-muted-foreground">{data.record.clientName}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">Total</dt>
          <dd className="font-medium">{formatCurrency(data.record.total)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Historical balance</dt>
          <dd className="font-medium">{formatCurrency(data.record.balance)}</dd>
        </div>
      </dl>
      <div>
        <p className="font-medium">Line items</p>
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {data.entries.map((entry) => (
            <li key={entry.id} className="flex justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="break-words">{entry.description}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.quantity} × {formatCurrency(entry.unitPrice)}
                </p>
              </div>
              <span className="shrink-0 font-medium">
                {formatCurrency(entry.total)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {data.allocations.length ? (
        <div>
          <p className="font-medium">Payment allocations</p>
          <ul className="mt-2 space-y-2 text-muted-foreground">
            {data.allocations.map((allocation) => (
              <li key={allocation.id}>
                {formatCurrency(allocation.amount)} ·{" "}
                {formatImportedDate(
                  (
                    allocation.allocatedAt ?? allocation.paymentReceivedAt
                  ).toISOString(),
                  timeZone,
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
