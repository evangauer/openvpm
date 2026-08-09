"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FlaskConical,
  History,
  Loader2,
  UserRoundCheck,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  dateTimeLocalInputUtcInstant,
  formatDateTimeLocalInputForTimeZone,
} from "@/lib/date-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type InboxFilter =
  | "action_required"
  | "awaiting_results"
  | "awaiting_review"
  | "critical"
  | "follow_up"
  | "all";

type ActionPanel =
  | { kind: "complete"; id: string; operationId: string }
  | { kind: "follow_up"; id: string; operationId: string }
  | { kind: "complete_follow_up"; id: string; operationId: string }
  | null;

type CompletionForm = {
  resultValue: string;
  unit: string;
  referenceRangeLow: string;
  referenceRangeHigh: string;
  resultFlag: "unknown" | "normal" | "abnormal" | "critical";
};

const FILTERS: Array<{ value: InboxFilter; label: string }> = [
  { value: "action_required", label: "Action required" },
  { value: "awaiting_results", label: "Awaiting values" },
  { value: "awaiting_review", label: "Awaiting review" },
  { value: "critical", label: "Critical" },
  { value: "follow_up", label: "Follow-up" },
  { value: "all", label: "All" },
];
const INBOX_FILTER_VALUES = new Set<InboxFilter>(
  FILTERS.map((item) => item.value),
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EMPTY_COMPLETION: CompletionForm = {
  resultValue: "",
  unit: "",
  referenceRangeLow: "",
  referenceRangeHigh: "",
  resultFlag: "unknown",
};

function formatEvidenceTime(
  value: Date | string | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return "Not recorded";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  try {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return date.toLocaleString("en-US");
  }
}

function canManage(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian" || role === "technician";
}

function canReview(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

function LabResultsLoading() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      Loading clinic lab inbox…
    </div>
  );
}

function LabResultHistory({
  resultId,
  timeZone,
}: {
  resultId: string;
  timeZone?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const history = trpc.records.listLabResultHistory.useQuery(
    { id: resultId },
    { enabled: expanded, staleTime: 60_000 },
  );

  return (
    <div className="border-t border-border pt-3">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <History className="mr-1.5 h-4 w-4" aria-hidden="true" />
        {expanded ? "Hide evidence history" : "Show evidence history"}
      </Button>
      {expanded ? (
        <div className="mt-3 space-y-2" aria-live="polite">
          {history.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading evidence…</p>
          ) : history.error ? (
            <p role="alert" className="text-sm text-destructive">
              Evidence history could not be loaded. {history.error.message}
            </p>
          ) : history.data?.length ? (
            <ol className="space-y-2">
              {history.data.map((event) => (
                <li key={event.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium capitalize">
                      {event.eventType.replaceAll("_", " ")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatEvidenceTime(event.createdAt, timeZone)} · {event.actorName}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {event.resultValue
                      ? `Snapshot: ${event.resultValue}${event.unit ? ` ${event.unit}` : ""}${
                          event.referenceRangeLow != null && event.referenceRangeHigh != null
                            ? ` · reference ${event.referenceRangeLow}–${event.referenceRangeHigh}`
                            : ""
                        } · ${event.resultFlag}`
                      : "Values pending at this event"}
                  </p>
                  {event.note ? <p className="mt-1">{event.note}</p> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">
              No immutable event history is available for this legacy result.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function LabResultsInboxContent() {
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<InboxFilter>("action_required");
  const [actionPanel, setActionPanel] = useState<ActionPanel>(null);
  const [completion, setCompletion] = useState<CompletionForm>(EMPTY_COMPLETION);
  const [followUpAssignee, setFollowUpAssignee] = useState("");
  const [followUpDueAt, setFollowUpDueAt] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [followUpOutcome, setFollowUpOutcome] = useState("");
  const reviewOperationIds = useRef(new Map<string, string>());

  const reviewOperationId = (resultId: string) => {
    const existing = reviewOperationIds.current.get(resultId);
    if (existing) return existing;
    const created = crypto.randomUUID();
    reviewOperationIds.current.set(resultId, created);
    return created;
  };

  const role = session?.user?.role;
  const isManager = canManage(role);
  const isReviewer = canReview(role);
  const isFrontDesk = role === "front_desk";
  const settings = trpc.records.settings.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const requestedResultId = searchParams.get("resultId");
  const selectedResultId = requestedResultId && UUID_PATTERN.test(requestedResultId)
    ? requestedResultId
    : undefined;
  const inbox = trpc.records.listLabReviewInbox.useQuery({
    filter,
    limit: 100,
    resultId: selectedResultId,
  });
  const assignees = trpc.records.listLabAssignees.useQuery(undefined, {
    enabled: isManager,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const requestedFilter = searchParams.get("filter") as InboxFilter | null;
    if (requestedFilter && INBOX_FILTER_VALUES.has(requestedFilter)) {
      setFilter(requestedFilter);
    }
  }, [searchParams]);

  const refresh = async (patientId?: string) => {
    await Promise.all([
      utils.records.listLabReviewInbox.invalidate(),
      utils.records.listLabResultHistory.invalidate(),
      patientId
        ? utils.records.listLabResults.invalidate({ patientId })
        : Promise.resolve(),
    ]);
  };

  const completeResult = trpc.records.completeLabResult.useMutation({
    onSuccess: async (result) => {
      toast.success("Result completed and added to the review queue");
      setActionPanel(null);
      setCompletion(EMPTY_COMPLETION);
      await refresh(result.patientId);
    },
    onError: (error) => toast.error(error.message),
  });
  const reviewResult = trpc.records.updateLabResultStatus.useMutation({
    onSuccess: async (result) => {
      toast.success("Review evidence recorded");
      reviewOperationIds.current.delete(result.id);
      await refresh(result.patientId);
    },
    onError: (error) => toast.error(error.message),
  });
  const assignFollowUp = trpc.records.assignLabFollowUp.useMutation({
    onSuccess: async (result) => {
      toast.success("Follow-up owner recorded");
      setActionPanel(null);
      setFollowUpAssignee("");
      setFollowUpDueAt("");
      setFollowUpNote("");
      await refresh(result.patientId);
    },
    onError: (error) => toast.error(error.message),
  });
  const completeFollowUp = trpc.records.completeLabFollowUp.useMutation({
    onSuccess: async (result) => {
      toast.success("Follow-up completion recorded");
      setActionPanel(null);
      setFollowUpOutcome("");
      await refresh(result.patientId);
    },
    onError: (error) => toast.error(error.message),
  });

  const rows = inbox.data?.items ?? [];
  const actionCount = useMemo(
    () => isFrontDesk
      ? rows.length
      : rows.filter(
          (row) => row.status !== "reviewed" || row.followUpStatus === "open",
        ).length,
    [isFrontDesk, rows],
  );
  const timeZone = settings.data?.timezone;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Lab Inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isFrontDesk
              ? "Your assigned lab follow-up, with instructions from the clinical team."
              : "One clinic-wide queue for pending values, clinical review, and owned follow-up."}
          </p>
        </div>
        <Badge variant={actionCount > 0 ? "destructive" : "secondary"} className="w-fit">
          {actionCount} action {actionCount === 1 ? "item" : "items"} shown
        </Badge>
      </div>

      {selectedResultId ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
          <span className="font-medium">Showing selected result</span>
          <Button asChild variant="outline" size="sm">
            <Link href="/lab-results">Return to queue</Link>
          </Button>
        </div>
      ) : null}

      {!isFrontDesk && !selectedResultId ? (
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="group"
          aria-label="Filter lab results"
        >
          {FILTERS.map((item) => (
            <Button
              key={item.value}
              type="button"
              size="sm"
              variant={filter === item.value ? "default" : "outline"}
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
              className="shrink-0"
            >
              {item.label}
            </Button>
          ))}
        </div>
      ) : null}

      {inbox.error ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive">
          Unable to load the lab inbox. {inbox.error.message}
        </div>
      ) : inbox.isLoading ? (
        <LabResultsLoading />
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" aria-hidden="true" />
          <h2 className="mt-3 font-medium">
            {isFrontDesk ? "No assigned lab follow-up" : "No lab results in this view"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {isFrontDesk ? "Your assigned queue is clear." : "The selected queue is clear."}
          </p>
        </div>
      ) : (
        <div className="space-y-4" aria-live="polite">
          {inbox.data?.truncated ? (
            <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              {isFrontDesk
                ? "Your 100 highest-priority assigned items are shown. Complete or ask the clinical team to reassign items, then refresh to reveal the remainder."
                : "More than 100 results match this view. Refine the filter so no action item is hidden beyond the current page."}
            </div>
          ) : null}
          {rows.map((row) => {
            const isCritical = row.resultFlag === "critical";
            const isAbnormal = row.resultFlag === "abnormal";
            const panelOpen = actionPanel?.id === row.id;
            const canCompleteAssignedFollowUp =
              row.status !== "pending" &&
              row.followUpStatus === "open" &&
              (isManager ||
                (role === "front_desk" &&
                  row.followUpAssignedTo === session?.user?.id));
            const selectedAssigneeRole = assignees.data?.find(
              (person) => person.id === followUpAssignee,
            )?.role;
            const followUpDueRequired = row.resultFlag === "critical";
            const followUpNoteRequired = selectedAssigneeRole === "front_desk";
            const followUpDueInstant = followUpDueAt
              ? dateTimeLocalInputUtcInstant(followUpDueAt, timeZone)
              : null;
            const followUpDueInvalid = Boolean(followUpDueAt) && !followUpDueInstant;
            return (
              <Card
                key={row.id}
                className={cn(
                  isCritical && "border-red-500/70 bg-red-50/40 dark:bg-red-950/10",
                  !isCritical && isAbnormal && "border-amber-400/70",
                )}
              >
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {isCritical ? <AlertTriangle className="h-4 w-4 text-red-600" aria-label="Critical result" /> : null}
                        <CardTitle className="text-base">{row.patientName} · {row.testName}</CardTitle>
                        <Badge variant={isCritical ? "destructive" : isAbnormal ? "outline" : "secondary"} className="capitalize">
                          {isFrontDesk
                            ? "Assigned follow-up"
                            : row.resultFlag === "unknown"
                              ? row.status.replace("_", " ")
                              : row.resultFlag}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {isFrontDesk ? (
                          "Clinical values are restricted; follow the instructions below."
                        ) : (
                          <>
                            {row.resultValue ?? "Values pending"}{row.unit ? ` ${row.unit}` : ""}
                            {row.referenceRangeLow != null && row.referenceRangeHigh != null
                              ? ` · Reference ${row.referenceRangeLow}–${row.referenceRangeHigh}`
                              : ""}
                          </>
                        )}
                      </p>
                    </div>
                    {!isFrontDesk ? (
                      <Button asChild variant="ghost" size="sm" className="w-fit">
                        <Link href={`/records?patientId=${row.patientId}&tab=labResults`}>
                          Patient record <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    {!isFrontDesk ? <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Visit</dt>
                      <dd className="mt-1">
                        {row.appointmentStart
                          ? formatEvidenceTime(row.appointmentStart, timeZone)
                          : "No linked appointment"}
                        {row.clinicianName ? ` · ${row.clinicianName}` : ""}
                      </dd>
                    </div> : null}
                    {!isFrontDesk ? <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Completion</dt>
                      <dd className="mt-1 flex items-start gap-1.5">
                        <Clock3 className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {row.completedAt
                          ? `${formatEvidenceTime(row.completedAt, timeZone)}${row.completionActorName ? ` · ${row.completionActorName}` : " · actor unavailable (legacy)"}`
                          : `Pending since ${formatEvidenceTime(row.createdAt, timeZone)}`}
                      </dd>
                    </div> : null}
                    {!isFrontDesk ? <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Clinical review</dt>
                      <dd className="mt-1 flex items-start gap-1.5">
                        <ClipboardCheck className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {row.reviewedAt
                          ? `${formatEvidenceTime(row.reviewedAt, timeZone)}${row.reviewedByName ? ` · ${row.reviewedByName}` : ""}`
                          : row.status === "completed" ? "Awaiting review" : "Waiting for values"}
                      </dd>
                    </div> : null}
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Follow-up owner</dt>
                      <dd className="mt-1 flex items-start gap-1.5">
                        <UserRoundCheck className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {row.followUpStatus === "open"
                          ? `${row.followUpAssigneeName ?? "Assigned"}${row.followUpDueAt ? ` · due ${formatEvidenceTime(row.followUpDueAt, timeZone)}` : ""}`
                          : row.followUpStatus === "completed"
                            ? `Completed ${formatEvidenceTime(row.followUpCompletedAt, timeZone)}${row.followUpOutcome ? ` · ${row.followUpOutcome}` : ""}`
                            : "Not required"}
                      </dd>
                    </div>
                  </dl>

                  {row.followUpNote ? (
                    <p className="rounded-md bg-muted/60 px-3 py-2 text-sm">
                      <span className="font-medium">Follow-up note:</span> {row.followUpNote}
                    </p>
                  ) : null}

                  {isManager || canCompleteAssignedFollowUp ? (
                    <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                      {isManager && row.status === "pending" ? (
                        <Button
                          size="sm"
                          onClick={() => {
                            setCompletion({
                              resultValue: row.resultValue ?? "",
                              unit: row.unit ?? "",
                              referenceRangeLow: row.referenceRangeLow ?? "",
                              referenceRangeHigh: row.referenceRangeHigh ?? "",
                              resultFlag: row.resultFlag,
                            });
                            setActionPanel({
                              kind: "complete",
                              id: row.id,
                              operationId: crypto.randomUUID(),
                            });
                          }}
                        >
                          Enter values and complete
                        </Button>
                      ) : null}
                      {row.status === "completed" &&
                      isReviewer &&
                      (row.resultFlag !== "critical" ||
                        row.followUpStatus !== "not_required") ? (
                        <Button
                          size="sm"
                          disabled={reviewResult.isPending}
                          onClick={() =>
                            reviewResult.mutate({
                              id: row.id,
                              status: "reviewed",
                              operationId: reviewOperationId(row.id),
                            })
                          }
                        >
                          Mark reviewed
                        </Button>
                      ) : null}
                      {isManager && row.status !== "pending" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!timeZone || settings.isLoading}
                          onClick={() => {
                            setFollowUpAssignee(row.followUpAssignedTo ?? session?.user?.id ?? "");
                            setFollowUpDueAt(
                              formatDateTimeLocalInputForTimeZone(
                                row.followUpDueAt,
                                timeZone,
                              ),
                            );
                            setFollowUpNote(row.followUpNote ?? "");
                            setActionPanel({
                              kind: "follow_up",
                              id: row.id,
                              operationId: crypto.randomUUID(),
                            });
                          }}
                        >
                          {row.followUpStatus === "open" ? "Reassign follow-up" : "Assign follow-up"}
                        </Button>
                      ) : null}
                      {canCompleteAssignedFollowUp ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setFollowUpOutcome("");
                            setActionPanel({
                              kind: "complete_follow_up",
                              id: row.id,
                              operationId: crypto.randomUUID(),
                            });
                          }}
                        >
                          Complete follow-up
                        </Button>
                      ) : null}
                    </div>
                  ) : null}

                  {panelOpen && actionPanel?.kind === "complete" ? (
                    <form
                      className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!completion.resultValue.trim()) return;
                        completeResult.mutate({
                          id: row.id,
                          resultValue: completion.resultValue.trim(),
                          unit: completion.unit.trim() || undefined,
                          referenceRangeLow: completion.referenceRangeLow.trim() || undefined,
                          referenceRangeHigh: completion.referenceRangeHigh.trim() || undefined,
                          resultFlag: completion.resultFlag,
                          operationId: actionPanel.operationId,
                        });
                      }}
                    >
                      <h3 className="font-medium">Complete {row.testName}</h3>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        <label className="text-sm font-medium">
                          Result value <span aria-hidden="true">*</span>
                          <Input className="mt-1" required maxLength={128} value={completion.resultValue} onChange={(event) => setCompletion((form) => ({ ...form, resultValue: event.target.value }))} />
                        </label>
                        <label className="text-sm font-medium">
                          Unit
                          <Input className="mt-1" maxLength={32} value={completion.unit} onChange={(event) => setCompletion((form) => ({ ...form, unit: event.target.value }))} />
                        </label>
                        <label className="text-sm font-medium">
                          Reference low
                          <Input className="mt-1" type="number" step="0.001" value={completion.referenceRangeLow} onChange={(event) => setCompletion((form) => ({ ...form, referenceRangeLow: event.target.value }))} />
                        </label>
                        <label className="text-sm font-medium">
                          Reference high
                          <Input className="mt-1" type="number" step="0.001" value={completion.referenceRangeHigh} onChange={(event) => setCompletion((form) => ({ ...form, referenceRangeHigh: event.target.value }))} />
                        </label>
                        <label className="text-sm font-medium">
                          Clinical flag
                          <select className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={completion.resultFlag} onChange={(event) => setCompletion((form) => ({ ...form, resultFlag: event.target.value as CompletionForm["resultFlag"] }))}>
                            <option value="unknown">Not assessed</option>
                            <option value="normal">Normal</option>
                            <option value="abnormal">Abnormal</option>
                            <option value="critical">Critical</option>
                          </select>
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={!completion.resultValue.trim() || completeResult.isPending}>
                          {completeResult.isPending ? "Recording…" : "Record completion"}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setActionPanel(null)}>Cancel</Button>
                      </div>
                    </form>
                  ) : null}

                  {panelOpen && actionPanel?.kind === "follow_up" ? (
                    <form
                      className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (
                          !followUpAssignee ||
                          (followUpDueRequired && !followUpDueAt) ||
                          followUpDueInvalid ||
                          (followUpNoteRequired && !followUpNote.trim())
                        ) return;
                        assignFollowUp.mutate({
                          id: row.id,
                          assigneeId: followUpAssignee,
                          dueAt: followUpDueInstant?.toISOString(),
                          note: followUpNote.trim() || undefined,
                          operationId: actionPanel.operationId,
                        });
                      }}
                    >
                      <h3 className="font-medium">Own the follow-up</h3>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="text-sm font-medium">
                          Assigned teammate <span aria-hidden="true">*</span>
                          <select required className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={followUpAssignee} onChange={(event) => setFollowUpAssignee(event.target.value)}>
                            <option value="">Choose a teammate</option>
                            {assignees.data?.map((person) => (
                              <option key={person.id} value={person.id}>{person.name} · {person.role.replace("_", " ")}</option>
                            ))}
                          </select>
                        </label>
                        <label className="text-sm font-medium">
                          Due date and time {followUpDueRequired ? <span aria-hidden="true">*</span> : null}
                          <Input className="mt-1" type="datetime-local" required={followUpDueRequired} value={followUpDueAt} onChange={(event) => setFollowUpDueAt(event.target.value)} />
                        </label>
                      </div>
                      <label className="block text-sm font-medium">
                        Follow-up instructions {followUpNoteRequired ? <span aria-hidden="true">*</span> : null}
                        <Textarea className="mt-1" required={followUpNoteRequired} maxLength={1000} value={followUpNote} onChange={(event) => setFollowUpNote(event.target.value)} placeholder="Call owner, repeat test, medication guidance…" />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        This assignment stays with the lab result even after the encounter is closed.
                      </p>
                      {followUpDueInvalid ? (
                        <p role="alert" className="text-xs text-destructive">
                          Choose a valid clinic-local time. Times skipped by daylight saving cannot be used.
                        </p>
                      ) : null}
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={!followUpAssignee || (followUpDueRequired && !followUpDueAt) || followUpDueInvalid || (followUpNoteRequired && !followUpNote.trim()) || assignFollowUp.isPending}>
                          {assignFollowUp.isPending ? "Assigning…" : "Save ownership"}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setActionPanel(null)}>Cancel</Button>
                      </div>
                    </form>
                  ) : null}

                  {panelOpen && actionPanel?.kind === "complete_follow_up" ? (
                    <form
                      className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (followUpOutcome.trim().length < 3) return;
                        completeFollowUp.mutate({
                          id: row.id,
                          outcome: followUpOutcome.trim(),
                          operationId: actionPanel.operationId,
                        });
                      }}
                    >
                      <h3 className="font-medium">Record follow-up outcome</h3>
                      <label className="block text-sm font-medium">
                        What was completed? <span aria-hidden="true">*</span>
                        <Textarea
                          className="mt-1"
                          required
                          minLength={3}
                          maxLength={1000}
                          value={followUpOutcome}
                          onChange={(event) => setFollowUpOutcome(event.target.value)}
                          placeholder="Owner reached; repeat test booked for…"
                        />
                      </label>
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={followUpOutcome.trim().length < 3 || completeFollowUp.isPending}>
                          {completeFollowUp.isPending ? "Recording…" : "Record completion"}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setActionPanel(null)}>Cancel</Button>
                      </div>
                    </form>
                  ) : null}

                  {!isFrontDesk ? (
                    <LabResultHistory resultId={row.id} timeZone={timeZone} />
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

    </div>
  );
}

export default function LabResultsInboxPage() {
  return (
    <Suspense fallback={<LabResultsLoading />}>
      <LabResultsInboxContent />
    </Suspense>
  );
}
