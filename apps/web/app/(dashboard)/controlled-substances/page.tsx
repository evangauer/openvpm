"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  ShieldAlert,
  Plus,
  ChevronDown,
  ChevronRight,
  Search,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { TableScroll } from "@/components/common/table-scroll";
import {
  CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_QUANTITY_MAX,
  CONTROLLED_SUBSTANCE_QUANTITY_MIN,
  CONTROLLED_SUBSTANCE_QUANTITY_STEP,
  CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH,
  isControlledSubstanceOptionalTextInputValid,
  isControlledSubstanceQuantityInputValid,
  isControlledSubstanceRequiredTextInputValid,
} from "@/lib/controlled-substances/policy";

const DEA_SCHEDULES = [
  { label: "Schedule II", value: "II" },
  { label: "Schedule III", value: "III" },
  { label: "Schedule IV", value: "IV" },
  { label: "Schedule V", value: "V" },
] as const;

const ACTIONS = [
  { label: "Received", value: "received" },
  { label: "Administered", value: "administered" },
  { label: "Wasted", value: "wasted" },
  { label: "Returned", value: "returned" },
] as const;

const UNITS = [
  { label: "mg", value: "mg" },
  { label: "ml", value: "ml" },
  { label: "tablet", value: "tablet" },
  { label: "capsule", value: "capsule" },
  { label: "vial", value: "vial" },
] as const;

const ACTION_STYLES: Record<string, string> = {
  received: "bg-blue-100 text-blue-700",
  administered: "bg-green-100 text-green-700",
  wasted: "bg-amber-100 text-amber-700",
  returned: "bg-gray-100 text-gray-700",
};

function canManageControlledSubstancesRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

const trimmedOrUndefined = (value: string) => value.trim() || undefined;

function formatControlledSubstanceDateTime(
  date: Date | string,
  timeZone?: string | null,
) {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: timeZone ?? undefined,
  };

  try {
    return new Date(date).toLocaleString("en-US", options);
  } catch {
    return new Date(date).toLocaleString("en-US", {
      ...options,
      timeZone: undefined,
    });
  }
}

function InlineLookupError({ message }: { message: string }) {
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
      <AlertTriangle className="h-3 w-3" />
      {message}
    </p>
  );
}

function LogEntryForm({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const createMutation = trpc.controlledSubstances.create.useMutation({
    onSuccess: () => {
      toast.success("Log entry recorded");
      utils.controlledSubstances.list.invalidate();
      utils.controlledSubstances.summary.invalidate();
      onClose();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const patientsQuery = trpc.patients.list.useQuery({
    limit: 100,
    offset: 0,
  });
  const witnessesQuery = trpc.controlledSubstances.listWitnesses.useQuery();

  const [form, setForm] = useState({
    drugName: "",
    deaSchedule: "II",
    action: "received",
    quantity: "",
    unit: "mg",
    patientId: "",
    witnessedBy: "",
    lotNumber: "",
    notes: "",
  });
  const operationRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const patientsMissing =
    !patientsQuery.isLoading && !patientsQuery.error && !patientsQuery.data;
  const witnessesMissing =
    !witnessesQuery.isLoading && !witnessesQuery.error && !witnessesQuery.data;
  const patientOptions =
    patientsQuery.data && !patientsQuery.error && !patientsMissing
      ? patientsQuery.data.items
      : [];
  const witnessOptions =
    witnessesQuery.data && !witnessesQuery.error && !witnessesMissing
      ? witnessesQuery.data
      : [];
  const patientLookupUnavailable =
    form.action === "administered" &&
    (patientsQuery.isLoading ||
      Boolean(patientsQuery.error) ||
      patientsMissing);
  const witnessLookupUnavailable =
    form.action === "wasted" &&
    (witnessesQuery.isLoading ||
      Boolean(witnessesQuery.error) ||
      witnessesMissing);
  const canSubmit =
    isControlledSubstanceRequiredTextInputValid(
      form.drugName,
      CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH,
    ) &&
    isControlledSubstanceQuantityInputValid(form.quantity) &&
    isControlledSubstanceRequiredTextInputValid(
      form.unit,
      CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH,
    ) &&
    isControlledSubstanceOptionalTextInputValid(
      form.lotNumber,
      CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH,
    ) &&
    isControlledSubstanceOptionalTextInputValid(
      form.notes,
      CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH,
    ) &&
    (form.action !== "administered" || Boolean(form.patientId)) &&
    (form.action !== "wasted" || Boolean(form.witnessedBy)) &&
    !patientLookupUnavailable &&
    !witnessLookupUnavailable &&
    !createMutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (patientLookupUnavailable) {
      toast.error(
        patientsQuery.error?.message ??
          (patientsMissing
            ? "Patient lookup is unavailable. Please retry."
            : "Patient lookup is still loading"),
      );
      return;
    }
    if (witnessLookupUnavailable) {
      toast.error(
        witnessesQuery.error?.message ??
          (witnessesMissing
            ? "Witness lookup is unavailable. Please retry."
            : "Witness lookup is still loading"),
      );
      return;
    }
    if (form.action === "administered" && !form.patientId) {
      toast.error("Patient is required for administered entries");
      return;
    }
    if (form.action === "wasted" && !form.witnessedBy) {
      toast.error("Witness is required for wasted entries");
      return;
    }
    const payload = {
      drugName: form.drugName.trim(),
      deaSchedule: form.deaSchedule as "II" | "III" | "IV" | "V",
      action: form.action as
        | "received"
        | "administered"
        | "wasted"
        | "returned",
      quantity: form.quantity.trim(),
      unit: form.unit.trim(),
      patientId: form.patientId || undefined,
      witnessedBy: form.witnessedBy || undefined,
      lotNumber: trimmedOrUndefined(form.lotNumber),
      notes: trimmedOrUndefined(form.notes),
    };
    const fingerprint = JSON.stringify(payload);
    const operationId =
      operationRef.current?.fingerprint === fingerprint
        ? operationRef.current.id
        : crypto.randomUUID();
    operationRef.current = { fingerprint, id: operationId };
    createMutation.mutate({ ...payload, operationId });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-lg border border-border bg-card p-4 space-y-3"
    >
      <h3 className="font-medium text-sm">New Log Entry</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Drug Name *
          </label>
          <Input
            placeholder="Drug name"
            value={form.drugName}
            maxLength={CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH}
            onChange={(e) => setForm({ ...form, drugName: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            DEA Schedule
          </label>
          <select
            value={form.deaSchedule}
            onChange={(e) => setForm({ ...form, deaSchedule: e.target.value })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {DEA_SCHEDULES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Action
          </label>
          <select
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Quantity *
            </label>
            <Input
              type="number"
              step={CONTROLLED_SUBSTANCE_QUANTITY_STEP}
              min={CONTROLLED_SUBSTANCE_QUANTITY_MIN}
              max={CONTROLLED_SUBSTANCE_QUANTITY_MAX}
              placeholder="Qty"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Unit
            </label>
            <select
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Patient {form.action === "administered" && "*"}
          </label>
          <select
            value={form.patientId}
            onChange={(e) => setForm({ ...form, patientId: e.target.value })}
            required={form.action === "administered"}
            disabled={
              patientsQuery.isLoading ||
              Boolean(patientsQuery.error) ||
              patientsMissing
            }
            className={[
              "flex h-10 w-full rounded-md border border-input bg-background",
              "px-3 py-2 text-sm",
            ].join(" ")}
          >
            <option value="">
              {patientsQuery.error || patientsMissing
                ? "Unable to load patients"
                : patientsQuery.isLoading
                  ? "Loading patients..."
                  : "No patient"}
            </option>
            {patientOptions.map((patient) => (
              <option key={patient.id} value={patient.id}>
                {patient.name}
                {patient.clientFirstName || patient.clientLastName
                  ? ` (${[patient.clientFirstName, patient.clientLastName]
                      .filter(Boolean)
                      .join(" ")})`
                  : ""}
              </option>
            ))}
          </select>
          {patientsQuery.error || patientsMissing ? (
            <InlineLookupError
              message={
                patientsQuery.error?.message ??
                "Patient lookup returned no data. Please retry before recording an administered dose."
              }
            />
          ) : null}
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Witness {form.action === "wasted" && "*"}
          </label>
          <select
            value={form.witnessedBy}
            onChange={(e) => setForm({ ...form, witnessedBy: e.target.value })}
            required={form.action === "wasted"}
            disabled={
              witnessesQuery.isLoading ||
              Boolean(witnessesQuery.error) ||
              witnessesMissing
            }
            className={[
              "flex h-10 w-full rounded-md border border-input bg-background",
              "px-3 py-2 text-sm",
            ].join(" ")}
          >
            <option value="">
              {witnessesQuery.error || witnessesMissing
                ? "Unable to load witnesses"
                : witnessesQuery.isLoading
                  ? "Loading witnesses..."
                  : "No witness"}
            </option>
            {witnessOptions.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} ({user.role.replace("_", " ")})
              </option>
            ))}
          </select>
          {witnessesQuery.error || witnessesMissing ? (
            <InlineLookupError
              message={
                witnessesQuery.error?.message ??
                "Witness lookup returned no data. Please retry before recording wasted inventory."
              }
            />
          ) : null}
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Lot Number
          </label>
          <Input
            placeholder="Lot #"
            value={form.lotNumber}
            maxLength={CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH}
            onChange={(e) => setForm({ ...form, lotNumber: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Notes
          </label>
          <Input
            placeholder="Optional notes"
            value={form.notes}
            maxLength={CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {createMutation.isPending ? "Submitting..." : "Submit Entry"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {createMutation.error && (
        <p className="text-sm text-destructive">
          {createMutation.error.message}
        </p>
      )}
    </form>
  );
}

function SummarySection() {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = trpc.controlledSubstances.summary.useQuery({});
  const summaryMissing = !isLoading && !error && !data;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/30 transition-colors"
      >
        <span>Drug Balance Summary</span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          {error || summaryMissing ? (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {error?.message ??
                "Unable to load controlled-substance balances. Please retry."}
            </div>
          ) : isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading summary...
            </div>
          ) : data && data.length > 0 ? (
            <TableScroll>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 text-left font-medium text-muted-foreground">
                      Drug
                    </th>
                    <th className="py-2 text-right font-medium text-muted-foreground">
                      Received
                    </th>
                    <th className="py-2 text-right font-medium text-muted-foreground">
                      Administered
                    </th>
                    <th className="py-2 text-right font-medium text-muted-foreground">
                      Wasted
                    </th>
                    <th className="py-2 text-right font-medium text-muted-foreground">
                      Returned
                    </th>
                    <th className="py-2 text-right font-medium text-muted-foreground">
                      Net Balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((drug) => (
                    <tr
                      key={drug.drugName}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="py-2 font-medium">{drug.drugName}</td>
                      <td className="py-2 text-right tabular-nums text-blue-600">
                        {drug.totalReceived}
                      </td>
                      <td className="py-2 text-right tabular-nums text-green-600">
                        {drug.totalAdministered}
                      </td>
                      <td className="py-2 text-right tabular-nums text-amber-600">
                        {drug.totalWasted}
                      </td>
                      <td className="py-2 text-right tabular-nums text-gray-600">
                        {drug.totalReturned}
                      </td>
                      <td className="py-2 text-right tabular-nums font-semibold">
                        {(
                          Number(drug.totalReceived) -
                          Number(drug.totalAdministered) -
                          Number(drug.totalWasted) -
                          Number(drug.totalReturned)
                        ).toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          ) : (
            <EmptyState
              className="border-0 bg-transparent py-6"
              icon={ShieldAlert}
              title="No balance data yet"
              description="Balance totals will appear once controlled-substance entries are logged."
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function ControlledSubstancesPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking controlled-substance access...
        </div>
      </div>
    );
  }

  if (!canManageControlledSubstancesRole(session?.user?.role)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Controlled substance log is restricted"
        description="Only administrators and veterinarians can view or record controlled-substance activity."
        action={{
          label: "Back to dashboard",
          onClick: () => router.push("/"),
        }}
      />
    );
  }

  return <ControlledSubstancesLogPage />;
}

function ControlledSubstancesLogPage() {
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const searchFilter = search.trim();
  const settingsQuery = trpc.controlledSubstances.settings.useQuery();

  const { data, isLoading, error } = trpc.controlledSubstances.list.useQuery({
    drugName: searchFilter || undefined,
    limit,
    offset,
  });
  const logError = settingsQuery.error ?? error;
  const isLogLoading = settingsQuery.isLoading || isLoading;
  const settingsMissing =
    !settingsQuery.isLoading && !settingsQuery.error && !settingsQuery.data;
  const logMissing = !isLoading && !error && !data;
  const controlledSubstanceLogMissing = settingsMissing || logMissing;
  const verifiedLogPayload =
    !logError &&
    !isLogLoading &&
    !controlledSubstanceLogMissing &&
    settingsQuery.data &&
    data
      ? { settings: settingsQuery.data, log: data }
      : null;
  const canRecordControlledSubstance = Boolean(verifiedLogPayload);

  useEffect(() => {
    if (!canRecordControlledSubstance && showForm) {
      setShowForm(false);
    }
  }, [canRecordControlledSubstance, showForm]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">
            Controlled Substance Log
          </h2>
          <p className="text-sm text-muted-foreground">
            DEA-required tracking for scheduled drugs
          </p>
        </div>
        <Button
          disabled={!canRecordControlledSubstance}
          onClick={() => {
            if (!canRecordControlledSubstance) return;
            setShowForm(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          Log Entry
        </Button>
      </div>

      {canRecordControlledSubstance && showForm && (
        <LogEntryForm onClose={() => setShowForm(false)} />
      )}

      {/* Summary Section */}
      <div className="mt-6">
        <SummarySection />
      </div>

      {/* Search / Filter */}
      <div className="mt-4 flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by drug name..."
            value={search}
            maxLength={CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
            className="pl-9"
          />
        </div>
      </div>

      {logError || controlledSubstanceLogMissing ? (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {logError?.message ??
            "Unable to load controlled-substance entries. Please retry."}
        </div>
      ) : isLogLoading ? (
        <div className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading controlled-substance entries...
        </div>
      ) : !verifiedLogPayload ? (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Unable to load controlled-substance entries. Please retry.
        </div>
      ) : verifiedLogPayload.log.items.length > 0 ? (
        <>
          <TableScroll className="mt-4 rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Date/Time
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Drug Name
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Schedule
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Action
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Qty/Unit
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Patient
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Performed By
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Witness
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {verifiedLogPayload.log.items.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {entry.performedAt
                        ? formatControlledSubstanceDateTime(
                            entry.performedAt,
                            verifiedLogPayload.settings.timezone,
                          )
                        : "\u2014"}
                    </td>
                    <td className="px-4 py-3 font-medium">{entry.drugName}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.deaSchedule}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                          ACTION_STYLES[entry.action] ??
                          "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {entry.quantity} {entry.unit}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.patientName || "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.performerName || "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.witnessName || "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">
                      {entry.notes || "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <p>
              Showing {offset + 1}&ndash;
              {Math.min(offset + limit, verifiedLogPayload.log.total)} of{" "}
              {verifiedLogPayload.log.total}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + limit >= verifiedLogPayload.log.total}
                onClick={() => setOffset(offset + limit)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : (
        <EmptyState
          className="mt-6"
          icon={ShieldAlert}
          title={
            search
              ? "No entries match your filter"
              : "No controlled substance entries yet"
          }
          description={
            search
              ? "Try a different drug name or clear the filter."
              : "Record each received, administered, wasted, or returned scheduled-drug event here."
          }
          action={
            search
              ? undefined
              : {
                  label: "Log first entry",
                  onClick: () => {
                    if (!canRecordControlledSubstance) return;
                    setShowForm(true);
                  },
                  icon: Plus,
                }
          }
        />
      )}
    </div>
  );
}
