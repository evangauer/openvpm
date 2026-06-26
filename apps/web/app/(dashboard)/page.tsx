"use client";

import Link from "next/link";
import { Calendar, PawPrint, DollarSign, FileText, Clock, TrendingUp } from "lucide-react";
import { WelcomePanel } from "@/components/dashboard/welcome-panel";
import { ActivationChecklist } from "@/components/dashboard/activation-checklist";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { formatCurrency, localeForCountry } from "@/lib/locale/format";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from "recharts";

function formatTime(date: Date | string) {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
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

const SPECIES_COLORS: Record<string, string> = {
  Canine: "#3b82f6",
  Feline: "#f59e0b",
  Avian: "#10b981",
  Rabbit: "#8b5cf6",
  Reptile: "#ef4444",
  Equine: "#06b6d4",
  Other: "#6b7280",
};

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

function PieLabel({
  cx,
  cy,
  midAngle,
  innerRadius,
  outerRadius,
  percent,
  name,
}: {
  cx: number;
  cy: number;
  midAngle: number;
  innerRadius: number;
  outerRadius: number;
  percent: number;
  name: string;
}) {
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 1.4;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  if (percent < 0.03) return null;
  return (
    <text
      x={x}
      y={y}
      fill="currentColor"
      className="text-xs fill-foreground"
      textAnchor={x > cx ? "start" : "end"}
      dominantBaseline="central"
    >
      {name} ({(percent * 100).toFixed(0)}%)
    </text>
  );
}

export default function DashboardPage() {
  const stats = trpc.dashboard.getStats.useQuery();
  const charts = trpc.dashboard.getCharts.useQuery();
  const taxConfig = trpc.billing.getTaxConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const currency = taxConfig.data?.currency ?? "usd";
  const country = taxConfig.data?.country ?? "US";
  const fmtMoney = (v: number) => formatCurrency(v, currency, country);

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 1
  )
    .toISOString()
    .slice(0, 10);

  const upcoming = trpc.appointments.list.useQuery({
    startDate: todayStr,
    endDate: tomorrowStr,
  });

  const upcomingAppointments = (upcoming.data ?? [])
    .filter(
      (a) =>
        a.status !== "checked_out" &&
        a.status !== "cancelled" &&
        a.status !== "no_show"
    )
    .slice(0, 5);

  // A brand-new practice has no real activity yet. Hide the charts until there
  // is something to show so the page feels calm instead of abandoned.
  const cd = charts.data;
  const hasChartData =
    !!cd &&
    (cd.speciesDistribution.length > 0 ||
      cd.appointmentsByDay.some(
        (d) => d.completed + d.scheduled + d.cancelled > 0
      ) ||
      cd.revenueByDay.some((d) => d.revenue > 0));

  return (
    <div className="space-y-8">
      <WelcomePanel />
      <ActivationChecklist />
      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.isLoading
          ? Array.from({ length: 4 }).map((_, i) => <KpiSkeleton key={i} />)
          : kpiConfig.map((kpi) => {
              const Icon = kpi.icon;
              const value = stats.data?.[kpi.key] ?? 0;
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
                      <p className="text-sm text-muted-foreground">
                        {kpi.label}
                      </p>
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

      {/* Recent Appointments */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-6 py-4">
          <h2 className="font-heading text-lg font-semibold">
            Upcoming Appointments
          </h2>
        </div>
        <div className="space-y-2 p-4">
          {upcoming.isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <AppointmentRowSkeleton key={i} />
            ))
          ) : upcomingAppointments.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Calendar className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium">No visits booked yet</p>
                <p className="text-sm text-muted-foreground">
                  Book your first visit and it shows up here.
                </p>
              </div>
              <Link
                href="/schedule"
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Book your first visit
              </Link>
            </div>
          ) : (
            upcomingAppointments.map((appt) => (
              <div
                key={appt.id}
                className="flex items-center gap-4 rounded-md border border-border px-4 py-3"
              >
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span>{formatTime(appt.startTime)}</span>
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
                          : "bg-muted text-muted-foreground"
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
      {charts.isLoading ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
          <ChartSkeleton />
        </>
      ) : !hasChartData ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card p-12 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <TrendingUp className="h-5 w-5" />
          </div>
          <p className="font-heading text-base font-semibold">
            Your charts show up once you start
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            As you book visits and send bills, your trends and totals fill in
            here.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {/* Appointments This Week - Bar Chart */}
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="mb-4 font-heading text-lg font-semibold">
                Appointments This Week
              </h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={charts.data?.appointmentsByDay ?? []}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey="date"
                    className="text-xs fill-muted-foreground"
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis
                    allowDecimals={false}
                    className="text-xs fill-muted-foreground"
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "0.5rem",
                      fontSize: "0.875rem",
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: "0.75rem" }} />
                  <Bar
                    dataKey="completed"
                    name="Completed"
                    stackId="a"
                    fill="#22c55e"
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="scheduled"
                    name="Scheduled"
                    stackId="a"
                    fill="#3b82f6"
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="cancelled"
                    name="Cancelled"
                    stackId="a"
                    fill="#ef4444"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Species Distribution - Pie Chart */}
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="mb-4 font-heading text-lg font-semibold">
                Species Distribution
              </h2>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={charts.data?.speciesDistribution ?? []}
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    dataKey="value"
                    label={PieLabel}
                  >
                    {(charts.data?.speciesDistribution ?? []).map((entry) => (
                      <Cell
                        key={entry.name}
                        fill={SPECIES_COLORS[entry.name] ?? "#6b7280"}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "0.5rem",
                      fontSize: "0.875rem",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Revenue Trend - Line Chart */}
          <div className="rounded-lg border border-border bg-card p-6">
            <h2 className="mb-4 font-heading text-lg font-semibold">
              Revenue (Last 30 Days)
            </h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={charts.data?.revenueByDay ?? []}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  className="text-xs fill-muted-foreground"
                  tick={{ fontSize: 12 }}
                />
                <YAxis
                  className="text-xs fill-muted-foreground"
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value: number) =>
                    new Intl.NumberFormat(localeForCountry(country), {
                      style: "currency",
                      currency: currency.toUpperCase(),
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 0,
                    }).format(value)
                  }
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "0.5rem",
                    fontSize: "0.875rem",
                  }}
                  formatter={(value: number) => [fmtMoney(value), "Revenue"]}
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  name="Revenue"
                  stroke="#0d9488"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "#0d9488" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
