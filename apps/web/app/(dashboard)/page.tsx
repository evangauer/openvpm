"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CalendarPlus,
  Clock,
  DollarSign,
  FileText,
  PawPrint,
  TrendingUp,
} from "lucide-react";
import { ActivationChecklist } from "@/components/dashboard/activation-checklist";
import { EmptyState } from "@/components/common/empty-state";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { formatCurrency } from "@/lib/locale/format";
import { formatDateInputForTimeZone } from "@/lib/date-input";

function DashboardChartsChunkLoading() {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-[360px] animate-pulse rounded-lg border border-border bg-card p-6">
          <div className="mb-4 h-5 w-40 rounded bg-muted" />
          <div className="h-[300px] w-full rounded bg-muted" />
        </div>
        <div className="h-[360px] animate-pulse rounded-lg border border-border bg-card p-6">
          <div className="mb-4 h-5 w-40 rounded bg-muted" />
          <div className="h-[300px] w-full rounded bg-muted" />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-[360px] animate-pulse rounded-lg border border-border bg-card p-6">
          <div className="mb-4 h-5 w-40 rounded bg-muted" />
          <div className="h-[300px] w-full rounded bg-muted" />
        </div>
        <div className="h-[360px] animate-pulse rounded-lg border border-border bg-card p-6">
          <div className="mb-4 h-5 w-40 rounded bg-muted" />
          <div className="h-[300px] w-full rounded bg-muted" />
        </div>
      </div>
    </>
  );
}

const DashboardCharts = dynamic(
  () =>
    import("@/components/dashboard/dashboard-charts").then(
      (mod) => mod.DashboardCharts,
    ),
  {
    ssr: false,
    loading: DashboardChartsChunkLoading,
  },
);

function formatTime(date: Date | string, timeZone?: string | null) {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone ?? undefined,
  };
  try {
    return new Date(date).toLocaleTimeString("en-US", options);
  } catch {
    return new Date(date).toLocaleTimeString("en-US", {
      ...options,
      timeZone: undefined,
    });
  }
}

function formatDueDate(dateInput: string) {
  const [year, month, day] = dateInput.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString(
    "en-US",
    {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    },
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
    "0",
  )}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

const kpiConfig = [
  {
    key: "todayAppointments" as const,
    label: "Today's Appointments",
    description: "Scheduled for today",
    icon: Calendar,
    isCurrency: false,
  },
  {
    key: "patientsSeen" as const,
    label: "Patients Seen Today",
    description: "Checked out today",
    icon: PawPrint,
    isCurrency: false,
  },
  {
    key: "revenueMtd" as const,
    label: "Revenue (MTD)",
    description: "Paid invoices this month",
    icon: DollarSign,
    isCurrency: true,
  },
  {
    key: "pendingInvoices" as const,
    label: "Pending Invoices",
    description: "Sent or overdue",
    icon: FileText,
    isCurrency: false,
  },
];

function KpiSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-6 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-md bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 rounded bg-muted" />
          <div className="h-6 w-16 rounded bg-muted" />
        </div>
      </div>
      <div className="mt-2 h-3 w-32 rounded bg-muted" />
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-6 animate-pulse">
      <div className="mb-4 h-5 w-40 rounded bg-muted" />
      <div className="h-[300px] w-full rounded bg-muted" />
    </div>
  );
}

function AppointmentRowSkeleton() {
  return (
    <div className="flex items-center gap-4 rounded-md border border-border p-3 animate-pulse">
      <div className="h-4 w-16 rounded bg-muted" />
      <div className="h-4 w-32 rounded bg-muted" />
      <div className="ml-auto h-5 w-20 rounded-full bg-muted" />
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const stats = trpc.dashboard.getStats.useQuery();
  const charts = trpc.dashboard.getCharts.useQuery();
  const pendingFollowUps = trpc.encounters.listPendingFollowUps.useQuery();
  const taxConfig = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const calendarSettingsQuery = trpc.appointments.calendarSettings.useQuery();
  const calendarSettings = calendarSettingsQuery.data;
  const taxConfigMissing =
    !taxConfig.isLoading && !taxConfig.error && !taxConfig.data;
  const verifiedTaxConfig =
    taxConfig.error || taxConfigMissing || !taxConfig.data
      ? null
      : taxConfig.data;
  const currency = verifiedTaxConfig ? verifiedTaxConfig.currency : "usd";
  const country = verifiedTaxConfig ? verifiedTaxConfig.country : "US";
  const calendarSettingsMissing =
    !calendarSettingsQuery.isLoading &&
    !calendarSettingsQuery.error &&
    !calendarSettings;
  const verifiedCalendarSettings =
    calendarSettingsQuery.error || calendarSettingsMissing || !calendarSettings
      ? null
      : calendarSettings;
  const dashboardTimeZone = verifiedCalendarSettings
    ? verifiedCalendarSettings.timezone
    : null;
  const fmtMoney = (v: number) => formatCurrency(v, currency, country);

  const today = new Date();
  const todayStr = formatDateInputForTimeZone(today, dashboardTimeZone);
  const tomorrowStr = addDateInputDays(todayStr, 1);

  const upcoming = trpc.appointments.list.useQuery(
    {
      startDate: todayStr,
      endDate: tomorrowStr,
    },
    {
      enabled: verifiedCalendarSettings !== null,
    },
  );
  const upcomingError = calendarSettingsQuery.error ?? upcoming.error;
  const isUpcomingLoading =
    calendarSettingsQuery.isLoading || upcoming.isLoading;
  const isUpcomingMissing =
    calendarSettingsMissing ||
    (verifiedCalendarSettings !== null &&
      !upcoming.isLoading &&
      !upcoming.error &&
      !upcoming.data);
  const statsMissing = !stats.isLoading && !stats.error && !stats.data;
  const chartsMissing = !charts.isLoading && !charts.error && !charts.data;
  const statsError = stats.error ?? taxConfig.error;
  const chartsError = charts.error ?? taxConfig.error;
  const isStatsLoading = stats.isLoading || taxConfig.isLoading;
  const isChartsLoading = charts.isLoading || taxConfig.isLoading;
  const statsDisplayMissing = statsMissing || taxConfigMissing;
  const chartsDisplayMissing = chartsMissing || taxConfigMissing;
  const verifiedStats =
    stats.error || statsMissing || !stats.data ? null : stats.data;
  const verifiedCharts =
    charts.error || chartsMissing || !charts.data ? null : charts.data;
  const verifiedUpcomingAppointments =
    upcomingError || isUpcomingLoading || isUpcomingMissing || !upcoming.data
      ? null
      : upcoming.data;
  const dashboardStats =
    statsError || isStatsLoading || statsDisplayMissing ? null : verifiedStats;

  const upcomingAppointments = (verifiedUpcomingAppointments ?? [])
    .filter(
      (a) =>
        a.status !== "checked_out" &&
        a.status !== "cancelled" &&
        a.status !== "no_show",
    )
    .slice(0, 5);

  // A brand-new practice has no real activity yet. Hide the charts until there
  // is something to show so the page feels calm instead of abandoned.
  const chartData =
    chartsError || isChartsLoading || chartsDisplayMissing
      ? null
      : verifiedCharts;
  const hasChartData =
    !!chartData &&
    (chartData.speciesDistribution.length > 0 ||
      chartData.appointmentsByDay.some(
        (d) => d.completed + d.scheduled + d.cancelled > 0,
      ) ||
      chartData.revenueByDay.some((d) => d.revenue > 0) ||
      chartData.productionByDoctor.some((d) => d.production > 0));

  return (
    <div className="space-y-8">
      <ActivationChecklist />
      {/* KPI Cards */}
      {statsError || statsDisplayMissing ? (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Unable to load dashboard metrics.
          {statsError ? ` ${statsError.message}` : " Please retry."}
        </div>
      ) : isStatsLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <KpiSkeleton key={i} />
          ))}
        </div>
      ) : dashboardStats ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {kpiConfig.map((kpi) => {
            const Icon = kpi.icon;
            const value = dashboardStats[kpi.key] ?? 0;
            return (
              <div
                key={kpi.key}
                className="rounded-lg border border-border bg-card p-6"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{kpi.label}</p>
                    <p className="font-heading text-2xl font-bold">
                      {kpi.isCurrency ? fmtMoney(value) : String(value)}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {kpi.description}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}

      <section
        className="rounded-lg border border-border bg-card"
        aria-labelledby="pending-follow-ups-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 py-4">
          <div>
            <h2
              id="pending-follow-ups-heading"
              className="font-heading text-lg font-semibold"
            >
              Follow-up work queue
            </h2>
            <p className="text-sm text-muted-foreground">
              Signed visit obligations that still need an owner.
            </p>
          </div>
          {pendingFollowUps.data?.length ? (
            <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              {pendingFollowUps.data.length} open
            </span>
          ) : null}
        </div>
        <div className="space-y-2 p-4">
          {pendingFollowUps.error ? (
            <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
              Follow-up obligations could not be loaded. Refresh before ending
              the shift.
            </div>
          ) : pendingFollowUps.isLoading ? (
            Array.from({ length: 2 }).map((_, index) => (
              <AppointmentRowSkeleton key={index} />
            ))
          ) : pendingFollowUps.data?.length ? (
            pendingFollowUps.data.map((followUp) => {
              const dueDate = followUp.dueDate!;
              const overdue = dueDate < todayStr;
              return (
                <div
                  key={followUp.closeoutId}
                  className="flex flex-col gap-3 rounded-md border border-border px-4 py-3 sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <AlertTriangle
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0",
                        overdue ? "text-destructive" : "text-amber-600",
                      )}
                    />
                    <div className="min-w-0">
                      <p className="font-medium">
                        {followUp.patientName} · due {formatDueDate(dueDate)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Owner: {followUp.clientFirstName}{" "}
                        {followUp.clientLastName}
                        {followUp.assigneeName
                          ? ` · Assigned to ${followUp.assigneeName}`
                          : ""}
                      </p>
                      {followUp.followUpNotes ? (
                        <p className="mt-1 line-clamp-2 text-sm">
                          {followUp.followUpNotes}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <Link
                    href={`/encounters/${followUp.appointmentId}#visit-closeout`}
                    className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    Resolve follow-up
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              );
            })
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No pending follow-up obligations.
            </p>
          )}
        </div>
      </section>

      {/* Recent Appointments */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-6 py-4">
          <h2 className="font-heading text-lg font-semibold">
            Upcoming Appointments
          </h2>
        </div>
        <div className="space-y-2 p-4">
          {upcomingError || isUpcomingMissing ? (
            <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
              Unable to load upcoming appointments.
              {upcomingError ? ` ${upcomingError.message}` : " Please retry."}
            </div>
          ) : isUpcomingLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <AppointmentRowSkeleton key={i} />
            ))
          ) : upcomingAppointments.length === 0 ? (
            <EmptyState
              className="border-0 bg-transparent py-8"
              icon={Calendar}
              title="No visits booked yet"
              description="Book your first visit and it shows up here."
              action={{
                label: "Book your first visit",
                onClick: () => router.push("/schedule"),
                icon: CalendarPlus,
              }}
            />
          ) : (
            upcomingAppointments.map((appt) => (
              <div
                key={appt.id}
                className="flex items-center gap-4 rounded-md border border-border px-4 py-3"
              >
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span>{formatTime(appt.startTime, dashboardTimeZone)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {appt.patientName ?? "Unknown Patient"}
                    {appt.clientLastName && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        ({appt.clientFirstName} {appt.clientLastName})
                      </span>
                    )}
                  </p>
                  {appt.typeName && (
                    <p className="text-xs text-muted-foreground">
                      {appt.typeName}
                      {appt.doctorName ? ` with ${appt.doctorName}` : ""}
                    </p>
                  )}
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
                    appt.status === "confirmed"
                      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                      : appt.status === "checked_in"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                        : appt.status === "in_exam"
                          ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
                          : "bg-muted text-muted-foreground",
                  )}
                >
                  {appt.status.replace("_", " ")}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Charts */}
      {chartsError || chartsDisplayMissing ? (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Unable to load dashboard charts.
          {chartsError ? ` ${chartsError.message}` : " Please retry."}
        </div>
      ) : isChartsLoading ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
        </>
      ) : chartData && !hasChartData ? (
        <EmptyState
          icon={TrendingUp}
          title="Your charts show up once you start"
          description="As you book visits and send bills, your trends and totals fill in here."
        />
      ) : chartData ? (
        <DashboardCharts
          appointmentsByDay={chartData.appointmentsByDay}
          speciesDistribution={chartData.speciesDistribution}
          revenueByDay={chartData.revenueByDay}
          productionByDoctor={chartData.productionByDoctor}
          currency={currency}
          country={country}
        />
      ) : null}
    </div>
  );
}
