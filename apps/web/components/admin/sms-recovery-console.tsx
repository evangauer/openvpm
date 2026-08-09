"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

const EMPTY_UUID = "00000000-0000-4000-8000-000000000000";
const QUEUE_LIMIT = 25;
const WITHHELD_PHONE_LIKE_OPERATIONAL_ID = "[withheld: phone-like identifier]";

type AttemptSelection = {
  practiceId: string;
  attemptId: string;
  classification:
    | "missing_provider_result"
    | "outcome_unknown"
    | "terminal_projection_pending";
};

type DeliverySelection = {
  eventId: string;
  queueReason:
    | "identity_conflict"
    | "unmatched"
    | "unknown_status"
    | "projection_miss";
  pendingHistoryId: string | null;
};

type AttemptOutcome = "accepted" | "definite_failure";
type DeliveryClassification = "sent" | "failed" | "delivered";
type DeliveryReason =
  | "exact_attribution_retry"
  | "provider_portal_status_review"
  | "projection_repair"
  | "identity_conflict_review"
  | "unmatched_evidence_review";

const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

function operationId() {
  return window.crypto.randomUUID();
}

function formatTimestamp(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function label(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "—";
}

function looksLikePhoneNumber(value: string) {
  return /^\+?\d[\d ().-]{6,18}$/.test(value.trim());
}

function safeProviderEvidenceId(value: string | null | undefined) {
  if (!value) return "—";
  return looksLikePhoneNumber(value)
    ? WITHHELD_PHONE_LIKE_OPERATIONAL_ID
    : value;
}

function EvidenceId({
  label: idLabel,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {idLabel}
      </dt>
      <dd className="mt-0.5 break-all font-mono text-xs">{value ?? "—"}</dd>
    </div>
  );
}

function QueueError({ children }: { children: string }) {
  return (
    <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {children}
    </div>
  );
}

function ActionNotice({
  message,
  error,
}: {
  message: string | null;
  error: string | null;
}) {
  if (!message && !error) return null;
  return (
    <div
      role="status"
      className={`mt-3 rounded-md border px-3 py-2 text-sm ${
        error
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-green-200 bg-green-50 text-green-900"
      }`}
    >
      {error ?? message}
    </div>
  );
}

function deliveryReasons(
  queueReason: DeliverySelection["queueReason"],
): Array<{ value: DeliveryReason; text: string }> {
  if (queueReason === "identity_conflict") {
    return [
      {
        value: "identity_conflict_review",
        text: "Quarantine exact identity conflict after review",
      },
    ];
  }
  if (queueReason === "unmatched") {
    return [
      {
        value: "unmatched_evidence_review",
        text: "Quarantine exact unmatched evidence after review",
      },
    ];
  }
  return [
    {
      value: "exact_attribution_retry",
      text: "Retry exact attribution and projection",
    },
    {
      value: "projection_repair",
      text: "Repair a verified projection miss",
    },
    {
      value: "provider_portal_status_review",
      text: "Record status verified in provider portal",
    },
  ];
}

export function SmsRecoveryConsole() {
  const utils = trpc.useUtils();
  const attemptQueue = trpc.admin.smsSendAttemptQueue.useQuery(
    { staleMinutes: 15, limit: QUEUE_LIMIT },
    { retry: false },
  );
  const deliveryQueue = trpc.admin.smsDeliveryEventQueue.useQuery(
    { staleMinutes: 60, limit: QUEUE_LIMIT },
    { retry: false },
  );
  const [attemptSelection, setAttemptSelection] =
    useState<AttemptSelection | null>(null);
  const [deliverySelection, setDeliverySelection] =
    useState<DeliverySelection | null>(null);
  const [attemptOutcome, setAttemptOutcome] = useState<AttemptOutcome | "">("");
  const [attemptEvidence, setAttemptEvidence] = useState("");
  const [providerMessageId, setProviderMessageId] = useState("");
  const [attemptReviewed, setAttemptReviewed] = useState(false);
  const [attemptReconciliationId, setAttemptReconciliationId] = useState<
    string | null
  >(null);
  const [resendId, setResendId] = useState<string | null>(null);
  const [resendReviewed, setResendReviewed] = useState(false);
  const [resendCompleted, setResendCompleted] = useState(false);
  const [deliveryReason, setDeliveryReason] = useState<DeliveryReason | "">("");
  const [deliveryClassification, setDeliveryClassification] = useState<
    DeliveryClassification | ""
  >("");
  const [deliveryReviewed, setDeliveryReviewed] = useState(false);
  const [deliveryReconciliationId, setDeliveryReconciliationId] = useState<
    string | null
  >(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const attemptDetail = trpc.admin.smsSendAttempt.useQuery(
    {
      practiceId: attemptSelection?.practiceId ?? EMPTY_UUID,
      attemptId: attemptSelection?.attemptId ?? EMPTY_UUID,
    },
    { enabled: Boolean(attemptSelection), retry: false },
  );
  const deliveryDetail = trpc.admin.smsDeliveryEventDetail.useQuery(
    {
      deliveryEventId: deliverySelection?.eventId ?? EMPTY_UUID,
      historyLimit: 100,
    },
    { enabled: Boolean(deliverySelection), retry: false },
  );

  const effectiveAttemptEvent = useMemo(() => {
    const events = attemptDetail.data?.events ?? [];
    return (
      events.find((event) => event.kind === "reconciliation") ??
      events.find((event) => event.kind === "provider_result") ??
      null
    );
  }, [attemptDetail.data?.events]);
  const backendConfirmedFailure =
    effectiveAttemptEvent?.outcome === "definite_failure";

  const refreshQueues = () => {
    void Promise.all([
      utils.admin.smsSendAttemptQueue.invalidate(),
      utils.admin.smsDeliveryEventQueue.invalidate(),
      utils.admin.smsOperationsHealth.invalidate(),
    ]);
  };

  const reconcileAttempt = trpc.admin.reconcileSmsSendAttempt.useMutation({
    onSuccess: (result, variables) => {
      const expectedRecorded =
        result.attemptId === variables.attemptId &&
        result.outcome === variables.outcome;
      if (!expectedRecorded) {
        setActionError(
          "The backend did not confirm the reviewed outcome. No resend is enabled.",
        );
      } else {
        setActionError(null);
        setActionMessage(
          variables.outcome === "definite_failure"
            ? "Definite failure recorded. Refreshing the immutable attempt history before resend is enabled."
            : "Provider acceptance recorded and projected from the reviewed evidence.",
        );
        setAttemptReviewed(false);
        setAttemptReconciliationId(operationId());
      }
      void utils.admin.smsSendAttempt.invalidate({
        practiceId: variables.practiceId,
        attemptId: variables.attemptId,
      });
      refreshQueues();
    },
    onError: (error) => {
      setActionMessage(null);
      setActionError(error.message);
    },
  });
  const resendAttempt = trpc.admin.resendSmsSendAttempt.useMutation({
    onSuccess: (result, variables) => {
      const newAttemptRecorded =
        Boolean(result.attemptId) && result.attemptId !== variables.attemptId;
      setResendCompleted(newAttemptRecorded);
      setActionError(
        newAttemptRecorded
          ? null
          : "error" in result
            ? (result.error ?? "Resend was blocked.")
            : "Resend was blocked.",
      );
      setActionMessage(
        newAttemptRecorded
          ? result.success
            ? `Explicit resend accepted as new attempt ${result.attemptId}.`
            : `Explicit resend created attempt ${result.attemptId}; provider outcome: ${label(result.outcome)}.`
          : null,
      );
      refreshQueues();
    },
    onError: (error) => {
      setActionMessage(null);
      setActionError(error.message);
    },
  });
  const reconcileDelivery = trpc.admin.reconcileSmsDeliveryEvent.useMutation({
    onSuccess: (result) => {
      setActionError(null);
      setActionMessage(
        `Delivery evidence reconciled as ${label(result.classification)} (${label(result.result)}).`,
      );
      setDeliveryReviewed(false);
      setDeliveryReconciliationId(operationId());
      if (deliverySelection) {
        void utils.admin.smsDeliveryEventDetail.invalidate({
          deliveryEventId: deliverySelection.eventId,
          historyLimit: 100,
        });
      }
      refreshQueues();
    },
    onError: (error) => {
      setActionMessage(null);
      setActionError(error.message);
    },
  });

  const selectAttempt = (selection: AttemptSelection) => {
    setAttemptSelection(selection);
    setDeliverySelection(null);
    setAttemptOutcome("");
    setAttemptEvidence("");
    setProviderMessageId("");
    setAttemptReviewed(false);
    setAttemptReconciliationId(operationId());
    setResendId(operationId());
    setResendReviewed(false);
    setResendCompleted(false);
    setActionMessage(null);
    setActionError(null);
  };

  const selectDelivery = (selection: DeliverySelection) => {
    setDeliverySelection(selection);
    setAttemptSelection(null);
    setDeliveryReason("");
    setDeliveryClassification("");
    setDeliveryReviewed(false);
    setDeliveryReconciliationId(operationId());
    setActionMessage(null);
    setActionError(null);
  };

  const terminalProjectionOutcome =
    attemptSelection?.classification === "terminal_projection_pending" &&
    (effectiveAttemptEvent?.outcome === "accepted" ||
      effectiveAttemptEvent?.outcome === "definite_failure")
      ? effectiveAttemptEvent.outcome
      : null;
  const reviewedAttemptOutcome = terminalProjectionOutcome || attemptOutcome;
  const reviewedProviderMessageId =
    terminalProjectionOutcome === "accepted"
      ? (effectiveAttemptEvent?.providerMessageId ?? "")
      : providerMessageId.trim();
  const providerIdLooksSensitive =
    reviewedProviderMessageId === WITHHELD_PHONE_LIKE_OPERATIONAL_ID ||
    looksLikePhoneNumber(reviewedProviderMessageId);
  const canReconcileAttempt = Boolean(
    attemptSelection &&
    attemptDetail.data &&
    attemptReconciliationId &&
    reviewedAttemptOutcome &&
    attemptEvidence &&
    attemptReviewed &&
    (reviewedAttemptOutcome !== "accepted" ||
      (reviewedProviderMessageId && !providerIdLooksSensitive)) &&
    !reconcileAttempt.isPending,
  );

  const deliveryReasonOptions = deliverySelection
    ? deliveryReasons(deliverySelection.queueReason)
    : [];
  const reviewedHistory =
    deliverySelection?.pendingHistoryId && deliveryDetail.data
      ? deliveryDetail.data.history.find(
          (history) => history.id === deliverySelection.pendingHistoryId,
        )
      : null;
  const quarantineReason =
    deliveryReason === "identity_conflict_review" ||
    deliveryReason === "unmatched_evidence_review";
  const exactQuarantineEvidence =
    deliveryReason === "identity_conflict_review"
      ? reviewedHistory?.result === "ambiguous"
      : deliveryReason === "unmatched_evidence_review"
        ? reviewedHistory?.result === "unmatched"
        : !deliverySelection?.pendingHistoryId;
  const canReconcileDelivery = Boolean(
    deliverySelection &&
    deliveryDetail.data &&
    deliveryReconciliationId &&
    deliveryReason &&
    deliveryReviewed &&
    exactQuarantineEvidence &&
    !deliveryDetail.data.truncated &&
    (deliveryReason !== "provider_portal_status_review" ||
      deliveryClassification) &&
    !reconcileDelivery.isPending,
  );

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            <span className="text-sm">SMS evidence recovery</span>
          </div>
          <p className="mt-2 max-w-3xl text-xs text-muted-foreground">
            Bounded, oldest-first operational evidence only. Phone numbers,
            message bodies, free-text provider payloads, and clinic PHI are
            never rendered here. Every write requires exact history review and a
            fresh UUID operation key.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={attemptQueue.isFetching || deliveryQueue.isFetching}
          onClick={refreshQueues}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh evidence
        </Button>
      </div>

      <ActionNotice message={actionMessage} error={actionError} />

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">Send-attempt exceptions</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            At most {QUEUE_LIMIT} rows. Orphan communication claims are visible
            for investigation but have no unsafe repair shortcut.
          </p>
          {attemptQueue.error ? (
            <QueueError>
              Could not load the send-attempt recovery queue.
            </QueueError>
          ) : attemptQueue.data ? (
            <div className="mt-3 overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Age / provider</th>
                    <th className="px-3 py-2 font-medium">Evidence</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {attemptQueue.data.items.map((item) => (
                    <tr
                      key={`${item.practiceId}:${item.attemptId ?? item.communicationId}`}
                    >
                      <td className="px-3 py-2 align-top">
                        <p>{formatTimestamp(item.createdAt)}</p>
                        <p className="text-xs capitalize text-muted-foreground">
                          {item.provider ?? "No attempt"} ·{" "}
                          {label(item.classification)}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <p className="break-all font-mono text-xs">
                          practice {item.practiceId}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {item.attemptId
                            ? `attempt ${item.attemptId}`
                            : `communication ${item.communicationId ?? "unavailable"}`}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {item.attemptId ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              selectAttempt({
                                practiceId: item.practiceId,
                                attemptId: item.attemptId!,
                                classification:
                                  item.classification as AttemptSelection["classification"],
                              })
                            }
                          >
                            Inspect history
                            <ChevronRight className="ml-1 h-4 w-4" />
                          </Button>
                        ) : (
                          <span className="text-xs font-medium text-amber-700">
                            Manual investigation only
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {attemptQueue.data.items.length === 0 ? (
                    <tr>
                      <td
                        colSpan={3}
                        className="px-3 py-6 text-center text-muted-foreground"
                      >
                        No stale send attempts need recovery.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Loading send evidence…
            </p>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold">Delivery-event exceptions</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            At most {QUEUE_LIMIT} actionable events. Stale accepted sends
            without a final callback remain monitor-only.
          </p>
          {deliveryQueue.error ? (
            <QueueError>
              Could not load the delivery-event recovery queue.
            </QueueError>
          ) : deliveryQueue.data ? (
            <div className="mt-3 overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">
                      Received / provider
                    </th>
                    <th className="px-3 py-2 font-medium">Evidence</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {deliveryQueue.data.items.map((item) => (
                    <tr key={item.eventId}>
                      <td className="px-3 py-2 align-top">
                        <p>{formatTimestamp(item.receivedAt)}</p>
                        <p className="text-xs capitalize text-muted-foreground">
                          {item.provider} · {label(item.queueReason)}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <p className="break-all font-mono text-xs">
                          event {item.eventId}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          incident{" "}
                          {item.pendingHistoryId ?? "derived status/projection"}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            selectDelivery({
                              eventId: item.eventId!,
                              queueReason:
                                item.queueReason as DeliverySelection["queueReason"],
                              pendingHistoryId: item.pendingHistoryId,
                            })
                          }
                        >
                          Inspect history
                          <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {deliveryQueue.data.items.length === 0 ? (
                    <tr>
                      <td
                        colSpan={3}
                        className="px-3 py-6 text-center text-muted-foreground"
                      >
                        No delivery events need reconciliation.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Loading delivery evidence…
            </p>
          )}
          {deliveryQueue.data?.staleAcceptedWithoutFinalDelivery.length ? (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {deliveryQueue.data.staleAcceptedWithoutFinalDelivery.length}{" "}
              accepted send(s) have no final callback. Monitor provider delivery
              evidence; this console intentionally offers no resend or status
              override.
            </div>
          ) : null}
        </div>
      </div>

      {attemptSelection ? (
        <div className="mt-6 rounded-md border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">Exact send-attempt history</h3>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {attemptSelection.practiceId}:{attemptSelection.attemptId}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAttemptSelection(null)}
            >
              Close
            </Button>
          </div>
          {attemptDetail.error ? (
            <QueueError>
              Could not load this exact send-attempt history.
            </QueueError>
          ) : attemptDetail.data ? (
            <>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <EvidenceId
                  label="Attempt"
                  value={attemptDetail.data.attempt.id}
                />
                <EvidenceId
                  label="Practice"
                  value={attemptDetail.data.attempt.practiceId}
                />
                <EvidenceId
                  label="Location"
                  value={attemptDetail.data.attempt.locationId}
                />
                <EvidenceId
                  label="Communication"
                  value={attemptDetail.data.attempt.communicationId}
                />
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Created {formatTimestamp(attemptDetail.data.attempt.createdAt)}{" "}
                · provider {attemptDetail.data.attempt.provider} · source{" "}
                {label(attemptDetail.data.attempt.source)}
              </p>
              <div className="mt-4 overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Recorded</th>
                      <th className="px-3 py-2 font-medium">Kind / outcome</th>
                      <th className="px-3 py-2 font-medium">
                        Immutable evidence IDs
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {attemptDetail.data.events.map((event) => (
                      <tr key={event.id}>
                        <td className="px-3 py-2 align-top">
                          {formatTimestamp(event.createdAt)}
                        </td>
                        <td className="px-3 py-2 align-top capitalize">
                          {label(event.kind)} · {label(event.outcome)}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <p className="break-all font-mono">
                            event {event.id}
                          </p>
                          <p className="mt-1 break-all font-mono text-muted-foreground">
                            provider message{" "}
                            {safeProviderEvidenceId(event.providerMessageId)}
                          </p>
                          <p className="mt-1 break-all font-mono text-muted-foreground">
                            key {event.eventKey}
                          </p>
                        </td>
                      </tr>
                    ))}
                    {attemptDetail.data.events.length === 0 ? (
                      <tr>
                        <td
                          colSpan={3}
                          className="px-3 py-5 text-center text-muted-foreground"
                        >
                          No provider-result evidence has been recorded.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Free-text event detail and operator identity are omitted at the
                server boundary because they can contain sensitive data.
              </p>

              {!effectiveAttemptEvent ||
              effectiveAttemptEvent.outcome === "outcome_unknown" ||
              terminalProjectionOutcome ? (
                <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 p-4">
                  <h4 className="text-sm font-semibold text-amber-950">
                    Reconcile reviewed provider outcome
                  </h4>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label className="text-xs font-medium">
                      Reviewed outcome
                      {terminalProjectionOutcome ? (
                        <Input
                          className="mt-1 capitalize"
                          value={label(terminalProjectionOutcome)}
                          readOnly
                        />
                      ) : (
                        <select
                          className={`${selectClassName} mt-1`}
                          value={attemptOutcome}
                          onChange={(event) => {
                            setAttemptOutcome(
                              event.target.value as AttemptOutcome | "",
                            );
                            if (event.target.value !== "accepted")
                              setProviderMessageId("");
                            setAttemptReviewed(false);
                          }}
                        >
                          <option value="">Choose reviewed outcome</option>
                          <option value="accepted">Accepted by provider</option>
                          <option value="definite_failure">
                            Definite failure
                          </option>
                        </select>
                      )}
                    </label>
                    <label className="text-xs font-medium">
                      Evidence source
                      <select
                        className={`${selectClassName} mt-1`}
                        value={attemptEvidence}
                        onChange={(event) => {
                          setAttemptEvidence(event.target.value);
                          setAttemptReviewed(false);
                        }}
                      >
                        <option value="">Choose evidence reviewed</option>
                        <option value="provider_portal_status">
                          Provider portal status
                        </option>
                        <option value="provider_support_confirmation">
                          Provider support confirmation
                        </option>
                        <option value="durable_provider_audit">
                          Durable provider audit record
                        </option>
                      </select>
                    </label>
                  </div>
                  {reviewedAttemptOutcome === "accepted" &&
                  !terminalProjectionOutcome ? (
                    <label className="mt-3 block text-xs font-medium">
                      Exact provider message ID
                      <Input
                        className="mt-1 font-mono"
                        value={providerMessageId}
                        maxLength={255}
                        autoComplete="off"
                        aria-invalid={providerIdLooksSensitive}
                        placeholder="Provider evidence ID only"
                        onChange={(event) => {
                          setProviderMessageId(event.target.value);
                          setAttemptReviewed(false);
                        }}
                      />
                    </label>
                  ) : null}
                  {providerIdLooksSensitive ? (
                    <p className="mt-2 text-xs font-medium text-destructive">
                      This value is phone-like or was withheld by the server. It
                      cannot be used as recovery evidence.
                    </p>
                  ) : null}
                  <label className="mt-3 flex items-start gap-2 text-xs text-amber-950">
                    <Checkbox
                      checked={attemptReviewed}
                      onChange={(event) =>
                        setAttemptReviewed(event.target.checked)
                      }
                    />
                    <span>
                      I reviewed this exact attempt and its immutable event
                      history, confirmed the selected outcome against the
                      evidence source, and did not copy a phone number, message
                      body, client name, or PHI.
                    </span>
                  </label>
                  <p className="mt-3 break-all font-mono text-[11px] text-amber-900">
                    Reconciliation UUID: {attemptReconciliationId}
                  </p>
                  <Button
                    type="button"
                    className="mt-3"
                    disabled={!canReconcileAttempt}
                    onClick={() => {
                      if (
                        !attemptSelection ||
                        !attemptReconciliationId ||
                        !reviewedAttemptOutcome ||
                        !attemptEvidence
                      ) {
                        return;
                      }
                      const acceptedProviderId =
                        reviewedAttemptOutcome === "accepted"
                          ? reviewedProviderMessageId
                          : undefined;
                      if (
                        !window.confirm(
                          `Record ${label(reviewedAttemptOutcome)} for exact attempt ${attemptSelection.attemptId}? This writes immutable reconciliation evidence.`,
                        )
                      ) {
                        return;
                      }
                      setActionError(null);
                      setActionMessage(null);
                      reconcileAttempt.mutate({
                        practiceId: attemptSelection.practiceId,
                        attemptId: attemptSelection.attemptId,
                        reconciliationId: attemptReconciliationId,
                        outcome: reviewedAttemptOutcome,
                        providerMessageId: acceptedProviderId,
                        detail: `Evidence source ${attemptEvidence}; reviewed outcome ${reviewedAttemptOutcome}; exact immutable attempt history reviewed; sensitive content excluded.`,
                      });
                    }}
                  >
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Record reviewed outcome
                  </Button>
                </div>
              ) : (
                <div className="mt-5 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
                  Backend-confirmed terminal outcome:{" "}
                  {label(effectiveAttemptEvent.outcome)}.
                </div>
              )}

              {backendConfirmedFailure ? (
                <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-4">
                  <h4 className="text-sm font-semibold">
                    Explicit resend after definite failure
                  </h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The backend ledger confirms a definite failure. The backend
                    will still re-check the failed communication, provider
                    window, clinic identity, and prior resend before sending.
                  </p>
                  <label className="mt-3 flex items-start gap-2 text-xs">
                    <Checkbox
                      checked={resendReviewed}
                      disabled={resendCompleted}
                      onChange={(event) =>
                        setResendReviewed(event.target.checked)
                      }
                    />
                    <span>
                      I confirm this is the exact failed attempt and authorize
                      one new provider send. I understand duplicate outreach is
                      possible if external evidence was reviewed incorrectly.
                    </span>
                  </label>
                  <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
                    Resend UUID: {resendId}
                  </p>
                  <Button
                    type="button"
                    variant="destructive"
                    className="mt-3"
                    disabled={
                      !resendReviewed ||
                      !resendId ||
                      resendCompleted ||
                      resendAttempt.isPending
                    }
                    onClick={() => {
                      if (!resendId) return;
                      if (
                        !window.confirm(
                          `Send one new SMS for definitively failed attempt ${attemptSelection.attemptId}? This is an external side effect.`,
                        )
                      ) {
                        return;
                      }
                      setActionError(null);
                      setActionMessage(null);
                      resendAttempt.mutate({
                        practiceId: attemptSelection.practiceId,
                        attemptId: attemptSelection.attemptId,
                        resendId,
                      });
                    }}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    {resendCompleted
                      ? "Resend already requested"
                      : "Confirm one resend"}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Loading exact attempt history…
            </p>
          )}
        </div>
      ) : null}

      {deliverySelection ? (
        <div className="mt-6 rounded-md border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">Exact delivery-event history</h3>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {deliverySelection.eventId}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setDeliverySelection(null)}
            >
              Close
            </Button>
          </div>
          {deliveryDetail.error ? (
            <QueueError>
              Could not load this exact delivery-event history.
            </QueueError>
          ) : deliveryDetail.data ? (
            <>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <EvidenceId
                  label="Event"
                  value={deliveryDetail.data.event.id}
                />
                <EvidenceId
                  label="Provider event"
                  value={deliveryDetail.data.event.providerEventId}
                />
                <EvidenceId
                  label="Provider message"
                  value={safeProviderEvidenceId(
                    deliveryDetail.data.event.providerMessageId,
                  )}
                />
                <EvidenceId
                  label="Payload fingerprint"
                  value={deliveryDetail.data.event.payloadFingerprintSha256}
                />
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Received {formatTimestamp(deliveryDetail.data.event.receivedAt)}{" "}
                · provider {deliveryDetail.data.event.provider} · event{" "}
                {label(deliveryDetail.data.event.providerEventType)} · observed{" "}
                {label(deliveryDetail.data.event.providerStatus)} · classified{" "}
                {label(deliveryDetail.data.event.classification)} · error code{" "}
                {deliveryDetail.data.event.providerErrorCode ?? "—"}
              </p>
              <div className="mt-4 overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Recorded</th>
                      <th className="px-3 py-2 font-medium">Kind / result</th>
                      <th className="px-3 py-2 font-medium">
                        Exact evidence links
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {deliveryDetail.data.history.map((history) => (
                      <tr key={history.id}>
                        <td className="px-3 py-2 align-top">
                          {formatTimestamp(history.createdAt)}
                        </td>
                        <td className="px-3 py-2 align-top capitalize">
                          {label(history.kind)} · {label(history.result)} ·{" "}
                          {label(history.classification)}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <p className="break-all font-mono">
                            history {history.id}
                          </p>
                          <p className="mt-1 break-all font-mono text-muted-foreground">
                            reviewed {history.reviewedHistoryId ?? "—"}
                          </p>
                          <p className="mt-1 break-all font-mono text-muted-foreground">
                            practice {history.practiceId ?? "—"} · attempt{" "}
                            {history.attemptId ?? "—"}
                          </p>
                          <p className="mt-1 break-all font-mono text-muted-foreground">
                            key {history.eventKey}
                          </p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Free-text history detail and operator identity are omitted at
                the server boundary. Candidate attribution is shown only as
                tenant and attempt UUID pairs.
              </p>
              {deliveryDetail.data.truncated ? (
                <p className="mt-2 text-xs font-medium text-destructive">
                  This event has more history than the bounded view can show. Do
                  not reconcile it from this console.
                </p>
              ) : null}
              {deliveryDetail.data.candidateAttempts.length ? (
                <div className="mt-3 rounded-md border border-border p-3">
                  <p className="text-xs font-semibold">
                    Exact attribution candidates
                  </p>
                  <ul className="mt-2 space-y-1 font-mono text-xs">
                    {deliveryDetail.data.candidateAttempts.map((candidate) => (
                      <li
                        key={`${candidate.practiceId}:${candidate.attemptId}`}
                        className="break-all"
                      >
                        {candidate.practiceId}:{candidate.attemptId}
                      </li>
                    ))}
                  </ul>
                  {deliveryDetail.data.candidateAttemptsTruncated ? (
                    <p className="mt-2 text-xs font-medium text-amber-700">
                      Candidate evidence is truncated; do not reconcile from
                      this view.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 p-4">
                <h4 className="text-sm font-semibold text-amber-950">
                  Reconcile reviewed delivery evidence
                </h4>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <label className="text-xs font-medium">
                    Reason
                    <select
                      className={`${selectClassName} mt-1`}
                      value={deliveryReason}
                      onChange={(event) => {
                        const next = event.target.value as DeliveryReason | "";
                        setDeliveryReason(next);
                        if (next !== "provider_portal_status_review") {
                          setDeliveryClassification("");
                        }
                        setDeliveryReviewed(false);
                      }}
                    >
                      <option value="">Choose exact recovery reason</option>
                      {deliveryReasonOptions.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {reason.text}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-medium">
                    Reviewed classification
                    <select
                      className={`${selectClassName} mt-1`}
                      value={deliveryClassification}
                      disabled={
                        deliveryReason !== "provider_portal_status_review"
                      }
                      onChange={(event) => {
                        setDeliveryClassification(
                          event.target.value as DeliveryClassification | "",
                        );
                        setDeliveryReviewed(false);
                      }}
                    >
                      <option value="">
                        {deliveryReason === "provider_portal_status_review"
                          ? "Choose provider-confirmed status"
                          : "Derived from durable evidence"}
                      </option>
                      <option value="sent">Sent</option>
                      <option value="failed">Failed</option>
                      <option value="delivered">Delivered</option>
                    </select>
                  </label>
                </div>
                {quarantineReason ? (
                  <p className="mt-3 break-all font-mono text-[11px] text-amber-900">
                    Exact reviewed incident:{" "}
                    {deliverySelection.pendingHistoryId ?? "missing"}
                  </p>
                ) : null}
                {!exactQuarantineEvidence ? (
                  <p className="mt-2 text-xs font-medium text-destructive">
                    The exact unresolved history row is absent or no longer
                    matches this incident. Refresh before acting.
                  </p>
                ) : null}
                <label className="mt-3 flex items-start gap-2 text-xs text-amber-950">
                  <Checkbox
                    checked={deliveryReviewed}
                    onChange={(event) =>
                      setDeliveryReviewed(event.target.checked)
                    }
                  />
                  <span>
                    I reviewed this exact event, the complete visible immutable
                    history, and the selected recovery evidence. I did not copy
                    a phone number, message body, client name, or PHI.
                  </span>
                </label>
                <p className="mt-3 break-all font-mono text-[11px] text-amber-900">
                  Reconciliation UUID: {deliveryReconciliationId}
                </p>
                <Button
                  type="button"
                  className="mt-3"
                  disabled={
                    !canReconcileDelivery ||
                    deliveryDetail.data.candidateAttemptsTruncated
                  }
                  onClick={() => {
                    if (
                      !deliveryReason ||
                      !deliveryReconciliationId ||
                      !deliverySelection
                    ) {
                      return;
                    }
                    if (
                      !window.confirm(
                        `Apply ${label(deliveryReason)} to exact delivery event ${deliverySelection.eventId}? This appends immutable operator evidence.`,
                      )
                    ) {
                      return;
                    }
                    setActionError(null);
                    setActionMessage(null);
                    reconcileDelivery.mutate({
                      deliveryEventId: deliverySelection.eventId,
                      reconciliationId: deliveryReconciliationId,
                      reviewedHistoryId: quarantineReason
                        ? (deliverySelection.pendingHistoryId ?? undefined)
                        : undefined,
                      classification:
                        deliveryReason === "provider_portal_status_review"
                          ? deliveryClassification || undefined
                          : undefined,
                      reasonCode: deliveryReason,
                    });
                  }}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Record reviewed delivery action
                </Button>
              </div>
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Loading exact delivery history…
            </p>
          )}
        </div>
      ) : null}

      {attemptQueue.data?.items.length === QUEUE_LIMIT ||
      deliveryQueue.data?.items.length === QUEUE_LIMIT ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />A queue reached
          its display bound. Resolve or narrow the oldest evidence, then refresh
          before concluding the queue is clear.
        </div>
      ) : null}
    </section>
  );
}
