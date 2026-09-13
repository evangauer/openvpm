"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  dateTimeLocalInputUtcInstant,
  formatDateTimeLocalInputForTimeZone,
} from "@/lib/date-input";
import { type MeasurementSystem } from "@/lib/ambulatory-workspace";
import {
  correctedWeightKilograms,
  weightDisplayInput,
} from "@/lib/records/weight-display";
import {
  PATIENT_WEIGHT_MIN_KG,
  PATIENT_WEIGHT_MAX_KG,
  isPatientWeightInputValid,
} from "@/lib/records/patient-weight-policy";
import {
  CLINICAL_CORRECTION_REASON_MIN_LENGTH,
  CLINICAL_CORRECTION_REASON_MAX_LENGTH,
} from "@/lib/records/clinical-correction-policy";

export function WeightCorrectionDialog({
  patientId,
  weight,
  timeZone,
  measurementSystem,
  onSaved,
}: {
  patientId: string;
  weight: { id: string; weightKg: string; recordedAt: Date | string };
  timeZone?: string | null;
  measurementSystem: MeasurementSystem;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [weightKg, setWeightKg] = useState(
    weightDisplayInput(weight.weightKg, measurementSystem),
  );
  const [measuredAt, setMeasuredAt] = useState("");
  const [reason, setReason] = useState("");
  const correction = trpc.patients.correctWeight.useMutation({
    onSuccess: () => {
      toast.success("Weight corrected; original preserved in the audit log");
      setOpen(false);
      onSaved();
    },
    onError: (error) => toast.error(error.message),
  });
  const instant = timeZone
    ? measuredAt ===
      formatDateTimeLocalInputForTimeZone(weight.recordedAt, timeZone)
      ? new Date(weight.recordedAt)
      : dateTimeLocalInputUtcInstant(measuredAt, timeZone)
    : null;
  const canonicalWeightKg = correctedWeightKilograms(
    weightKg,
    weight.weightKg,
    measurementSystem,
  );
  const valid =
    isPatientWeightInputValid(canonicalWeightKg) &&
    instant &&
    instant.getTime() <= Date.now() &&
    reason.trim().length >= CLINICAL_CORRECTION_REASON_MIN_LENGTH;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={!timeZone}
        onClick={() => {
          setWeightKg(weightDisplayInput(weight.weightKg, measurementSystem));
          setMeasuredAt(
            formatDateTimeLocalInputForTimeZone(weight.recordedAt, timeZone),
          );
          setReason("");
          setOpen(true);
        }}
      >
        Correct
      </Button>
      <DialogPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          if (!correction.isPending) setOpen(next);
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-lg">
            <div className="mb-4">
              <DialogPrimitive.Title className="text-lg font-semibold">
                Correct weight
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
                The original measurement is preserved with your name and
                correction reason in the audit log. Use the same units as the
                patient chart.
              </DialogPrimitive.Description>
            </div>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!valid || !instant || correction.isPending) return;
                correction.mutate({
                  patientId,
                  weightId: weight.id,
                  weightKg: canonicalWeightKg,
                  recordedAt: instant,
                  reason: reason.trim(),
                });
              }}
            >
              <label className="block text-sm font-medium">
                Corrected weight (
                {measurementSystem === "us_customary" ? "lb" : "kg"})
                <input
                  className="mt-1 w-full rounded-md border bg-background p-2"
                  type="number"
                  min={weightDisplayInput(
                    String(PATIENT_WEIGHT_MIN_KG),
                    measurementSystem,
                  )}
                  max={weightDisplayInput(
                    String(PATIENT_WEIGHT_MAX_KG),
                    measurementSystem,
                  )}
                  step="0.001"
                  required
                  value={weightKg}
                  onChange={(event) => setWeightKg(event.target.value)}
                />
              </label>
              <label className="block text-sm font-medium">
                Measured at ({timeZone})
                <input
                  className="mt-1 w-full rounded-md border bg-background p-2"
                  type="datetime-local"
                  required
                  value={measuredAt}
                  max={formatDateTimeLocalInputForTimeZone(
                    new Date(),
                    timeZone,
                  )}
                  onChange={(event) => setMeasuredAt(event.target.value)}
                />
              </label>
              <label className="block text-sm font-medium">
                Reason for correction
                <textarea
                  className="mt-1 w-full rounded-md border bg-background p-2"
                  required
                  minLength={CLINICAL_CORRECTION_REASON_MIN_LENGTH}
                  maxLength={CLINICAL_CORRECTION_REASON_MAX_LENGTH}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <Button type="submit" disabled={!valid || correction.isPending}>
                {correction.isPending ? "Saving…" : "Save correction"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="ml-2"
                disabled={correction.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
            </form>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
