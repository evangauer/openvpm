"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  DollarSign,
  CalendarCheck,
  UserX,
  XCircle,
  TrendingUp,
  Package,
  AlertTriangle,
  CheckCircle,
  Activity,
  BarChart3,
  Download,
  Loader2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  isCompleteReportDateRangeInputValid,
  reportPresetDateRange,
  reportDateRangeInputError,
  type ReportDatePreset,
} from "@/lib/reports/date-range";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { useCurrencyFormatter } from "@/lib/locale/useCurrency";

function ReportChartChunkLoading() {
  return (
    <div className="h-[300px] w-full animate-pulse rounded-md bg-muted" />
  );
}

const RevenueLineChart = dynamic(
  () =>
    import("@/components/reports/report-charts").then(
      (mod) => mod.RevenueLineChart
    ),
  {
    ssr: false,
    loading: ReportChartChunkLoading,
  }
);

const ServicesCountChart = dynamic(
  () =>
    import("@/components/reports/report-charts").then(
      (mod) => mod.ServicesCountChart
    ),
  {
    ssr: false,
    loading: ReportChartChunkLoading,
  }
);

type Tab = "revenue" | "appointments" | "services" | "inventory";
type DateRange = { startDate: string; endDate: string };
type ReportPdfCell = string | number | null | undefined;

const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "revenue", label: "Revenue", icon: DollarSign },
  { key: "appointments", label: "Appointments", icon: CalendarCheck },
  { key: "services", label: "Services", icon: BarChart3 },
  { key: "inventory", label: "Inventory", icon: Package },
];

function canViewReportsRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

function KpiCard({
  title,
  value,
  subtitle,
  icon: Icon,
  className,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-5", className)}>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-2xl font-semibold tracking-tight">{value}</p>
          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
    />
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

function defaultClientReportDateRange(
  now = new Date(),
  timeZone?: string | null
): DateRange {
  return reportPresetDateRange("last30", now, timeZone);
}

function reportFilename(
  tab: Tab,
  range?: { startDate: string; endDate: string },
  extension = "csv"
) {
  const suffix = range ? `${range.startDate}_to_${range.endDate}` : "current";
  return `${tab}-report-${suffix}.${extension}`;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function downloadCsv(filename: string, rows: unknown[][]) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function downloadReportPdf({
  filename,
  title,
  subtitle,
  columns,
  rows,
  emptyMessage,
}: {
  filename: string;
  title: string;
  subtitle?: string;
  columns: string[];
  rows: ReportPdfCell[][];
  emptyMessage?: string;
}) {
  const { generateReportPdf } = await import("@/lib/pdf");
  generateReportPdf({
    title,
    subtitle,
    columns,
    rows,
    emptyMessage,
  }).save(filename);
}

function ReportExportButtons({
  onCsv,
  onPdf,
}: {
  onCsv: () => void;
  onPdf: () => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="outline" size="sm" onClick={onCsv} className="gap-2">
        <Download className="h-4 w-4" />
        Export CSV
      </Button>
      <Button variant="outline" size="sm" onClick={onPdf} className="gap-2">
        <Download className="h-4 w-4" />
        Export PDF
      </Button>
    </div>
  );
}

function ReportError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
      <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
      <p className="mt-3 font-medium">Could not load report</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-4">
        Retry
      </Button>
    </div>
  );
}

function ReportMissingData({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Could not load report data"
      description="The report request finished without returning data. Try loading it again."
      action={{ label: "Retry", onClick: onRetry }}
      className="border-destructive/30 bg-destructive/5"
    />
  );
}

function DateRangeControls({
  value,
  onChange,
  timeZone,
  validationMessage,
}: {
  value: DateRange;
  onChange: (next: DateRange) => void;
  timeZone?: string | null;
  validationMessage?: string | null;
}) {
  const setPreset = (preset: ReportDatePreset) => {
    onChange(reportPresetDateRange(preset, new Date(), timeZone));
  };
  const errorId = validationMessage ? "reports-date-range-error" : undefined;

  return (
    <div className="mt-4 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-muted-foreground">
            Start
            <Input
              type="date"
              value={value.startDate}
              aria-invalid={Boolean(validationMessage) || undefined}
              aria-describedby={errorId}
              onChange={(event) =>
                onChange({ ...value, startDate: event.target.value })
              }
              className="mt-1"
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            End
            <Input
              type="date"
              value={value.endDate}
              aria-invalid={Boolean(validationMessage) || undefined}
              aria-describedby={errorId}
              onChange={(event) =>
                onChange({ ...value, endDate: event.target.value })
              }
              className="mt-1"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreset("last30")}
          >
            Last 30 Days
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreset("month")}
          >
            Month to Date
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreset("lastMonth")}
          >
            Last Month
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPreset("year")}>
            Year to Date
          </Button>
        </div>
      </div>
      {validationMessage ? (
        <p
          id="reports-date-range-error"
          className="mt-2 text-xs text-destructive"
        >
          {validationMessage}
        </p>
      ) : null}
    </div>
  );
}

function ReportDateRangeInvalid({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
      <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
      <p className="mt-3 font-medium">Choose a valid report date range</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function RevenueTab({ dateRange }: { dateRange: DateRange }) {
  const formatCurrency = useCurrencyFormatter();
  const { data, isLoading, isError, error, refetch } =
    trpc.reports.revenue.useQuery(dateRange);

  if (isError) {
    return <ReportError message={error.message} onRetry={() => refetch()} />;
  }
  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <ReportMissingData onRetry={() => refetch()} />;

  // A percent against a $0 previous period is meaningless; call it new
  // revenue instead of "+100%".
  const diff =
    data.previousTotal > 0
      ? Math.round(
          ((data.total - data.previousTotal) / data.previousTotal) * 100
        )
      : null;
  const rangeSubtitle =
    diff !== null && diff !== 0
      ? `${diff > 0 ? "+" : ""}${diff}% vs previous period`
      : diff === null && data.total > 0
        ? "New revenue this period"
        : undefined;
  const revenueRows = [
    [
      "selected_period_total",
      `${data.range.startDate} to ${data.range.endDate}`,
      data.total,
    ],
    [
      "previous_period_total",
      `${data.range.previousStartDate} to ${data.range.previousEndDate}`,
      data.previousTotal,
    ],
    ...data.daily.map((row) => ["daily_revenue", row.date, row.amount]),
  ];
  const exportRevenue = () =>
    downloadCsv(reportFilename("revenue", data.range), [
      ["metric", "period", "amount"],
      ...revenueRows,
    ]);
  const exportRevenuePdf = () =>
    void downloadReportPdf({
      filename: reportFilename("revenue", data.range, "pdf"),
      title: "Revenue Report",
      subtitle: `${data.range.startDate} to ${data.range.endDate}`,
      columns: ["Metric", "Period", "Amount"],
      rows: revenueRows.map(([metric, period, amount]) => [
        metric,
        period,
        formatCurrency(Number(amount)),
      ]),
      emptyMessage: "No revenue data for this period.",
    });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <KpiCard
          title="Selected Range"
          value={formatCurrency(data.total)}
          subtitle={rangeSubtitle}
          icon={DollarSign}
        />
        <KpiCard
          title="Previous Period"
          value={formatCurrency(data.previousTotal)}
          icon={TrendingUp}
        />
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            Daily Revenue
          </h3>
          <ReportExportButtons
            onCsv={exportRevenue}
            onPdf={exportRevenuePdf}
          />
        </div>
        {data.daily.length > 0 ? (
          <RevenueLineChart
            daily={data.daily}
            formatCurrency={formatCurrency}
          />
        ) : (
          <EmptyState
            className="border-0 bg-transparent py-12"
            icon={DollarSign}
            title="No revenue data for this period"
            description="Paid invoices will appear here once they fall inside the selected date range."
          />
        )}
      </div>
    </div>
  );
}

function AppointmentsTab({ dateRange }: { dateRange: DateRange }) {
  const { data, isLoading, isError, error, refetch } =
    trpc.reports.appointments.useQuery(dateRange);

  if (isError) {
    return <ReportError message={error.message} onRetry={() => refetch()} />;
  }
  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <ReportMissingData onRetry={() => refetch()} />;

  const appointmentRows = [
    [
      "summary",
      "",
      data.total,
      data.completed,
      data.noShows,
      data.cancelled,
      data.fillRate,
    ],
    ...data.byDoctor.map((doc) => [
      "doctor",
      doc.doctorName,
      doc.total,
      doc.completed,
      "",
      "",
      doc.total > 0 ? Math.round((doc.completed / doc.total) * 100) : 0,
    ]),
  ];
  const exportAppointments = () =>
    downloadCsv(reportFilename("appointments", data.range), [
      ["section", "doctor", "total", "completed", "no_shows", "cancelled", "fill_rate"],
      ...appointmentRows,
    ]);
  const exportAppointmentsPdf = () =>
    void downloadReportPdf({
      filename: reportFilename("appointments", data.range, "pdf"),
      title: "Appointments Report",
      subtitle: `${data.range.startDate} to ${data.range.endDate}`,
      columns: [
        "Section",
        "Doctor",
        "Total",
        "Completed",
        "No-shows",
        "Cancelled",
        "Fill Rate",
      ],
      rows: appointmentRows.map((row) => [
        row[0],
        row[1],
        row[2],
        row[3],
        row[4],
        row[5],
        `${row[6]}%`,
      ]),
      emptyMessage: "No appointment data for this period.",
    });

  return (
    <div className="space-y-6">
      <ReportExportButtons
        onCsv={exportAppointments}
        onPdf={exportAppointmentsPdf}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Total" value={String(data.total)} icon={CalendarCheck} />
        <KpiCard
          title="Completed"
          value={String(data.completed)}
          icon={CheckCircle}
        />
        <KpiCard title="No-Shows" value={String(data.noShows)} icon={UserX} />
        <KpiCard
          title="Cancellations"
          value={String(data.cancelled)}
          icon={XCircle}
        />
      </div>

      {/* Fill rate */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">
            Fill Rate
          </h3>
          <span className="text-lg font-semibold">{data.fillRate}%</span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-teal-600 transition-all"
            style={{ width: `${Math.min(data.fillRate, 100)}%` }}
          />
        </div>
      </div>

      {/* Doctor breakdown */}
      {data.byDoctor.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-4 text-sm font-medium text-muted-foreground">
            Doctor Breakdown
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Doctor</th>
                  <th className="pb-2 font-medium text-right">Total</th>
                  <th className="pb-2 font-medium text-right">Completed</th>
                  <th className="pb-2 font-medium text-right">Completion Rate</th>
                </tr>
              </thead>
              <tbody>
                {data.byDoctor.map((doc) => (
                  <tr key={doc.doctorName} className="border-b border-border last:border-0">
                    <td className="py-2">{doc.doctorName}</td>
                    <td className="py-2 text-right">{doc.total}</td>
                    <td className="py-2 text-right">{doc.completed}</td>
                    <td className="py-2 text-right">
                      {doc.total > 0
                        ? Math.round((doc.completed / doc.total) * 100)
                        : 0}
                      %
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={CalendarCheck}
          title="No doctor breakdown available"
          description="Appointments will be grouped by assigned doctor for the selected date range."
        />
      )}
    </div>
  );
}

function ServicesTab({ dateRange }: { dateRange: DateRange }) {
  const formatCurrency = useCurrencyFormatter();
  const { data, isLoading, isError, error, refetch } =
    trpc.reports.topServices.useQuery(dateRange);

  if (isError) {
    return <ReportError message={error.message} onRetry={() => refetch()} />;
  }
  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <ReportMissingData onRetry={() => refetch()} />;

  const serviceRows = data.items.map((svc) => [
    svc.name,
    svc.count,
    svc.revenue,
  ]);
  const exportServices = () =>
    downloadCsv(reportFilename("services", data.range), [
      ["service", "count", "revenue"],
      ...serviceRows,
    ]);
  const exportServicesPdf = () =>
    void downloadReportPdf({
      filename: reportFilename("services", data.range, "pdf"),
      title: "Services Report",
      subtitle: `${data.range.startDate} to ${data.range.endDate}`,
      columns: ["Service", "Count", "Revenue"],
      rows: serviceRows.map(([name, count, revenue]) => [
        name,
        count,
        formatCurrency(Number(revenue)),
      ]),
      emptyMessage: "No billed service items were found for the selected range.",
    });

  if (data.items.length === 0) {
    return (
      <div className="space-y-4">
        <ReportExportButtons
          onCsv={exportServices}
          onPdf={exportServicesPdf}
        />
        <EmptyState
          icon={BarChart3}
          title="No service data available"
          description="No billed service items were found for the selected range."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            Top 10 Services by Count
          </h3>
          <ReportExportButtons
            onCsv={exportServices}
            onPdf={exportServicesPdf}
          />
        </div>
        <ServicesCountChart items={data.items} />
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="mb-4 text-sm font-medium text-muted-foreground">
          Service Details
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-2 font-medium">Service</th>
                <th className="pb-2 font-medium text-right">Count</th>
                <th className="pb-2 font-medium text-right">Total Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((svc) => (
                <tr key={svc.name} className="border-b border-border last:border-0">
                  <td className="py-2">{svc.name}</td>
                  <td className="py-2 text-right">{svc.count}</td>
                  <td className="py-2 text-right">{formatCurrency(svc.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function InventoryTab() {
  const { data, isLoading, isError, error, refetch } =
    trpc.reports.inventoryAlerts.useQuery();

  if (isError) {
    return <ReportError message={error.message} onRetry={() => refetch()} />;
  }
  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <ReportMissingData onRetry={() => refetch()} />;

  const hasAlerts =
    data.lowStock.length > 0 ||
    data.expired.length > 0 ||
    data.expiringSoon.length > 0;
  const inventoryRows = [
    ...data.lowStock.map((item) => [
      "low_stock",
      item.name,
      item.sku ?? "",
      item.stockQuantity,
      item.reorderPoint ?? 10,
      "",
    ]),
    ...data.expired.map((item) => [
      "expired",
      item.name,
      item.sku ?? "",
      item.stockQuantity,
      "",
      item.expirationDate,
    ]),
    ...data.expiringSoon.map((item) => [
      "expiring_soon",
      item.name,
      item.sku ?? "",
      item.stockQuantity,
      "",
      item.expirationDate,
    ]),
  ];
  const exportInventory = () =>
    downloadCsv(reportFilename("inventory"), [
      ["section", "product", "sku", "stock", "reorder_point", "expiration_date"],
      ...inventoryRows,
    ]);
  const exportInventoryPdf = () =>
    void downloadReportPdf({
      filename: reportFilename("inventory", undefined, "pdf"),
      title: "Inventory Alerts Report",
      columns: [
        "Section",
        "Product",
        "SKU",
        "Stock",
        "Reorder Point",
        "Expiration",
      ],
      rows: inventoryRows,
      emptyMessage: "No low stock, expired, or expiring products detected.",
    });

  if (!hasAlerts) {
    return (
      <div className="space-y-4">
        <ReportExportButtons
          onCsv={exportInventory}
          onPdf={exportInventoryPdf}
        />
        <EmptyState
          icon={CheckCircle}
          title="All stock levels OK"
          description="No low stock, expired, or expiring products detected."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ReportExportButtons
        onCsv={exportInventory}
        onPdf={exportInventoryPdf}
      />
      {/* Low Stock Alerts */}
      {data.lowStock.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-5 dark:border-amber-900 dark:bg-amber-950/20">
          <div className="mb-4 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            <h3 className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Low Stock Alerts ({data.lowStock.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-amber-200 text-left text-amber-700 dark:border-amber-800 dark:text-amber-400">
                  <th className="pb-2 font-medium">Product</th>
                  <th className="pb-2 font-medium">SKU</th>
                  <th className="pb-2 font-medium text-right">Stock</th>
                  <th className="pb-2 font-medium text-right">Reorder Point</th>
                </tr>
              </thead>
              <tbody>
                {data.lowStock.map((item) => (
                  <tr
                    key={item.sku ?? item.name}
                    className="border-b border-amber-100 last:border-0 dark:border-amber-900"
                  >
                    <td className="py-2">{item.name}</td>
                    <td className="py-2 text-muted-foreground">{item.sku ?? "-"}</td>
                    <td className="py-2 text-right font-medium">{item.stockQuantity}</td>
                    <td className="py-2 text-right">{item.reorderPoint ?? 10}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Expired Products */}
      {data.expired.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50/50 p-5 dark:border-red-900 dark:bg-red-950/20">
          <div className="mb-4 flex items-center gap-2">
            <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
            <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
              Expired Products ({data.expired.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-red-200 text-left text-red-700 dark:border-red-800 dark:text-red-400">
                  <th className="pb-2 font-medium">Product</th>
                  <th className="pb-2 font-medium">SKU</th>
                  <th className="pb-2 font-medium text-right">Stock</th>
                  <th className="pb-2 font-medium text-right">Expiration Date</th>
                </tr>
              </thead>
              <tbody>
                {data.expired.map((item) => (
                  <tr
                    key={item.sku ?? item.name}
                    className="border-b border-red-100 last:border-0 dark:border-red-900"
                  >
                    <td className="py-2">{item.name}</td>
                    <td className="py-2 text-muted-foreground">{item.sku ?? "-"}</td>
                    <td className="py-2 text-right">{item.stockQuantity}</td>
                    <td className="py-2 text-right font-medium">{item.expirationDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Expiring Soon */}
      {data.expiringSoon.length > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50/50 p-5 dark:border-orange-900 dark:bg-orange-950/20">
          <div className="mb-4 flex items-center gap-2">
            <Activity className="h-5 w-5 text-orange-600 dark:text-orange-400" />
            <h3 className="text-sm font-medium text-orange-800 dark:text-orange-300">
              Expiring Soon ({data.expiringSoon.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-orange-200 text-left text-orange-700 dark:border-orange-800 dark:text-orange-400">
                  <th className="pb-2 font-medium">Product</th>
                  <th className="pb-2 font-medium">SKU</th>
                  <th className="pb-2 font-medium text-right">Stock</th>
                  <th className="pb-2 font-medium text-right">Expiration Date</th>
                </tr>
              </thead>
              <tbody>
                {data.expiringSoon.map((item) => (
                  <tr
                    key={item.sku ?? item.name}
                    className="border-b border-orange-100 last:border-0 dark:border-orange-900"
                  >
                    <td className="py-2">{item.name}</td>
                    <td className="py-2 text-muted-foreground">{item.sku ?? "-"}</td>
                    <td className="py-2 text-right">{item.stockQuantity}</td>
                    <td className="py-2 text-right font-medium">{item.expirationDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking report access...
        </div>
      </div>
    );
  }

  if (!canViewReportsRole(session?.user?.role)) {
    return (
      <EmptyState
        icon={BarChart3}
        title="Reports are restricted"
        description="Only administrators and veterinarians can view practice reports."
        action={{
          label: "Back to dashboard",
          onClick: () => router.push("/"),
        }}
      />
    );
  }

  return <ReportsDashboard />;
}

function ReportsDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("revenue");
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const settingsQuery = trpc.reports.settings.useQuery();
  const reportSettings = settingsQuery.data;

  useEffect(() => {
    if (dateRange === null && reportSettings !== undefined) {
      setDateRange(
        defaultClientReportDateRange(new Date(), reportSettings.timezone)
      );
    }
  }, [dateRange, reportSettings]);

  const needsDateRange = activeTab !== "inventory";
  const dateRangeError = needsDateRange ? settingsQuery.error : null;
  const settingsMissingData =
    needsDateRange &&
    !settingsQuery.isLoading &&
    !settingsQuery.error &&
    reportSettings === undefined;
  const reportSettingsReady =
    !needsDateRange || Boolean(reportSettings && !settingsQuery.error);
  const dateRangeValidationMessage =
    needsDateRange && dateRange ? reportDateRangeInputError(dateRange) : null;
  const hasValidDateRange =
    reportSettingsReady &&
    (!needsDateRange ||
      Boolean(dateRange && isCompleteReportDateRangeInputValid(dateRange)));
  const canRenderDateRangeControls =
    needsDateRange && dateRange && reportSettings && !settingsQuery.error;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">Reports</h2>
          <p className="text-sm text-muted-foreground">
            Practice analytics and insights
          </p>
        </div>
      </div>

      {canRenderDateRangeControls ? (
        <DateRangeControls
          value={dateRange}
          onChange={setDateRange}
          timeZone={reportSettings.timezone}
          validationMessage={dateRangeValidationMessage}
        />
      ) : null}

      {/* Tabs */}
      <div className="mt-6 flex gap-1 rounded-lg border border-border bg-muted/50 p-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Button
              key={tab.key}
              variant={activeTab === tab.key ? "default" : "ghost"}
              size="sm"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "flex-1 gap-2",
                activeTab === tab.key
                  ? ""
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{tab.label}</span>
            </Button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="mt-6">
        {dateRangeError ? (
          <ReportError
            message={dateRangeError.message}
            onRetry={() => settingsQuery.refetch()}
          />
        ) : settingsMissingData ? (
          <ReportMissingData onRetry={() => settingsQuery.refetch()} />
        ) : needsDateRange && !dateRange ? (
          <LoadingSkeleton />
        ) : dateRangeValidationMessage ? (
          <ReportDateRangeInvalid message={dateRangeValidationMessage} />
        ) : null}
        {activeTab === "revenue" && hasValidDateRange && dateRange && (
          <RevenueTab dateRange={dateRange} />
        )}
        {activeTab === "appointments" && (
          hasValidDateRange && dateRange ? (
            <AppointmentsTab dateRange={dateRange} />
          ) : null
        )}
        {activeTab === "services" && hasValidDateRange && dateRange && (
          <ServicesTab dateRange={dateRange} />
        )}
        {activeTab === "inventory" && <InventoryTab />}
      </div>
    </div>
  );
}
