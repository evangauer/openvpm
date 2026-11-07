"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { useOfflineNoteDraft } from "@/lib/records/use-offline-note-draft";

export function OfflineNoteDraftControls({
  recovery,
  disabled = false,
}: {
  recovery: ReturnType<typeof useOfflineNoteDraft>;
  disabled?: boolean;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [expanded, setExpanded] = useState(false);
  if (!recovery.enabled) return null;
  const locked = recovery.mode === "locked";
  const ready = recovery.mode === "ready";
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      {ready ? (
        <p role="status">
          {recovery.localStatus === "saved"
            ? "Encrypted draft saved on this device. Not yet saved to the chart."
            : recovery.localStatus === "saving"
              ? "Saving encrypted device draft..."
              : recovery.localStatus === "error"
                ? "Device draft needs attention."
                : "Device draft recovery is on for this chart."}
        </p>
      ) : recovery.mode === "loading" ? (
        <p role="status">Checking for a device draft...</p>
      ) : recovery.mode === "bypassed" ? (
        <p role="status">
          Your saved device draft is still locked. This new note stays in this
          tab until saved to the chart. Reopen the chart to recover the earlier
          draft.
        </p>
      ) : recovery.mode !== "unavailable" ? (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || recovery.busy}
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            {locked
              ? "Unlock saved device draft"
              : "Keep a draft on this device"}
          </Button>
          {locked ? (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled || recovery.busy}
              onClick={recovery.startSeparateNote}
            >
              Start a separate note
            </Button>
          ) : null}
          {expanded ? (
            <div className="space-y-3">
              <p className="text-muted-foreground">
                Keep writing in this open chart if the connection drops. Your
                draft is encrypted with a passphrase you choose. Reopen this
                chart and enter it to recover your draft. A connection is needed
                to open the chart and save to the practice record.
              </p>
              <p className="text-muted-foreground">
                Use a trusted device and keep your passphrase safe. It cannot be
                reset. Clearing browser data removes the device copy.
              </p>
              <p id="draft-passphrase-help" className="text-muted-foreground">
                Use at least 12 characters and a different passphrase from your
                OpenVPM password.
              </p>
              <label className="block font-medium">
                Draft passphrase
                <input
                  type="password"
                  autoComplete="off"
                  maxLength={1024}
                  aria-describedby="draft-passphrase-help"
                  value={passphrase}
                  disabled={disabled || recovery.busy}
                  onChange={(event) => setPassphrase(event.target.value)}
                  className="mt-1 block w-full rounded-md border border-input bg-background p-2"
                />
              </label>
              {!locked ? (
                <label className="block font-medium">
                  Confirm draft passphrase
                  <input
                    type="password"
                    autoComplete="off"
                    value={confirmPassphrase}
                    disabled={disabled || recovery.busy}
                    onChange={(event) =>
                      setConfirmPassphrase(event.target.value)
                    }
                    className="mt-1 block w-full rounded-md border border-input bg-background p-2"
                  />
                </label>
              ) : null}
              <Button
                type="button"
                disabled={
                  disabled ||
                  recovery.busy ||
                  passphrase.length < 12 ||
                  (!locked && passphrase !== confirmPassphrase)
                }
                onClick={async () => {
                  const secret = passphrase;
                  setPassphrase("");
                  setConfirmPassphrase("");
                  await recovery.unlock(secret);
                }}
              >
                {recovery.busy
                  ? "Opening device draft..."
                  : locked
                    ? "Recover draft"
                    : "Enable draft recovery"}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {recovery.message ? (
        <p role="alert" className="text-destructive">
          {recovery.message}
        </p>
      ) : null}
    </div>
  );
}
