"use client";

import { Activity } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  hasTrendValues,
  type LabTrendGroup,
  type VitalTrendPoint,
  type WeightTrendPoint,
} from "@/lib/records/clinical-trends";

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number | string | null;
    color?: string;
  }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <div className="space-y-1">
        {payload
          .filter((entry) => entry.value !== null && entry.value !== undefined)
          .map((entry) => (
            <div key={entry.name} className="flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-muted-foreground">{entry.name}</span>
              <span className="font-medium text-foreground">{entry.value}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

export function WeightTrendChart({ data }: { data: WeightTrendPoint[] }) {
  if (data.length < 2) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center">
        <Activity className="mx-auto h-8 w-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">
          Not enough weight history for a trend yet.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="font-heading text-base font-semibold">Weight Trend</h3>
          <p className="text-sm text-muted-foreground">
            {data[0]!.weightKg} kg to {data[data.length - 1]!.weightKg} kg
          </p>
        </div>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="dateLabel"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
            />
            <YAxis
              width={44}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
              domain={["dataMin - 1", "dataMax + 1"]}
            />
            <Tooltip content={<ChartTooltip />} />
            <Line
              type="monotone"
              dataKey="weightKg"
              name="Weight kg"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function VitalsTrendChart({ data }: { data: VitalTrendPoint[] }) {
  const hasTemp = hasTrendValues(data, ["temperatureC"]);
  const hasRates = hasTrendValues(data, ["heartRateBpm", "respiratoryRateBpm"]);
  const hasScores = hasTrendValues(data, ["bodyConditionScore", "painScore"]);

  if (data.length < 2 || (!hasTemp && !hasRates && !hasScores)) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center">
        <Activity className="mx-auto h-8 w-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">
          Not enough vitals history for trends yet.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {hasTemp && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="font-heading text-base font-semibold">Temperature</h3>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="dateLabel" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis width={44} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} domain={["dataMin - 0.5", "dataMax + 0.5"]} />
                <Tooltip content={<ChartTooltip />} />
                <Line type="monotone" dataKey="temperatureC" name="Temp C" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {hasRates && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="font-heading text-base font-semibold">Heart / Respiratory Rate</h3>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="dateLabel" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis width={44} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
                <Tooltip content={<ChartTooltip />} />
                <Line type="monotone" dataKey="heartRateBpm" name="HR bpm" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                <Line type="monotone" dataKey="respiratoryRateBpm" name="RR bpm" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {hasScores && (
        <div className="rounded-lg border border-border bg-card p-4 lg:col-span-2">
          <h3 className="font-heading text-base font-semibold">Body / Pain Scores</h3>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="dateLabel" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis width={44} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} domain={[0, 10]} />
                <Tooltip content={<ChartTooltip />} />
                <Line type="monotone" dataKey="bodyConditionScore" name="BCS" stroke="#0d9488" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                <Line type="monotone" dataKey="painScore" name="Pain" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function formatLabValue(value: number, unit: string | null): string {
  return `${Number.isInteger(value) ? value : value.toFixed(2)}${unit ? ` ${unit}` : ""}`;
}

export function LabTrendCharts({ groups }: { groups: LabTrendGroup[] }) {
  if (groups.length === 0) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.map((group) => {
        const latest = group.points[group.points.length - 1]!;
        const changeLabel =
          group.change === 0
            ? "No change"
            : `${group.change > 0 ? "+" : ""}${formatLabValue(
                group.change,
                group.unit
              )} from prior`;
        const rangeLabel =
          latest.referenceRangeLow !== null && latest.referenceRangeHigh !== null
            ? `${latest.referenceRangeLow} - ${latest.referenceRangeHigh}${
                group.unit ? ` ${group.unit}` : ""
              }`
            : "No reference range";

        return (
          <div key={group.key} className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="font-heading text-base font-semibold">
                  {group.testName}
                </h3>
                <p className="text-xs text-muted-foreground">{rangeLabel}</p>
              </div>
              <div className="text-left sm:text-right">
                <p className="text-sm font-semibold">
                  {formatLabValue(group.latestValue, group.unit)}
                </p>
                <p className="text-xs text-muted-foreground">{changeLabel}</p>
              </div>
            </div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={group.points}
                  margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="dateLabel"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "hsl(var(--border))" }}
                  />
                  <YAxis
                    width={44}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "hsl(var(--border))" }}
                    domain={["dataMin - 1", "dataMax + 1"]}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    name={group.unit ? `Result ${group.unit}` : "Result"}
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}
