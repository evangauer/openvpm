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
  MessageSquare,
  RefreshCw,
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

const recoveryTrialStyles: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  ending_soon: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-700",
  no_trial: "bg-gray-100 text-gray-600",
};

function recoveryLabel(value: string) {
  return value.replaceAll("_", " ");
}

export default function AdminPage() {
  const utils = trpc.useUtils();
  const { data, isLoading, error, refetch } =
    trpc.admin.overview.useQuery(undefined, {
      retry: false,
    });
  const { data: funnel, error: funnelError } =
    trpc.admin.activationFunnel.useQuery({ days: 30 }, { retry: false });
  const { data: recoveryQueue, error: recoveryError } =
    trpc.admin.activationRecovery.useQuery(undefined, { retry: false });
  const { data: journey, error: journeyError } =
    trpc.admin.journeyFunnel.useQuery({ days: 30 }, { retry: false });
  const { data: messagingQueue, error: messagingQueueError } =
    trpc.admin.messagingRegistrationQueue.useQuery(undefined, { retry: false });
  const [extendTrialError, setExtendTrialError] = useState<string | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [messagingError, setMessagingError] = useState<string | null>(null);
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
      utils.admin.activationRecovery.invalidate();
    },
    onError: (err) => setAnalyticsError(err.message),
  });
  const refreshMessagingQueue = () =>
    utils.admin.messagingRegistrationQueue.invalidate();
  const submitMessagingBrand = trpc.admin.submitMessagingBrand.useMutation({
    onSuccess: () => {
      setMessagingError(null);
      refreshMessagingQueue();
    },
    onError: (err) => setMessagingError(err.message),
  });
  const submitMessagingCampaign =
    trpc.admin.submitMessagingCampaign.useMutation({
      onSuccess: () => {
        setMessagingError(null);
        refreshMessagingQueue();
      },
      onError: (err) => setMessagingError(err.message),
    });
  const assignMessagingNumbers = trpc.admin.assignMessagingNumbers.useMutation({
    onSuccess: () => {
      setMessagingError(null);
      refreshMessagingQueue();
    },
    onError: (err) => setMessagingError(err.message),
  });
  const attachMessagingProviderIds =
    trpc.admin.attachMessagingProviderIds.useMutation({
      onSuccess: () => {
        setMessagingError(null);
        refreshMessagingQueue();
      },
      onError: (err) => setMessagingError(err.message),
    });
  const clearStaleMessagingSubmissionLock =
    trpc.admin.clearStaleMessagingSubmissionLock.useMutation({
      onSuccess: () => {
        setMessagingError(null);
        refreshMessagingQueue();
      },
      onError: (err) => setMessagingError(err.message),
    });
  const reconcileMessagingRegistration =
    trpc.admin.reconcileMessagingRegistration.useMutation({
      onSuccess: () => {
        setMessagingError(null);
        refreshMessagingQueue();
      },
      onError: (err) => setMessagingError(err.message),
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
    { label: "Active trials", value: String(data.totals.activeTrials), icon: Clock },
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

      {/* Activation recovery queue */}
      <div className="mt-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm">Clinic activation recovery</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Ranked by the next operator action, then by days since a real clinic
          milestone. Internal/test workspaces and sample data are excluded.
        </p>
        {recoveryQueue ? (
          <div className="mt-4 overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Rank</th>
                  <th className="px-3 py-2 font-medium">Clinic contact</th>
                  <th className="px-3 py-2 font-medium">Trial</th>
                  <th className="px-3 py-2 font-medium">Setup</th>
                  <th className="px-3 py-2 font-medium">Real activity</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">Next action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recoveryQueue.map((clinic) => (
                  <tr key={clinic.practiceId} className="align-top hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium tabular-nums">
                      {clinic.queueRank}
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium">{clinic.practiceName}</p>
                      {clinic.verifiedAdminEmail && clinic.verifiedAdminEmailAt ? (
                        <a
                          href={`mailto:${clinic.verifiedAdminEmail}`}
                          className="mt-0.5 block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          {clinic.verifiedAdminName
                            ? `${clinic.verifiedAdminName} · `
                            : ""}
                          {clinic.verifiedAdminEmail}
                        </a>
                      ) : (
                        <p className="mt-0.5 text-xs font-medium text-amber-700">
                          No verified admin contact
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                          recoveryTrialStyles[clinic.trialState] ??
                          recoveryTrialStyles.no_trial
                        }`}
                      >
                        {recoveryLabel(clinic.trialState)}
                      </span>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {clinic.trialEndsAt
                          ? `Ends ${formatDate(clinic.trialEndsAt, clinic.timezone)}`
                          : "No trial end"}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <p>{clinic.setupStage}</p>
                      {clinic.setupHelpRequestedAt ? (
                        <p className="mt-0.5 text-xs font-medium text-emerald-700">
                          Help requested {formatDate(
                            clinic.setupHelpRequestedAt,
                            clinic.timezone
                          )}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <p className="tabular-nums">
                        {clinic.realClientCount} clients ·{" "}
                        {clinic.realAppointmentCount} visits
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Last {formatDate(
                          clinic.lastMeaningfulActivityAt,
                          clinic.timezone
                        )} · stalled {clinic.stallAgeDays}d
                      </p>
                    </td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">
                      {recoveryLabel(clinic.authoritativeStage)}
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium">{clinic.nextAction}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Priority {clinic.nextActionPriority}
                      </p>
                    </td>
                  </tr>
                ))}
                {recoveryQueue.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                      No clinic workspaces need activation recovery.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {recoveryError
              ? "Could not load activation recovery."
              : "Loading activation recovery…"}
          </p>
        )}
      </div>

      {/* Messaging carrier operations */}
      <div className="mt-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <MessageSquare className="h-4 w-4" />
          <span className="text-sm">Messaging carrier registrations</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Brand and campaign submissions incur Telnyx charges and require an
          explicit confirmation. Refresh is read-only. Assignment never enables
          sending.
        </p>
        {messagingError ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {messagingError}
          </div>
        ) : null}
        {messagingQueue ? (
          <div className="mt-4 overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Clinic</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Brand</th>
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Numbers</th>
                  <th className="px-3 py-2 font-medium">Operator action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {messagingQueue.map((registration) => {
                  const busy = Boolean(registration.submissionLockAt);
                  const lockIsStale =
                    registration.submissionLockAt != null &&
                    Date.now() -
                      new Date(registration.submissionLockAt).getTime() >=
                      15 * 60 * 1000;
                  const anyMutationPending =
                    submitMessagingBrand.isPending ||
                    submitMessagingCampaign.isPending ||
                    assignMessagingNumbers.isPending ||
                    attachMessagingProviderIds.isPending ||
                    clearStaleMessagingSubmissionLock.isPending ||
                    reconcileMessagingRegistration.isPending;
                  return (
                    <tr key={registration.id}>
                      <td className="px-3 py-2">
                        <p className="font-medium">
                          {registration.practiceName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {registration.legalName} · EIN ••••
                          {registration.taxIdLast4}
                        </p>
                        {registration.lastError ? (
                          <p className="mt-1 max-w-xs text-xs text-destructive">
                            {registration.lastError}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 capitalize">
                        {registration.status.replace("_", " ")}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {registration.providerBrandStatus ?? "Not submitted"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {registration.providerCampaignStatus ?? "Not submitted"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {registration.senders.length === 0
                          ? "No number"
                          : registration.senders
                              .map(
                                (sender) =>
                                  `${sender.senderE164 ?? "—"} (${sender.registrationStatus})`
                              )
                              .join(", ")}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {!registration.providerBrandId ? (
                            <button
                              type="button"
                              disabled={busy || anyMutationPending}
                              className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    registration.lastError
                                      ? `Retry ${registration.practiceName}'s brand only after confirming in the Telnyx portal that no brand was created. This can incur another non-refundable charge. Continue?`
                                      : `Submit ${registration.practiceName}'s legal brand to Telnyx? This incurs a non-refundable provider charge.`
                                  )
                                ) {
                                  submitMessagingBrand.mutate({
                                    practiceId: registration.practiceId,
                                    confirmProviderCharges: true,
                                    retryAfterProviderReview: Boolean(
                                      registration.lastError
                                    ),
                                  });
                                }
                              }}
                            >
                              {registration.lastError
                                ? "Retry reviewed brand"
                                : "Submit brand"}
                            </button>
                          ) : null}
                          {registration.providerBrandId &&
                          !registration.providerCampaignId ? (
                            <button
                              type="button"
                              disabled={busy || anyMutationPending}
                              className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    registration.lastError
                                      ? `Retry ${registration.practiceName}'s campaign only after confirming in the Telnyx portal that no matching campaign exists. This can incur another non-refundable charge. Continue?`
                                      : `Submit ${registration.practiceName}'s campaign to Telnyx? This incurs non-refundable provider charges.`
                                  )
                                ) {
                                  submitMessagingCampaign.mutate({
                                    practiceId: registration.practiceId,
                                    confirmProviderCharges: true,
                                    retryAfterProviderReview: Boolean(
                                      registration.lastError
                                    ),
                                  });
                                }
                              }}
                            >
                              {registration.lastError
                                ? "Retry reviewed campaign"
                                : "Submit campaign"}
                            </button>
                          ) : null}
                          {registration.providerCampaignId ? (
                            <button
                              type="button"
                              disabled={busy || anyMutationPending}
                              className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Assign ${registration.practiceName}'s texting numbers to its approved campaign? Sending will remain disabled.`
                                  )
                                ) {
                                  assignMessagingNumbers.mutate({
                                    practiceId: registration.practiceId,
                                    confirmProviderMutation: true,
                                  });
                                }
                              }}
                            >
                              Assign numbers
                            </button>
                          ) : null}
                          {registration.providerBrandId ? (
                            <button
                              type="button"
                              title="Read current carrier status"
                              disabled={anyMutationPending}
                              className="inline-flex items-center rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                              onClick={() =>
                                reconcileMessagingRegistration.mutate({
                                  practiceId: registration.practiceId,
                                })
                              }
                            >
                              <RefreshCw className="mr-1 h-3 w-3" /> Refresh
                            </button>
                          ) : null}
                          {busy ? (
                            <>
                              <button
                                type="button"
                                disabled={anyMutationPending}
                                className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                                onClick={() => {
                                  const brandId = window.prompt(
                                    "After reviewing the Telnyx portal, enter the existing brand ID. Cancel if no provider object exists."
                                  );
                                  if (!brandId) return;
                                  const campaignId = window.prompt(
                                    "Optional: enter the existing campaign ID, or leave blank."
                                  );
                                  attachMessagingProviderIds.mutate({
                                    practiceId: registration.practiceId,
                                    providerBrandId: brandId.trim(),
                                    providerCampaignId:
                                      campaignId?.trim() || undefined,
                                    confirmProviderPortalReviewed: true,
                                  });
                                }}
                              >
                                Recover provider IDs
                              </button>
                              <button
                                type="button"
                                disabled={!lockIsStale || anyMutationPending}
                                title={
                                  lockIsStale
                                    ? "Use only after confirming no matching object exists in Telnyx"
                                    : "Available after the 15-minute safety window"
                                }
                                className="rounded border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/5 disabled:opacity-50"
                                onClick={() => {
                                  const providerObject =
                                    registration.providerBrandId
                                      ? "campaign"
                                      : "brand";
                                  if (
                                    window.confirm(
                                      `I reviewed the Telnyx portal and confirmed NO matching ${providerObject} exists. Clear the stale lock and keep all sending disabled?`
                                    )
                                  ) {
                                    clearStaleMessagingSubmissionLock.mutate({
                                      practiceId: registration.practiceId,
                                      providerObject,
                                      confirmProviderPortalReviewed: true,
                                      confirmNoProviderObjectExists:
                                        "NO_PROVIDER_OBJECT",
                                    });
                                  }
                                }}
                              >
                                No object — clear stale lock
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {messagingQueue.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      No clinics have submitted carrier details yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {messagingQueueError
              ? "Could not load messaging registrations."
              : "Loading messaging registrations…"}
          </p>
        )}
      </div>

      {/* Trial funnel */}
      <div className="mt-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm">Production journey cohorts (30 days)</span>
        </div>
        {journey ? (
          <>
            <div className="mt-3 grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
              {[
                ["Visit", journey.totals.visitors, null],
                ["Demo", journey.totals.demos, journey.totals.demoRate],
                ["Registered", journey.totals.registrations, journey.totals.registrationRate],
                ["Activated", journey.totals.activated, journey.totals.activationRate],
                [
                  "Payment method",
                  journey.totals.paymentMethodCollected,
                  journey.totals.paymentMethodRate,
                ],
                [
                  "First positive payment",
                  journey.totals.firstPositivePayment,
                  journey.totals.positivePaymentRate,
                ],
              ].map(([label, value, rate]) => (
                <div key={String(label)}>
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                    {value}
                    {typeof rate === "number" ? (
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        {formatPct(rate)}
                      </span>
                    ) : null}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-5 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2 xl:grid-cols-6">
              <p>Left before trying (7d+): {journey.totals.leftBeforeTrying}</p>
              <p>Demo without signup (7d+): {journey.totals.demoAbandoned}</p>
              <p>Signup stalled (7d+): {journey.totals.registrationAbandoned}</p>
              <p>Activation stalled (7d+): {journey.totals.activationAbandoned}</p>
              <p>
                Payment method without positive payment after trial (7d+):{" "}
                {journey.totals.paymentAbandoned}
              </p>
              <p>Client errors: {journey.totals.clientErrors}</p>
            </div>

            <div className="mt-5 overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Cohort week</th>
                    <th className="px-3 py-2 font-medium">Visit</th>
                    <th className="px-3 py-2 font-medium">Demo</th>
                    <th className="px-3 py-2 font-medium">Registered</th>
                    <th className="px-3 py-2 font-medium">Activated</th>
                    <th className="px-3 py-2 font-medium">Payment method</th>
                    <th className="px-3 py-2 font-medium">Positive payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {journey.weeks.map((week) => (
                    <tr key={week.weekStart}>
                      <td className="px-3 py-2 font-medium">{week.weekStart}</td>
                      <td className="px-3 py-2 tabular-nums">{week.visitors}</td>
                      <td className="px-3 py-2 tabular-nums">{week.demos}</td>
                      <td className="px-3 py-2 tabular-nums">{week.registrations}</td>
                      <td className="px-3 py-2 tabular-nums">{week.activated}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {week.paymentMethodCollected}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {week.firstPositivePayment}
                      </td>
                    </tr>
                  ))}
                  {journey.weeks.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                        No first-party journey cohorts recorded yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Anonymous first touch is carried across openvpm.com, demo, and signup.
              Rates are visit-to-step for demo and registration, then step-to-step.{" "}
              Stalls require seven full days; an active trial with a collected
              payment method is not treated as payment-abandoned.
              {journey.totals.unattributedRegistrations > 0
                ? ` ${journey.totals.unattributedRegistrations} registration(s) could not be matched to a first touch.`
                : ""}
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {journeyError ? "Could not load journey cohorts." : "Loading journey cohorts..."}
          </p>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm">Trial funnel (30 days)</span>
        </div>
        {funnel ? (
          <>
            <div className="mt-3 grid gap-4 sm:grid-cols-3 xl:grid-cols-8">
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
                <p className="text-sm text-muted-foreground">First visit done</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.firstVisitCompleted}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.firstVisitCompletionRate)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Payment method</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.paymentMethodCollected}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.paymentMethodRate)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">First positive payment</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.firstPositivePayment}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.positivePaymentRate)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Currently active</p>
                <p className="mt-1 font-heading text-2xl font-bold tabular-nums">
                  {funnel.totals.currentlyActive}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {formatPct(funnel.totals.currentlyActiveRate)}
                  </span>
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Setup progress comes from the guided clinic setup. Activated = added a
              real client and booked a real visit. First visit done requires a
              completed clinical and billing closeout; its rate is measured from
              activated clinics. Payment method = a signed subscription Checkout
              completed with collection required. First positive payment = a signed,
              positive subscription invoice payment. Currently active is current
              billing state, not a historical conversion milestone.
            </p>
            <div className="mt-4 rounded-md border border-amber-300/60 bg-amber-50/50 p-3 text-xs text-muted-foreground dark:bg-amber-950/10">
              <p className="font-medium text-foreground">Conversion evidence quality</p>
              <p className="mt-1">
                Legacy business-stage rows are excluded; unknown evidence is never
                counted as zero or assigned a synthetic date.
              </p>
              <p className="mt-2">
                Legacy rows: {funnel.dataQuality.legacyBusinessStageRows} · Unknown
                payment method: {funnel.dataQuality.unknownPaymentMethodPractices} ·{" "}
                Unknown positive payment: {funnel.dataQuality.unknownPositivePaymentPractices}
                {" · "}Missing registrations: {funnel.dataQuality.missingRegistrationMilestones}
                {" · "}Missing activations: {funnel.dataQuality.missingActivationMilestones}
                {" · "}Unprojected Stripe evidence: {funnel.dataQuality.unprojectedStripeEvidence}
                {" · "}Unmapped Stripe evidence: {funnel.dataQuality.unmappedStripeEvidence}
              </p>
            </div>
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
                <td className="px-4 py-2.5">
                  <p className="font-medium">{p.name}</p>
                  {p.adminEmail ? (
                    <a
                      href={`mailto:${p.adminEmail}`}
                      className="mt-0.5 block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {p.adminName ? `${p.adminName} · ` : ""}
                      {p.adminEmail}
                      {!p.adminEmailVerifiedAt ? " · unverified" : ""}
                    </a>
                  ) : (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      No active admin contact
                    </p>
                  )}
                </td>
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
                  <p>{p.setupStage}</p>
                  {p.setupHelpRequestedAt ? (
                    <p className="mt-0.5 text-xs font-medium text-emerald-700">
                      Help requested {formatDate(p.setupHelpRequestedAt, p.timezone)}
                    </p>
                  ) : null}
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
