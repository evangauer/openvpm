"use client";

import Link from "next/link";
import { Suspense, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { LAB_REPORT_MAX_BYTES } from "@/lib/upload-limits";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { LabNavigation } from "@/components/labs/lab-navigation";
import { ArrowLeft, FileText, Upload } from "lucide-react";
import {
  selectManagedUploadFile,
  type ManagedUploadAttempt,
} from "@/lib/managed-upload-attempt";

type Report =
  inferRouterOutputs<AppRouter>["labReports"]["list"]["items"][number];

const REPORT_STATES = {
  unmatched: "Needs patient match",
  matched: "Needs review",
  reviewed: "Reviewed",
  dismissed: "Dismissed",
};

function UploadReport({
  previous,
  onDone,
  onCancel,
}: {
  previous: Report | null;
  onDone: (reportId: string) => void;
  onCancel: () => void;
}) {
  const [attempt, setAttempt] = useState<ManagedUploadAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  async function upload() {
    if (!attempt || inFlight.current) return;
    if (attempt.file.size > LAB_REPORT_MAX_BYTES) {
      setError(
        "Lab reports must be 4 MB or smaller. Download a smaller report from your lab portal.",
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("file", attempt.file);
      body.set("category", "lab-results");
      if (previous) body.set("supersedesId", previous.id);
      const response = await fetch("/api/upload", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": attempt.idempotencyKey },
      });
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          data?.error ||
            (response.status === 413
              ? "Lab reports must be 4 MB or smaller."
              : "Import failed. Try again."),
        );
      if (!data?.reportId)
        throw new Error(
          "Import outcome is unclear. Retry this upload to verify it.",
        );
      toast.success(
        data.duplicate
          ? "This PDF is already in the inbox. No duplicate report was added."
          : "PDF uploaded. Confirm the patient next.",
      );
      setAttempt(null);
      if (fileInput.current) fileInput.current.value = "";
      onDone(data.reportId);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Connection interrupted. Retry this upload.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Card id="import-report">
      <CardHeader>
        <CardTitle className="text-lg">
          {previous ? "Upload revised PDF" : "Upload a lab PDF"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Choose the original report from your lab portal. You’ll confirm the
          patient before review.
        </p>
        {previous ? (
          <p className="break-words text-sm">
            Revises: <strong>{previous.fileName}</strong>. Both versions will
            remain available; the new version needs its own patient match and
            review.
          </p>
        ) : null}
        <label className="block text-sm font-medium">
          Report PDF (up to 4 MB)
          <Input
            ref={fileInput}
            autoFocus
            className="mt-2"
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              setAttempt(file ? selectManagedUploadFile(null, file) : null);
              setError("");
            }}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button onClick={upload} disabled={!attempt || busy}>
            {busy ? "Uploading…" : error ? "Retry upload" : "Upload PDF"}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReportCard({
  report,
  canManage,
  canReview,
  revise,
  detailHref,
  expanded,
}: {
  report: Report;
  canManage: boolean;
  canReview: boolean;
  revise: (report: Report) => void;
  detailHref: (id: string) => string;
  expanded: boolean;
}) {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [checked, setChecked] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [correction, setCorrection] = useState<
    "unmatched" | "dismissed" | null
  >(null);
  const [reason, setReason] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  const people = trpc.patients.search.useQuery(
    { query: search },
    {
      enabled:
        expanded &&
        canManage &&
        report.state === "unmatched" &&
        search.trim().length >= 2,
    },
  );
  const history = trpc.labReports.history.useQuery(
    { id: report.id },
    { enabled: historyOpen },
  );
  const decide = trpc.labReports.decide.useMutation({
    retry: false,
    networkMode: "always",
    onSuccess: async () => {
      setCorrection(null);
      setReviewOpen(false);
      setChecked(false);
      setChosen(null);
      attempt.current = null;
      await Promise.all([
        utils.labReports.list.invalidate(),
        utils.labReports.history.invalidate(),
      ]);
      toast.success("Report updated");
    },
  });
  function save(
    state: "matched" | "reviewed" | "unmatched" | "dismissed",
    patientId: string | null,
    note = "",
  ) {
    const input = {
      id: report.id,
      expectedVersion: report.version,
      state,
      patientId,
      reason: note,
    };
    const payload = JSON.stringify(input);
    if (attempt.current?.payload !== payload)
      attempt.current = { payload, id: crypto.randomUUID() };
    decide.mutate({ ...input, operationId: attempt.current.id });
  }
  const unavailable = report.storageStatus !== "available";
  return (
    <Card id={`report-${report.id}`}>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="min-w-0 break-all text-base">
            {report.fileName}
          </CardTitle>
          <Badge
            variant={report.state === "reviewed" ? "secondary" : "outline"}
          >
            {REPORT_STATES[report.state]}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Imported {new Date(report.receivedAt).toLocaleString()}
          {report.patientName
            ? ` · ${report.patientName} · ${report.ownerFirstName ?? ""} ${report.ownerLastName ?? ""}`
            : ""}
        </p>
        {report.supersedesId ? (
          <p className="text-sm">
            Revised report ·{" "}
            <Link className="underline" href={detailHref(report.supersedesId)}>
              Previous version
            </Link>
          </p>
        ) : null}
        {report.revisionIds.length ? (
          <p className="text-sm font-medium">
            A newer report was imported.{" "}
            {report.revisionIds.map((id) => (
              <Link key={id} className="mr-2 underline" href={detailHref(id)}>
                Open revision
              </Link>
            ))}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {!expanded ? (
            <Button asChild size="sm">
              <Link href={detailHref(report.id)}>
                {canManage && report.state === "unmatched"
                  ? "Match patient"
                  : canReview && report.state === "matched"
                    ? "Review report"
                    : "View report"}
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <a href={report.fileUrl} target="_blank" rel="noopener noreferrer">
              Open original PDF
            </a>
          </Button>
          {expanded && report.patientId ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/patients/${report.patientId}?tab=records`}>
                Patient chart
              </Link>
            </Button>
          ) : null}
        </div>
        {unavailable ? (
          <p role="alert" className="text-sm text-destructive">
            File storage needs attention. Matching and review are paused until
            the original is available.
          </p>
        ) : null}
        {expanded && canManage && report.state === "unmatched" ? (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm">
              Open the PDF, then check the patient and owner.
            </p>
            <FormField
              label="Find patient or owner"
              htmlFor={`patient-search-${report.id}`}
            >
              <Input
                id={`patient-search-${report.id}`}
                className="mt-1"
                value={search}
                maxLength={100}
                placeholder="Type at least 2 characters"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setChosen(null);
                  setChecked(false);
                }}
              />
            </FormField>
            {people.isError ? (
              <p role="alert" className="text-sm text-destructive">
                Patient search failed. Change the search to retry.
              </p>
            ) : null}
            {people.isFetching ? <p className="text-sm">Searching…</p> : null}
            {!people.isFetching &&
            search.trim().length >= 2 &&
            people.data?.length === 0 ? (
              <p className="text-sm">No matching patients.</p>
            ) : null}
            {people.data && search.trim().length >= 2 ? (
              <div className="flex flex-col gap-1">
                {people.data.map((patient) => {
                  const label = `${patient.name} · ${patient.species} · ${patient.clientFirstName ?? ""} ${patient.clientLastName ?? ""}`;
                  return (
                    <Button
                      key={patient.id}
                      variant={
                        chosen?.id === patient.id ? "secondary" : "ghost"
                      }
                      className="h-auto justify-start whitespace-normal text-left"
                      aria-pressed={chosen?.id === patient.id}
                      onClick={() => {
                        setChosen({ id: patient.id, label });
                        setChecked(false);
                      }}
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
            ) : null}
            {chosen ? (
              <>
                <p className="text-sm font-medium">Selected: {chosen.label}</p>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5 shrink-0"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                  />
                  I checked the patient and owner against the original report.
                </label>
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={
                  !chosen || !checked || decide.isPending || unavailable
                }
                onClick={() => save("matched", chosen!.id)}
              >
                Confirm patient match
              </Button>
            </div>
          </div>
        ) : null}
        {expanded && report.state === "matched" ? (
          <p className="text-sm text-muted-foreground">
            {canReview
              ? "Ready for clinical review."
              : "A veterinarian or administrator needs to review this report."}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {expanded &&
          canReview &&
          report.state === "matched" &&
          !reviewOpen ? (
            <Button
              size="sm"
              disabled={unavailable || decide.isPending}
              onClick={() => setReviewOpen(true)}
            >
              Review report
            </Button>
          ) : null}
        </div>
        {reviewOpen ? (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm">
              Confirm that you reviewed the original PDF for this patient.
              Record any needed values and follow-up in the patient’s clinical
              record.
            </p>
            <Button
              size="sm"
              disabled={decide.isPending || unavailable}
              onClick={() => save("reviewed", report.patientId)}
            >
              Confirm clinical review
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReviewOpen(false)}
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {expanded ? (
          <details className="border-t pt-3">
            <summary className="cursor-pointer text-sm font-medium">
              More actions &amp; history
            </summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen(!historyOpen)}
              >
                {historyOpen ? "Hide history" : "Decision history"}
              </Button>
              {canManage ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revise(report)}
                  >
                    Import revision
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => {
                      setReason("");
                      setReviewOpen(false);
                      setCorrection(
                        report.state === "unmatched"
                          ? "dismissed"
                          : "unmatched",
                      );
                    }}
                  >
                    {report.state === "unmatched"
                      ? "Dismiss report"
                      : report.state === "dismissed"
                        ? "Reopen report"
                        : "Correct patient match"}
                  </Button>
                </>
              ) : null}
            </div>
          </details>
        ) : null}
        {correction ? (
          <div className="space-y-2 rounded-md border p-3">
            <label className="block text-sm font-medium">
              {correction === "dismissed"
                ? "Reason for dismissal"
                : report.state === "dismissed"
                  ? "Reason for reopening"
                  : "Reason for correction"}
              <Input
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <p className="text-sm text-muted-foreground">
              The original document and all previous decisions remain in
              history.
              {correction === "unmatched" && report.state !== "dismissed"
                ? " This removes the current match and clears its review status."
                : ""}
            </p>
            <Button
              size="sm"
              disabled={!reason.trim() || decide.isPending}
              onClick={() => save(correction, null, reason.trim())}
            >
              {correction === "dismissed"
                ? "Dismiss report"
                : report.state === "dismissed"
                  ? "Reopen report"
                  : "Clear patient match"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCorrection(null)}
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {decide.error ? (
          <p role="alert" className="text-sm text-destructive">
            {decide.error.message}{" "}
            <button
              className="underline"
              onClick={() => utils.labReports.list.invalidate()}
            >
              Refresh reports
            </button>
          </p>
        ) : null}
        {historyOpen ? (
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium">Decision history</h3>
            {history.isLoading ? (
              <p className="text-sm">Loading…</p>
            ) : history.error ? (
              <p role="alert">History could not be loaded.</p>
            ) : history.data?.length ? (
              history.data.map((event) => (
                <p key={event.id} className="break-words text-sm">
                  {REPORT_STATES[event.state]} · {event.actorName}
                  {event.patientName ? ` · ${event.patientName}` : ""} ·{" "}
                  {new Date(event.createdAt).toLocaleString()}
                  {event.reason ? ` — ${event.reason}` : ""}
                </p>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No decisions yet. The original upload is preserved.
              </p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReportInbox() {
  const params = useSearchParams();
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const patientId = params.get("patientId") ?? undefined;
  const reportId = params.get("reportId") ?? undefined;
  const filterParam = params.get("filter");
  const filter =
    filterParam === "all" || filterParam === "unreviewed"
      ? filterParam
      : patientId
        ? "all"
        : "unmatched";
  const parsedOffset = Number(params.get("offset") ?? 0);
  const offset =
    Number.isInteger(parsedOffset) &&
    parsedOffset >= 0 &&
    parsedOffset <= 100000
      ? parsedOffset
      : 0;
  const [uploadOpen, setUploadOpen] = useState(false);
  const [previous, setPrevious] = useState<Report | null>(null);
  const role = session?.user.role;
  const enabled = process.env.NEXT_PUBLIC_LAB_REPORT_INTAKE_ENABLED === "true";
  const canRead =
    !!role && ["admin", "veterinarian", "technician", "viewer"].includes(role);
  const canManage = canRead && role !== "viewer";
  const canReview = role === "admin" || role === "veterinarian";
  const reports = trpc.labReports.list.useQuery(
    {
      filter: reportId ? "all" : filter,
      offset: reportId ? 0 : offset,
      // Keep a selected report visible after correcting its patient match.
      patientId: reportId ? undefined : patientId,
      reportId,
    },
    { enabled: enabled && canRead },
  );
  const patient = trpc.patients.getById.useQuery(
    { id: patientId! },
    { enabled: enabled && canRead && !!patientId },
  );
  const utils = trpc.useUtils();
  function inboxHref(
    options: { reportId?: string; filter?: string; offset?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (patientId) query.set("patientId", patientId);
    query.set("filter", options.filter ?? filter);
    if (options.reportId) query.set("reportId", options.reportId);
    if (options.offset) query.set("offset", String(options.offset));
    return `/lab-reports?${query}`;
  }
  function closeUpload() {
    setUploadOpen(false);
    setPrevious(null);
  }
  if (!enabled)
    return <p>Lab report import is not enabled for this installation.</p>;
  if (sessionStatus === "loading")
    return <p role="status">Loading lab reports…</p>;
  if (!canRead)
    return <p>Clinical report access is unavailable for this account.</p>;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Lab Inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a PDF, confirm the patient, and review the report.
          </p>
        </div>
        {canManage && !uploadOpen ? (
          <Button
            onClick={() => {
              setPrevious(null);
              setUploadOpen(true);
            }}
          >
            <Upload
              data-icon="inline-start"
              className="mr-2 size-4"
              aria-hidden="true"
            />
            Upload PDF
          </Button>
        ) : null}
      </div>
      <LabNavigation active="reports" />
      {patientId ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Link
            className="inline-flex items-center gap-2 underline"
            href={`/patients/${patientId}?tab=documents`}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {patient.data
              ? `${patient.data.name}’s documents`
              : "Patient documents"}
          </Link>
          <Link className="underline" href="/lab-reports">
            All clinic reports
          </Link>
        </div>
      ) : null}
      {reportId ? (
        <Link
          className="inline-flex items-center gap-2 text-sm underline"
          href={inboxHref({ offset })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Back to reports
        </Link>
      ) : null}
      {uploadOpen && canManage ? (
        <UploadReport
          key={previous?.id ?? "new"}
          previous={previous}
          onCancel={closeUpload}
          onDone={(id) => {
            closeUpload();
            void utils.labReports.list.invalidate();
            router.push(inboxHref({ reportId: id }));
          }}
        />
      ) : null}
      {!reportId ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <nav className="flex flex-wrap gap-2" aria-label="Report filters">
            {(
              (patientId
                ? [
                    ["all", "All reports"],
                    ["unreviewed", "Needs review"],
                  ]
                : [
                    ["unmatched", "Needs match"],
                    ["unreviewed", "Needs review"],
                    ["all", "All reports"],
                  ]) as Array<[string, string]>
            ).map(([value, label]) => (
              <Button
                key={value}
                asChild
                variant={filter === value ? "secondary" : "ghost"}
                size="sm"
              >
                <Link
                  href={inboxHref({ filter: value })}
                  aria-current={filter === value ? "page" : undefined}
                >
                  {label}
                </Link>
              </Button>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="sm"
            disabled={reports.isFetching}
            onClick={() => reports.refetch()}
          >
            {reports.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      ) : null}
      {reports.isLoading ? (
        <p role="status">Loading reports…</p>
      ) : reports.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <p>Reports could not be loaded.</p>
          <Button variant="outline" size="sm" onClick={() => reports.refetch()}>
            Try again
          </Button>
        </div>
      ) : !reports.data?.items.length ? (
        <Card>
          <CardHeader>
            <FileText
              className="mb-2 size-6 text-muted-foreground"
              aria-hidden="true"
            />
            <CardTitle>
              {reportId
                ? "Report unavailable"
                : patientId
                  ? "No reports in this view"
                  : filter === "unmatched"
                    ? "No PDFs waiting for a match"
                    : filter === "unreviewed"
                      ? "No reports waiting for review"
                      : "No lab PDFs yet"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {reportId
                ? "Return to the reports list or refresh to try again."
                : patientId
                  ? "Reports appear here after the patient match is confirmed."
                  : filter === "unreviewed"
                    ? "Matched reports appear here for a veterinarian or administrator to review."
                    : "Upload a report from your lab portal, or choose another view to find existing reports."}
            </p>
          </CardContent>
        </Card>
      ) : (
        reports.data.items.map((report) => (
          <ReportCard
            key={`${report.id}:${report.version}:${!!reportId}`}
            report={report}
            expanded={!!reportId}
            canManage={canManage}
            canReview={canReview}
            detailHref={(id) => inboxHref({ reportId: id, offset })}
            revise={(report) => {
              setPrevious(report);
              setUploadOpen(true);
            }}
          />
        ))
      )}
      {!reportId && (offset > 0 || reports.data?.hasMore) ? (
        <nav className="flex gap-2" aria-label="Report pages">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() =>
              router.push(inboxHref({ offset: Math.max(0, offset - 25) }))
            }
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!reports.data?.hasMore}
            onClick={() => router.push(inboxHref({ offset: offset + 25 }))}
          >
            Next
          </Button>
        </nav>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Original PDFs stay intact. Record lab values and follow-up separately in
        the patient chart.
      </p>
    </div>
  );
}
function LabReportsRoute() {
  const params = useSearchParams();
  return <ReportInbox key={params.toString()} />;
}

export default function LabReportsPage() {
  return (
    <Suspense fallback={<p>Loading lab reports…</p>}>
      <LabReportsRoute />
    </Suspense>
  );
}
