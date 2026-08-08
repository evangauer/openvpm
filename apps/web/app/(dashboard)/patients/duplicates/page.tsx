"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import type { inferRouterOutputs } from "@trpc/server";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  GitMerge,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { TableSkeleton } from "@/components/common/loading";

const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";
const MERGE_REASON_MIN_LENGTH = 5;
const MERGE_REASON_MAX_LENGTH = 500;
const MERGE_CONFIRMATION = "MERGE";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type DuplicateGroup = RouterOutputs["patients"]["findDuplicates"][number];
type DuplicatePatient = DuplicateGroup["patients"][number];

type MergeSelection = {
  keepId: string;
  mergeId: string;
  keepName: string;
  mergeName: string;
};

function readableCountLabel(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatPatientIdentity(patient: DuplicatePatient) {
  return [
    patient.species,
    patient.breed,
    patient.dob ? `DOB ${patient.dob}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function DuplicateGroupCard({
  group,
  onReview,
}: {
  group: DuplicateGroup;
  onReview: (selection: MergeSelection) => void;
}) {
  const [keepId, setKeepId] = useState("");
  const [mergeId, setMergeId] = useState("");
  const keepPatient = group.patients.find((patient) => patient.id === keepId);
  const mergePatient = group.patients.find((patient) => patient.id === mergeId);
  const canReview = Boolean(
    keepPatient && mergePatient && keepPatient.id !== mergePatient.id,
  );

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-heading font-semibold">
            {group.clientFirstName} {group.clientLastName}
          </h3>
          <p className="text-sm text-muted-foreground">
            {group.patients.length} same-owner charts need review
          </p>
        </div>
        <Badge variant="outline">Possible duplicate</Badge>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {group.patients.map((patient) => (
          <div key={patient.id} className="rounded-md border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Link
                  href={`/patients/${patient.id}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {patient.name}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatPatientIdentity(patient)}
                </p>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {patient.id.slice(0, 8)}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Microchip</dt>
              <dd>{patient.microchipNumber || "—"}</dd>
              <dt className="text-muted-foreground">External ID</dt>
              <dd>
                {patient.externalSource && patient.externalId
                  ? `${patient.externalSource}: ${patient.externalId}`
                  : "—"}
              </dd>
            </dl>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end">
        <label className="text-sm font-medium">
          Keep this chart
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={keepId}
            onChange={(event) => {
              setKeepId(event.target.value);
              if (event.target.value === mergeId) setMergeId("");
            }}
          >
            <option value="">Choose the canonical chart</option>
            {group.patients.map((patient) => (
              <option key={patient.id} value={patient.id}>
                {patient.name} · {patient.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <ArrowRight className="mb-3 hidden h-4 w-4 text-muted-foreground sm:block" />
        <label className="text-sm font-medium">
          Retire this duplicate
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={mergeId}
            onChange={(event) => setMergeId(event.target.value)}
          >
            <option value="">Choose the duplicate chart</option>
            {group.patients
              .filter((patient) => patient.id !== keepId)
              .map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name} · {patient.id.slice(0, 8)}
                </option>
              ))}
          </select>
        </label>
        <Button
          variant="outline"
          disabled={!canReview}
          onClick={() => {
            if (!keepPatient || !mergePatient) return;
            onReview({
              keepId: keepPatient.id,
              mergeId: mergePatient.id,
              keepName: keepPatient.name,
              mergeName: mergePatient.name,
            });
          }}
        >
          Review merge
        </Button>
      </div>
    </article>
  );
}

function IdentitySummary({
  label,
  patient,
}: {
  label: string;
  patient: {
    id: string;
    name: string;
    species: string;
    breed: string | null;
    dob: string | null;
    microchipNumber: string | null;
    externalSource: string | null;
    externalId: string | null;
  };
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-medium">{patient.name}</p>
      <p className="text-sm text-muted-foreground">
        {patient.species} · {patient.breed || "Unknown breed"}
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">DOB</dt>
        <dd>{patient.dob || "—"}</dd>
        <dt className="text-muted-foreground">Microchip</dt>
        <dd>{patient.microchipNumber || "—"}</dd>
        <dt className="text-muted-foreground">External ID</dt>
        <dd>
          {patient.externalSource && patient.externalId
            ? `${patient.externalSource}: ${patient.externalId}`
            : "—"}
        </dd>
        <dt className="text-muted-foreground">Chart ID</dt>
        <dd className="font-mono">{patient.id}</dd>
      </dl>
    </div>
  );
}

export default function PatientDuplicatesPage() {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const [selection, setSelection] = useState<MergeSelection | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const operationId = useRef<string | null>(null);
  const utils = trpc.useUtils();

  const duplicates = trpc.patients.findDuplicates.useQuery(undefined, {
    enabled: isAdmin,
    refetchOnWindowFocus: false,
  });
  const preview = trpc.patients.previewMerge.useQuery(
    {
      keepId: selection?.keepId ?? EMPTY_UUID,
      mergeId: selection?.mergeId ?? EMPTY_UUID,
    },
    {
      enabled: isAdmin && selection !== null,
      refetchOnWindowFocus: false,
    },
  );
  const mergePatient = trpc.patients.merge.useMutation({
    onSuccess: async () => {
      toast.success("Duplicate chart retired with an immutable merge record");
      const keepId = selection?.keepId;
      operationId.current = null;
      setSelection(null);
      setReason("");
      setConfirmation("");
      await Promise.all([
        utils.patients.findDuplicates.invalidate(),
        utils.patients.list.invalidate(),
      ]);
      if (keepId) router.push(`/patients/${keepId}?merged=1`);
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    operationId.current = null;
    setReason("");
    setConfirmation("");
  }, [selection?.keepId, selection?.mergeId]);

  const trimmedReason = reason.trim();
  const canMerge =
    preview.data?.allowed === true &&
    trimmedReason.length >= MERGE_REASON_MIN_LENGTH &&
    trimmedReason.length <= MERGE_REASON_MAX_LENGTH &&
    confirmation === MERGE_CONFIRMATION &&
    !mergePatient.isPending;

  const submitMerge = () => {
    if (!selection || !canMerge) return;
    operationId.current ??= crypto.randomUUID();
    mergePatient.mutate({
      keepId: selection.keepId,
      mergeId: selection.mergeId,
      reason: trimmedReason,
      operationId: operationId.current,
    });
  };

  if (sessionStatus === "loading") {
    return <TableSkeleton rows={5} cols={2} />;
  }

  if (!isAdmin) {
    return (
      <div>
        <Button variant="ghost" onClick={() => router.push("/patients")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to patients
        </Button>
        <div className="mt-6 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Only practice administrators can review or merge duplicate patient
          identities.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            className="-ml-3 mb-2"
            onClick={() => router.push("/patients")}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to patients
          </Button>
          <h2 className="font-heading text-xl font-semibold">
            Review duplicate patient identities
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            OpenVPM only suggests same-owner matches. A merge is permitted when
            the retiring chart has no clinical, medication, controlled,
            financial, or other retained history.
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          Admin-only
        </Badge>
      </div>

      <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Never merge charts merely because pet names match. Confirm the
            owner, species, DOB, microchip, external identity, and both charts'
            contents. Historical records are never silently reassigned.
          </p>
        </div>
      </div>

      {duplicates.isError ? (
        <div className="mt-6 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Unable to load duplicate candidates. {duplicates.error.message}
        </div>
      ) : duplicates.isLoading ? (
        <TableSkeleton rows={5} cols={2} />
      ) : duplicates.data && duplicates.data.length > 0 ? (
        <div className="mt-6 space-y-4">
          {duplicates.data.map((group) => (
            <DuplicateGroupCard
              key={`${group.clientId}-${group.patients.map((patient) => patient.id).join("-")}`}
              group={group}
              onReview={setSelection}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          className="mt-6"
          icon={CheckCircle}
          title="No duplicate patient identities found"
          description="No same-owner charts currently match the duplicate review rules."
        />
      )}

      {selection ? (
        <section className="mt-6 rounded-lg border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-heading text-lg font-semibold">
                Merge safety preview
              </h3>
              <p className="text-sm text-muted-foreground">
                Preview is recalculated on the server before the merge commits.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={mergePatient.isPending}
              onClick={() => setSelection(null)}
            >
              Close
            </Button>
          </div>

          {preview.isError ? (
            <div className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              Unable to preview this merge. {preview.error.message}
            </div>
          ) : preview.isLoading || !preview.data ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking both charts and their retained history...
            </div>
          ) : (
            <>
              <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
                <IdentitySummary
                  label="Keep as canonical"
                  patient={preview.data.keepPatient}
                />
                <ArrowRight className="mx-auto h-5 w-5 text-muted-foreground" />
                <IdentitySummary
                  label="Retire as duplicate"
                  patient={preview.data.mergePatient}
                />
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="rounded-md border border-border p-3">
                  <h4 className="text-sm font-semibold">
                    Retained-history checks
                  </h4>
                  <dl className="mt-2 space-y-1 text-sm">
                    {Object.entries(preview.data.blockerCounts).map(
                      ([label, count]) => (
                        <div key={label} className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">
                            {readableCountLabel(label)}
                          </dt>
                          <dd className="tabular-nums">{count}</dd>
                        </div>
                      ),
                    )}
                  </dl>
                </div>
                <div className="rounded-md border border-border p-3">
                  <h4 className="text-sm font-semibold">Prospective work</h4>
                  <dl className="mt-2 space-y-1 text-sm">
                    {Object.entries(preview.data.movableCounts).map(
                      ([label, count]) => (
                        <div key={label} className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">
                            {readableCountLabel(label)}
                          </dt>
                          <dd className="tabular-nums">{count}</dd>
                        </div>
                      ),
                    )}
                  </dl>
                </div>
              </div>

              {!preview.data.allowed ? (
                <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
                  <p className="font-semibold">
                    Keep both chart identities—this merge is blocked.
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {preview.data.reasons.map((blockReason) => (
                      <li key={blockReason}>{blockReason}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                      The retiring chart has no retained history. Any explicitly
                      listed prospective work will move atomically; an immutable
                      identity event will preserve who merged it, when, and why.
                    </p>
                  </div>
                </div>
              )}

              {preview.data.allowed ? (
                <div className="mt-4 space-y-4 border-t border-border pt-4">
                  <label className="block text-sm font-medium">
                    Reason for merging
                    <Textarea
                      className="mt-1"
                      value={reason}
                      minLength={MERGE_REASON_MIN_LENGTH}
                      maxLength={MERGE_REASON_MAX_LENGTH}
                      placeholder="Explain how the duplicate was verified"
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {MERGE_REASON_MIN_LENGTH} characters minimum.{" "}
                      {reason.length}/{MERGE_REASON_MAX_LENGTH}
                    </span>
                  </label>
                  <label className="block text-sm font-medium">
                    Type {MERGE_CONFIRMATION} to confirm
                    <Input
                      className="mt-1 max-w-sm font-mono"
                      value={confirmation}
                      autoComplete="off"
                      placeholder={MERGE_CONFIRMATION}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      {selection.mergeName} will redirect permanently to the
                      canonical {selection.keepName} chart.
                    </p>
                    <Button
                      variant="destructive"
                      disabled={!canMerge}
                      onClick={submitMerge}
                    >
                      {mergePatient.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <GitMerge className="mr-2 h-4 w-4" />
                      )}
                      Merge duplicate chart
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
