"use client";

import { useId, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CLINICAL_CORRECTION_REASON_MAX_LENGTH,
  isClinicalCorrectionReasonValid,
} from "@/lib/records/clinical-correction-policy";
import { formatClinicalDateTime } from "@/lib/records/clinical-dates";

type ExistingCorrection = {
  id: string;
  reason: string;
  correctedAt: Date | string;
  correctedByName?: string | null;
};

export function ClinicalCorrectionControl({
  correction,
  canCorrect,
  isPending,
  onCorrect,
  description,
  timeZone,
}: {
  correction?: ExistingCorrection | null;
  canCorrect: boolean;
  isPending: boolean;
  onCorrect: (reason: string) => Promise<unknown>;
  description?: string;
  timeZone?: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();

  if (correction) {
    const dateLabel = formatClinicalDateTime(
      correction.correctedAt,
      timeZone,
      "Unknown time",
    );
    return (
      <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Entered in error — retained in chart history
        </div>
        <p className="mt-1 whitespace-pre-wrap text-foreground">
          {correction.reason}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Corrected by {correction.correctedByName ?? "Unknown user"} ·{" "}
          {dateLabel}
        </p>
      </div>
    );
  }

  if (!canCorrect) return null;

  const valid = isClinicalCorrectionReasonValid(reason);
  return (
    <DialogPrimitive.Root
      open={editing}
      onOpenChange={(open) => {
        if (isPending) return;
        setEditing(open);
        if (!open) {
          setReason("");
        }
      }}
    >
      <div className="mt-3 flex justify-end">
        <DialogPrimitive.Trigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-destructive"
          >
            Mark entered in error
          </Button>
        </DialogPrimitive.Trigger>
      </div>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-lg">
          <DialogPrimitive.Title className="text-lg font-semibold">
            Mark record entered in error?
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
            {description ??
              "The original record will remain visible in staff chart history, but it will no longer be used for current clinical summaries, client portal records, reminders, or certificates."}
          </DialogPrimitive.Description>
          <div className="mt-4">
            <label
              htmlFor={reasonId}
              className="block text-sm font-medium text-foreground"
            >
              Why is this record incorrect?
            </label>
            <Textarea
              id={reasonId}
              className="mt-1 bg-background"
              value={reason}
              maxLength={CLINICAL_CORRECTION_REASON_MAX_LENGTH}
              rows={4}
              autoFocus
              placeholder="Required. Be specific; this reason becomes permanent chart history."
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" disabled={isPending}>
                Cancel
              </Button>
            </DialogPrimitive.Close>
            <Button
              type="button"
              variant="destructive"
              disabled={!valid || isPending}
              onClick={async () => {
                try {
                  await onCorrect(reason.trim());
                  setReason("");
                  setEditing(false);
                } catch {
                  // The mutation owner presents the server error and keeps the
                  // dialog open so the user can review or retry.
                }
              }}
            >
              {isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Confirm correction
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
