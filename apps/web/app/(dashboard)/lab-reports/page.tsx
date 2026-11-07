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
import {
  selectManagedUploadFile,
  type ManagedUploadAttempt,
} from "@/lib/managed-upload-attempt";

type Report =
  inferRouterOutputs<AppRouter>["labReports"]["list"]["items"][number];

function UploadReport({
  previous,
  onDone,
}: {
  previous: Report | null;
  onDone: () => void;
}) {
  const [attempt, setAttempt] = useState<ManagedUploadAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
    setMessage("");
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
      setMessage(
        data.duplicate
          ? "This PDF is already in the inbox. No duplicate report was added."
          : "Report saved. Match it to a patient below.",
      );
      setAttempt(null);
      if (fileInput.current) fileInput.current.value = "";
      onDone();
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
          {previous ? "Import a revised report" : "Import a lab report"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Download a PDF from your lab portal, then upload it here. The original
          stays intact. Values are not extracted or added to the chart
          automatically.
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
            className="mt-2"
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              setAttempt(file ? selectManagedUploadFile(null, file) : null);
              setError("");
              setMessage("");
            }}
          />
        </label>
        <Button onClick={upload} disabled={!attempt || busy}>
          {busy ? "Importing…" : error ? "Retry import" : "Import PDF"}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-sm">
            {message}
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
}: {
  report: Report;
  canManage: boolean;
  canReview: boolean;
  revise: (report: Report) => void;
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
        canManage && report.state === "unmatched" && search.trim().length >= 2,
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
            {
              {
                unmatched: "Needs patient match",
                matched: "Needs review",
                reviewed: "Reviewed",
                dismissed: "Dismissed",
              }[report.state]
            }
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
            <Link
              className="underline"
              href={`/lab-reports?reportId=${report.supersedesId}`}
            >
              Previous version
            </Link>
          </p>
        ) : null}
        {report.revisionIds.length ? (
          <p className="text-sm font-medium">
            A newer report was imported.{" "}
            {report.revisionIds.map((id) => (
              <Link
                key={id}
                className="mr-2 underline"
                href={`/lab-reports?reportId=${id}`}
              >
                Open revision
              </Link>
            ))}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={report.fileUrl} target="_blank" rel="noopener noreferrer">
              Open original PDF
            </a>
          </Button>
          {report.patientId ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/patients/${report.patientId}?tab=records`}>
                Patient chart
              </Link>
            </Button>
          ) : null}
          {canManage ? (
            <Button variant="ghost" size="sm" onClick={() => revise(report)}>
              Import revision
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            {historyOpen ? "Hide history" : "Decision history"}
          </Button>
        </div>
        {unavailable ? (
          <p role="alert" className="text-sm text-destructive">
            File storage needs attention. Matching and review are paused until
            the original is available.
          </p>
        ) : null}
        {canManage && report.state === "unmatched" ? (
          <div className="space-y-3 rounded-md border p-3">
            <label className="block text-sm font-medium">
              Find patient or owner
              <Input
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
            </label>
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
                  <input
                    type="checkbox"
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCorrection("dismissed")}
              >
                Dismiss report
              </Button>
            </div>
          </div>
        ) : null}
        {report.state === "matched" ? (
          <p className="text-sm text-muted-foreground">
            Matched documents still need clinical review. Review does not add
            structured values, mark a lab order complete, or close follow-up
            tasks.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {canReview && report.state === "matched" ? (
            <Button
              size="sm"
              disabled={unavailable || decide.isPending}
              onClick={() => setReviewOpen(true)}
            >
              Review report
            </Button>
          ) : null}
          {canManage &&
          (report.state === "matched" ||
            report.state === "reviewed" ||
            report.state === "dismissed") ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCorrection("unmatched")}
            >
              {report.state === "dismissed"
                ? "Reopen report"
                : "Correct patient match"}
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
              disabled={decide.isPending}
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
        {correction ? (
          <div className="space-y-2 rounded-md border p-3">
            <label className="block text-sm font-medium">
              {correction === "dismissed"
                ? "Reason for dismissal"
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
              {correction === "unmatched"
                ? " This removes the current match and clears its review status."
                : ""}
            </p>
            <Button
              size="sm"
              disabled={!reason.trim() || decide.isPending}
              onClick={() => save(correction, null, reason.trim())}
            >
              Save correction
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
                  {event.version}. {event.state} · {event.actorName}
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
  const { data: session } = useSession();
  const patientId = params.get("patientId") ?? undefined;
  const reportId = params.get("reportId") ?? undefined;
  const [filter, setFilter] = useState<"unmatched" | "unreviewed" | "all">(
    params.get("filter") === "all" || patientId ? "all" : "unmatched",
  );
  const [offset, setOffset] = useState(0);
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
      patientId,
      reportId,
    },
    { enabled: enabled && canRead },
  );
  const utils = trpc.useUtils();
  if (!enabled)
    return <p>Lab report import is not enabled for this installation.</p>;
  if (!canRead)
    return <p>Clinical report access is unavailable for this account.</p>;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {reportId ? (
        <Link className="text-sm underline" href="/lab-reports">
          Show all reports
        </Link>
      ) : null}
      <div>
        <Link href="/lab-results" className="text-sm underline">
          Back to lab inbox
        </Link>
        <h1 className="mt-3 font-heading text-2xl font-semibold">
          Lab reports
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Import the report. Check the patient. Review the results.
        </p>
      </div>
      {patientId ? (
        <p className="text-sm">
          Showing this patient’s matched reports.{" "}
          <Link className="underline" href="/lab-reports">
            Open the clinic inbox
          </Link>
        </p>
      ) : null}
      {canManage && !patientId ? (
        <>
          <UploadReport
            key={previous?.id ?? "new"}
            previous={previous}
            onDone={() => {
              if (reportId) router.replace("/lab-reports?filter=all");
              setFilter("all");
              setOffset(0);
              void utils.labReports.list.invalidate();
            }}
          />
          {previous ? (
            <Button variant="ghost" onClick={() => setPrevious(null)}>
              Import an unrelated report instead
            </Button>
          ) : null}
        </>
      ) : null}
      {!reportId ? (
        <div className="flex flex-wrap gap-2" aria-label="Report filters">
          {(
            [
              ["unmatched", "Needs match"],
              ["unreviewed", "Needs review"],
              ["all", "All reports"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={filter === value ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setFilter(value);
                setOffset(0);
              }}
            >
              {label}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => reports.refetch()}>
            Refresh
          </Button>
        </div>
      ) : null}
      {reports.isLoading ? (
        <p>Loading reports…</p>
      ) : reports.error ? (
        <p role="alert" className="text-destructive">
          Reports could not be loaded. Please refresh.
        </p>
      ) : !reports.data?.items.length ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">
          No reports in this view.
        </p>
      ) : (
        reports.data.items.map((report) => (
          <ReportCard
            key={`${report.id}:${report.version}`}
            report={report}
            canManage={canManage}
            canReview={canReview}
            revise={(report) => {
              if (patientId) {
                window.location.assign(`/lab-reports?reportId=${report.id}`);
                return;
              }
              setPrevious(report);
              document
                .getElementById("import-report")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          />
        ))
      )}
      {!reportId ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!reports.data?.hasMore}
            onClick={() => setOffset(offset + 25)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
export default function LabReportsPage() {
  return (
    <Suspense fallback={<p>Loading lab reports…</p>}>
      <ReportInbox />
    </Suspense>
  );
}
