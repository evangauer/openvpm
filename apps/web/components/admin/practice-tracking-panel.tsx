"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { engagementFor, type TrackingCursor } from "@/lib/admin/practice-tracking-types";

function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export function PracticeTrackingPanel() {
  const [pages, setPages] = useState<(TrackingCursor | undefined)[]>([undefined]);
  const { data, error, isFetching, refetch } = trpc.admin.practiceTracking.useQuery(
    { limit: 25, cursor: pages.at(-1) },
    { retry: false, refetchInterval: 60_000 },
  );
  return (
    <section id="practice-tracking" className="mt-8 rounded-lg border border-border p-4 sm:p-6" aria-labelledby="practice-tracking-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="practice-tracking-title" className="font-heading text-lg font-semibold">Trial and customer activity</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Includes signups before checkout. Business names are account-provided. Record counts exclude seeded samples.
            Recorded actions show product use, not time online or current presence.
          </p>
        </div>
        <button type="button" onClick={() => void refetch()} disabled={isFetching}
          className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">
          {isFetching ? "Refreshing…" : "Refresh activity"}
        </button>
      </div>
      {error ? <p role="alert" className="mt-4 text-sm text-destructive">Could not load activity. Refresh to try again.</p> : null}
      {!data && !error ? <p role="status" className="mt-4 text-sm text-muted-foreground">Loading activity…</p> : null}
      {data ? <>
        <p className="mt-3 text-xs text-muted-foreground">Updated {date(data.snapshotAt)} · Action days use UTC. Internal and test practices marked excluded are omitted.</p>
        <div className="mt-4 space-y-3">
          {data.practices.map(p => (
            <details key={p.practiceId} className="rounded-lg border border-border p-4">
              <summary className="cursor-pointer">
                <span className="font-medium break-words">{p.businessName}</span>
                <span className="ml-2 text-xs text-muted-foreground">{p.billingStatus} · {engagementFor(p, new Date(data.snapshotAt))}</span>
                <span className="mt-1 block text-xs text-muted-foreground break-words">
                  {p.ownerName || "Contact name unknown"} · {p.ownerEmail || "Contact email unknown"}
                </span>
              </summary>
              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <div>
                  <h3 className="text-sm font-medium">Account and source</h3>
                  <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                    <div><dt className="inline font-medium">Registered: </dt><dd className="inline">{date(p.registeredAt)}</dd></div>
                    <div><dt className="inline font-medium">Email verified: </dt><dd className="inline">{date(p.emailVerifiedAt)}</dd></div>
                    <div><dt className="inline font-medium">Trial ends: </dt><dd className="inline">{date(p.trialEndsAt)}</dd></div>
                    <div><dt className="inline font-medium">Signup source / placement: </dt><dd className="inline break-all">{p.acquisition.signupSource || "Unknown"}</dd></div>
                    <div><dt className="inline font-medium">Medium: </dt><dd className="inline">{p.acquisition.medium || "Unknown"}</dd></div>
                    <div><dt className="inline font-medium">Campaign: </dt><dd className="inline break-all">{p.acquisition.campaign || "Unknown"}</dd></div>
                  </dl>
                  <p className="mt-2 text-xs text-muted-foreground">A homepage button identifies signup placement; it does not establish an external referral channel.</p>
                </div>
                <div>
                  <h3 className="text-sm font-medium">Usage since registration</h3>
                  <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    {([
                      ["Clients", p.usage.clients], ["Patients", p.usage.patients],
                      ["Appointments", p.usage.appointments], ["Clinical notes", p.usage.soapNotes],
                      ["Invoices", p.usage.invoices], ["Uploaded files", p.usage.files],
                      ["Capture sessions started", p.usage.captureSessions], ["Metered AI runs", p.usage.aiRuns],
                      ["Metered SMS", p.usage.sms],
                    ] as const).map(([label, count]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{count}</dd></div>)}
                  </dl>
                  <p className="mt-2 text-xs text-muted-foreground">New appointments can still use sample patients. Starting capture does not mean a file was uploaded.</p>
                </div>
                <div>
                  <h3 className="text-sm font-medium">Recorded product actions</h3>
                  <p className="mt-2 text-xs text-muted-foreground">Last action: {date(p.lastActionAt)}<br />Days with actions: {p.activeDays7} in 7 days · {p.activeDays30} in 30 days</p>
                  {p.actions.length ? <ul className="mt-2 space-y-1 text-xs">{p.actions.map(a => <li key={a.label}>
                    <span className="font-medium">{a.label} × {a.count}</span><span className="block text-muted-foreground">{date(a.lastAt)}</span>
                  </li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No supported actions recorded yet.</p>}
                </div>
              </div>
            </details>
          ))}
          {!data.practices.length ? <p className="py-4 text-sm text-muted-foreground">No registered accounts to track yet.</p> : null}
        </div>
        <div className="mt-4 flex gap-2">
          <button type="button" disabled={isFetching || pages.length === 1} onClick={() => setPages(p => p.slice(0, -1))}
            className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50">Newer accounts</button>
          <button type="button" disabled={isFetching || !data.nextCursor}
            onClick={() => { const cursor = data.nextCursor; if (cursor) setPages(p => [...p, cursor]); }}
            className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50">Older accounts</button>
        </div>
      </> : null}
    </section>
  );
}
