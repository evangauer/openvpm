"use client";

import { useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  PRESCRIPTION_LIFECYCLE_REASON_MAX_LENGTH,
  isPrescriptionLifecycleReasonValid,
  prescriptionLifecycleHistoryLabel,
  type PrescriptionStatus,
} from "@/lib/records/prescription-lifecycle";

type ActionMode = "refill" | "complete" | "cancel";

export interface PrescriptionLifecycleControlProps {
  prescription: {
    id: string;
    effectiveStatus: PrescriptionStatus;
    productId: string | null;
    quantity: number | null;
    refillsRemaining: number;
  };
  canManage: boolean;
  timeZone?: string | null;
  onChanged: () => void | Promise<void>;
}

function formatEventTime(value: Date | string, timeZone?: string | null) {
  const date = value instanceof Date ? value : new Date(value);
  try {
    return date.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return date.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
}

export function PrescriptionLifecycleControl({
  prescription,
  canManage,
  timeZone,
  onChanged,
}: PrescriptionLifecycleControlProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<ActionMode | null>(null);
  const [reason, setReason] = useState("");
  const operationId = useRef<string | null>(null);
  const history = trpc.records.listPrescriptionEvents.useQuery(
    { prescriptionId: prescription.id },
    { enabled: historyOpen },
  );

  const resetAction = () => {
    setMode(null);
    setReason("");
    operationId.current = null;
  };
  const finishAction = async (message: string) => {
    toast.success(message);
    await Promise.all([Promise.resolve(onChanged()), history.refetch()]);
    resetAction();
  };
  const refill = trpc.records.recordPrescriptionRefill.useMutation({
    onSuccess: (result) =>
      finishAction(
        result.event.eventType === "refill_dispensed"
          ? "Clinic-stock refill dispensed"
          : "External refill authorized",
      ),
    onError: (error) => toast.error(error.message),
  });
  const complete = trpc.records.completePrescription.useMutation({
    onSuccess: () => finishAction("Prescription completed"),
    onError: (error) => toast.error(error.message),
  });
  const cancel = trpc.records.cancelPrescription.useMutation({
    onSuccess: () => finishAction("Prescription cancelled"),
    onError: (error) => toast.error(error.message),
  });
  const isPending = refill.isPending || complete.isPending || cancel.isPending;
  const isActive = prescription.effectiveStatus === "active";
  const isExternalPrescription = !prescription.productId;
  const hasInvalidInventoryLink = Boolean(
    prescription.productId &&
      (!prescription.quantity || prescription.quantity <= 0),
  );
  const canRefill =
    isActive &&
    prescription.refillsRemaining > 0 &&
    !hasInvalidInventoryLink;

  const openAction = (nextMode: ActionMode) => {
    setMode(nextMode);
    setReason("");
    operationId.current = null;
  };

  const submitAction = () => {
    operationId.current ??= crypto.randomUUID();
    if (mode === "refill") {
      refill.mutate({
        id: prescription.id,
        operationId: operationId.current,
        note: reason.trim() || undefined,
      });
      return;
    }
    if (!mode || !isPrescriptionLifecycleReasonValid(reason)) return;
    const input = {
      id: prescription.id,
      operationId: operationId.current,
      reason: reason.trim(),
    };
    if (mode === "complete") complete.mutate(input);
    if (mode === "cancel") cancel.mutate(input);
  };

  return (
    <div className="min-w-[18rem] space-y-2 text-left">
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {historyOpen ? (
            <ChevronUp className="mr-1 h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="mr-1 h-3.5 w-3.5" />
          )}
          History
        </Button>
        {canManage && isActive ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canRefill || isPending}
              title={
                canRefill
                  ? isExternalPrescription
                    ? "Authorize one external-pharmacy refill"
                    : "Dispense one clinic-stock refill"
                  : hasInvalidInventoryLink
                    ? "The linked inventory prescription is missing a positive dispensing quantity"
                    : "This prescription has no remaining refills"
              }
              onClick={() => openAction("refill")}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              {isExternalPrescription ? "Authorize refill" : "Refill"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => openAction("complete")}
            >
              <Check className="mr-1 h-3.5 w-3.5" />
              Complete
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => openAction("cancel")}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          </>
        ) : null}
      </div>

      {mode ? (
        <div className="ml-auto max-w-sm rounded-md border border-border bg-background p-3">
          <p className="text-sm font-medium">
            {mode === "refill"
              ? isExternalPrescription
                ? "Authorize external-pharmacy refill"
                : `Dispense ${prescription.quantity ?? "--"} from inventory`
              : mode === "complete"
                ? "Complete prescription"
                : "Cancel prescription"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === "refill"
              ? isExternalPrescription
                ? "This records authorization and uses one refill. It does not dispense stock or contact the pharmacy. An optional note is retained in history."
                : "This deducts the original quantity from stock, records the refill, and uses one refill. It does not create a client charge; add the refill charge in Billing."
              : "Enter a clinical reason (at least 5 characters). The status change is permanent and audited."}
          </p>
          <Textarea
            className="mt-2 min-h-16"
            value={reason}
            maxLength={PRESCRIPTION_LIFECYCLE_REASON_MAX_LENGTH}
            aria-label={mode === "refill" ? "Refill note" : "Clinical reason"}
            aria-invalid={
              mode !== "refill" &&
              reason.length > 0 &&
              !isPrescriptionLifecycleReasonValid(reason)
            }
            placeholder={
              mode === "refill"
                ? "Optional dispensing note"
                : "Required clinical reason"
            }
            onChange={(event) => {
              setReason(event.target.value);
              operationId.current = null;
            }}
          />
          {mode === "refill" && !isExternalPrescription ? (
            <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              Controlled-substance log entries are not automated. If applicable,
              complete the required controlled drug record separately before
              dispensing.
            </p>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={resetAction}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                isPending ||
                (mode !== "refill" &&
                  !isPrescriptionLifecycleReasonValid(reason))
              }
              onClick={submitAction}
            >
              {isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Confirm
            </Button>
          </div>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="ml-auto max-w-sm rounded-md border border-border bg-muted/30 p-3">
          {history.isLoading ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading history…
            </p>
          ) : history.error || !history.data ? (
            <div className="space-y-2">
              <p className="text-xs text-destructive">
                {history.error?.message ?? "Unable to load prescription history."}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => history.refetch()}>
                Retry
              </Button>
            </div>
          ) : history.data.length === 0 ? (
            <p className="text-xs text-muted-foreground">No lifecycle history recorded.</p>
          ) : (
            <ol className="space-y-3">
              {history.data.map((event) => (
                <li key={event.id} className="border-l-2 border-border pl-3 text-xs">
                  <p className="font-medium">
                    {prescriptionLifecycleHistoryLabel({
                      eventType: event.eventType,
                      productId: event.productId,
                      quantity: event.quantity,
                    })}
                  </p>
                  <p className="text-muted-foreground">
                    {formatEventTime(event.createdAt, timeZone)} · {event.actorName}
                  </p>
                  {event.eventType === "refill_dispensed" ? (
                    <p className="text-muted-foreground">
                      Dispensed {event.quantity}; {event.refillsAfter} refill
                      {event.refillsAfter === 1 ? "" : "s"} remaining
                    </p>
                  ) : event.eventType === "refill_authorized" ? (
                    <p className="text-muted-foreground">
                      External refill authorized; {event.refillsAfter} refill
                      {event.refillsAfter === 1 ? "" : "s"} remaining
                    </p>
                  ) : null}
                  {event.reason ? <p className="mt-1">{event.reason}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}
