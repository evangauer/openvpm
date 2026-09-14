"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ReconciliationReasonActions({
  label,
  canVoid,
  disabled,
  onResolve,
}: {
  label: string;
  canVoid: boolean;
  disabled: boolean;
  onResolve: (resolution: {
    status: "no_charge" | "voided";
    reason: string;
  }) => void;
}) {
  const [status, setStatus] = useState<"no_charge" | "voided" | null>(null);
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          aria-pressed={status === "no_charge"}
          disabled={disabled}
          onClick={() => setStatus("no_charge")}
        >
          No charge
        </Button>
        {canVoid && (
          <Button
            type="button"
            variant="outline"
            aria-pressed={status === "voided"}
            disabled={disabled}
            onClick={() => setStatus("voided")}
          >
            Void/corrected
          </Button>
        )}
      </div>
      {status && (
        <div className="space-y-2 rounded-md border p-3">
          <label className="block text-sm">
            {status === "voided"
              ? "Why is this work void or corrected?"
              : "Why is there no charge?"}
            <Input
              autoFocus
              value={reason}
              maxLength={500}
              aria-label={`Reconciliation reason for ${label}`}
              disabled={disabled}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Enter at least 3 characters. This reason and your name will be
            recorded.
          </p>
          <Button
            type="button"
            disabled={disabled || reason.trim().length < 3}
            onClick={() => onResolve({ status, reason: reason.trim() })}
          >
            Confirm {status === "voided" ? "void/correction" : "no charge"}
          </Button>
        </div>
      )}
    </div>
  );
}
