"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

type OfferedLine = {
  id: string;
  description: string;
  offeredQuantity: string;
  unitPrice: string;
  lineTotal: string;
};

type PendingPlan = {
  status: "pending";
  title: string;
  patientName: string;
  revisionNumber: number;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  lines: OfferedLine[];
};

type Decision = {
  decision: "accepted" | "declined" | null;
  acceptedQuantity: string;
  declineReason: string;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "complete" }
  | { kind: "ready"; plan: PendingPlan };

function money(value: string, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(Number(value));
}

export function TreatmentPlanDecisionClient({ token }: { token: string }) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/treatment-plan/${token}`)
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 404) {
          setState({ kind: "expired" });
          return;
        }
        if (!response.ok) {
          setState({ kind: "error", message: "The plan could not be loaded." });
          return;
        }
        const data = (await response.json()) as
          | PendingPlan
          | {
              status: "awaiting_signature" | "completed";
              signUrl: string | null;
            };
        if (data.status === "awaiting_signature" && data.signUrl) {
          window.location.assign(data.signUrl);
          return;
        }
        if (data.status === "completed") {
          setState({ kind: "complete" });
          return;
        }
        if (data.status !== "pending") {
          setState({ kind: "expired" });
          return;
        }
        setDecisions(
          Object.fromEntries(
            data.lines.map((line) => [
              line.id,
              {
                decision: null,
                acceptedQuantity: line.offeredQuantity,
                declineReason: "",
              },
            ]),
          ),
        );
        setState({ kind: "ready", plan: data });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ kind: "error", message: "The plan could not be loaded." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-gray-600">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading treatment plan…
      </div>
    );
  }

  if (state.kind === "expired" || state.kind === "error") {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-center">
        <AlertCircle className="h-8 w-8 text-amber-500" />
        <p className="text-sm text-gray-600">
          {state.kind === "expired"
            ? "This link is no longer available. Ask the clinic for a new link."
            : state.message}
        </p>
      </div>
    );
  }

  if (state.kind === "complete") {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-center">
        <CheckCircle2 className="h-10 w-10 text-teal-600" />
        <h1 className="text-lg font-semibold text-gray-900">Plan signed</h1>
        <p className="text-sm text-gray-600">
          The clinic has your decisions and signed document.
        </p>
      </div>
    );
  }

  const { plan } = state;
  const allDecided = plan.lines.every(
    (line) => decisions[line.id]?.decision !== null,
  );

  async function continueToSignature() {
    if (!allDecided) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await fetch(`/api/treatment-plan/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: plan.lines.map((line) => {
            const choice = decisions[line.id]!;
            return {
              revisionLineId: line.id,
              decision: choice.decision,
              acceptedQuantity:
                choice.decision === "accepted"
                  ? choice.acceptedQuantity
                  : "0.000",
              declineReason:
                choice.decision === "declined"
                  ? choice.declineReason || null
                  : null,
            };
          }),
        }),
      });
      if (response.status === 404) {
        setState({ kind: "expired" });
        return;
      }
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        status?: string;
        signUrl?: string;
      } | null;
      if (!response.ok || !data?.signUrl) {
        setSubmitError(data?.error ?? "Decisions could not be saved.");
        return;
      }
      window.location.assign(data.signUrl);
    } catch {
      setSubmitError("Decisions could not be saved. Check your connection.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-950">{plan.title}</h1>
        <p className="mt-1 text-sm text-gray-600">
          For {plan.patientName} · Revision {plan.revisionNumber}
        </p>
      </div>

      <div className="space-y-3">
        {plan.lines.map((line) => {
          const choice = decisions[line.id];
          return (
            <fieldset
              key={line.id}
              className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <legend className="sr-only">
                Decision for {line.description}
              </legend>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium text-gray-950">
                    {line.description}
                  </p>
                  <p className="mt-1 text-sm text-gray-500">
                    {line.offeredQuantity} ×{" "}
                    {money(line.unitPrice, plan.currency)}
                  </p>
                </div>
                <p className="font-semibold tabular-nums text-gray-950">
                  {money(line.lineTotal, plan.currency)}
                </p>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {(["accepted", "declined"] as const).map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    aria-pressed={choice?.decision === decision}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                      choice?.decision === decision
                        ? decision === "accepted"
                          ? "border-teal-600 bg-teal-50 text-teal-800"
                          : "border-gray-700 bg-gray-100 text-gray-900"
                        : "border-gray-300 bg-white text-gray-700"
                    }`}
                    onClick={() =>
                      setDecisions((current) => ({
                        ...current,
                        [line.id]: {
                          ...(current[line.id] ?? {
                            acceptedQuantity: line.offeredQuantity,
                            declineReason: "",
                          }),
                          decision,
                        },
                      }))
                    }
                  >
                    {decision === "accepted" ? "Accept" : "Decline"}
                  </button>
                ))}
              </div>
              {choice?.decision === "accepted" ? (
                <label className="mt-3 block text-sm text-gray-700">
                  Accepted quantity (maximum {line.offeredQuantity})
                  <input
                    inputMode="decimal"
                    value={choice.acceptedQuantity}
                    onChange={(event) =>
                      setDecisions((current) => ({
                        ...current,
                        [line.id]: {
                          ...current[line.id]!,
                          acceptedQuantity: event.target.value,
                        },
                      }))
                    }
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                </label>
              ) : null}
              {choice?.decision === "declined" ? (
                <label className="mt-3 block text-sm text-gray-700">
                  Reason (optional)
                  <input
                    maxLength={2_000}
                    value={choice.declineReason}
                    onChange={(event) =>
                      setDecisions((current) => ({
                        ...current,
                        [line.id]: {
                          ...current[line.id]!,
                          declineReason: event.target.value,
                        },
                      }))
                    }
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                </label>
              ) : null}
            </fieldset>
          );
        })}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-600">Subtotal</dt>
            <dd>{money(plan.subtotal, plan.currency)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-600">Tax</dt>
            <dd>{money(plan.tax, plan.currency)}</dd>
          </div>
          <div className="flex justify-between border-t pt-2 font-semibold">
            <dt>Total offered</dt>
            <dd>{money(plan.total, plan.currency)}</dd>
          </div>
        </dl>
      </div>

      {submitError ? (
        <p role="alert" className="text-sm text-red-600">
          {submitError}
        </p>
      ) : null}
      <button
        type="button"
        disabled={!allDecided || submitting}
        onClick={() => void continueToSignature()}
        className="w-full rounded-lg bg-teal-600 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Saving decisions…" : "Continue to signature"}
      </button>
      <p className="text-center text-xs text-gray-500">
        This step records your choices. It does not charge you or schedule care.
      </p>
    </div>
  );
}
