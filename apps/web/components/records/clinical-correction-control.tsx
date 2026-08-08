"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CLINICAL_CORRECTION_REASON_MAX_LENGTH,
  isClinicalCorrectionReasonValid,
} from "@/lib/records/clinical-correction-policy";

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
}: {
  correction?: ExistingCorrection | null;
  canCorrect: boolean;
  isPending: boolean;
  onCorrect: (reason: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");

  if (correction) {
    const correctedAt = new Date(correction.correctedAt);
    const dateLabel = Number.isNaN(correctedAt.getTime())
      ? "Unknown time"
      : correctedAt.toLocaleString();
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

  if (!editing) {
    return (
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-destructive"
          onClick={() => setEditing(true)}
        >
          Mark entered in error
        </Button>
      </div>
    );
  }

  const valid = isClinicalCorrectionReasonValid(reason);
  return (
    <div className="mt-3 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <label className="block text-xs font-medium text-foreground">
        Why is this record incorrect?
        <Textarea
          className="mt-1 bg-background"
          value={reason}
          maxLength={CLINICAL_CORRECTION_REASON_MAX_LENGTH}
          rows={3}
          placeholder="Required. Be specific; this reason becomes permanent chart history."
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        The original record will remain visible and cannot be edited or deleted.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => {
            setReason("");
            setEditing(false);
          }}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={!valid || isPending}
          onClick={async () => {
            try {
              await onCorrect(reason.trim());
              setReason("");
              setEditing(false);
            } catch {
              // The mutation owner presents the server error and keeps this
              // form open so the user can review or retry the correction.
            }
          }}
        >
          {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Confirm correction
        </Button>
      </div>
    </div>
  );
}
