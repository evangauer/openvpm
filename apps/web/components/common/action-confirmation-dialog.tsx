"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ReasonInput = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
};

export function ActionConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmVariant = "default",
  isPending = false,
  reason,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: "default" | "destructive";
  isPending?: boolean;
  reason?: ReasonInput;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  const pendingRef = useRef(isPending);
  const hasReason = reason !== undefined;
  cancelRef.current = onCancel;
  pendingRef.current = isPending;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      (hasReason ? reasonRef.current : confirmRef.current)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) {
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]",
        ) ?? [],
      ).filter((element) => element.tabIndex !== -1);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [hasReason, open]);

  if (!open) return null;

  const trimmedReason = reason?.value.trim() ?? "";
  const reasonIsValid = reason
    ? trimmedReason.length >= (reason.minLength ?? 1) &&
      trimmedReason.length <= (reason.maxLength ?? Number.POSITIVE_INFINITY)
    : true;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-2xl"
      >
        <h2 id={titleId} className="font-heading text-lg font-semibold">
          {title}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">
          {description}
        </p>

        {reason ? (
          <div className="mt-4">
            <label htmlFor={reasonId} className="text-sm font-medium">
              {reason.label}
            </label>
            <Textarea
              ref={reasonRef}
              id={reasonId}
              className="mt-2"
              value={reason.value}
              placeholder={reason.placeholder}
              minLength={reason.minLength}
              maxLength={reason.maxLength}
              aria-invalid={reason.value.length > 0 && !reasonIsValid}
              onChange={(event) => reason.onChange(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {reason.minLength
                ? `${reason.minLength} characters minimum. `
                : null}
              {reason.maxLength
                ? `${reason.value.length}/${reason.maxLength}`
                : null}
            </p>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" disabled={isPending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={confirmVariant}
            disabled={isPending || !reasonIsValid}
            onClick={onConfirm}
          >
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
