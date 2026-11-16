"use client";

import Link from "next/link";
import { ArrowLeft, ClipboardList, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/empty-state";
import { formatDate } from "@/lib/locale/format";
import { trpc } from "@/lib/trpc";

function preferredDates(from: string | null, to: string | null): string {
  if (from && to) {
    return from === to
      ? formatDate(from)
      : `${formatDate(from)} – ${formatDate(to)}`;
  }
  if (from) return `From ${formatDate(from)}`;
  if (to) return `Through ${formatDate(to)}`;
  return "Any date";
}

export default function WaitlistPage() {
  const waitlist = trpc.waitlist.list.useQuery(
    { status: "waiting" },
    { refetchOnMount: "always" },
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/schedule">
          <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
          Back to schedule
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold">Appointment waitlist</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Clients waiting for an opening, oldest request first.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void waitlist.refetch()}
          disabled={waitlist.isFetching}
        >
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          {waitlist.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {waitlist.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p className="font-medium">Unable to load the waitlist</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Refresh to try again. Waiting clients will appear once the list loads.
          </p>
        </div>
      ) : waitlist.isPending || !waitlist.data ? (
        <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading waitlist…
        </div>
      ) : waitlist.data.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No clients waiting"
          description="There are no waiting appointment requests for your clinic."
        />
      ) : (
        <section aria-label="Waiting appointment requests" className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">
            {waitlist.isFetching
              ? "Refreshing waitlist…"
              : `${waitlist.data.length} ${waitlist.data.length === 1 ? "request" : "requests"} waiting`}
          </p>
          <ol className="space-y-3">
            {waitlist.data.map((entry) => {
              const clientName = [entry.clientFirstName, entry.clientLastName]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={entry.id} className="rounded-lg border border-border bg-card p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 className="min-w-0 break-words font-semibold">
                      {clientName || "Client unavailable"}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      Requested {formatDate(entry.createdAt)}
                    </span>
                  </div>
                  <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Patient</dt>
                      <dd className="mt-1 break-words">{entry.patientName || "Not specified or unavailable"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Phone</dt>
                      <dd className="mt-1 break-words">{entry.clientPhone || "Not available"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Appointment type</dt>
                      <dd className="mt-1 break-words">
                        {entry.typeName || (entry.typeId ? "Type unavailable" : "Any type")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Preferred dates</dt>
                      <dd className="mt-1">{preferredDates(entry.preferredFrom, entry.preferredTo)}</dd>
                    </div>
                  </dl>
                  {entry.notes ? (
                    <div className="mt-4 border-t border-border pt-3 text-sm">
                      <p className="text-muted-foreground">Notes</p>
                      <p className="mt-1 whitespace-pre-wrap break-words">{entry.notes}</p>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
