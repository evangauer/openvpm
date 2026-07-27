"use client";

import { useState } from "react";
import {
  ShieldAlert,
  Building2,
  DollarSign,
  Clock,
  CheckCircle,
  AlertTriangle,
  TrendingUp,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/common/empty-state";
import { PageLoading } from "@/components/common/loading";

function formatUsd(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function formatDate(d: Date | string | null, timeZone?: string | null) {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timeZone?.trim() || "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  try {
    return date.toLocaleDateString("en-US", options);
  } catch {
    return date.toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
  }
}

function formatPct(rate: number) {
  return `${Math.round(rate * 100)}%`;
}

const statusStyles: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  trialing: "bg-blue-100 text-blue-700",
  past_due: "bg-red-100 text-red-700",
  canceled: "bg-gray-100 text-gray-500",
  none: "bg-gray-100 text-gray-500",
};

export default function AdminPage() {
  const utils = trpc.useUtils();
  const { data, isLoading, error, refetch } =
    trpc.admin.overview.useQuery(undefined, {
      retry: false,
    });
  const { data: funnel, error: funnelError } =
    trpc.admin.activationFunnel.useQuery({ days: 30 }, { retry: false });
  const [extendTrialError, setExtendTrialError] = useState<string | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const extendTrial = trpc.admin.extendTrial.useMutation({
    onSuccess: () => {
      setExtendTrialError(null);
      utils.admin.overview.invalidate();
    },
    onError: (err) => setExtendTrialError(err.message),
  });
  const setAnalyticsExcluded = trpc.admin.setAnalyticsExcluded.useMutation({
    onSuccess: () => {
      setAnalyticsError(null);
      utils.admin.overview.invalidate();
      utils.admin.activationFunnel.invalidate();
    },
    onError: (err) => setAnalyticsError(err.message),
  });

  if (error?.data?.code === "FORBIDDEN") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="font-heading text-xl font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground mt-1">
          This area is for OpenVPM platform operators only.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Unable to load platform admin"
        description={error.message}
        action={{ label: "Retry", onClick: () => refetch() }}
        className="border-destructive/30 bg-destructive/5"
      />
    );
  }

  if (isLoading) return <PageLoading className="py-24" />;

  if (!data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Unable to load platform admin"
        description="The admin overview finished without returning data. Try loading it again."
        action={{ label: "Retry", onClick: () => refetch() }}
        className="border-destructive/30 bg-destructive/5"
      />
    );
  }

  const kpis = [
    { label: "Practices", value: String(data.totals.practices), icon: Building2 },
    { label: "Est. MRR", value: formatUsd(data.totals.estimatedMrr), icon: DollarSign },
    { label: "On trial", value: String(data.totals.trialing), icon: Clock },
    { label: "Active", value: String(data.totals.active), icon: CheckCircle },
    { label: "Past due", value: String(data.totals.pastDue), icon: AlertTriangle },
  ];

  return (
    <div>
      <div>
        <h2 className="font-heading text-xl font-semibold">Platform Admin</h2>
        <p className="text-sm text-muted-foreground">
          Cross-tenant operations overview
        </p>
      </div>

      {/* KPIs */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon className="h-4 w-4" />
                <span className="text-sm">{k.label}</span>
              </div>
              <p className="mt-2 font-heading text-2xl font-bold">{k.value}</p>
            </div>
          );
        })}
      </div>

      {/* Trial funnel */}
      <div className="mt-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm">Trial funnel (30 days)</span>
        </div>
        {funnel ? (
          <>
            <div className="mt-3 grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
              <div>
                <p className="text-sm text-muted-foreground">Signups</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.signups}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Setup started</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.setupStarted}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.setupStartRate)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Setup complete</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.setupCompleted}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.setupCompletionRate)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Activated</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.activated}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.activationRate)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Billing started</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.billingStarted}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.billingStartRate)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Paid active</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.subscribed}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.conversionRate)}
                  </span>
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Setup progress comes from the guided clinic setup. Activated = added a
              real client and booked a real visit. Billing started = Stripe
              subscription created; paid active = billing status active. All rates
              are signup-cohort rates for this window.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {funnelError ? "Could not load the funnel." : "Loading funnel..."}
          </p>
        )}
      </div>

      {/* Practices table */}
      {extendTrialError && (
        <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Could not extend the trial: {extendTrialError}
        </div>
      )}
      {analyticsError && (
        <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Could not update funnel inclusion: {analyticsError}
        </div>
      )}
      <div className="mt-8 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Practice</th>
              <th className="px-4 py-2.5 font-medium">Plan</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Source</th>
              <th className="px-4 py-2.5 font-medium">Intent</th>
              <th className="px-4 py-2.5 font-medium">Setup</th>
              <th className="px-4 py-2.5 font-medium">Metrics</th>
              <th className="px-4 py-2.5 font-medium">Trial ends</th>
              <th className="px-4 py-2.5 font-medium text-right">Locations</th>
              <th className="px-4 py-2.5 font-medium text-right">Staff</th>
              <th className="px-4 py-2.5 font-medium text-right">Base MRR</th>
              <th className="px-4 py-2.5 font-medium text-right">Clients</th>
              <th className="px-4 py-2.5 font-medium text-right">Patients</th>
              <th className="px-4 py-2.5 font-medium">Country</th>
              <th className="px-4 py-2.5 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.practices.map((p) => (
              <tr key={p.id} className="hover:bg-muted/20">
                <td className="px-4 py-2.5 font-medium">{p.name}</td>
                <td className="px-4 py-2.5 capitalize">{p.tier}</td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      statusStyles[p.billingStatus] || "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {p.billingStatus.replace("_", " ")}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {p.acquisitionSource}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {p.onboardingIntent}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {p.setupStage}
                </td>
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    title={
                      p.analyticsExcluded
                        ? "Include this practice in conversion reporting"
                        : "Exclude this internal or test practice from conversion reporting"
                    }
                    aria-pressed={p.analyticsExcluded}
                    disabled={setAnalyticsExcluded.isPending}
                    onClick={() =>
                      setAnalyticsExcluded.mutate({
                        practiceId: p.id,
                        excluded: !p.analyticsExcluded,
                      })
                    }
                    className={`rounded border px-1.5 py-0.5 text-xs font-medium disabled:opacity-50 ${
                      p.analyticsExcluded
                        ? "border-amber-300 bg-amber-50 text-amber-800"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {p.analyticsExcluded ? "Excluded" : "Exclude"}
                  </button>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    {formatDate(p.trialEndsAt, p.timezone)}
                    {p.billingStatus === "trialing" && (
                      <button
                        type="button"
                        title="Give this trial 14 more days"
                        disabled={extendTrial.isPending}
                        onClick={() =>
                          extendTrial.mutate({ practiceId: p.id, days: 14 })
                        }
                        className="rounded border border-border px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        +14d
                      </button>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{p.locationCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{p.userCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatUsd(p.estimatedMrr)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{p.clientCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{p.patientCount}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{p.country}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {formatDate(p.createdAt, p.timezone)}
                </td>
              </tr>
            ))}
            {data.practices.length === 0 && (
              <tr>
                <td colSpan={15} className="px-4 py-8 text-center text-muted-foreground">
                  No practices yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
